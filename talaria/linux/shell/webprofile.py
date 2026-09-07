"""
The one web profile, in a module both the shell and the exporter can import.

**It lives here because of how the shell is started.** `talaria-shell` runs
`python3 shell.py`, so that file is `__main__` — and `import shell` from another
module does not find it in `sys.modules`. It re-executes the file as a *second*
module with its own globals, which means a second `PROFILE = None` and a second
`QWebEngineProfile` built on the same storage directory. The scheme handler is
installed on the first one, so the second knows no schemes: the export view
asked it for a `talaria-app://` URL, the load failed, and the shell hung on the
duplicate profile. That was a fix for the same bug making it worse.

A module neither of them owns is imported once, by name, from both.
"""

from __future__ import annotations

import os

#: Held for the life of the process. A profile collected while a page still
#: points at it takes the page with it.
PROFILE = None


def get(app):
    """
    A profile that remembers being logged in.

    `QWebEngineProfile.defaultProfile()` is **off the record**: no cookie jar on
    disk, no cache, nothing kept past the process. So the Hermes window asked for
    a password on every start — not because anything logged you out, but because
    nothing had ever written the session down.

    A named profile is persistent by default, and `ForcePersistentCookies` keeps
    even a session cookie across a restart. That last part is the one that
    matters: a login that lasts until the window closes is exactly the behavior
    being complained about, and it is what an ordinary persistent jar would still
    give you.

    Under the same directory as everything else Talaria keeps, so "where is my
    state" has one answer, and so removing it is removing a folder.
    """
    global PROFILE
    from PySide6.QtWebEngineCore import QWebEngineProfile

    if PROFILE is not None:
        return PROFILE
    home = os.path.join(
        (os.environ.get("XDG_DATA_HOME") or "").strip()
        or os.path.join(os.path.expanduser("~"), ".local", "share"),
        "talaria",
    )
    PROFILE = QWebEngineProfile("talaria", app)
    PROFILE.setPersistentStoragePath(os.path.join(home, "web"))
    PROFILE.setCachePath(os.path.join(home, "web-cache"))
    PROFILE.setPersistentCookiesPolicy(
        QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies
    )
    return PROFILE
