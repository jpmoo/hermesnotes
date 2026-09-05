"""
Talking to the daemon from Python.

The Swift reference shells out to `curl` because Foundation has no Unix-socket
transport and framing HTTP by hand is a lot of code to get subtly wrong. Python
has the transport, so this is the one place the port gets to be simpler than the
original: `http.client` does the framing and a two-line subclass supplies the
socket.

That removes the reference's most delicate detail along with it. It had to read
the pipe *before* waiting on the process, because a reply larger than the pipe
buffer deadlocks otherwise — a canvas full of photographs being exactly that
reply. There is no pipe and no process here, so there is nothing to deadlock.
"""

from __future__ import annotations

import http.client
import json
import os
import socket
from typing import Any


def socket_path() -> str:
    """
    Where the daemon is listening.

    A third copy of the rule in `daemon/src/config.ts` — see the note in
    `cli/src/client.ts` about why the second one exists. Same instruction: if
    that rule changes, change it here.
    """
    if (env := os.environ.get("TALARIA_SOCKET")):
        return env
    xdg = (os.environ.get("XDG_DATA_HOME") or "").strip()
    base = xdg or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "talaria", "talaria.sock")


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float) -> None:
        super().__init__("talaria", timeout=timeout)
        self._path = path

    def connect(self) -> None:  # type: ignore[override]
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._path)
        self.sock = sock


class DaemonDown(Exception):
    """The socket is not there, or nothing is listening on it."""


def request(
    method: str,
    path: str,
    body: bytes | None = None,
    content_type: str = "application/json",
    timeout: float = 120.0,
) -> tuple[int, bytes, str]:
    """
    One request. Returns (status, body, content-type).

    The timeout is generous by default because `/assistant` waits on a language
    model. Callers that are only asking the mirror a question should pass
    something short — a panel that hangs for two minutes on a dead daemon is
    worse than one that says so in two seconds.
    """
    conn = _UnixConnection(socket_path(), timeout)
    try:
        headers = {"content-type": content_type} if body else {}
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        # Explicitly, never sniffed. The reference makes this point and it is
        # the same here: a JSON reply that arrives without a declared type gets
        # guessed at, and a `fetch` resolves to something unusable.
        return resp.status, data, resp.getheader("content-type") or "application/octet-stream"
    except (FileNotFoundError, ConnectionRefusedError, socket.error) as err:
        raise DaemonDown(f"the daemon isn't answering on {socket_path()} — {err}") from err
    finally:
        conn.close()


def get_json(path: str, timeout: float = 10.0) -> Any:
    """A read, unwrapped. The daemon answers `{"data": …}`; callers want the data."""
    status, body, _ = request("GET", path, timeout=timeout)
    if status >= 400:
        raise DaemonDown(f"{path} answered {status}")
    parsed = json.loads(body)
    return parsed.get("data", parsed) if isinstance(parsed, dict) else parsed


def origin() -> str | None:
    """
    Where Hermes lives, from the same config the daemon reads.

    Asked of the daemon rather than read off disk: `/health` already reports it,
    the daemon is the thing that knows whether the file parsed, and a shell that
    reads the config itself is a second parser to keep in step with the first.
    """
    try:
        health = get_json("/health", timeout=5.0)
    except Exception:
        return None
    value = health.get("origin") if isinstance(health, dict) else None
    return value.rstrip("/") if isinstance(value, str) else None
