"""
Reading the selection out of whatever is in front. The ladder.

macOS climbs seven rungs. This machine was measured before any of it was built,
which the brief insists on — "if the primary selection plus a browser extension
covers the real workflow, rung 6 never needs building, and it is the most
fragile part and the only one with a side effect" — and the measurements said
something clear:

- **Rung 3, the primary selection, answers most often** — with no permission, no
  prompt and no synthesis, and it does not exist on macOS at all. But it is
  *global and persistent*: it holds the last thing highlighted anywhere, by any
  window, so it can confidently return something that belongs to a different
  application. See the ordering note in `read`.
- **Rung 4, AT-SPI, returned nothing at first** — four applications on this
  desktop exposed a tree, GTK's `toolkit-accessibility` was off and Electron
  wants `--force-renderer-accessibility`. With that setting turned on it reaches
  seventeen, including the Qt and KDE applications, and it has the one property
  the primary selection lacks: it is scoped to the focused window, so when it
  answers the answer is certainly about what is in front.
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
import sys
import time
from dataclasses import dataclass

#: How much is worth embedding. The daemon embeds whatever it is given, and a
#: whole document pasted into one vector says less than a paragraph does — every
#: term in it pulls the point toward the middle of the library.
MAX_CHARS = 4000

#: The shortest a field's whole contents can be and still be worth asking about.
#: Not applied to a selection, which is deliberate at any length — a highlight is
#: a statement of intent and a field's contents are incidental.
#:
#: The floor exists because of Google Docs, and the Mac names the same case: the
#: focused element there is an off-screen input one pixel tall holding a
#: two-character window around the cursor. Without a floor Glance would take
#: "no" as the document, embed it, and return nonsense with every appearance of
#: having read something.
MEANINGFUL = 12

#: Said by rung 4 when it could see the focused window and there was nothing
#: selected in it. Distinct from not being able to see the window at all, and
#: `read` treats the two very differently.
REACHED_NO_SELECTION = "the focused window has nothing selected"

#: Said by rung 4 when it read the focused field's whole contents instead of a
#: selection. A weaker claim, and the panel says so.
FOCUSED_FIELD = "the focused field, unselected"


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
    #: Whether anything in the focused window implements the text interface at
    #: all. Without one, this rung has no opinion about selections — see `read`.
    speaks_text = False
    #: The focused field's whole contents, when there is no selection in it.
    #: A weaker answer, so it is kept and only used if nothing better turns up.
    whole: list[str] = []

    def walk(node, depth=0):
        nonlocal seen, speaks_text
        if depth > 12 or seen > 400:
            return None
        seen += 1
        try:
            text = node.query_text()
            count = text.get_character_count()
            if count:
                speaks_text = True
            if node.get_state_set().contains(Atspi.StateType.FOCUSED):
                if text.get_n_selections() > 0:
                    start, end = text.get_selection(0)
                    if end > start:
                        return text.get_text(start, end)
                # Nothing highlighted, but this is the field somebody is in.
                # Worth having when the alternative is a window title.
                if count:
                    body = text.get_text(0, min(count, MAX_CHARS))
                    if body and len(body.strip()) >= MEANINGFUL:
                        whole.append(body)
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
                    # No highlight, but the field somebody is typing in is a
                    # fair answer to "what is this about" — which is the whole
                    # question. The Mac does the same and calls it incidental
                    # rather than chosen, which is why it ranks below a
                    # selection and above a window title.
                    if whole:
                        return whole[0], FOCUSED_FIELD
                    # **Reachable is not the same as competent.**
                    #
                    # Firefox exposes a thousand nodes of page structure and
                    # never reports a text selection — not on a Google Doc and
                    # not on an ordinary news page where the selection was
                    # plainly there and rung 3 read it without difficulty. Its
                    # "nothing is selected" is not an answer about the window,
                    # it is this rung having nothing to say.
                    #
                    # So the negative only counts when something in the window
                    # implements the text interface. Kate does, and its silence
                    # means there is genuinely no selection. Firefox does not,
                    # and its silence means nothing at all.
                    return (None, REACHED_NO_SELECTION) if speaks_text else (
                        None, "the focused window exposes no text to read",
                    )
    except Exception as err:  # noqa: BLE001
        return None, f"AT-SPI walk failed ({err})"
    return None, "the focused window exposes no accessibility tree"


#: Window classes a synthetic copy may be sent to.
#:
#: A named list rather than "anything", copying the Mac's fence and its
#: reasoning: a synthetic ctrl+c is near-universal but not universal, and
#: sending one into an application that means something else by it is not a risk
#: worth taking to fill in a form. Browsers only, because a browser is the one
#: thing that draws a document rather than exposing it.
COPYABLE = (
    "firefox", "librewolf", "waterfox", "zen",
    "chromium", "google-chrome", "brave-browser", "microsoft-edge", "vivaldi",
)


def _is_copyable(window) -> bool:
    if window is None:
        return False
    haystack = f"{window.window_class or ''} {window.resource_name or ''}".lower()
    return any(name in haystack for name in COPYABLE)


def clipboard_text() -> str | None:
    """What is on the clipboard now, if it is text."""
    try:
        done = subprocess.run(
            ["wl-paste", "--no-newline"], capture_output=True, timeout=2
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    return done.stdout.decode("utf8", "replace") if done.returncode == 0 else None


def _clipboard_is_text() -> bool:
    """
    Whether the clipboard holds text and nothing more interesting.

    This decides whether the rung runs at all. The clipboard is put back
    afterwards, but only what can be read can be put back — and restoring an
    image as the empty string, or as its own file name, is worse than declining
    to look. Somebody who copied a picture a minute ago should not lose it
    because a note-taking tool wanted a paragraph.
    """
    try:
        done = subprocess.run(["wl-paste", "--list-types"], capture_output=True, timeout=2)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    if done.returncode != 0:
        # Nothing on the clipboard at all, which is the easiest case to restore.
        return True
    types = [t.strip() for t in done.stdout.decode("utf8", "replace").split() if t.strip()]
    if not types:
        return True

    # **Refuse what cannot be put back; ignore what nobody would miss.**
    #
    # Requiring *every* offered type to be text was far too strict: a clipboard
    # filled from any Chromium application carries
    # `chromium/x-internal-source-rfh-token` beside the real text, and a file
    # copied in a file manager carries several. The first is a provenance marker
    # nobody pastes and losing it costs nothing; an image or a list of files is
    # content, and replacing it with a paragraph of prose would be destroying
    # something the user still wanted.
    losable = ("image/", "application/", "text/uri-list", "x-special/")
    if any(t.startswith(losable) or t == "text/uri-list" for t in types):
        return False
    return any(t.startswith("text/") or t in ("UTF8_STRING", "STRING", "TEXT") for t in types)


def synthetic_copy(window) -> tuple[str | None, str]:
    """
    Rung 6. Ask the front window to copy, and read what it copied.

    The last resort, and the only thing that reaches a document a browser draws
    rather than exposes — which on this machine means Google Docs, whose body is
    not in the accessibility tree and whose selection sets no primary. The Mac
    reaches for exactly this rung, for exactly that reason.

    It is the one read here with a side effect, so it carries the same three
    fences the Mac puts on it: browsers only, never on a poll (the caller passes
    `allow_copy` for the single read when a panel opens), and the clipboard is
    put back.

    **Wayland has no `changeCount`.** macOS can tell "nothing was selected" from
    "it has not landed yet" by watching a counter; here the only signal is the
    content itself, so this waits for the clipboard to *differ* and treats a
    timeout as nothing having been selected. That is why a copy of text
    identical to what was already on the clipboard reads as a failure — a rare
    and harmless wrong answer, and the honest one to accept.
    """
    if not _is_copyable(window):
        return None, "a synthetic copy is only sent to browsers"
    if not _clipboard_is_text():
        return None, "the clipboard holds something that could not be put back"

    import fakeinput

    before = clipboard_text()
    sent, why = fakeinput.shared.copy()
    if not sent:
        return None, why

    got = None
    deadline = time.time() + 1.5
    while time.time() < deadline:
        time.sleep(0.08)
        now = clipboard_text()
        if now is not None and now != before and now.strip():
            got = now
            break

    if got is None:
        # Nothing landed, so nothing was taken and there is nothing to restore.
        return None, "nothing was selected"

    # Put it back, and only after reading what we came for.
    if before is not None and before != got:
        try:
            subprocess.run(["wl-copy"], input=before.encode("utf8"), timeout=2, check=False)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
    elif before is None:
        try:
            subprocess.run(["wl-copy", "--clear"], timeout=2, check=False)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    return got, "synthetic copy"


def read(window, allow_copy: bool = False) -> Reading:
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

    # **The accessibility tree first, and this is a departure from the Mac's
    # order for a reason the Mac cannot have.**
    #
    # macOS has no primary selection, so its ladder never faces this: the
    # primary selection is *global and persistent*. It holds the last thing
    # highlighted anywhere, by any window, until something replaces it. Asking
    # it first means that working in an editor with nothing selected returns
    # whatever was selected in a terminal ten minutes ago — confidently, and
    # with no sign that it belongs to a different window. That was observed:
    # Glance offered a shell transcript while the user sat in Kate.
    #
    # AT-SPI has the opposite property. It is scoped to the *focused* window, so
    # when it answers, the answer is certainly about what is in front. It is
    # also the rung that fails more often, which is why it is tried first rather
    # than trusted alone: a miss here costs one bounded tree walk.
    text, how = atspi_selection()
    if text and text.strip():
        rung = "focused field" if how == FOCUSED_FIELD else "accessibility"
        return Reading(text[:MAX_CHARS], rung, how)
    atspi_why = how

    # **A window that was reachable and had nothing selected has answered.**
    #
    # This is the whole point of asking AT-SPI first. The primary selection is
    # global: with nothing highlighted in the front window it happily returns
    # what was highlighted in a terminal an hour ago, and Glance then goes off
    # and looks up a shell transcript while the user sits in an editor. When the
    # accessibility tree can see the focused window and reports no selection,
    # that is direct evidence about *this* window, and it outranks a global
    # buffer that cannot say whose text it holds.
    #
    # Only when the front window is invisible to AT-SPI — most browsers here,
    # and every terminal — is the primary selection the best available guess.
    # **In a browser, ask the browser — before trusting a global buffer.**
    #
    # This is the ordering that made rung 6 reachable at all. A browser is the
    # one window whose selection may be invisible to everything else: Google
    # Docs sets no primary selection when you highlight in it, so the primary
    # selection still holds whatever was highlighted somewhere else, answers
    # confidently, and the ladder stops. Rung 6 was built and never ran.
    #
    # So for a browser the copy is tried first. It is authoritative — it asks
    # *that window* what it has — where the primary selection cannot say whose
    # text it holds. When nothing is selected the copy changes nothing, the
    # clipboard does not move, and this falls through exactly as before.
    #
    # The cost is honest: a synthetic ctrl+c on a browser Glance where rung 3
    # might have answered correctly. The fences make that bounded — browsers
    # only, once per summon, clipboard restored — and the alternative is a rung
    # that exists and never fires.
    if allow_copy and _is_copyable(window):
        text, how = synthetic_copy(window)
        # Said out loud either way. A rung with a side effect that quietly
        # declines is the worst of both — it has already pressed the keys.
        print(f"talaria: glance rung 6 — {'read ' + str(len(text)) + ' chars' if text else 'nothing'} ({how})",
              file=sys.stderr, flush=True)
        if text and text.strip():
            return Reading(text[:MAX_CHARS], "synthetic copy", how)

    if atspi_why != REACHED_NO_SELECTION:
        text, how = primary_selection()
        if text and text.strip():
            return Reading(text[:MAX_CHARS], "primary selection", how)

    # Rung 7. The weakest thing that is still better than nothing, and the one
    # the daemon would otherwise have had to guess at.
    if window is not None and window.caption:
        return Reading(window.caption[:MAX_CHARS], "window title", f"from {window.name}")

    return Reading(None, "nothing", atspi_why)
