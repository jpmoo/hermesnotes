#!/usr/bin/env python3
"""
Sample the ladder repeatedly, so the window under test can be the focused one.

The earlier probe was run from a terminal, which meant the terminal was in
front — and a browser that is minimized or merely unfocused does not maintain
its web-content accessibility tree. A measurement taken that way says nothing
about what the rung would return in use.

Run it, then switch to the window you want to test and select some text. It
reports each distinct reading, and nothing is stored.

    python3 glance_watch.py [seconds]
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import glance
import glance_probe


def main() -> int:
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    print(f"Watching for {seconds}s. Switch to the window, select some text, and leave it\n"
          f"selected — every sample is printed, so a rung that keeps returning nothing\n"
          f"while text is plainly selected is itself the result.\n", flush=True)
    end = time.time() + seconds
    while time.time() < end:
        window = glance_probe.active_window()
        if "error" in window:
            line = f"front: {window['error']}"
        else:
            atspi, why4 = glance.atspi_selection()
            primary, why3 = glance.primary_selection()
            line = (
                f"front={window.get('app')!r} active-frame={window.get('title','')[:40]!r}\n"
                f"    rung 4: {glance_probe.summarize(atspi)}   [{why4}]\n"
                f"    rung 3: {glance_probe.summarize(primary)}   [{why3}]"
            )
        # Every sample, never deduplicated. An earlier version printed only on
        # change, which made "you selected something and the rung still returned
        # nothing" indistinguishable from "you had not selected yet" — the one
        # distinction the whole exercise is about.
        print(f"{time.strftime('%H:%M:%S')}  {line}", flush=True)
        time.sleep(2)
    print("\ndone")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nstopped")
