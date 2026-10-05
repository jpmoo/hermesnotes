"""
Sign-in codes from BlueBubbles, onto the clipboard as they arrive.

Switched on in Settings (`blueBubblesCodes` in `config.json`). When a text
comes in that `otp.find_code` says carries a code, the code goes onto the
clipboard and a notification says so — the bar's toast on Noctalia, since it
is the desktop's notification server.

**The server and its password come from the BlueBubbles client**, read from
its own settings each time they are needed rather than copied into ours. The
client already has to know both, a copy would go stale the day the password
changes, and somebody who has BlueBubbles set up has nothing to type here.

**Polled, not pushed.** The server's push channel is Socket.IO, and neither
PySide6 as Ubuntu ships it nor the standard library speaks WebSockets — so it
would be a new dependency for a feature that is a sentence long. Asking every
few seconds for messages newer than the last one seen costs the server one
indexed query, and a code that lands three seconds late is still a code.

**Nothing old is handed over.** The cursor starts at "now", and after a sleep
the first answer can hold an hour of messages: anything older than
`FRESH_SECONDS` is skipped, because a code from before the laptop was closed
has expired, and putting it on the clipboard would overwrite something that
had not.

Message text is never logged or kept. Only the code leaves this module.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

import daemon
import otp

CLIENT_PREFS = os.path.expanduser(
    "~/.var/app/app.bluebubbles.BlueBubbles/data/bluebubbles/shared_preferences.json"
)
POLL_SECONDS = 3
FRESH_SECONDS = 120
ICON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons", "talaria.png")


def enabled() -> bool:
    try:
        with open(os.path.join(os.path.dirname(daemon.socket_path()), "config.json"),
                  encoding="utf8") as handle:
            return bool(json.load(handle).get("blueBubblesCodes"))
    except Exception:  # noqa: BLE001 — unreadable config is "off"
        return False


def server() -> tuple[str, str] | None:
    """The BlueBubbles server's address and password, as its client has them."""
    try:
        with open(CLIENT_PREFS, encoding="utf8") as handle:
            prefs = json.load(handle)
    except Exception:  # noqa: BLE001
        return None
    address, password = prefs.get("serverAddress"), prefs.get("guidAuthKey")
    if not isinstance(address, str) or not address or not isinstance(password, str):
        return None
    return address.rstrip("/"), password


def _since(address: str, password: str, after_ms: int) -> list[dict]:
    query = urllib.parse.urlencode({"guid": password})
    body = json.dumps({"after": after_ms, "sort": "ASC", "limit": 50, "with": ["handle"]}).encode()
    request = urllib.request.Request(f"{address}/api/v1/message/query?{query}", data=body,
                                     headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as reply:
        return json.load(reply).get("data") or []


def _deliver(code: str, sender: str) -> None:
    subprocess.run(["wl-copy", code], timeout=3, check=False)
    who = f" from {sender}" if sender else ""
    subprocess.run(["notify-send", "-a", "Talaria", "-i", ICON, "-t", "6000",
                    "-h", "boolean:transient:true",
                    f"Code copied: {code}", f"Sign-in code{who} is on the clipboard."],
                   timeout=3, check=False)


class Listener:
    """A daemon thread; harmless when switched off or with no server to ask."""

    def __init__(self) -> None:
        self._seen: set[str] = set()

    def start(self) -> None:
        threading.Thread(target=self._run, name="talaria-bluebubbles", daemon=True).start()

    def _run(self) -> None:
        cursor = int(time.time() * 1000)
        failing = False
        while True:
            time.sleep(POLL_SECONDS)
            if not enabled() or (where := server()) is None:
                # Off now means nothing that arrived meanwhile is handed over
                # when it is switched back on.
                cursor = int(time.time() * 1000)
                continue
            try:
                messages = _since(*where, cursor)
            except Exception as err:  # noqa: BLE001 — asleep, offline, server down: try again
                if not failing:
                    print(f"talaria: bluebubbles — {type(err).__name__}", file=sys.stderr, flush=True)
                failing = True
                continue
            if failing:
                print("talaria: bluebubbles — reachable again", file=sys.stderr, flush=True)
                failing = False
            for message in messages:
                created = message.get("dateCreated") or 0
                cursor = max(cursor, created)
                guid = message.get("guid")
                if guid in self._seen or message.get("isFromMe"):
                    continue
                self._seen.add(guid)
                if time.time() * 1000 - created > FRESH_SECONDS * 1000:
                    continue
                if code := otp.find_code(message.get("text")):
                    handle = message.get("handle") or {}
                    _deliver(code, handle.get("address") or "")
            # `after` may include the cursor's own millisecond, so the guids are
            # what stop the last message being read twice — and only the ones at
            # the cursor can come back.
            self._seen = {m.get("guid") for m in messages if (m.get("dateCreated") or 0) >= cursor} | (
                self._seen if not messages else set())
