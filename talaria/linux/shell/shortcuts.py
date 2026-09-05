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

import sys
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

        # **Unique again, and that is a reversal worth explaining.**
        #
        # This was made a constant because KDE was naming the kglobalaccel
        # component after it, so a random token per launch stranded the user's
        # bindings under a dead `token_talaria_…` section every start.
        #
        # That is no longer how the component is named. Started properly — as
        # `app-dev.talaria.shell@autostart.service` rather than as a child of
        # whatever happened to launch it — the portal resolves a real app id and
        # the bindings live under `[dev.talaria.shell]`, which is stable on its
        # own account. The constant then stopped helping and started hurting: a
        # restart races the previous session's teardown, and `CreateSession`
        # with a token the portal still holds fails outright. No session means
        # no `Activated` subscription, which looks exactly like hotkeys that
        # have stopped working while their bindings sit correctly in the config.
        token = uuid.uuid4().hex[:8]
        created = ask("CreateSession", GLib.Variant("(a{sv})", ({
            "handle_token": GLib.Variant("s", f"talaria_{token}"),
            "session_handle_token": GLib.Variant("s", f"talaria_{token}"),
        },)))
        if not created or created[0] != 0:
            self._give_up("the desktop's shortcut portal declined to open a session")
            return
        session = created[1].get("session_handle")
        if not session:
            self._give_up("the shortcut portal opened a session but did not name it")
            return

        # **Bound on every session, and that is not the nagging it looks like.**
        #
        # This has been wrong in both directions. First it re-requested anything
        # the portal reported without a trigger, and an unanswered dialog
        # records a shortcut with no key — so each restart asked again and a
        # working binding was lost. The fix was to ask at most once. That made
        # it worse in a way that was harder to see: in this portal a shortcut is
        # attached to a *session*, and `BindShortcuts` is what attaches it. A
        # session that never binds has no routing at all, so the keys sat
        # correctly in `[dev.talaria.shell]`, the app sat listening, and nothing
        # connected the two.
        #
        # Binding every time is what the portal expects. A shortcut this app id
        # has already been granted is re-attached silently; only a genuinely new
        # one raises the dialog. The record of what has been asked is kept, but
        # as a record rather than as a gate — it is what tells the log whether a
        # prompt was expected.
        asked = set(self._asked())
        fresh = [w[0] for w in self._wanted if w[0] not in asked]
        if fresh:
            print(f"talaria: shortcuts — asking the portal for {', '.join(fresh)}",
                  file=sys.stderr, flush=True)
        shortcuts = [
            (action, {
                "description": GLib.Variant("s", friendly),
                "preferred_trigger": GLib.Variant("s", trigger),
            })
            for action, friendly, trigger in self._wanted
        ]
        bound = ask("BindShortcuts", GLib.Variant(
            "(oa(sa{sv})sa{sv})", (session, shortcuts, "", {})
        ))
        if not bound or bound[0] != 0:
            # Response code 1 is somebody closing the dialog, which is a
            # decision rather than a fault and is reported as one.
            self.failures.append(
                "hotkeys were not granted — ask again with:  talaria-shell --rebind"
            )
        else:
            self._remember_asked(asked | {w[0] for w in self._wanted})

        final = ask("ListShortcuts", GLib.Variant("(oa{sv})", (session, {})))
        if final and final[0] == 0:
            for entry in final[1].get("shortcuts", []):
                self.bound[entry[0]] = entry[1].get("trigger_description", "")
        print(
            "talaria: shortcuts listening — "
            + (", ".join(f"{k}={v or 'unbound'}" for k, v in self.bound.items()) or "nothing bound"),
            file=sys.stderr, flush=True,
        )
        self.settled.emit()

        def on_activated(_c, sender, path, _i, _sig, params):
            unpacked = params.unpack()
            # Logged because a hotkey that does nothing has two very different
            # causes — the portal never sent it, or it arrived and the handler
            # dropped it — and from the outside they look identical.
            print(f"talaria: portal Activated {unpacked[1:2]} from {sender} {path}",
                  file=sys.stderr, flush=True)
            if len(unpacked) >= 2:
                self.pressed.emit(unpacked[1])

        # **No path filter, and no sender filter.**
        #
        # Both were set, and a subscription that matches nothing is
        # indistinguishable from a key that was never pressed — which is how
        # this went four rounds. The spec puts `Activated` on the portal's own
        # object, but the portal is one implementation among several and the
        # session object is an equally reasonable place to emit it. Matching on
        # the interface and member alone costs nothing here: this bus carries a
        # handful of signals a second and exactly one interface uses this name.
        bus.signal_subscribe(
            None, SHORTCUTS_IFACE, "Activated", None, None,
            Gio.DBusSignalFlags.NONE, on_activated,
        )

        GLib.MainLoop.new(context, False).run()

    def _give_up(self, message: str) -> None:
        # To stderr as well as to the tray. A balloon is missed, and this is the
        # one subsystem whose failure is completely silent from the outside — a
        # hotkey that does nothing looks identical whether the binding is wrong,
        # the session never opened, or the key was never pressed.
        print(f"talaria: shortcuts — {message}", file=sys.stderr, flush=True)
        self.failures.append(message)
        self.settled.emit()
