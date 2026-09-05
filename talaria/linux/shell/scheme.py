"""
A web view that can talk to the daemon.

`QWebEngineView` speaks http and nothing else, and the daemon listens on a Unix
socket. That leaves two ways to put a page in front of somebody: give the daemon
a TCP port, or carry the requests yourself. A port would make every process on
the machine a client of a service that answers questions about what the user is
reading, so this carries them. That reasoning is the Swift reference's and it
did not change on the way across.

The page is written as though it were on an ordinary server — `fetch("/boards")`,
`<img src="/canvas/image/…">` — and this turns each of those into a request on
the socket. Nothing in the page knows.

**Two kinds of path, one origin.** Anything under `/ui/` is a file shipped beside
this module; everything else is the daemon's. That split is why no daemon change
was needed to serve these panels, and it sidesteps the warning in the brief about
esbuild copying no static assets: nothing is bundled, because the shell already
has the files.
"""

from __future__ import annotations

import mimetypes
import os
import traceback

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QObject, QRunnable, Qt, QThreadPool, QUrl, Signal
import shiboken6
from PySide6.QtWebEngineCore import QWebEngineUrlRequestJob, QWebEngineUrlScheme, QWebEngineUrlSchemeHandler

import daemon

SCHEME = b"talaria-app"
ORIGIN = "talaria-app://daemon"
UI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui")


def register_scheme() -> None:
    """
    Declare the scheme before any web engine profile exists.

    Qt requires this before the first QWebEngineProfile is constructed and
    silently gives you a scheme with no permissions if you skip it — the page
    then loads and every `fetch` fails CORS, which looks like a broken daemon
    rather than a missing registration.
    """
    scheme = QWebEngineUrlScheme(SCHEME)
    scheme.setSyntax(QWebEngineUrlScheme.Syntax.HostAndPort)
    scheme.setFlags(
        QWebEngineUrlScheme.Flag.SecureScheme
        | QWebEngineUrlScheme.Flag.LocalAccessAllowed
        | QWebEngineUrlScheme.Flag.CorsEnabled
        # The one that is easy to leave out and impossible to diagnose from the
        # page. Without it every `fetch` fails as "Failed to fetch" — a network
        # error with no status, no console detail and nothing in the handler,
        # because the engine refuses before the request is ever issued. The
        # panels rendered perfectly and showed that string in place of all their
        # data, which reads exactly like a dead daemon.
        | QWebEngineUrlScheme.Flag.FetchApiAllowed
        | QWebEngineUrlScheme.Flag.ContentSecurityPolicyIgnored
    )
    QWebEngineUrlScheme.registerScheme(scheme)


#: How much JSON a request may carry in its header. Headers are not sized for
#: documents; over this the request is refused with a sentence rather than
#: truncated into something the daemon would half-accept. QWebChannel is the way
#: out if this ever bites — it has no such limit.
MAX_BODY = 96 * 1024

#: Sentinel for "there was a body and it was too big", which is not the same
#: answer as "there was no body".
TOO_BIG = object()


def _error_json(message: str) -> bytes:
    return ('{"error":%s}' % _json_string(message)).encode("utf8")


class _Reply(QObject):
    done = Signal(int, bytes, str)
    failed = Signal(str)


class _Ask(QRunnable):
    """One request, off the UI thread."""

    def __init__(self, reply: _Reply, method: str, path: str, body: bytes | None, ctype: str) -> None:
        super().__init__()
        self._reply, self._method, self._path, self._body, self._ctype = reply, method, path, body, ctype

    def run(self) -> None:
        try:
            status, data, mime = daemon.request(self._method, self._path, self._body, self._ctype)
            self._reply.done.emit(status, data, mime)
        except Exception as err:  # noqa: BLE001 — the page gets the message, whatever it was
            self._reply.failed.emit(str(err))


class DaemonScheme(QWebEngineUrlSchemeHandler):
    """
    Proxy `talaria-app://daemon/...` into the socket.

    **On lifetime, which is where both implementations bled.**

    The Swift version crashed inside `objc_release` because it held only
    identifiers: a task could be freed and a new one land on the same address,
    and closing a window released the view with requests still in flight. This
    one crashed in `PySide::getWrapperForQObject` for the same reason wearing
    different clothes. The reply object was parented to the job, so when the job
    died the reply's C++ half died with it — and the worker thread, still
    holding the Python wrapper, emitted on freed memory. A segfault naming
    nothing, minutes in, exactly like the history in the brief.

    So the handler owns every reply outright and parents none of them to a job.
    Two independent checks guard the delivery, both on the main thread where
    `destroyed` also runs, so they cannot interleave with it:

    - `_live`, which `destroyed` empties — the job we were asked about is still
      one the engine wants an answer for;
    - `shiboken6.isValid`, which asks whether the C++ object behind the wrapper
      is actually still there. The set can only tell us what we were told; this
      tells us what is true.

    The `QBuffer` is still parented to the job, which is Qt's own prescription
    for the reply device — and safe precisely because nothing reaches that line
    until both checks have passed.
    """

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._live: set[int] = set()
        #: Replies we own. Keyed the same way as `_live` and cleared together.
        self._replies: dict[int, _Reply] = {}
        self._pool = QThreadPool(self)
        # The daemon is one process on one socket; a burst of parallel requests
        # buys nothing and makes the failure modes harder to read.
        self._pool.setMaxThreadCount(4)

    def requestStarted(self, job: QWebEngineUrlRequestJob) -> None:  # noqa: N802 — Qt's name
        url = job.requestUrl()
        # **Fully encoded, both halves.** `QUrl.path()` and `QUrl.query()`
        # default to `PrettyDecoded`, which turns `%20` back into a space — and
        # a space in an HTTP request line is not a URL, it is a syntax error.
        # Glance was the first page to send a query with anything in it that
        # needed escaping, and every request it made came back as "URL can't
        # contain control characters" from a path the page had encoded
        # perfectly well before handing it over.
        fmt = QUrl.ComponentFormattingOption.FullyEncoded
        path = url.path(fmt) or "/"
        if url.hasQuery():
            path += "?" + url.query(fmt)

        if path.startswith("/ui/") or path == "/":
            self._serve_file(job, "/ui/index.html" if path == "/" else path)
            return

        key = id(job)
        self._live.add(key)
        # Drop our claim the moment the engine lets go, so a reply that lands
        # afterwards finds nothing to deliver to and says so quietly.
        job.destroyed.connect(lambda *_: self._forget(key))

        method = bytes(job.requestMethod()).decode("ascii", "replace").upper()
        body = None
        # Asked for only when the method can carry one, and this is not tidiness.
        # On a GET there is no body device, and PySide tries to build a Python
        # wrapper around the null `QIODevice*` it gets back — a segfault inside
        # `getWrapperForQObject`, on the very first request the page makes. The
        # window renders, the CSS arrives, and the process dies reaching for a
        # body that was never going to be there.
        if method in ("POST", "PUT", "PATCH"):
            body = self._body_from_headers(job)
            if body is TOO_BIG:
                self._forget(key)
                self._reply_bytes(job, _error_json(
                    f"That is too large to send this way — the limit is {MAX_BODY // 1024} KB."
                ), "application/json")
                return

        reply = _Reply()
        self._replies[key] = reply  # owned here, never parented to the job
        reply.done.connect(
            lambda status, data, mime: self._finish(job, key, status, data, mime),
            Qt.ConnectionType.QueuedConnection,
        )
        reply.failed.connect(
            lambda message: self._fail(job, key, message),
            Qt.ConnectionType.QueuedConnection,
        )
        self._pool.start(_Ask(reply, method, path, body, "application/json"))

    @staticmethod
    def _body_from_headers(job: QWebEngineUrlRequestJob) -> bytes | None | object:
        """
        The request body, which arrives in a header rather than in the body.

        **`job.requestBody()` cannot be called at all in this PySide6 build.**
        It hands PySide a `QIODevice*` it cannot wrap and dies inside
        `getWrapperForQObject` — on a GET, where the device is null, and equally
        on a POST where there plainly is one. Dragging a card is the first thing
        that writes, and it took the whole application down.

        `requestHeaders()` returns a value type, so no wrapper is looked up and
        nothing crashes. `api.js` puts the JSON in `x-talaria-body` instead.
        This is one process talking to itself — the header never reaches a
        network or a log, which is why it is acceptable here and would not be
        over the wire.
        """
        try:
            headers = job.requestHeaders()
        except Exception:  # noqa: BLE001
            return None
        for key, value in headers.items():
            if bytes(key).lower() == b"x-talaria-body":
                raw = bytes(value)
                return TOO_BIG if len(raw) > MAX_BODY else (raw or None)
        return None

    def _forget(self, key: int) -> None:
        self._live.discard(key)
        self._replies.pop(key, None)

    def _usable(self, job: QWebEngineUrlRequestJob, key: int) -> bool:
        """Both checks, in the order that makes the second one cheap."""
        if key not in self._live:
            return False
        if not shiboken6.isValid(job):
            self._forget(key)
            return False
        return True

    def _serve_file(self, job: QWebEngineUrlRequestJob, path: str) -> None:
        rel = path[len("/ui/"):]
        # The name is checked rather than trusted, the same way the daemon checks
        # an image name. These files are ours, but a page is a place where a
        # string becomes a path and `../../.ssh/id_rsa` is a file name until
        # somebody says otherwise.
        target = os.path.normpath(os.path.join(UI_DIR, rel))
        if not target.startswith(UI_DIR + os.sep) or not os.path.isfile(target):
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return
        try:
            with open(target, "rb") as handle:
                data = handle.read()
        except OSError:
            job.fail(QWebEngineUrlRequestJob.Error.RequestFailed)
            return
        mime = mimetypes.guess_type(target)[0] or "application/octet-stream"
        self._reply_bytes(job, data, mime)

    def _finish(self, job: QWebEngineUrlRequestJob, key: int, status: int, data: bytes, mime: str) -> None:
        if not self._usable(job, key):
            return
        self._forget(key)
        # A status is not something QWebEngineUrlRequestJob can carry, so an
        # error arrives as its body. The pages read `ok` off the JSON rather
        # than a code, which is what the daemon's own envelope already provides.
        if status >= 400 and not data:
            job.fail(QWebEngineUrlRequestJob.Error.RequestFailed)
            return
        self._reply_bytes(job, data, mime)

    def _fail(self, job: QWebEngineUrlRequestJob, key: int, message: str) -> None:
        if not self._usable(job, key):
            return
        self._forget(key)
        # Answered rather than failed: a page that gets a JSON error can say what
        # went wrong, and one that gets a network failure can only say "failed".
        payload = ('{"error":%s}' % _json_string(message)).encode("utf8")
        self._reply_bytes(job, payload, "application/json")

    @staticmethod
    def _reply_bytes(job: QWebEngineUrlRequestJob, data: bytes, mime: str) -> None:
        buffer = QBuffer(job)  # Qt's prescription — see the class note
        buffer.setData(QByteArray(data))
        buffer.open(QIODevice.OpenModeFlag.ReadOnly)
        job.reply(mime.split(";")[0].strip().encode("ascii", "replace"), buffer)


def _json_string(value: str) -> str:
    import json

    return json.dumps(value)
