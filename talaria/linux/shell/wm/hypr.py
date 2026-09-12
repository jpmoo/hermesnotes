"""
Hyprland's answers.

Everything here goes through Hyprland's own IPC: two Unix sockets in the
runtime directory, named after the instance signature. `.socket.sock` takes
commands and answers them; `.socket2.sock` streams events. That is the whole
dependency — no `hyprctl`, no subprocess per focus change, and nothing that has
to be installed beside Talaria.

**The same shape as KDE, by different means.** KWin is told what to do by a
script it runs; Hyprland is told by window rules set at runtime. KWin pushes the
focused window over D-Bus; Hyprland announces it on the event socket and is then
asked for the details. Both arrive at `frontmost.py` as the same five fields.

**Two Hyprland facts worth knowing before changing anything here.** Window rules
are matched against a window as it opens, so they must be set before a panel is
shown — which is why `place` is called from the panel's constructor rather than
at startup. And the rule keyword was renamed between releases (`windowrulev2`
became `windowrule`), so every rule is sent under the newer name and retried
under the older one rather than the version being detected: detection would be
one more thing to get wrong on a compositor that moves this fast.

This is written from the protocol rather than from a running machine — there is
no Hyprland session in this project's reach — so the failure of anything here is
deliberately quiet and reported through `talaria doctor` instead of stopping the
shell.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
from typing import Any, Callable

#: What the portal and the desktop file call us. A Hyprland `bind` line naming
#: a global shortcut has to spell this exactly.
APP_ID = "dev.talaria.shell"

#: Breathing room between a panel and the edge it sits against. The same twelve
#: pixels `kwin/talaria-window.js` uses, so the two desktops look alike.
MARGIN = 12

_blur: bool | None = None
_follow: bool | None = None


# ----------------------------------------------------------------------- IPC


def _signature() -> str | None:
    return os.environ.get("HYPRLAND_INSTANCE_SIGNATURE") or None


def _socket_path(which: str) -> str | None:
    """
    Where Hyprland's sockets are, this release or the last one.

    They moved into `$XDG_RUNTIME_DIR/hypr/` and were in `/tmp/hypr/` before
    that. Both are checked because a distribution can be a release behind, and
    the cost of looking in two places once is nothing.
    """
    signature = _signature()
    if not signature:
        return None
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    candidates = []
    if runtime:
        candidates.append(os.path.join(runtime, "hypr", signature, which))
    candidates.append(os.path.join("/tmp", "hypr", signature, which))
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def request(command: str, timeout: float = 3.0) -> str:
    """
    One command to the compositor, and its answer as text.

    Raises on anything that goes wrong, because every caller here wants to
    treat a compositor that will not answer as a compositor that cannot do the
    thing — and they say so in their own words rather than in this one's.
    """
    path = _socket_path(".socket.sock")
    if not path:
        raise OSError("no Hyprland command socket")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(path)
        sock.sendall(command.encode("utf8"))
        chunks = []
        while True:
            chunk = sock.recv(8192)
            if not chunk:
                break
            chunks.append(chunk)
    return b"".join(chunks).decode("utf8", "replace")


def ask(command: str) -> Any:
    """A `j/` query, parsed. None when the answer was not JSON."""
    try:
        return json.loads(request(f"j/{command}"))
    except Exception:  # noqa: BLE001
        return None


# -------------------------------------------------------------- what it offers


def offers_search_entrance() -> bool:
    """
    No.

    Hyprland has no search box of its own: the launcher is a separate program
    the distribution chooses — walker on Omarchy, its own shell's launcher on
    Ryoku — and each has its own idea of a plugin. Talaria's own hotkeys reach
    everything KRunner reached, so nothing is lost that is worth a guess here.
    """
    return False


def focus_follows_mouse() -> bool:
    """
    Whether the keyboard follows the pointer, asked of the running config.

    This matters more here than anywhere else Talaria runs. A summoned panel
    dismisses itself when it loses focus, and Hyprland's default is
    `follow_mouse = 1` — so a hand brushing the mouse while typing into New
    Block moves the focus to whatever is under the pointer and the panel closes
    mid-sentence. The shell uses this answer to keep a panel the pointer is
    still over. Asked once: it is a setting, and a person who changes it can
    restart the shell.
    """
    global _follow
    if _follow is None:
        answer = ask("getoption input:follow_mouse")
        value = (answer or {}).get("int", 1) if isinstance(answer, dict) else 1
        _follow = bool(value)
    return _follow


def frost(widget) -> bool:
    """
    Blur is the compositor's own setting here, and there is nothing to ask for.

    KWin blurs behind a surface that requests it through `org_kde_kwin_blur`,
    which is why KDE needs a C++ binding. Hyprland has no such protocol and
    needs none: it blurs behind any window that is translucent, when blur is on
    in its config. Talaria's panels are already translucent — the page paints
    its own sheet at `--surface-alpha` — so on a desktop with blur enabled they
    are frosted without asking, and on one with it switched off they are plain
    and that is the user's decision rather than a failure.

    So this reports what is true rather than doing anything. The widget is taken
    and ignored, to keep one signature across backends.
    """
    global _blur
    if _blur is None:
        answer = ask("getoption decoration:blur:enabled")
        _blur = bool((answer or {}).get("int", 0)) if isinstance(answer, dict) else False
        print(
            "talaria: frosting " + ("on — the compositor blurs behind the panels"
                                    if _blur else "off — blur is disabled in this Hyprland config"),
            file=sys.stderr, flush=True,
        )
    return _blur


# ------------------------------------------------------------------- placement


def _monitor() -> dict | None:
    """The focused monitor, or the first one. None if it cannot be asked."""
    monitors = ask("monitors")
    if not isinstance(monitors, list) or not monitors:
        return None
    for monitor in monitors:
        if isinstance(monitor, dict) and monitor.get("focused"):
            return monitor
    first = monitors[0]
    return first if isinstance(first, dict) else None


def _area(monitor: dict) -> tuple[int, int, int, int]:
    """
    The usable box of a monitor, in the coordinates a window rule speaks.

    Scale matters: Hyprland reports a monitor's size in physical pixels and its
    scale beside it, while a window's size and position are logical. On a 2x
    display, skipping the division puts every panel off the bottom of the
    screen.

    `reserved` is what the bar and any other layer surface has taken — waybar on
    Omarchy, the Quickshell bar on Ryoku. Subtracting it is what keeps a panel
    from opening underneath the bar.
    """
    scale = float(monitor.get("scale") or 1.0) or 1.0
    width = int(float(monitor.get("width") or 0) / scale)
    height = int(float(monitor.get("height") or 0) / scale)
    reserved = monitor.get("reserved") or [0, 0, 0, 0]
    try:
        left, top, right, bottom = (int(v) for v in reserved[:4])
    except Exception:  # noqa: BLE001
        left = top = right = bottom = 0
    x = int(monitor.get("x") or 0) + left
    y = int(monitor.get("y") or 0) + top
    return x, y, max(1, width - left - right), max(1, height - top - bottom)


def _spot(placement: str, area: tuple[int, int, int, int], width: int, height: int) -> tuple[int, int]:
    """Where a panel of this size rests, for one of the nine placements."""
    ax, ay, aw, ah = area
    vertical, _, horizontal = placement.partition("-")
    if horizontal == "left":
        x = ax + MARGIN
    elif horizontal == "right":
        x = ax + aw - width - MARGIN
    else:
        x = ax + (aw - width) // 2
    if vertical == "top":
        y = ay + MARGIN
    elif vertical == "middle":
        y = ay + (ah - height) // 2
    else:
        y = ay + ah - height - MARGIN
    return max(ax, x), max(ay, y)


def _keyword(rule: str) -> bool:
    """
    Set one window rule, under whichever name this Hyprland knows.

    `windowrulev2` was the name for years and became `windowrule` when the
    original `windowrule` was removed. Asking the version would mean parsing it
    and keeping a table of which release changed what; trying the newer name and
    falling back costs one extra socket round trip on older releases and needs
    no table at all.
    """
    for keyword in ("windowrulev2", "windowrule"):
        try:
            answer = request(f"keyword {keyword} {rule}").strip().lower()
        except Exception:  # noqa: BLE001
            return False
        if answer.startswith("ok"):
            return True
    return False


def _lua_rule(title: str, fields: str) -> bool:
    """
    The same rule, for a Hyprland whose config is Lua.

    A Lua-configured Hyprland (Omarchy's `hyprland.lua`) answers every
    `keyword` with "keyword can't work with non-legacy parsers. Use eval." —
    so none of the rules below ever landed, and every panel opened tiled.
    `eval` takes the same `hl.window_rule` table the config itself uses, and
    names an unknown field rather than ignoring it, so "ok" means it held.

    Tried first: on a hyprlang config `eval` is not a command, the answer is
    not "ok", and `place` falls through to the keywords as before.

    Border and rounding go with every rule for the reason `place` gives.
    """
    lua = (
        f"hl.window_rule({{ match = {{ title = [==[^({_escape(title)})$]==] }}, "
        f"float = true, {fields}, border_size = 0, rounding = 0 }})"
    )
    try:
        return request(f"eval {lua}").strip().lower().startswith("ok")
    except Exception:  # noqa: BLE001
        return False


def place(title: str, width: int, height: int, is_desk: bool = False) -> None:
    """
    Write the rules that catch this panel when it opens.

    Matched on the window title, which is the only thing telling one panel from
    another: they share a class, exactly as they do on KDE, and the KWin script
    keys on the caption for the same reason.

    The desk is the exception in the same way it is there. It is a full-screen
    surface the other panels are summoned over, so it fills the usable area,
    takes no margin, and does not animate — a desk that slid in from the bottom
    edge every time would be pantomime.
    """
    if not _signature():
        return
    monitor = _monitor()
    if monitor is None:
        return
    area = _area(monitor)
    match = f"title:^({_escape(title)})$"

    if is_desk:
        ax, ay, aw, ah = area
        if _lua_rule(title, f"size = {{ {aw}, {ah} }}, move = {{ {ax}, {ay} }}, no_anim = true"):
            return
        rules = [
            f"float, {match}",
            f"size {aw} {ah}, {match}",
            f"move {ax} {ay}, {match}",
            f"noanim, {match}",
        ]
    else:
        width = min(width, area[2] - 2 * MARGIN)
        height = min(height, area[3] - 2 * MARGIN)
        x, y = _spot(_placement(), area, width, height)
        if _lua_rule(title, f"size = {{ {width}, {height} }}, move = {{ {x}, {y} }}, animation = \"slide\""):
            return
        rules = [
            f"float, {match}",
            f"size {width} {height}, {match}",
            f"move {x} {y}, {match}",
            # It arrives from an edge rather than appearing in the middle of
            # the screen — the same reason `kwin/talaria-window.js` animates.
            # Hyprland owns the animation, so this asks for the style and lets
            # the user's own curve and speed apply.
            f"animation slide, {match}",
        ]
    # No border and no rounding from the compositor: the page draws its own
    # rounded, translucent sheet, and a second radius around it shows as a
    # hairline of desktop between the two.
    rules += [f"noborder, {match}", f"rounding 0, {match}"]
    for rule in rules:
        _keyword(rule)


def _escape(title: str) -> str:
    """A title as a regex that matches only itself."""
    out = []
    for char in title:
        if char in r"\^$.|?*+()[]{}":
            out.append("\\" + char)
        else:
            out.append(char)
    return "".join(out)


def _placement() -> str:
    """Where panels rest, from the same `config.json` key the Mac writes."""
    from . import placement

    return placement()


# ----------------------------------------------------------------- the windows


def run_window_source(arrive, fail) -> None:
    """
    Follow the focus on the event socket, and block.

    The events say *that* the focused window changed; the details come from
    asking `activewindow`, which answers class, title, pid and workspace in one
    reply. That is one short socket round trip per focus change — no process is
    spawned, which is not merely tidy: the KDE path learned the hard way that
    spawning anything from a focus callback makes a new Wayland client, which is
    itself a focus change.

    The first answer is read before any event arrives, because a shell that has
    just started should know what is in front without waiting for somebody to
    switch windows.
    """
    path = _socket_path(".socket2.sock")
    if not path:
        fail("no Hyprland event socket — is this a Hyprland session?")
        return

    _report(arrive)

    # Events worth asking again after. A window closing or a workspace changing
    # moves the focus without necessarily announcing a new active window.
    WATCHED = (
        "activewindow>>", "activewindowv2>>", "workspace>>", "workspacev2>>",
        "focusedmon>>", "closewindow>>", "movewindow>>",
    )

    attempts = 0
    while True:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.connect(path)
                attempts = 0
                rest = b""
                while True:
                    chunk = sock.recv(4096)
                    if not chunk:
                        break
                    rest += chunk
                    while b"\n" in rest:
                        line, rest = rest.split(b"\n", 1)
                        text = line.decode("utf8", "replace")
                        if text.startswith(WATCHED):
                            _report(arrive)
        except Exception as err:  # noqa: BLE001
            attempts += 1
            if attempts == 1:
                print(f"talaria: hyprland event socket dropped ({err}) — reconnecting",
                      file=sys.stderr, flush=True)
            if attempts >= 10:
                fail(f"lost the Hyprland event socket — {err}")
                return
        # A compositor restart takes the socket with it and is the ordinary
        # reason to be here. Waiting is cheaper than a tight loop against a
        # socket that does not exist yet.
        time.sleep(min(5.0, 0.5 * attempts))


def _report(arrive: Callable[..., None]) -> None:
    """Ask who is in front, and hand the five fields on."""
    window = ask("activewindow")
    if not isinstance(window, dict) or not window:
        # Focus on nothing — an empty workspace, or a layer surface. Said
        # rather than swallowed, because "nothing is in front" is an answer.
        arrive("", "", 0, "", _workspace_name(None))
        return
    workspace = window.get("workspace")
    arrive(
        str(window.get("initialClass") or window.get("class") or ""),
        str(window.get("class") or ""),
        int(window.get("pid") or 0),
        str(window.get("title") or ""),
        _workspace_name(workspace),
    )


def _workspace_name(workspace: Any) -> str:
    """
    A workspace's name, for the daemon's context record.

    Hyprland names workspaces and numbers them; the name is what a person would
    recognize, so it is preferred and the id stands in when there is none. When
    no window is focused the current workspace is asked for separately, since
    the question the record asks is "where were you", not "what window".
    """
    if isinstance(workspace, dict):
        return str(workspace.get("name") or workspace.get("id") or "")
    current = ask("activeworkspace")
    if isinstance(current, dict):
        return str(current.get("name") or current.get("id") or "")
    return ""


# ------------------------------------------------------------- hotkey bindings


#: How a hotkey spelled in `config.json` maps onto Hyprland's modifier names.
_MODS = {
    "meta": "SUPER", "cmd": "SUPER", "super": "SUPER", "win": "SUPER",
    "ctrl": "CTRL", "control": "CTRL",
    "alt": "ALT", "opt": "ALT", "option": "ALT",
    "shift": "SHIFT",
}
_ORDER = ["SUPER", "CTRL", "ALT", "SHIFT"]

#: How the shell is started with the session. Through systemd-run rather than
#: directly: the portal names a non-sandboxed app after the process that
#: launched it, so a shell started as a child of the compositor files itself
#: under the compositor. This was diagnosed three times on KDE.
SYSTEMD_RUN = "systemd-run --user --scope --unit=app-dev.talaria.shell -- "


def _keys(spec: str) -> tuple[list[str], str] | None:
    """`"meta+shift+g"` to `(["SUPER", "SHIFT"], "G")`, or None if it makes no sense."""
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
    return [m for m in _ORDER if m in mods], key.upper()


def snippet(style: str, hotkeys: list[tuple[str, str, str]], shell_bin: str) -> str:
    """
    Talaria's hotkeys and its autostart, as a file a Hyprland config can load.

    `hotkeys` is `(action, name, spec)` per panel. `style` is `"lua"` or
    `"conf"`, because Hyprland now has two config languages and the
    distributions have split between them — Omarchy moved to Lua, and a Lua
    config cannot `source` a hyprlang file.

    **Each key runs `talaria-shell --toggle <panel>`, not a portal shortcut.**
    Both desktops register their shortcuts through the GlobalShortcuts portal,
    and on KDE that is the whole story. On Hyprland the portal registers them
    and leaves the key to the compositor's config — the first run on Omarchy
    found them registered and permanently `unbound`. `--toggle` reaches the
    running shell over its own local socket, involves no portal at all, and is
    what that run actually saw working.

    **The Lua form removes a default before binding.** Omarchy ships Super+Shift
    +C, A, N and G bound to its own apps, and `hl.bind` on a key that is already
    bound adds a second action rather than replacing the first — so one press
    would open both. `pcall` because unbinding a key nobody bound is not
    something to stop a config over, whatever this release thinks of it.
    """
    import json
    import shlex

    command = shlex.quote(shell_bin)
    if style == "lua":
        out = [
            "-- Talaria's hotkeys, and the shell starting with the session.",
            "-- Written by talaria/linux/install.sh; it is safe to re-run, and it will",
            "-- overwrite this file. Load it from the end of hyprland.lua, after the",
            "-- distribution's own defaults, so the unbinds below can see them:",
            '--   dofile(os.getenv("HOME") .. "/.config/hypr/talaria.lua")',
            "",
            f"local shell = {json.dumps(command, ensure_ascii=False)}",
            "",
            "local function panel(keys, name, action)",
            "  pcall(hl.unbind, keys)",
            '  hl.bind(keys, hl.dsp.exec_cmd(shell .. " --toggle " .. action),',
            '    { description = "Talaria: " .. name })',
            "end",
            "",
        ]
        for action, name, spec in hotkeys:
            parsed = _keys(spec)
            if parsed is None:
                out.append(f"-- {action}: could not make sense of the hotkey {spec!r}")
                continue
            mods, key = parsed
            keys = " + ".join(mods + [key])
            out.append(
                f"panel({json.dumps(keys)}, {json.dumps(name, ensure_ascii=False)}, "
                f"{json.dumps(action)})"
            )
        out += [
            "",
            'hl.on("hyprland.start", function()',
            f"  hl.exec_cmd({json.dumps(SYSTEMD_RUN, ensure_ascii=False)} .. shell)",
            "end)",
        ]
        return "\n".join(out) + "\n"

    out = [
        "# Talaria's hotkeys, and the shell starting with the session.",
        "# Written by talaria/linux/install.sh; it is safe to re-run, and it will",
        "# overwrite this file. Load it from the end of hyprland.conf with:",
        "#   source = ~/.config/hypr/talaria.conf",
        "",
    ]
    for action, name, spec in hotkeys:
        parsed = _keys(spec)
        if parsed is None:
            out.append(f"# {action}: could not make sense of the hotkey {spec!r}")
            continue
        mods, key = parsed
        out.append(f"unbind = {' '.join(mods)}, {key}")
        out.append(f"bind = {' '.join(mods)}, {key}, exec, {command} --toggle {action}")
    out += ["", f"exec-once = {SYSTEMD_RUN}{command}"]
    return "\n".join(out) + "\n"


def send_chord(key: str) -> tuple[bool, str]:
    """
    Press ctrl+<key> in the focused window, through the compositor itself.

    Glance's last rung copies the selection out of an application that will not
    say what it holds. On KDE that needs the RemoteDesktop portal, a permission
    dialog and a held session; Hyprland has a dispatcher for exactly this, so
    the same rung costs one socket write and asks nobody for anything.

    `sendshortcut` sends the chord to a named window rather than to the seat, so
    it does not matter which keys a person is physically holding — which is the
    failure the portal path had to work around with a wait and a list of
    modifiers to release.
    """
    try:
        answer = request(f"dispatch sendshortcut CTRL,{key},activewindow").strip().lower()
        # A Lua-configured Hyprland reads `dispatch` as Lua and rejects the
        # hyprlang argument list outright, the same way it rejects `keyword`.
        # The dispatcher is the same one under its Lua name, built from a table.
        if not answer.startswith("ok"):
            lua = (f'hl.dispatch(hl.dsp.send_shortcut({{ mods = "CTRL", '
                   f'key = "{key.lower()}", window = "activewindow" }}))')
            answer = request(f"eval {lua}").strip().lower()
    except Exception as err:  # noqa: BLE001
        return False, f"the compositor would not send the key press ({err})"
    if answer.startswith("ok"):
        return True, f"ctrl+{key.lower()}"
    return False, answer or "the compositor refused the key press"
