"""
Asking a model server what it has.

A port of `Probe` in `app/Sources/Settings.swift`, and the filtering rules come
across exactly because each of them is a judgement rather than a detail:

- **Filtered by capability, not by name.** A server says which of its models
  embed and which call tools, so the chat list and the Glance list are two
  filters over one answer. Guessing from a model's name would be the same
  mistake as `if (type.name === "Task")` in a different room.
- **Degrades to the whole list, never to an empty one.** An older server
  declares no capabilities at all. Showing everything is a worse list than
  showing the right one and a far better one than showing an empty box under a
  server that plainly answered.
- **A chat server with nothing tool-capable is a warning, not a failure.** It
  will chat and draw nothing, which is worth saying in those words.

`urllib` rather than the daemon: this is an arbitrary address the user is
typing, it has nothing to do with the mirror, and asking the daemon to fetch it
would make the daemon a proxy for whatever somebody puts in that box.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass

EMBEDDING = "embedding"
CHAT = "chat"


@dataclass(frozen=True)
class Model:
    name: str
    #: From `details.embedding_length`. Worth showing: a vector's meaning depends
    #: on the model that made it, and the width is the visible part of that.
    dimensions: int | None
    embeds: bool
    calls_tools: bool


def is_local(url: str) -> bool:
    """
    Is this address on this machine?

    Mirrors `isLocal` in `glance.ts`, including its refusal to match by prefix —
    `http://localhost.evil.example/` is not localhost, and treating it as one
    would send the front window's text off the machine under a reassuring
    message.
    """
    return bool(re.match(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:|/|$)", url))


def models(url: str, kind: str = EMBEDDING) -> tuple[list[Model], tuple[str, str]]:
    """Returns (models, (level, sentence)) where level is ok / warn / bad."""
    base = url.rstrip("/")
    if not base:
        return [], ("bad", "No address to ask.")
    try:
        with urllib.request.urlopen(f"{base}/api/tags", timeout=5) as response:
            status = response.status
            body = response.read()
    except urllib.error.HTTPError as err:
        return [], ("bad", f"The address answered {err.code} — is that an Ollama server?")
    except Exception:
        where = "on this machine" if is_local(base) else "there"
        return [], ("bad", f"Nothing answered {where}. Is Ollama running at {base}?")

    if status != 200:
        return [], ("bad", f"The address answered {status} — is that an Ollama server?")
    try:
        raw = json.loads(body).get("models")
    except Exception:
        raw = None
    if not isinstance(raw, list):
        return [], ("bad", "Something answered, but not with a model list.")

    found: list[Model] = []
    for entry in raw:
        name = entry.get("name") if isinstance(entry, dict) else None
        if not isinstance(name, str):
            continue
        caps = entry.get("capabilities") or []
        details = entry.get("details") or {}
        found.append(Model(
            name=name,
            dimensions=details.get("embedding_length") if isinstance(details, dict) else None,
            embeds="embedding" in caps,
            calls_tools="tools" in caps,
        ))

    wanted = [m for m in found if (m.embeds if kind == EMBEDDING else m.calls_tools)]
    shown = sorted(wanted or found, key=lambda m: m.name)

    if not shown:
        pull = "nomic-embed-text" if kind == EMBEDDING else "qwen2.5"
        return [], ("warn", f"Answered, but has no models installed. Try: ollama pull {pull}")
    if not wanted and kind == CHAT:
        return shown, ("warn", "Nothing there declares tool calling. Listing everything — but a "
                               "model that cannot call tools will chat and draw nothing.")
    if not wanted and kind == EMBEDDING:
        return shown, ("warn", "Nothing there declares embedding. Listing everything — this server "
                               "may be too old to say, so check the one you pick actually embeds.")
    where = "on this machine" if is_local(base) else f"at {base}"
    return shown, ("ok", f"{len(shown)} model{'' if len(shown) == 1 else 's'} {where}.")
