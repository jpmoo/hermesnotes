"""
The library, in KDE's search box.

Plasma has one search field reached from everywhere — Alt+Space, the launcher,
and simply typing on the desktop — and anything can put results in it by
answering `org.kde.krunner1` on the session bus. That is the whole integration:
a D-Bus name, three methods, and a `.desktop` file naming them.

**This is the Alfred workflow, not a new feature.** AMBIENT's table gives Alfred
one line — "one more search entrance; already fed by `talaria alfred`; nothing
new required" — and its thesis is that sensors and entrances call `talaria`
rather than growing their own copy of the library. So this asks the daemon the
same questions the Alfred script filter asks, renders links through the same
`/link/:id` the picker uses, and holds no state of its own. What is different is
only that KRunner speaks D-Bus where Alfred speaks JSON on stdout.

**It lives in the shell rather than in a process of its own.** The alternative
was a D-Bus–activatable helper, so that typing on the desktop worked with the
shell closed. It would have to open a window to be any use, which means starting
the shell anyway — and the same reasoning covers the hotkeys, which have always
needed the shell running. One fewer process, and one fewer thing to keep in step.

GDBus on a thread, for the reason `frontmost.py` gives: QtDBus is not installed
here, and this file has to answer a compositor's call without holding the GUI.
"""

from __future__ import annotations

import json
import threading
import urllib.parse

from PySide6.QtCore import QObject, Signal

import daemon as daemon_client

BUS_NAME = "dev.talaria.Runner"
OBJECT_PATH = "/runner"
INTERFACE = "org.kde.krunner1"

INTROSPECTION = f"""
<node>
  <interface name='{INTERFACE}'>
    <method name='Match'>
      <arg type='s' name='query' direction='in'/>
      <arg type='a(sssida{{sv}})' name='matches' direction='out'/>
    </method>
    <method name='Actions'>
      <arg type='a(sss)' name='actions' direction='out'/>
    </method>
    <method name='Run'>
      <arg type='s' name='matchId' direction='in'/>
      <arg type='s' name='actionId' direction='in'/>
    </method>
    <method name='Teardown'/>
  </interface>
</node>
"""

# Plasma::QueryMatch::Type. Ours are `PossibleMatch` — a guess among other
# people's guesses — except a title matched outright, which is `ExactMatch` and
# sorts to the top the way opening a file by its full name does.
POSSIBLE, EXACT = 30, 100

#: Below this, everything matches and nothing is meant. Typing on the desktop
#: fires a query per keystroke, and "a" is not a question.
SHORTEST = 3

#: Words that mean "this one is for Talaria", and what they ask for. A prefix
#: also lifts the length floor: somebody who typed `hn ab` has said which
#: haystack they mean, and can have the two-letter answer.
PREFIXES = {"hn": "find", "note": "note", "task": "task"}

#: freedesktop icon names, which is what KRunner wants — a themed name rather
#: than a file, so the row looks like the rows above and below it.
ICONS = {
    "task": "checkbox",
    "event": "view-calendar-day",
    "note": "text-x-generic",
    "person": "user",
    "project": "folder",
    "organization": "group",
    "other": "text-x-generic",
}

ACTIONS = [
    # (id, label, icon). Named once — see `X-Plasma-Request-Actions-Once` in the
    # plugin file — and each match says which of them apply to it.
    ("link", "Copy a link to it", "edit-copy"),
    ("insert", "Paste a link where you were", "edit-paste"),
]


def _split(query: str) -> tuple[str, str]:
    """`("find", "roof")` — what was asked for, and about what."""
    text = query.strip()
    head, _, rest = text.partition(" ")
    verb = PREFIXES.get(head.lower())
    if verb and rest.strip():
        return verb, rest.strip()
    return "find", text


class Runner(QObject):
    """
    Answers KRunner, and asks the shell to do the parts that need a window.

    The two signals are the thread boundary. Everything above them runs on a
    GLib thread with a compositor waiting on it; everything below is Qt's, and
    opening a window or touching the clipboard belongs there.
    """

    #: A URL to open, exactly as `_opened` would receive it from a panel.
    open_url = Signal(str)
    #: Text to put on the clipboard and, when the second argument is true, type
    #: into whatever was in front before the search box appeared.
    put = Signal(str, bool)
    #: Something worth a word, when there is no window to say it in.
    said = Signal(str, str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.failure: str | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread:
            return
        self._thread = threading.Thread(target=self._run, name="talaria-krunner", daemon=True)
        self._thread.start()

    # ------------------------------------------------------------------ thread

    def _run(self) -> None:
        try:
            import gi

            gi.require_version("Gio", "2.0")
            gi.require_version("GLib", "2.0")
            from gi.repository import Gio, GLib
        except Exception as err:  # noqa: BLE001
            self.failure = f"no GLib/Gio bindings, so no KRunner entrance — {err}"
            return

        context = GLib.MainContext.new()
        context.push_thread_default()

        def on_call(_conn, _sender, _path, _iface, method, params, invocation):
            try:
                if method == "Match":
                    (query,) = params.unpack()
                    invocation.return_value(
                        GLib.Variant("(a(sssida{sv}))", [self._match(GLib, query)])
                    )
                elif method == "Actions":
                    invocation.return_value(GLib.Variant("(a(sss))", [ACTIONS]))
                elif method == "Run":
                    match_id, action_id = params.unpack()
                    self._did(match_id, action_id)
                    invocation.return_value(None)
                else:  # Teardown, and anything a future Plasma adds
                    invocation.return_value(None)
            except Exception as err:  # noqa: BLE001
                # Never a D-Bus error: KRunner logs one per keystroke and the
                # search box stutters. A quiet empty answer is the right way for
                # one runner among a dozen to fail.
                print(f"talaria: krunner — {err}", flush=True)
                if method == "Match":
                    invocation.return_value(GLib.Variant("(a(sssida{sv}))", [[]]))
                elif method == "Actions":
                    invocation.return_value(GLib.Variant("(a(sss))", [[]]))
                else:
                    invocation.return_value(None)

        try:
            node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
            conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            conn.register_object(OBJECT_PATH, node.interfaces[0], on_call, None, None)
            Gio.bus_own_name_on_connection(
                conn, BUS_NAME, Gio.BusNameOwnerFlags.REPLACE, None, None
            )
        except Exception as err:  # noqa: BLE001
            self.failure = f"couldn't take {BUS_NAME} — {err}"
            return

        GLib.MainLoop.new(context, False).run()

    # ------------------------------------------------------------------ asking

    def _match(self, glib, query: str) -> list:
        verb, text = _split(query)

        if verb in ("note", "task"):
            # A write, and only ever behind a word that says so. `note` and
            # `task` are the two the CLI's `capture` takes, spelled the same
            # way round: text in, one block out.
            return [(
                f"capture:{verb}:{text}",
                text,
                "list-add",
                POSSIBLE,
                0.9,
                {
                    "subtext": glib.Variant("s", f"New {verb} in Hermes Notes"),
                    "actions": glib.Variant("as", []),
                },
            )]

        prefixed = verb == "find" and query.strip() != text
        if len(text) < (1 if prefixed else SHORTEST):
            return []

        # The daemon ranks, because the daemon has the index — but it ranks
        # full text, and forty are asked for to keep ten. A library where the
        # word appears in a hundred bodies can bury the block *named* that word
        # below any short limit: `q=learning` did not return the note called
        # "Learning" in the first ten, which is the one result a search box has
        # to have.
        #
        # The whole envelope rather than `get_json`, which unwraps it: the
        # freshness and the sentence beside it are the point of the envelope,
        # and a search box is exactly where "this is what I had this morning"
        # needs saying.
        status, raw, _ = daemon_client.request(
            "GET", f"/blocks?q={urllib.parse.quote(text)}&limit=40", timeout=4.0
        )
        if status >= 400:
            return []
        env = json.loads(raw)
        rows = env.get("data") or []
        # Said out loud rather than hidden, the way every other surface says it:
        # a mirror that has not synced today is still worth searching, and the
        # row should admit which it is.
        stale = "" if env.get("freshness") == "fresh" else f"  ·  {env.get('note') or 'not synced'}"

        needle = text.casefold()

        # **A body match is not a result on the desktop.**
        #
        # The daemon searches full text, which is right for Alfred and for
        # `talaria find`, where somebody has already said which haystack they
        # mean. Here the row appears among applications and files, and a title
        # with no visible relation to what was typed reads as a broken runner
        # rather than as a deep search. So an unprefixed query sees only what it
        # can name, and `hn` is how you ask for the rest.
        kept = []
        for at, block in enumerate(rows):
            title = str(block.get("title") or "").casefold()
            named = needle in title
            if named or prefixed:
                # The one that *is* what was typed, then the ones that carry it
                # in their name, then everything else — and the daemon's own
                # order within each of those.
                rank = 0 if title == needle else (1 if named else 2)
                kept.append(((rank, at), block))
        kept.sort(key=lambda pair: pair[0])

        out = []
        for place, (_, block) in enumerate(kept[:10]):
            title = str(block.get("title") or "(untitled)")
            exact = title.casefold() == needle
            # Descending by where it ended up rather than by where the daemon
            # had it — forty were asked for, and a decay measured against that
            # list would put the fourth thing on screen at nearly nothing.
            #
            # Never above KRunner's own applications unless the title was typed
            # out in full, or the query was addressed to us.
            score = 1.0 if exact else (0.95 if prefixed else 0.62) - place * 0.03
            done = (block.get("completion") or {}).get("done")
            # Four. A row in a search box is one line, and a note wearing
            # eighteen tags pushed everything that identifies it — its type,
            # whether it is finished — off the end of it.
            tags = " ".join(f"#{t}" for t in (block.get("tags") or [])[:4])
            subtext = ("  ·  ".join(
                bit for bit in (
                    f"Hermes {block.get('typeName') or ''}".strip(),
                    "done" if done else None,
                    tags or None,
                ) if bit
            ) + stale)[:140]
            out.append((
                f"block:{block.get('id')}",
                title,
                ICONS.get(str(block.get("kind")), ICONS["other"]),
                EXACT if exact else POSSIBLE,
                min(1.0, max(0.05, score)),
                {
                    "subtext": glib.Variant("s", subtext),
                    "actions": glib.Variant("as", [a[0] for a in ACTIONS]),
                    # What Run gets is only the id, so the URL rides along here
                    # rather than being looked up a second time.
                    "urls": glib.Variant("as", [str(block.get("url") or "")]),
                },
            ))
        return out

    # ------------------------------------------------------------------- doing

    def _did(self, match_id: str, action_id: str) -> None:
        kind, _, rest = match_id.partition(":")

        if kind == "capture":
            as_, _, text = rest.partition(":")
            body = json.dumps({"text": text, "as": "task" if as_ == "task" else "note"})
            status, raw, _ = daemon_client.request(
                "POST", "/capture", body.encode("utf8"), timeout=20.0
            )
            made = json.loads(raw or b"{}")
            if status >= 400:
                return self.said.emit("Talaria couldn't write that", str(made.get("error") or status))
            if not made.get("applied"):
                # Offline. The write is on the durable queue and will go out,
                # and there is no block to open yet — so this is the one case
                # that needs saying out loud, because the search box has closed
                # and nothing else would.
                return self.said.emit("Saved for when Hermes is back", text[:120])
            # Straight to the thing that was just made. Capturing and then
            # hunting for what you captured is the failure the compose panel
            # avoids by doing the same.
            self._open(str(made.get("id") or ""))
            return

        if kind != "block" or not rest:
            return

        if action_id in ("link", "insert"):
            # Rendered by the daemon, with no `for` — which is deliberate. By the
            # time this runs the front window *is* KRunner, so the daemon's own
            # fallback (the last window that was not a launcher) is the right
            # answer, and it is the same one the picker gets.
            made = daemon_client.get_json(f"/link/{rest}", timeout=4.0)
            self.put.emit(str(made.get("text") or ""), action_id == "insert")
            return

        self._open(rest)

    def _open(self, block_id: str) -> None:
        """Open a block by id, which means asking where it lives first."""
        if not block_id:
            return
        block = daemon_client.get_json(f"/blocks/{block_id}", timeout=4.0)
        url = (block or {}).get("url")
        if url:
            self.open_url.emit(str(url))
