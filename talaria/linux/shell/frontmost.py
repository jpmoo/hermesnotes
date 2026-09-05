"""
Who is in front, told to us by KWin.

The Mac polls `lsappinfo` every two seconds. This is pushed instead, because
KWin will say when it changes and there is nothing to gain from asking a
question whose answer has not moved.

**The blindlist is applied on arrival, not on use.** A window that must not be
read has its caption dropped here, in the receiving callback, before anything
else in the process can see it. That is what makes "we did not look" a true
sentence rather than an intention: there is no moment at which a password
manager's title is sitting in an attribute waiting for somebody to be careful
about it.

Nothing is written down. This holds one window in memory and replaces it when
the next one arrives, which is the same promise Glance makes about the text it
embeds.

GDBus rather than QtDBus because `python3-pyside6.qtdbus` is not installed and
this already keeps a GLib loop on a thread for the shortcuts portal; a second
one is cheaper than another dependency.
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
from dataclasses import dataclass

from PySide6.QtCore import QObject, Signal

import blindlist

BUS_NAME = "dev.talaria.Shell"
OBJECT_PATH = "/Window"
INTERFACE = "dev.talaria.Window"

#: What KWin calls our own windows — `QApplication.setDesktopFileName`.
OURS = "dev.talaria."

INTROSPECTION = f"""
<node>
  <interface name='{INTERFACE}'>
    <method name='Changed'>
      <arg type='s' name='windowClass' direction='in'/>
      <arg type='s' name='resourceName' direction='in'/>
      <arg type='i' name='pid' direction='in'/>
      <arg type='s' name='caption' direction='in'/>
      <arg type='s' name='workspace' direction='in'/>
    </method>
  </interface>
</node>
"""

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kwin", "talaria-window.js")

#: Where the daemon keeps its things — `config.json` sits beside the socket.
SOCKET_DIR = os.path.join(
    (os.environ.get("XDG_DATA_HOME") or "").strip()
    or os.path.join(os.path.expanduser("~"), ".local", "share"),
    "talaria", "talaria.sock",
)


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
    """

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.changed_at: float | None = None

    def start(self) -> None:
        from PySide6.QtGui import QGuiApplication

        app = QGuiApplication.instance()
        if app is None:
            return
        clipboard = app.clipboard()
        if clipboard is None:
            return
        clipboard.selectionChanged.connect(self._tick)

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
        try:
            import gi

            gi.require_version("Gio", "2.0")
            gi.require_version("GLib", "2.0")
            from gi.repository import Gio, GLib
        except Exception as err:  # noqa: BLE001
            self.failure = f"no GLib/Gio bindings, so no window source — {err}"
            return

        context = GLib.MainContext.new()
        context.push_thread_default()

        def on_call(_conn, _sender, _path, _iface, method, params, invocation):
            if method != "Changed":
                invocation.return_value(None)
                return
            window_class, resource_name, pid, caption, workspace = params.unpack()

            # Our own windows are not "what is in front" for any purpose here.
            # Opening a panel would otherwise overwrite the thing the panel
            # exists to look at, and pressing the hotkey a second time while it
            # is open would read Talaria's own title. Reading is ordered to
            # avoid this too, but a window source that answers "Talaria" to
            # "what were you doing?" is wrong on its own account.
            if pid == os.getpid() or (window_class or "").startswith(OURS):
                return invocation.return_value(None)

            # **Never our own helpers.**
            #
            # An earlier version fingerprinted the primary selection here by
            # running `wl-paste`, which connects to the display, becomes a
            # Wayland client for an instant, and is reported by KWin as the
            # newly activated window — which ran this again, which spawned
            # another one. The screen flashed continuously and Glance solemnly
            # reported that the front window was `wl-paste`. Nothing is spawned
            # from this callback now, and the tools are ignored besides.
            if (window_class or "") in HELPERS or (resource_name or "") in HELPERS:
                return invocation.return_value(None)

            # Here, and before anything else touches it.
            blind = blindlist.is_blind(window_class or None, pid or None)
            # Only a timestamp. What the selection *holds* is never sampled on a
            # window change — see `SelectionClock`.
            self.focused_at = time.monotonic()
            self.changed.emit(Window(
                window_class=window_class,
                resource_name=resource_name,
                pid=pid,
                caption=None if blind else (caption or None),
                workspace=workspace or None,
                blind=blind,
            ))
            invocation.return_value(None)

        try:
            node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
            conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            conn.register_object(OBJECT_PATH, node.interfaces[0], on_call, None, None)
            Gio.bus_own_name_on_connection(
                conn, BUS_NAME, Gio.BusNameOwnerFlags.REPLACE, None, None
            )
        except Exception as err:  # noqa: BLE001
            self.failure = f"couldn't take {BUS_NAME} — {err}"
            return

        # The script is loaded after the name exists, or its first call lands on
        # nothing and the current window is unknown until the next switch.
        self._load_script()
        GLib.MainLoop.new(context, False).run()

    @staticmethod
    def _load_script() -> None:
        """
        Ask KWin to run the reporter.

        Reloaded on every start rather than installed once: this is a
        development tree, the file changes, and a KWin holding an old copy of it
        is a confusing thing to debug. `unloadScript` first because loading the
        same path twice leaves two of them connected to `windowActivated`, and
        every window change then arrives in duplicate.
        """
        script = _generated_script()
        for method, arg in (("unloadScript", script), ("loadScript", script)):
            subprocess.run(
                ["busctl", "--user", "call", "org.kde.KWin", "/Scripting",
                 "org.kde.kwin.Scripting", method, "s", arg],
                capture_output=True, timeout=5,
            )
        subprocess.run(
            ["busctl", "--user", "call", "org.kde.KWin", "/Scripting",
             "org.kde.kwin.Scripting", "start"],
            capture_output=True, timeout=5,
        )


PLACEMENTS = (
    "top-left", "top-center", "top-right",
    "middle-left", "middle-center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right",
)


def _generated_script() -> str:
    """
    The KWin script, with the placement written into it.

    A KWin script has no filesystem and cannot read `config.json`, so the value
    is substituted here and the result written beside the runtime state — a
    rendering of the source rather than a second source, which is the same
    arrangement `systemd/talaria.service.in` uses for `ExecStart`.
    """
    from PySide6.QtCore import QStandardPaths

    placement, opacity = "bottom-center", 1.0
    try:
        import json

        with open(os.path.join(os.path.dirname(SOCKET_DIR), "config.json"), encoding="utf8") as h:
            raw = json.load(h)
        if raw.get("glancePlacement") in PLACEMENTS:
            placement = raw["glancePlacement"]
        asked = 1.0
        # Clamped rather than trusted. A panel at 0.2 is unreadable and a panel
        # somebody cannot find is a panel they cannot turn back up.
        opacity = min(1.0, max(0.6, asked))
    except Exception:  # noqa: BLE001
        pass

    with open(SCRIPT, encoding="utf8") as handle:
        body = (
            handle.read()
            .replace("__PLACEMENT__", placement)
            .replace("__OPACITY__", f"{opacity:.2f}")
        )
    out = os.path.join(
        QStandardPaths.writableLocation(QStandardPaths.StandardLocation.RuntimeLocation) or "/tmp",
        "talaria-window.js",
    )
    with open(out, "w", encoding="utf8") as handle:
        handle.write(body)
    return out
