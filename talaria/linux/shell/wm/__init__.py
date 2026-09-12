"""
Which compositor this is, and the handful of things Talaria needs from one.

Almost nothing in this shell cares. The panels, the tray, the scheme handler,
the canvas, the settings window and six of Glance's seven rungs are Qt and
Wayland and would run under anything. What *is* compositor-specific is small
enough to list: who is in front, where a panel is allowed to sit, whether the
desktop will blur behind it, whether moving the mouse moves the focus, and
whether the desktop has a search box we can answer into.

So that list is this package's whole interface, KDE's answers live in `kde.py`,
Hyprland's in `hypr.py`, and the session is probed once at startup. **Neither
backend is a port of the other and neither is a fork of this shell** — adding a
third compositor means a third file here, not a second copy of everything else.

Everything below returns a harmless answer when there is no backend at all, or
when the backend cannot do that particular thing. A desktop Talaria has never
met should be a desktop where the panels are plain and the hotkeys still work,
not one where the shell refuses to start.
"""

from __future__ import annotations

import os
from typing import Any, Callable

#: Set once, by `session()`. A session does not change under a running process.
_backend: Any = None
_looked = False


def session() -> str:
    """
    `"hyprland"`, `"kwin"`, or `"unknown"`.

    Hyprland is asked about first and by its own signature rather than by
    `XDG_CURRENT_DESKTOP`: the signature is what the compositor itself sets and
    what its IPC socket is named after, so a session that has it is one we can
    actually talk to. `XDG_CURRENT_DESKTOP` is set by whatever launched the
    session and on the Hyprland distributions is sometimes the distribution's
    own name — Omarchy and Ryoku are both Hyprland underneath, and neither is
    worth a special case here.
    """
    if os.environ.get("HYPRLAND_INSTANCE_SIGNATURE"):
        return "hyprland"
    desktop = (os.environ.get("XDG_CURRENT_DESKTOP") or "").lower()
    if "hyprland" in desktop:
        return "hyprland"
    if os.environ.get("KDE_FULL_SESSION") or "kde" in desktop or "plasma" in desktop:
        return "kwin"
    return "unknown"


def backend() -> Any:
    """The module for this session, or None. Imported lazily and once."""
    global _backend, _looked
    if _looked:
        return _backend
    _looked = True
    name = session()
    try:
        if name == "hyprland":
            from . import hypr as module
        elif name == "kwin":
            from . import kde as module
        else:
            module = None  # type: ignore[assignment]
    except Exception:  # noqa: BLE001 — a missing backend is a plain desktop
        module = None  # type: ignore[assignment]
    _backend = module
    return module


def _ask(what: str, fallback: Any, *args: Any, **kw: Any) -> Any:
    """Call `what` on the backend, or answer `fallback`."""
    module = backend()
    call: Callable[..., Any] | None = getattr(module, what, None)
    if call is None:
        return fallback
    try:
        return call(*args, **kw)
    except Exception:  # noqa: BLE001
        return fallback


def run_window_source(arrive, fail) -> None:
    """
    Push focus changes into `arrive` until the process ends.

    Blocking: the caller owns the thread. `arrive` takes the same five fields
    on every compositor — window class, resource name, pid, caption, workspace
    — because the blindlist keys on the first three and must be applied before
    anything looks at the fourth, and a backend that pre-joined them would have
    made that impossible.
    """
    module = backend()
    call = getattr(module, "run_window_source", None)
    if call is None:
        fail(f"no window source for this session ({session()})")
        return
    call(arrive, fail)


def place(title: str, width: int, height: int, is_desk: bool = False) -> None:
    """
    Say where this panel goes, before it is shown.

    A Wayland client cannot place or size itself — the compositor owns geometry
    — so this is the one call that has to happen for a panel to come up the
    right size in the right corner. On KDE the KWin script has already been
    told; on Hyprland this writes window rules.
    """
    _ask("place", None, title, width, height, is_desk)


def frost(widget) -> bool:
    """Blur behind this window, if the compositor does that. False if not."""
    return bool(_ask("frost", False, widget))


def focus_follows_mouse() -> bool:
    """
    Whether the keyboard follows the pointer on this desktop.

    Asked because a summoned panel dismisses itself when it loses focus, and on
    a desktop where merely moving the mouse moves the focus that rule closes
    panels nobody looked away from. KDE answers false; Hyprland asks its own
    config, since this is a setting rather than a property of the compositor.
    """
    return bool(_ask("focus_follows_mouse", False))


def offers_search_entrance() -> bool:
    """Whether this desktop has a search box Talaria can answer into (KRunner)."""
    return bool(_ask("offers_search_entrance", False))


#: The nine spots a summoned panel can rest in. Named on both desktops and in
#: the Mac's settings panel, so the word in `config.json` means one thing
#: everywhere.
PLACEMENTS = (
    "top-left", "top-center", "top-right",
    "middle-left", "middle-center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right",
)


def config() -> dict:
    """
    `config.json`, which sits beside the daemon's socket.

    The same file the Mac's settings panel writes, read here for the same
    reason `config_hotkey` reads it: somebody who chose where Glance appears on
    one machine should not have to choose again by another name on the other.
    """
    import json

    try:
        import daemon

        path = os.path.join(os.path.dirname(daemon.socket_path()), "config.json")
    except Exception:  # noqa: BLE001 — the shell can run with no daemon yet
        home = (os.environ.get("XDG_DATA_HOME") or "").strip() or os.path.join(
            os.path.expanduser("~"), ".local", "share"
        )
        path = os.path.join(home, "talaria", "config.json")
    try:
        with open(path, encoding="utf8") as handle:
            loaded = json.load(handle)
    except Exception:  # noqa: BLE001
        return {}
    return loaded if isinstance(loaded, dict) else {}


def placement() -> str:
    """Where panels rest. `bottom-center` when nothing says otherwise."""
    asked = config().get("glancePlacement")
    return asked if asked in PLACEMENTS else "bottom-center"
