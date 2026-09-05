"""
Reading the selection out of whatever is in front. The ladder.

macOS climbs seven rungs. This machine was measured before any of it was built,
which the brief insists on — "if the primary selection plus a browser extension
covers the real workflow, rung 6 never needs building, and it is the most
fragile part and the only one with a side effect" — and the measurements said
something clear:

- **Rung 3, the primary selection, is the workhorse.** It returned a real
  selection every time it was asked, with no permission, no prompt and no
  synthesis. It does not exist on macOS at all.
- **Rung 4, AT-SPI, returned nothing, ever.** Four applications on this desktop
  expose an accessibility tree; GTK's `toolkit-accessibility` is off and
  Electron wants `--force-renderer-accessibility`. It is kept because it costs
  nothing when it fails and would start working the day that changes.
- **Rung 6, synthetic copy, is not built.** It is the only rung with a side
  effect — it presses Ctrl+C in somebody else's window and puts their clipboard
  back afterwards — and rung 3 already covers what it was for. Building it
  would be paying the highest price on the ladder for the smallest remaining
  gain. If the measurements change, this is where it goes.
- **Rung 5, a browser extension, is not built either**, and is the one worth
  building next: it is where a browser's *page* selection comes from, which is
  the gap rung 3 leaves when nothing is highlighted.

Rung 1 is not here because it happens earlier — `frontmost.py` applies the
blindlist as the window arrives, so a refused window reaches this file already
stripped of everything but the fact that it was refused.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass

#: How much is worth embedding. The daemon embeds whatever it is given, and a
#: whole document pasted into one vector says less than a paragraph does — every
#: term in it pulls the point toward the middle of the library.
MAX_CHARS = 4000


@dataclass(frozen=True)
class Reading:
    """What was found, and which rung found it."""

    text: str | None
    rung: str
    #: Shown to the user when nothing was found, so "it isn't working" and
    #: "nothing was selected" stop looking the same.
    why: str

    @property
    def usable(self) -> bool:
        return bool(self.text and self.text.strip())


def primary_selection() -> tuple[str | None, str]:
    """
    Rung 3. Select-to-copy, which both X11 and Wayland keep.

    Both tools are tried regardless of session type: XWayland means `xclip`
    often answers inside a Wayland session, and `XDG_SESSION_TYPE` is not
    reliable enough to be the only vote when the fallback costs one failed
    spawn.
    """
    for cmd in (
        ["wl-paste", "--primary", "--no-newline"],
        ["xclip", "-o", "-selection", "primary"],
    ):
        try:
            done = subprocess.run(cmd, capture_output=True, timeout=2)
        except FileNotFoundError:
            continue
        except subprocess.TimeoutExpired:
            return None, f"{cmd[0]} did not answer"
        if done.returncode == 0:
            return done.stdout.decode("utf8", "replace"), cmd[0]
        # A non-zero exit here usually means the selection is empty, which is an
        # answer about the desktop rather than a failure of the tool.
        return None, "nothing is selected"
    return None, "no wl-paste or xclip installed"


def atspi_selection() -> tuple[str | None, str]:
    """
    Rung 4. Selected text from the accessibility tree.

    Bounded on purpose. This walks somebody else's window while they are waiting
    for a panel to open, and an unbounded descent through a large document tree
    is a hang rather than an answer.
    """
    try:
        import gi

        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
    except Exception as err:  # noqa: BLE001
        return None, f"no AT-SPI bindings ({err})"

    seen = 0

    def walk(node, depth=0):
        nonlocal seen
        if depth > 12 or seen > 400:
            return None
        seen += 1
        try:
            if node.get_state_set().contains(Atspi.StateType.FOCUSED):
                text = node.query_text()
                if text.get_n_selections() > 0:
                    start, end = text.get_selection(0)
                    if end > start:
                        return text.get_text(start, end)
        except Exception:  # noqa: BLE001
            pass
        try:
            for i in range(node.get_child_count()):
                got = walk(node.get_child_at_index(i), depth + 1)
                if got:
                    return got
        except Exception:  # noqa: BLE001
            return None
        return None

    try:
        desktop = Atspi.get_desktop(0)
        for i in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(i)
            for j in range(app.get_child_count()):
                frame = app.get_child_at_index(j)
                if frame.get_state_set().contains(Atspi.StateType.ACTIVE):
                    got = walk(frame)
                    if got:
                        return got, "at-spi"
    except Exception as err:  # noqa: BLE001
        return None, f"AT-SPI walk failed ({err})"
    return None, "nothing selected in the accessibility tree"


def read(window) -> Reading:
    """
    Climb until something answers.

    `window` is a `frontmost.Window` or None. The blindlist has already been
    applied to it, and a refused window stops here — before the primary
    selection is read, which matters more than it looks: that selection may well
    be text the user highlighted *inside* the password manager, and reading it
    because it arrives by a different route would break the same promise through
    a side door.
    """
    if window is not None and window.blind:
        return Reading(None, "blindlist", f"{window.name} is on the blindlist — nothing was read")

    text, how = primary_selection()
    if text and text.strip():
        return Reading(text[:MAX_CHARS], "primary selection", how)
    first_why = how

    text, how = atspi_selection()
    if text and text.strip():
        return Reading(text[:MAX_CHARS], "accessibility", how)

    # Rung 7. The weakest thing that is still better than nothing, and the one
    # the daemon would otherwise have had to guess at.
    if window is not None and window.caption:
        return Reading(window.caption[:MAX_CHARS], "window title", f"from {window.name}")

    return Reading(None, "nothing", first_why)
