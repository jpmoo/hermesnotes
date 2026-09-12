"""
Who is in front, told to us by the compositor.

The Mac polls `lsappinfo` every two seconds. This is pushed instead, because
the compositor will say when it changes and there is nothing to gain from
asking a question whose answer has not moved.

**Which compositor is not this file's business.** KWin reports over D-Bus from
a script it runs; Hyprland announces it on an event socket and is then asked for
the details. Both arrive at `_arrive` below as the same five fields, and the
difference lives in `wm/`. What is here is what is true of every desktop: our
own windows are not "what is in front", our own helpers are not either, and the
blindlist is applied before anything can look at a caption.

**The blindlist is applied on arrival, not on use.** A window that must not be
read has its caption dropped here, in the receiving callback, before anything
else in the process can see it. That is what makes "we did not look" a true
sentence rather than an intention: there is no moment at which a password
manager's title is sitting in an attribute waiting for somebody to be careful
about it.

Nothing is written down. This holds one window in memory and replaces it when
the next one arrives, which is the same promise Glance makes about the text it
embeds.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass

from PySide6.QtCore import QObject, QProcess, Signal

import blindlist
import wm

#: What the compositor calls our own windows — `QApplication.setDesktopFileName`.
OURS = "dev.talaria."


#: Our own tools, which are not windows anybody switched to.
HELPERS = {"wl-paste", "wl-copy", "xclip", "xsel", "busctl", "curl"}


class SelectionClock(QObject):
    """
    When the primary selection last changed — and nothing about what it holds.

    The primary selection is global: it carries the last thing highlighted by
    any window and cannot say which. Comparing *when* it last changed against
    when the current window took focus answers what it cannot — a selection
    older than the focus was made somewhere else.

    **Qt's clipboard, not `wl-paste`.** Two earlier attempts failed in ways
    worth recording. Sampling with `wl-paste` on every window change spawned a
    Wayland client per focus event, which KWin reported as the newly activated
    window, which sampled again: the screen flashed continuously and Glance
    reported that the front window was `wl-paste`. Switching to
    `wl-paste --watch` failed differently and silently — it needs the wlroots
    `data-control` protocol, KWin does not implement it, so the watcher exited
    immediately and the clock never ticked at all.

    Qt is already a Wayland client with the primary-selection protocol
    negotiated. `selectionChanged` costs no process, creates no window, and
    cannot loop.

    Only the timestamp is kept. What the selection holds is never read here,
    which is not merely tidy: this fires on every highlight anywhere on the
    desktop, and the question is answered by a clock.

    **And on this compositor it does not fire for anybody else.** Measured,
    after the clock quietly broke the rung it was built to protect: a Qt client
    with no focused window received *zero* `selectionChanged` events while
    another application set the primary selection twice. Wayland offers the
    primary selection to the focused client and to nobody else, so these ticks
    are only ever about Talaria's own windows.

    That makes the timestamp worse than missing. `selection_is_stale` reads a
    tick older than the current focus as "this selection was made somewhere
    else" — which is true of every external selection the moment any Talaria
    panel has been used, because the clock stopped at the last thing selected
    *here*. Glance then refused the primary selection for every non-browser
    application and fell to the window title, and the failure had a signature
    worth recognizing: it worked after a restart and stopped for good once you
    selected anything inside a Talaria window.

    So the clock says whether it can see anything but itself, and the ladder is
    told to stop asking a question this platform cannot answer.

    **Answered from the platform, not from a probe.** The first attempt was a
    runtime one — a tick arriving while none of our windows was active would
    prove the clock could observe other applications — and it was wrong within
    the hour: a tray application with no window showing reports
    `ApplicationInactive`, so Talaria's own first tick looked like somebody
    else's and the clock declared itself sighted. The platform name is the fact
    the behavior actually follows. X11 delivers selection notifications to
    anyone who asks, and there the timestamps mean what `selection_is_stale`
    thinks they mean.
    """

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.changed_at: float | None = None
        #: True when the ticks are only ever about our own windows, so the
        #: timestamps say nothing about anybody else's selection. Set in
        #: `start`, from the platform.
        self.blind: bool = False

    def start(self) -> None:
        from PySide6.QtGui import QGuiApplication

        app = QGuiApplication.instance()
        if app is None:
            return
        clipboard = app.clipboard()
        if clipboard is None:
            return
        self.blind = app.platformName().startswith("wayland")
        clipboard.selectionChanged.connect(self._tick)
        if self.blind:
            self._watch()

    def _watch(self) -> None:
        """
        Give the clock eyes where the compositor offers `data-control`.

        The history above is KWin's: `wl-paste --watch` needs the wlroots
        `data-control` protocol, KWin has none, and the watcher died at once.
        Hyprland implements it, and there the watcher sees every primary
        selection on the desktop without being focused — measured: it stays up,
        fires on a highlight in another application, and the active window does
        not move. So a watcher that is *still running* is the proof, and only
        then is the clock declared sighted; one that exits leaves it blind,
        exactly as before.

        One long-lived client rather than a spawn per focus change, so the
        flashing loop recorded above cannot happen. And still only a timestamp:
        `echo` ignores the selection it is handed on stdin, so nothing
        highlighted anywhere is read into this process.
        """
        watcher = QProcess(self)
        watcher.setProgram("wl-paste")
        watcher.setArguments(["--primary", "--watch", "echo"])
        watcher.setStandardErrorFile(QProcess.nullDevice())
        watcher.readyReadStandardOutput.connect(self._watched)
        watcher.finished.connect(self._unwatched)
        self._watcher = watcher
        #: `--watch` runs once for whatever is selected when it starts. That is
        #: not a change anybody made, so it must not look like a fresh one.
        self._watch_started = time.monotonic()
        watcher.start()
        if watcher.waitForStarted(1000):
            self.blind = False

    def _watched(self) -> None:
        self._watcher.readAllStandardOutput()
        if time.monotonic() - self._watch_started > 0.5:
            self._tick()

    def _unwatched(self, *_args) -> None:
        # Gone — no data-control, or the display went away. Blind again, which
        # is the honest state, rather than trusting a clock that stopped.
        self.blind = True

    def _tick(self) -> None:
        self.changed_at = time.monotonic()


@dataclass(frozen=True)
class Window:
    """One window, already judged."""

    window_class: str
    resource_name: str
    pid: int
    #: None when the blindlist refused it. Absent rather than emptied, so the
    #: difference between "no title" and "not looked at" survives to the UI.
    caption: str | None
    #: The virtual desktop that was current. The Mac gets this from AeroSpace;
    #: here KWin owns the desktops and simply says.
    workspace: str | None
    blind: bool

    @property
    def name(self) -> str:
        return self.resource_name or self.window_class or "something"


class Frontmost(QObject):
    """Emits `changed(Window)` when the focused window changes."""

    changed = Signal(object)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.current: Window | None = None
        self.failure: str | None = None
        #: When the focused window last changed. Compared against the clock
        #: below to decide whether a selection was made in this window.
        self.focused_at: float = time.monotonic()
        self.selection = SelectionClock(self)
        self.selection.start()
        self._thread: threading.Thread | None = None
        self.changed.connect(self._remember)

    def _remember(self, window: Window) -> None:
        self.current = window
        self._tell_the_daemon(window)

    def _tell_the_daemon(self, window: Window) -> None:
        """
        Hand the change to `POST /context`.

        The daemon has kept a context record since it was written and has had
        nothing to put in it here: `frontmostApp` and AeroSpace are macOS, and
        `talaria doctor` has been saying "no window source on this platform yet"
        in those words. This is that source.

        **The title is sent and the daemon decides.** It has rules about titles
        that this side has no business duplicating — a short trusted list, a
        second list where a title is kept only if it names a block in the
        library, and everything else dropped. Filtering here as well would mean
        two policies to keep in step, and the one that matters is the one next
        to the storage.

        What is *not* sent is a blinded window's title, because that never
        existed in this process to send. Rung 1 dropped it on arrival.

        Off the GLib thread, because it is a socket call on a callback the
        compositor is waiting on — and failing quietly, because a context record
        is a convenience and a daemon that is restarting is not an error worth
        interrupting anybody about.
        """
        threading.Thread(
            target=self._post_context, args=(window,), name="talaria-context", daemon=True
        ).start()

    @staticmethod
    def _post_context(window: Window) -> None:
        import json

        import daemon as daemon_client

        payload = {
            # The window class, which is this platform's answer to a bundle id.
            "app": window.window_class or window.resource_name or None,
            "title": window.caption,
            "workspace": window.workspace,
        }
        try:
            daemon_client.request(
                "POST", "/context", json.dumps(payload).encode("utf8"), timeout=5.0
            )
        except Exception:  # noqa: BLE001
            pass

    def start(self) -> None:
        if self._thread:
            return
        self._thread = threading.Thread(target=self._run, name="talaria-frontmost", daemon=True)
        self._thread.start()

    # ------------------------------------------------------------------ thread

    def _run(self) -> None:
        """Hand the thread to whichever backend this session has."""
        wm.run_window_source(self._arrive, self._failed)

    def _failed(self, message: str) -> None:
        """
        No window source, said once and kept.

        Read by `talaria doctor`, which is the only place it can be seen — a
        shell with no window source still works, it simply cannot say what you
        were looking at, and stopping over that would be the wrong trade.
        """
        self.failure = message

    def _arrive(
        self,
        window_class: str,
        resource_name: str,
        pid: int,
        caption: str,
        workspace: str,
    ) -> None:
        """
        One window, from any compositor, judged before anything else sees it.

        Called on whatever thread the backend is running; everything it touches
        is either an attribute replaced wholesale or a Qt signal, which is a
        boundary Qt already guarantees is safe.
        """
        # Our own windows are not "what is in front" for any purpose here.
        # Opening a panel would otherwise overwrite the thing the panel exists
        # to look at, and pressing the hotkey a second time while it is open
        # would read Talaria's own title. Reading is ordered to avoid this too,
        # but a window source that answers "Talaria" to "what were you doing?"
        # is wrong on its own account.
        if pid == os.getpid() or (window_class or "").startswith(OURS):
            return

        # **Never our own helpers.**
        #
        # An earlier version fingerprinted the primary selection here by running
        # `wl-paste`, which connects to the display, becomes a Wayland client
        # for an instant, and is reported by the compositor as the newly
        # activated window — which ran this again, which spawned another one.
        # The screen flashed continuously and Glance solemnly reported that the
        # front window was `wl-paste`. Nothing is spawned from here now, and the
        # tools are ignored besides.
        if (window_class or "") in HELPERS or (resource_name or "") in HELPERS:
            return

        # Here, and before anything else touches it.
        blind = blindlist.is_blind(window_class or None, pid or None)
        # Only a timestamp. What the selection *holds* is never sampled on a
        # window change — see `SelectionClock`.
        #
        # **And only when the window changed, not its title.** Hyprland reports
        # the active window again on every title change, and a terminal
        # retitles itself constantly — a spinner, the running command, the
        # working directory. Stamping focus on each of those made a selection
        # made seconds ago in that same terminal read as older than the focus,
        # so Glance refused it as inherited and fell to the title.
        identity = (window_class, resource_name, pid)
        if identity != getattr(self, "_focused_identity", None):
            self._focused_identity = identity
            self.focused_at = time.monotonic()
        self.changed.emit(Window(
            window_class=window_class,
            resource_name=resource_name,
            pid=pid,
            caption=None if blind else (caption or None),
            workspace=workspace or None,
            blind=blind,
        ))
