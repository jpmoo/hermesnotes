"""
Pressing a key in somebody else's window.

The one thing Glance does that has an effect rather than just an answer, so it
is kept in a file of its own and used from exactly one place.

**The RemoteDesktop portal, not `ydotool`.** The brief is explicit and right:
`ydotool` wants `/dev/uinput` and therefore root, which is the wrong trade for
filling in a form. The portal asks the user once, keeps the grant, and runs as
the user. On X11 `xdotool` would do the same job with no session at all; that
path is not built because this desktop is Wayland, and it is the obvious place
to add one.

**The session is opened lazily.** Starting a remote-desktop session raises a
dialog asking permission to control input, and asking that of somebody who has
merely launched a note-taking tool — and may never use this rung — is the kind
of prompt that gets an application uninstalled. Nothing here happens until a
synthetic copy is actually wanted.
"""

from __future__ import annotations

import queue
import sys
import threading
import uuid

PORTAL = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
REQUEST = "org.freedesktop.portal.Request"

#: Linux evdev keycodes. `NotifyKeyboardKeycode` speaks these rather than
#: keysyms, so they do not depend on the keyboard layout — which is the
#: behaviour wanted here: ctrl+c is a chord, not the letter C.
KEY_LEFTCTRL = 29
KEY_C = 46

#: Keyboard only. A session that can also move the pointer is a larger grant
#: than this needs, and the dialog says which.
DEVICE_KEYBOARD = 1


class FakeInput:
    """A held remote-desktop session, able to send one chord."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._jobs: queue.Queue = queue.Queue()
        self._ready = threading.Event()
        self.failure: str | None = None
        self._session: str | None = None

    # ------------------------------------------------------------------ public

    def copy(self, timeout: float = 6.0) -> tuple[bool, str]:
        """Send ctrl+c to whatever is focused. Returns (sent, why)."""
        self._start()
        if not self._ready.wait(timeout=timeout + 30):
            return False, self.failure or "the input portal did not answer"
        if self._session is None:
            return False, self.failure or "no input session"
        answer: queue.Queue = queue.Queue()
        self._jobs.put(answer)
        try:
            return answer.get(timeout=timeout)
        except queue.Empty:
            return False, "the key press was not acknowledged"

    # ------------------------------------------------------------------ thread

    def _start(self) -> None:
        with self._lock:
            if self._thread:
                return
            self._thread = threading.Thread(target=self._run, name="talaria-input", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        try:
            import gi

            gi.require_version("Gio", "2.0")
            gi.require_version("GLib", "2.0")
            from gi.repository import Gio, GLib
        except Exception as err:  # noqa: BLE001
            self._give_up(f"no GLib/Gio bindings ({err})")
            return

        context = GLib.MainContext.new()
        context.push_thread_default()
        try:
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        except Exception as err:  # noqa: BLE001
            self._give_up(f"no session bus ({err})")
            return

        replies: dict = {}
        waiting = GLib.MainLoop.new(context, False)

        def on_response(_c, _s, path, _i, _sig, params):
            replies[path] = params.unpack()
            if waiting.is_running():
                waiting.quit()

        bus.signal_subscribe(PORTAL, REQUEST, "Response", None, None,
                             Gio.DBusSignalFlags.NONE, on_response)

        def ask(method: str, params):
            try:
                handle = bus.call_sync(
                    PORTAL, PORTAL_PATH, REMOTE, method, params,
                    None, Gio.DBusCallFlags.NONE, 120_000, None,
                ).unpack()[0]
            except Exception as err:  # noqa: BLE001
                self._give_up(f"{method} refused ({err})")
                return None
            if handle in replies:
                return replies.pop(handle)
            # Generous: `Start` puts a permission dialog in front of somebody
            # who may be reading something before they answer it.
            GLib.timeout_add_seconds(120, lambda: (waiting.quit(), False)[1])
            waiting.run()
            return replies.pop(handle, None)

        token = uuid.uuid4().hex[:8]
        created = ask("CreateSession", GLib.Variant("(a{sv})", ({
            "handle_token": GLib.Variant("s", f"talaria_{token}"),
            "session_handle_token": GLib.Variant("s", f"talaria_{token}"),
        },)))
        if not created or created[0] != 0:
            self._give_up("the remote-desktop portal declined to open a session")
            return
        session = created[1].get("session_handle")

        picked = ask("SelectDevices", GLib.Variant("(oa{sv})", (session, {
            "handle_token": GLib.Variant("s", f"talaria_d{token}"),
            "types": GLib.Variant("u", DEVICE_KEYBOARD),
        })))
        if not picked or picked[0] != 0:
            self._give_up("keyboard control was not offered")
            return

        started = ask("Start", GLib.Variant("(osa{sv})", (session, "", {
            "handle_token": GLib.Variant("s", f"talaria_s{token}"),
        })))
        if not started or started[0] != 0:
            # Response 1 is somebody declining the dialog, which is a decision.
            self._give_up("permission to send key presses was not granted")
            return

        self._session = session
        self._ready.set()
        print("talaria: input portal ready — synthetic copy is available",
              file=sys.stderr, flush=True)

        while True:
            answer = self._jobs.get()
            try:
                for code, pressed in (
                    (KEY_LEFTCTRL, 1), (KEY_C, 1), (KEY_C, 0), (KEY_LEFTCTRL, 0),
                ):
                    bus.call_sync(
                        PORTAL, PORTAL_PATH, REMOTE, "NotifyKeyboardKeycode",
                        GLib.Variant("(oa{sv}ii)", (session, {}, code, pressed)),
                        None, Gio.DBusCallFlags.NONE, 5000, None,
                    )
                answer.put((True, "ctrl+c"))
            except Exception as err:  # noqa: BLE001
                answer.put((False, f"the key press failed ({err})"))

    def _give_up(self, message: str) -> None:
        self.failure = message
        print(f"talaria: input portal — {message}", file=sys.stderr, flush=True)
        self._ready.set()


#: One session for the process. Opening a second would mean a second dialog.
shared = FakeInput()
