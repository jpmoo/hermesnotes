"""
Noctalia's colors and translucency, for Talaria's floating panels.

Noctalia renders `talaria/linux/noctalia/talaria.css` with its palette into
`noctalia.css` beside `config.json` — see that file for the why. This module
says where that is, what it holds, and how translucent Noctalia's bar is, and
answers None to all of it on a desktop without Noctalia, where the panels keep
the system's colors and the solidity chosen in Settings.

The desk is not themed: it is a surface of its own rather than a summoned
panel, and was asked to keep its look.
"""

from __future__ import annotations

import os


def _data_dir() -> str:
    home = (os.environ.get("XDG_DATA_HOME") or "").strip() or os.path.join(
        os.path.expanduser("~"), ".local", "share"
    )
    return os.path.join(home, "talaria")


def css_path() -> str:
    """Where Noctalia writes the rendered theme."""
    return os.path.join(_data_dir(), "noctalia.css")


def css() -> str | None:
    """The rendered theme, or None when Noctalia has not written one."""
    try:
        with open(css_path(), encoding="utf8") as handle:
            text = handle.read()
    except OSError:
        return None
    # A template that has not been rendered still has its `{{ }}` in it — a
    # file copied by hand, or a render that failed half way. Laid over the
    # panels it would set every color to nothing.
    return text if text.strip() and "{{" not in text else None


def _noctalia_settings() -> dict:
    state = (os.environ.get("NOCTALIA_STATE_HOME") or "").strip() or os.path.join(
        (os.environ.get("XDG_STATE_HOME") or "").strip()
        or os.path.join(os.path.expanduser("~"), ".local", "state"),
        "noctalia",
    )
    try:
        import tomllib

        with open(os.path.join(state, "settings.toml"), "rb") as handle:
            return tomllib.load(handle)
    except Exception:  # noqa: BLE001 — no Noctalia, or a file mid-write
        return {}


def bar_opacity() -> float | None:
    """
    How opaque Noctalia's bar is — `[bar.<name>].background_opacity`.

    The panels' own solidity, when themed: a panel as translucent as the bar
    sits beside it as one thing. The first bar that says, `default` first.
    Clamped to the same floor Settings uses, below which text over a busy
    desktop stops being readable however much it is blurred.
    """
    bars = _noctalia_settings().get("bar")
    if not isinstance(bars, dict):
        return None
    names = sorted(bars, key=lambda n: n != "default")
    for name in names:
        value = bars[name].get("background_opacity") if isinstance(bars[name], dict) else None
        if isinstance(value, (int, float)):
            return max(0.35, min(1.0, float(value)))
    return None


def colors() -> dict[str, str]:
    """
    The rendered theme's base colors by variable name — `canvas`,
    `canvas-text`, `accent-color` — for the parts of a panel that are Qt rather
    than page and so cannot read CSS variables: its tooltips. Empty without
    Noctalia.
    """
    import re

    sheet = css() or ""
    return {m.group(1): m.group(2) for m in re.finditer(r"--([a-z-]+):\s*(#[0-9a-fA-F]{3,8})\s*;", sheet)}
