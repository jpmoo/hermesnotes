"""
KWin's answers.

This is where the KDE-specific half of the shell moved when Hyprland arrived:
the D-Bus service KWin's script reports into, the script itself, and the blur
protocol. Nothing here is new — it is the code that ran on this desktop for
months, lifted out of `frontmost.py` and `shell.py` so that a second compositor
could be a second file rather than a second copy of the shell.

What KWin does that this file therefore does not have to: place and size the
panels. The script does all of it, so `place` has nothing to say.
"""

from __future__ import annotations

import os
import subprocess

BUS_NAME = "dev.talaria.Shell"
OBJECT_PATH = "/Window"
INTERFACE = "dev.talaria.Window"

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

#: The script KWin runs. One directory up, with the rest of the shell it
#: belongs to — it is KWin's half of "who is in front", and nothing else reads
#: it.
SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "kwin", "talaria-window.js")


def offers_search_entrance() -> bool:
    """KRunner: the entrance you reach by typing on the desktop."""
    return True


def focus_follows_mouse() -> bool:
    """Plasma's default is click-to-focus, and Talaria does not change it."""
    return False


def place(title: str, width: int, height: int, is_desk: bool = False) -> None:
    """
    Nothing: `kwin/talaria-window.js` already owns geometry here.

    Kept as a method that does nothing rather than left off the module, so the
    caller never has to ask which compositor it is talking to.
    """
    return None


def frost(widget) -> bool:
    """Blur, through the `org_kde_kwin_blur` binding in `frosting.py`."""
    import frosting

    return frosting.apply_to(widget)


def run_window_source(arrive, fail) -> None:
    """
    Hold the D-Bus name KWin's script reports into, and block.

    GDBus rather than QtDBus because `python3-pyside6.qtdbus` is not installed
    and the shortcuts portal already keeps a GLib loop on a thread; a second one
    is cheaper than another dependency.
    """
    try:
        import gi

        gi.require_version("Gio", "2.0")
        gi.require_version("GLib", "2.0")
        from gi.repository import Gio, GLib
    except Exception as err:  # noqa: BLE001
        fail(f"no GLib/Gio bindings, so no window source — {err}")
        return

    context = GLib.MainContext.new()
    context.push_thread_default()

    def on_call(_conn, _sender, _path, _iface, method, params, invocation):
        if method != "Changed":
            invocation.return_value(None)
            return
        window_class, resource_name, pid, caption, workspace = params.unpack()
        arrive(window_class, resource_name, pid, caption, workspace)
        invocation.return_value(None)

    try:
        node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
        conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        conn.register_object(OBJECT_PATH, node.interfaces[0], on_call, None, None)
        Gio.bus_own_name_on_connection(
            conn, BUS_NAME, Gio.BusNameOwnerFlags.REPLACE, None, None
        )
    except Exception as err:  # noqa: BLE001
        fail(f"couldn't take {BUS_NAME} — {err}")
        return

    # The script is loaded after the name exists, or its first call lands on
    # nothing and the current window is unknown until the next switch.
    load_script()
    GLib.MainLoop.new(context, False).run()


def load_script() -> None:
    """
    Ask KWin to run the reporter.

    Reloaded on every start rather than installed once: this is a development
    tree, the file changes, and a KWin holding an old copy of it is a confusing
    thing to debug. `unloadScript` first because loading the same path twice
    leaves two of them connected to `windowActivated`, and every window change
    then arrives in duplicate.
    """
    script = generated_script()
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


def generated_script() -> str:
    """
    The KWin script, with the placement written into it.

    A KWin script has no filesystem and cannot read `config.json`, so the value
    is substituted here and the result written beside the runtime state — a
    rendering of the source rather than a second source, which is the same
    arrangement `systemd/talaria.service.in` uses for `ExecStart`.
    """
    from PySide6.QtCore import QStandardPaths

    from . import placement as chosen

    # Clamped rather than trusted. A panel at 0.2 is unreadable and a panel
    # somebody cannot find is a panel they cannot turn back up.
    opacity = min(1.0, max(0.6, 1.0))

    with open(SCRIPT, encoding="utf8") as handle:
        body = (
            handle.read()
            .replace("__PLACEMENT__", chosen())
            .replace("__OPACITY__", f"{opacity:.2f}")
        )
    out = os.path.join(
        QStandardPaths.writableLocation(QStandardPaths.StandardLocation.RuntimeLocation) or "/tmp",
        "talaria-window.js",
    )
    with open(out, "w", encoding="utf8") as handle:
        handle.write(body)
    return out
