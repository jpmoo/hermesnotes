#!/usr/bin/env python3
"""
What each rung of the Glance ladder actually returns, per application.

The brief asks for exactly this before any of the ladder is built: "Prototype
rungs 3 and 4 against the applications actually used before building any of this
rung by rung. A day's script that reports what each rung returns per app. If the
primary selection plus a browser extension covers the real workflow, rung 6
never needs building — and it is the most fragile part and the only one with a
side effect."

So this builds nothing. It reads, reports, and keeps nothing.

    python3 glance_probe.py            # one look at whatever is in front
    python3 glance_probe.py --watch    # every 3s, until interrupted

Select some text in an application, put it in front, and run it. What matters is
not whether a rung works in principle but whether it works in *your* editor,
*your* browser and *your* terminal — which is a question only this machine can
answer.

**Nothing here is stored.** The rungs return text, this prints a redacted
summary of it, and the process exits. That is the same promise Glance itself
makes: it reads the front window, embeds it, and drops it.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import blindlist


def summarize(text: str | None, keep: int = 60) -> str:
    """
    Enough to tell whether a rung worked, and not enough to be a transcript.

    This prints to a terminal that may be scrolled back through, shared in a bug
    report, or sitting in somebody's history — so it says how much came back and
    shows only the head of it.
    """
    if text is None:
        return "—"
    text = text.strip()
    if not text:
        return "(empty)"
    head = " ".join(text.split())[:keep]
    return f"{len(text)} chars: {head}{'…' if len(text) > keep else ''}"


# --------------------------------------------------------------------- window


def active_window() -> dict:
    """
    What is in front, as far as anything here can tell.

    AT-SPI rather than KWin: Plasma 6 on Wayland has no general client API for
    the active window, and the accessibility tree already has to be consulted
    for rung 4. An application that is invisible to AT-SPI is therefore
    invisible here too — which is not a gap in the probe, it is the finding.
    """
    try:
        import gi

        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
    except Exception as err:  # noqa: BLE001
        return {"error": f"no AT-SPI bindings: {err}"}

    try:
        desktop = Atspi.get_desktop(0)
        for i in range(desktop.get_child_count()):
            try:
                app = desktop.get_child_at_index(i)
            except Exception:  # noqa: BLE001
                continue
            for j in range(app.get_child_count()):
                try:
                    frame = app.get_child_at_index(j)
                    states = frame.get_state_set()
                    if not states.contains(Atspi.StateType.ACTIVE):
                        continue
                    pid = None
                    try:
                        pid = app.get_process_id()
                    except Exception:  # noqa: BLE001
                        pass
                    return {
                        "app": app.get_name(),
                        "title": frame.get_name(),
                        "pid": pid,
                        "frame": frame,
                    }
                except Exception:  # noqa: BLE001
                    continue
    except Exception as err:  # noqa: BLE001
        return {"error": f"AT-SPI walk failed: {err}"}
    return {"error": "nothing reports itself as the active window"}


# ----------------------------------------------------------------------- rungs


def rung3_primary() -> tuple[str | None, str]:
    """
    The primary selection — select-to-copy, which X11 and Wayland both keep.

    The brief: "This rung does not exist on macOS and is free here. No
    synthesis, no permissions, no accessibility tree. Try it early; it is often
    the whole answer."
    """
    for cmd in (["wl-paste", "--primary", "--no-newline"], ["xclip", "-o", "-selection", "primary"]):
        try:
            out = subprocess.run(cmd, capture_output=True, timeout=2)
        except FileNotFoundError:
            continue
        except subprocess.TimeoutExpired:
            return None, f"{cmd[0]}: timed out"
        if out.returncode == 0:
            return out.stdout.decode("utf8", "replace"), cmd[0]
        # wl-paste exits non-zero when the selection is simply empty, which is
        # an answer rather than a failure.
        err = out.stderr.decode("utf8", "replace").strip()
        return None, f"{cmd[0]}: {err or 'nothing selected'}"
    return None, "no wl-paste or xclip installed"


def rung4_atspi(frame) -> tuple[str | None, str]:
    """
    Selected text out of the accessibility tree.

    Good for Qt, and for GTK when `toolkit-accessibility` is on. Electron needs
    `--force-renderer-accessibility`. Terminals expose nothing, which the brief
    calls a real regression from macOS — and is the sort of thing this script
    exists to confirm rather than assume.
    """
    if frame is None:
        return None, "no active frame"
    try:
        import gi

        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
    except Exception as err:  # noqa: BLE001
        return None, f"no bindings: {err}"

    seen = 0

    def walk(node, depth=0):
        nonlocal seen
        if depth > 12 or seen > 400:
            return None
        seen += 1
        try:
            if node.get_state_set().contains(Atspi.StateType.FOCUSED):
                try:
                    text = node.query_text()
                    n = text.get_n_selections()
                    if n > 0:
                        start, end = text.get_selection(0)
                        if end > start:
                            return text.get_text(start, end)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            return None
        try:
            for i in range(node.get_child_count()):
                got = walk(node.get_child_at_index(i), depth + 1)
                if got:
                    return got
        except Exception:  # noqa: BLE001
            return None
        return None

    try:
        got = walk(frame)
    except Exception as err:  # noqa: BLE001
        return None, f"walk failed: {err}"
    return (got, f"searched {seen} nodes") if got else (None, f"no selection in {seen} nodes")


# ------------------------------------------------------------------------ run


def look() -> None:
    window = active_window()
    if "error" in window:
        print(f"  window : {window['error']}")
        return

    app, title, pid = window.get("app"), window.get("title"), window.get("pid")
    exe = blindlist.exe_for(pid)
    blind = blindlist.is_blind(app, pid, title)

    print(f"  app    : {app!r}  pid={pid}  exe={os.path.basename(exe) if exe else '—'}")

    # Rung 1, and it answers before anything is read. Printing the title of a
    # blinded window here would break the promise this script is checking.
    if blind:
        print("  BLIND  : on the blindlist — nothing was read, including the title")
        return

    print(f"  title  : {summarize(title)}")
    primary, how3 = rung3_primary()
    print(f"  rung 3 : {summarize(primary):<70} [{how3}]")
    selected, how4 = rung4_atspi(window.get("frame"))
    print(f"  rung 4 : {summarize(selected):<70} [{how4}]")

    best = primary or selected or title
    print(f"  → would ask Glance about: {summarize(best, 40)}")


def main() -> int:
    watch = "--watch" in sys.argv
    print(__doc__.strip().splitlines()[0])
    print("Nothing is stored. Ctrl-C to stop.\n" if watch else "")
    while True:
        print(time.strftime("%H:%M:%S"))
        look()
        if not watch:
            return 0
        print()
        time.sleep(3)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nstopped")
