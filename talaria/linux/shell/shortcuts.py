"""
Global hotkeys, through the desktop's portal.

**Not `kglobalaccel`, and the reason is a scar.** Its D-Bus interface is KDE's
own internal one, and on Plasma 6 Wayland it is hosted inside `kwin_wayland` —
so a malformed argument is not a returned error, it is a dead compositor. A
`setShortcutKeys` call carrying `a(ai)` took the session down during
development. The interface is undocumented, unversioned, and shares a process
with the thing that draws every window on the machine. That is the wrong place
for a note-taking tool to be sending hand-marshalled variants.

`org.freedesktop.portal.GlobalShortcuts` is the opposite on all three counts:
specified, versioned, and hosted in `xdg-desktop-portal`, which is a separate
process that respawns. It also asks the user before binding anything, which for
a tool that is otherwise reaching into the desktop's keyboard is the right
default rather than an obstacle.

The cost, stated plainly: these bindings live in the portal's own store, so they
do not appear in System Settings → Shortcuts. `--rebind` re-opens the portal's
dialog, which is where they are changed instead.

**Why a thread.** The portal is a conversation — create a session, wait for its
reply, bind, wait again, then listen — and it is driven by a GLib main loop
while Qt is running its own. Rather than marrying two event loops, this drives a
private GLib context on one thread and hands presses to Qt as a queued signal,
which is a boundary Qt already guarantees is safe.
"""

from __future__ import annotations

import threading
import uuid

from PySide6.QtCore import QObject, Signal

PORTAL = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SHORTCUTS_IFACE = "org.freedesktop.portal.GlobalShortcuts"
REQUEST_IFACE = "org.freedesktop.portal.Request"

# The portal's trigger syntax, which is not Qt's and not the Mac's. Modifiers are
# spelled out and uppercase, joined by '+', with the key last.
_MODS = {
    "shift": "SHIFT",
    "ctrl": "CTRL", "control": "CTRL",
    "alt": "ALT", "opt": "ALT", "option": "ALT",
    "meta": "LOGO", "cmd": "LOGO", "super": "LOGO", "win": "LOGO",
}
_ORDER = ["LOGO", "CTRL", "ALT", "SHIFT"]


def to_trigger(spec: str) -> str | None:
    """`"shift+alt+c"` to the portal's `"ALT+SHIFT+c"`, or None if it makes no sense."""
    mods: set[str] = set()
    key: str | None = None
    for part in (p.strip().lower() for p in spec.split("+")):
        if not part:
            continue
        if part in _MODS:
            mods.add(_MODS[part])
        else:
            key = part
    if key is None:
        return None
    return "+".join([m for m in _ORDER if m in mods] + [key])


class Shortcuts(QObject):
    """Registers hotkeys and emits `pressed(action)` when one is used."""

    pressed = Signal(str)
    #: Emitted once the portal has answered, so the UI can say what took.
    settled = Signal()

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._thread: threading.Thread | None = None
        self._wanted: list[tuple[str, str, str]] = []
        self.failures: list[str] = []
        self.bound: dict[str, str] = {}

    def bind(self, action: str, friendly: str, spec: str) -> None:
        """Queue a binding. Nothing reaches the portal until `start`."""
        trigger = to_trigger(spec)
        if trigger is None:
            self.failures.append(f"{action}: can't make sense of hotkey '{spec}'")
            return
        self._wanted.append((action, friendly, trigger))

    def start(self, rebind: bool = False) -> None:
        if self._thread or not self._wanted:
            return
        self._thread = threading.Thread(
            target=self._run, args=(rebind,), name="talaria-shortcuts", daemon=True
        )
        self._thread.start()

    # ------------------------------------------------------------------ thread

    @staticmethod
    def _asked() -> list[str]:
        """Shortcut ids the portal has already been asked about, ever."""
        from PySide6.QtCore import QSettings

        value = QSettings("talaria", "shell").value("askedShortcuts")
        if isinstance(value, str):
            return [value] if value else []
        return list(value or [])

    @staticmethod
    def _remember_asked(ids: set[str]) -> None:
        from PySide6.QtCore import QSettings

        QSettings("talaria", "shell").setValue("askedShortcuts", sorted(ids))

    def _run(self, rebind: bool) -> None:
        try:
            import gi

            gi.require_version("Gio", "2.0")
            gi.require_version("GLib", "2.0")
            from gi.repository import Gio, GLib
        except Exception as err:  # noqa: BLE001
            self._give_up(f"no GLib/Gio bindings, so no hotkeys — {err}")
            return

        context = GLib.MainContext.new()
        context.push_thread_default()
        try:
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        except Exception as err:  # noqa: BLE001
            self._give_up(f"no session bus, so no hotkeys — {err}")
            return

        # Every reply arrives as a Response on a per-request object. Subscribing
        # by interface rather than by computing each path keeps this to one
        # subscription and avoids reimplementing the portal's path-mangling rule.
        replies: dict[str, tuple[int, dict]] = {}
        waiting = GLib.MainLoop.new(context, False)

        def on_response(_c, _s, path, _i, _sig, params):
            code, results = params.unpack()
            replies[path] = (code, results)
            if waiting.is_running():
                waiting.quit()

        bus.signal_subscribe(
            PORTAL, REQUEST_IFACE, "Response", None, None,
            Gio.DBusSignalFlags.NONE, on_response,
        )

        def ask(method: str, params) -> tuple[int, dict] | None:
            """Call, then pump this thread's loop until the Response lands."""
            try:
                handle = bus.call_sync(
                    PORTAL, PORTAL_PATH, SHORTCUTS_IFACE, method, params,
                    None, Gio.DBusCallFlags.NONE, 60_000, None,
                ).unpack()[0]
            except Exception as err:  # noqa: BLE001
                self.failures.append(f"{method} refused — {err}")
                return None
            if handle in replies:
                return replies.pop(handle)
            # Bounded, because BindShortcuts shows a dialog and a person may
            # simply never answer it. A hotkey that never binds is a shame; a
            # thread parked forever is a leak.
            GLib.timeout_add_seconds(120, lambda: (waiting.quit(), False)[1])
            waiting.run()
            return replies.pop(handle, None)

        # **The session token is stable, and that is not a shortcut taken.**
        #
        # KDE implements this portal on top of `kglobalaccel`, and when it
        # cannot resolve an app id it names the component after this token. A
        # random one per launch therefore means a brand new component every
        # start: the bindings a person set in System Settings are left behind
        # under the old name, the defaults come back, and the shortcut list
        # grows another `token_talaria_…` section every time the shell runs.
        #
        # The spec wants `session_handle_token` unique only against *live*
        # sessions, and the shell already refuses to be a second copy — so a
        # constant is safe here and is what makes a customized hotkey survive a
        # restart. `handle_token` stays unique because it identifies one request.
        created = ask("CreateSession", GLib.Variant("(a{sv})", ({
            "handle_token": GLib.Variant("s", f"talaria_{uuid.uuid4().hex[:8]}"),
            "session_handle_token": GLib.Variant("s", "talaria"),
        },)))
        if not created or created[0] != 0:
            self._give_up("the desktop's shortcut portal declined to open a session")
            return
        session = created[1].get("session_handle")
        if not session:
            self._give_up("the shortcut portal opened a session but did not name it")
            return

        # What the portal already holds for this session. On a second run these
        # come back bound and nothing is asked of the user again.
        #
        # **Listed is not the same as bound**, and reading it that way is what
        # left four of five hotkeys dead. `ListShortcuts` returns every shortcut
        # id the session knows, including ones the portal is holding with no
        # trigger attached — `trigger_description` is empty for those. Treating
        # a bare id as "already done" meant only the one genuinely new shortcut
        # was ever requested, and the other four were skipped on every start
        # while appearing, correctly, in the portal's own list.
        listed = ask("ListShortcuts", GLib.Variant("(oa{sv})", (session, {})))
        already = set()
        if listed and listed[0] == 0:
            for entry in listed[1].get("shortcuts", []):
                trigger = (entry[1] or {}).get("trigger_description") or ""
                if trigger.strip():
                    already.add(entry[0])

        # **Asked at most once, unless asked to ask again.**
        #
        # Re-requesting on every start is not merely noisy, it is destructive:
        # a `BindShortcuts` whose dialog nobody answers leaves the shortcut
        # recorded with no key, so the next start finds it empty and asks again,
        # and a binding that was working is now gone. Restarting the shell a few
        # times in a row was enough to wipe a set of hotkeys the user had chosen
        # — which is exactly what kept happening while this was being built.
        #
        # An unbound shortcut is also a legitimate answer. Somebody who was
        # asked and said no should not be asked again on Tuesday.
        asked = set(self._asked())
        missing = [w for w in self._wanted if w[0] not in already and w[0] not in asked]
        if missing or rebind:
            wanted = self._wanted if rebind else missing
            self._remember_asked(asked | {w[0] for w in wanted})
            shortcuts = [
                (action, {
                    "description": GLib.Variant("s", friendly),
                    "preferred_trigger": GLib.Variant("s", trigger),
                })
                for action, friendly, trigger in wanted
            ]
            bound = ask("BindShortcuts", GLib.Variant(
                "(oa(sa{sv})sa{sv})", (session, shortcuts, "", {})
            ))
            if not bound or bound[0] != 0:
                # Response code 1 is the user closing the dialog, which is a
                # decision rather than a fault and is reported as one.
                self.failures.append(
                    "hotkeys were not granted — reopen the request with:  talaria-shell --rebind"
                )

        final = ask("ListShortcuts", GLib.Variant("(oa{sv})", (session, {})))
        if final and final[0] == 0:
            for entry in final[1].get("shortcuts", []):
                self.bound[entry[0]] = entry[1].get("trigger_description", "")
        self.settled.emit()

        def on_activated(_c, _s, _p, _i, _sig, params):
            unpacked = params.unpack()
            # Logged because a hotkey that does nothing has two very different
            # causes — the portal never sent it, or it arrived and the handler
            # dropped it — and from the outside they look identical.
            print(f"talaria: portal Activated {unpacked[1:2]}", flush=True)
            if len(unpacked) >= 2:
                self.pressed.emit(unpacked[1])

        bus.signal_subscribe(
            PORTAL, SHORTCUTS_IFACE, "Activated", PORTAL_PATH, None,
            Gio.DBusSignalFlags.NONE, on_activated,
        )
        GLib.MainLoop.new(context, False).run()

    def _give_up(self, message: str) -> None:
        self.failures.append(message)
        self.settled.emit()
