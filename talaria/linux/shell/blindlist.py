"""
Applications Glance does not look at. Rung 1, and it comes before the rest.

The brief puts this first and says why: **the promise is "we did not look", not
"we discarded it".** A ladder that reads a password manager's window and then
drops the text on the floor has already broken it — the text existed in this
process, and whether it survived is a detail. So nothing below reads anything
until this has answered.

Mirrored from `TITLE_BLIND` in `daemon/src/context.ts`, which is a list of macOS
bundle ids and cannot be reused literally. What carries across is not the
strings but the *products*: the same software must be unreadable on both
machines. `check.py` fails if an entry over there has no answer here, which is
the drift check the brief asks for — a password manager added to the Mac's list
and forgotten here would otherwise be silently readable on Linux.

Two keys, because either alone is defeated too easily. A window class is what
the application says it is, and is absent or generic often enough to matter
(Electron apps that never set one, an Xwayland window with no class at all). The
executable behind the pid is what it actually is, and survives a renamed window,
but is not always reachable — a flatpak's `/proc/<pid>/exe` points into a
sandbox path that names the runtime rather than the app. Either one matching is
enough to refuse.
"""

from __future__ import annotations

import os
import re

#: macOS bundle id -> what the same product is called here.
#:
#: An empty tuple means "that one has no Linux counterpart", which is a claim
#: worth writing down rather than an omission: `com.apple.keychainaccess` and
#: `com.apple.Passwords` are Apple's own and ship nowhere else. Keeping them
#: listed with an empty answer is what lets `check.py` tell a deliberate
#: absence from a forgotten entry.
COUNTERPARTS: dict[str, tuple[str, ...]] = {
    "com.1password.1password": ("1password", "1Password"),
    "com.agilebits.onepassword7": ("1password", "1Password"),
    "com.apple.keychainaccess": (),
    "com.bitwarden.desktop": ("bitwarden", "Bitwarden"),
    "com.lastpass.LastPass": ("lastpass", "LastPass"),
    "com.apple.Passwords": (),
    "org.keepassxc.keepassxc": ("keepassxc", "KeePassXC"),
    # The Mac blinds Console because a log window is somebody else's secrets
    # scrolling past. The same is true of a journal reader.
    "com.apple.Console": ("ksystemlog", "org.kde.ksystemlog"),
}

#: Things with no macOS counterpart in that list but which belong here anyway.
#: A Linux desktop has its own keyring UIs, and they hold exactly what the
#: entries above hold.
LINUX_ONLY: tuple[str, ...] = (
    "kwalletmanager5", "kwalletmanager", "org.kde.kwalletmanager5",
    "seahorse", "org.gnome.seahorse.Application",
    "gcr-prompter", "gnome-keyring", "polkit-kde-authentication-agent-1",
    "org.kde.plasma.polkit", "pinentry", "pinentry-qt", "pinentry-gtk-2",
    "enpass", "Enpass", "keepass2", "keepassx", "proton-pass", "Proton Pass",
    "dashlane", "Dashlane", "nordpass", "NordPass", "org.gnome.World.Secrets",
)


def _names() -> tuple[str, ...]:
    out: list[str] = list(LINUX_ONLY)
    for names in COUNTERPARTS.values():
        out.extend(names)
    return tuple(out)


BLIND = _names()

#: Matched case-insensitively and on word-ish boundaries. Substring alone would
#: blind anything whose title merely mentions a password manager — a note about
#: 1Password is not 1Password, and refusing to read it is a bug in the other
#: direction.
_PATTERNS = tuple(re.compile(rf"(^|[^a-z0-9]){re.escape(n.lower())}([^a-z0-9]|$)") for n in BLIND)


def _hit(value: str | None) -> bool:
    if not value:
        return False
    v = value.lower()
    return any(p.search(v) for p in _PATTERNS)


def exe_for(pid: int | None) -> str | None:
    """The binary behind a pid, as far as this process is allowed to see."""
    if not pid:
        return None
    try:
        return os.readlink(f"/proc/{pid}/exe")
    except OSError:
        # A process owned by somebody else, or gone between asking and looking.
        # Not knowing is not the same as knowing it is safe — see `is_blind`.
        return None


def is_blind(window_class: str | None, pid: int | None = None, title: str | None = None) -> bool:
    """
    Whether this window must not be read.

    **Unknown counts as blind when nothing at all is known.** If the class is
    missing and the executable cannot be read, this refuses rather than reads —
    the cost of being wrong is a Glance saying nothing about one window, against
    a Glance reading a password manager because the compositor declined to name
    it.

    **The title is deliberately not a blinding signal**, and `title` is accepted
    only so callers need not decide that for themselves. It was tried and
    removed: a Firefox window called "Notes about 1Password migration" is a note
    about a password manager, not a password manager, and blinding it is a bug
    in the other direction — the one direction where the failure is invisible,
    because a Glance that quietly declines to help looks exactly like a Glance
    with nothing to say. When the class or the executable is known, that answer
    stands; when neither is, the rule above has already refused.

    A browser showing a web vault is therefore readable by this rung. That is
    the right seam: what a page contains is the browser extension's business
    (rung 5), which can see the page, and not the window manager's.
    """
    if _hit(window_class):
        return True
    exe = exe_for(pid)
    if _hit(exe) or _hit(os.path.basename(exe) if exe else None):
        return True
    return window_class is None and exe is None
