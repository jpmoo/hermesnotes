"""
Talaria's menu bar item, on KDE.

A port of what `app/Sources/main.swift` does around its `NSStatusItem`: the same
menu, the same four panels, the same toggle. What it is not is a port of the
panels themselves — the Mac draws those in AppKit and these are web pages the
shell serves, which is the architecture the brief settled on and the reason this
file is nine hundred lines shorter than its counterpart.

Nothing here talks to Hermes. Every panel reaches the daemon over the socket
through `scheme.py`, and the daemon reaches Hermes through pkm-interchange.
"""

from __future__ import annotations

import os
import subprocess
import sys

from PySide6.QtCore import (QObject, QSettings, QSize, QStandardPaths, Qt, QTimer, QUrl,
                            Signal)
from PySide6.QtGui import QAction, QActionGroup, QIcon, QKeySequence, QPainter, QPixmap, QShortcut
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWebEngineCore import QWebEnginePage
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication, QMenu, QMessageBox, QSystemTrayIcon, QVBoxLayout, QWidget

import threading

import daemon
import glance
import scheme
import webprofile
import wm
from frontmost import Frontmost
from krunner import Runner
from shortcuts import Shortcuts

HERE = os.path.dirname(os.path.abspath(__file__))

# Title, page, default hotkey.
#
# The defaults were the Mac's — shift+alt+… — on the reasoning that somebody
# with both machines should have one set of fingers. They are the Meta+Shift
# ones actually in use here now, because a default that nobody kept is not a
# default, it is a first suggestion that was declined.
PANELS = {
    "board": ("Hermes Notes Collections", "board.html", "meta+shift+c"),
    "assistant": ("Ask Hermes Notes", "assistant.html", "meta+shift+a"),
    "compose": ("New Block", "compose.html", "meta+shift+n"),
    # No counterpart on the Mac, which reaches Hermes through the menu only. It
    # earns one here because on Linux this window is also where a `talaria://`
    # deep link would land.
    "hermes": ("Hermes Notes", None, "meta+shift+h"),
    "glance": ("Glance", "glance.html", "meta+shift+g"),
    # The desk. Full screen, and the one panel the others sit on top of.
    "desk": ("Desk", "desk.html", "meta+shift+t"),
    # The reciprocal of capture — see `ui/reference.html`. On `l` for "link",
    # which is the word for what it makes rather than for what it searches.
    "reference": ("Link to a block", "reference.html", "meta+shift+l"),
    # What the machine noticed while nobody was asking. On `n` for noticed.
    "proposals": ("Noticed", "proposals.html", "meta+shift+i"),
}


#: Short names, for the one place a long one does not fit.
#:
#: The menu keeps the Mac's wording — "Hermes Notes Collections" — because that
#: is what it is called and a menu has room. A notification does not: five
#: entries at that length wrap, and a wrapped list is harder to read than the
#: five words it was trying to spell out.
SHORT = {
    "desk": "Desk",
    "board": "Collections",
    "assistant": "Ask",
    "compose": "New Block",
    "hermes": "Hermes",
    "glance": "Glance",
    "reference": "Link to…",
    "proposals": "Noticed",
}


def frosting_alpha() -> float:
    """
    How opaque a panel's own background is, from `frostingAmount`.

    1.0 is a solid panel with the blur invisible behind it; lower lets more of
    the blurred desktop through. Clamped at 0.35, below which text over a busy
    desktop stops being readable however much it is blurred.
    """
    import json

    try:
        with open(os.path.join(os.path.dirname(daemon.socket_path()), "config.json"),
                  encoding="utf8") as handle:
            asked = float(json.load(handle).get("frostingAmount", 0.82))
    except Exception:  # noqa: BLE001
        return 0.82
    return min(1.0, max(0.35, asked))


def config_hotkey(action: str, fallback: str) -> str:
    """
    A hotkey from `config.json`, so both machines can be configured in one file.

    These are the four keys `config.ts` documents as "only the app reads" —
    written by the Mac's settings panel, and passed through zod untouched. Read
    here for the same reason: somebody who set `boardHotkey` on their Mac should
    not have to set it again by another name.

    After the first run this is only a default. The portal keeps the binding it
    was granted, so what is here is what Talaria *asks* for the first time —
    `talaria-shell --rebind` is how it is changed after that.
    """
    import json

    path = os.path.join(os.path.dirname(daemon.socket_path()), "config.json")
    try:
        with open(path, encoding="utf8") as handle:
            value = json.load(handle).get(f"{action}Hotkey")
        return value if isinstance(value, str) and value.strip() else fallback
    except Exception:  # noqa: BLE001 — a missing or unreadable config is just "use the default"
        return fallback


class RoutedPage(QWebEnginePage):
    """
    A page whose outbound links are the shell's business, not the view's.

    The panels are served over `talaria-app://`, so any navigation to http(s) is
    a link *out* — a card pointing at the block it stands for. Letting the view
    follow it would replace the board with a web page and lose the board; the
    Mac never had the question because its cards are not a web view at all.

    `acceptNavigationRequest` catches both halves of it, a clicked anchor and a
    `location.href =`, which is one hook rather than two.
    """

    def __init__(self, route, profile, parent=None) -> None:
        # The profile is passed in rather than taken from the default, because
        # the default keeps nothing: see `webprofile`.
        super().__init__(profile, parent)
        self._route = route

    def acceptNavigationRequest(self, url: QUrl, kind, is_main_frame: bool) -> bool:  # noqa: N802
        # The route says whether it took the link. When it did not — the Hermes
        # window following one of Hermes' own links — the view navigates
        # normally, which keeps it a working web app rather than a series of
        # full page loads driven from Python.
        if url.scheme() in ("http", "https") and self._route(url):
            return False
        return super().acceptNavigationRequest(url, kind, is_main_frame)


_HARVEST: str | None = None


def _harvest() -> str:
    """
    The rung-2 script, which lives with the pages it reaches into.

    In `ui/` rather than in a string here because it is DOM knowledge — which
    element is the surface in view, which frames are ours — and that belongs
    next to the markup making those true. Read once: it does not change while
    the shell is running, and this is on the path of a keypress.
    """
    global _HARVEST
    if _HARVEST is None:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "ui", "harvest.js"), encoding="utf8") as handle:
            body = handle.read().strip().rstrip(";")
        # **Stringified, because an object does not survive the trip.**
        #
        # `runJavaScript` returns primitives faithfully — a string, a number,
        # `document.title` — and hands back an *empty string* for any object or
        # array. Measured, after rung 2 spent this long looking like an empty
        # desk: `"hello"` came back `'hello'`, `2 + 2` came back `4.0`, and
        # `({a: 1})` came back `''`. So the harvest's `{text, how}` never once
        # reached Python, `_summon_glance` saw nothing worth using, and Glance
        # fell through to reading whatever window was behind the desk — which
        # is precisely the defect rung 2 was written to fix.
        #
        # `export.py` already carried the workaround (`JSON.stringify(...)` on
        # its own `runJavaScript`) without saying why. This is the why.
        #
        # Wrapped in a try as well, so a harvest that throws says so instead of
        # arriving as the same silence.
        #
        # **Assigned before it is returned, and that is not a style choice.**
        # `harvest.js` opens with a block comment, so `return <body>` put a line
        # terminator between the keyword and the expression — automatic
        # semicolon insertion ends the statement there, the function returns
        # `undefined`, and the harvest that follows is dead code that runs and
        # is thrown away. It looked exactly like a page with nothing on it.
        _HARVEST = (
            "(() => { try { const found = " + body + " ?? null; return JSON.stringify(found); }"
            " catch (err) { return JSON.stringify({ error: String((err && err.message) || err) }); } })()"
        )
    return _HARVEST


class Panel(QWidget):
    """
    A window around a web view.

    Escape hides rather than closes, and closing hides too: these are summoned
    things, and rebuilding a web view per summon would throw away the page's
    scroll position, its half-typed message and its session every time.
    """

    def __init__(self, title: str, url: QUrl, size: QSize, route=None, floating: bool = True) -> None:
        # `Qt.Tool` is the analogue of the Mac's `NSPanel` with `.utilityWindow`
        # and `isFloatingPanel`: a thinner frame, no entry in the task switcher,
        # and it stays above the thing it was summoned over. These are things
        # you call up over your work, look at, and dismiss — a full application
        # window in the alt-tab list is the wrong shape for that, and is what
        # made them feel like a different program rather than part of the
        # desktop.
        #
        # The Hermes window is not one of these. It is a browser you work *in*,
        # so it is an ordinary window that can be tiled, tabbed and left open.
        # Frameless, for the panels. These are summoned over your work, do one
        # thing and go — a titlebar with a close button is furniture for a
        # window you live in, and these are closer to a large toast. The page
        # draws its own header, so nothing is lost but the chrome.
        flags = Qt.WindowType.Window
        if floating:
            flags = (
                Qt.WindowType.Tool
                | Qt.WindowType.FramelessWindowHint
                | Qt.WindowType.NoDropShadowWindowHint
            )
        super().__init__(None, flags)
        if floating:
            # Rounded corners need the corners to be see-through.
            self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
            # The widget itself must paint nothing either. `WA_TranslucentBackground`
            # governs the window surface; a QWidget still fills its own rect from
            # the palette unless told otherwise, and that fill is square.
            self.setStyleSheet("background: transparent;")
            self.view_is_panel = True
            #: Whether losing focus dismisses it — see `event`. Every floating
            #: panel does; the desk is the one that does not, and it is not a
            #: property of *looking* like a panel, which is why it is its own
            #: flag rather than another reading of `view_is_panel`.
            self.dismisses = True
            self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
        #: Asked for once, after the first show — see `_frost`.
        self._frosted = False
        self.setWindowTitle(f"Talaria — {title}")
        self.resize(size)
        if floating:
            # Where this one goes, said before it is shown.
            #
            # On KDE the KWin script already knows and this does nothing. On
            # Hyprland it writes the window rules — and those are matched
            # against a window as it opens, so they have to be set here rather
            # than once at startup.
            wm.place(self.windowTitle(), size.width(), size.height(),
                     is_desk=title == "Desk")
        self.view = QWebEngineView(self)
        # On the shell's own profile, not the default one — which is off the
        # record, and would hand each window its own amnesiac cookie jar.
        if route is None:
            self._page = QWebEnginePage(webprofile.get(QApplication.instance()), self.view)
            self.view.setPage(self._page)
        if route is not None:
            # Held on the view: a page the widget does not own is collected out
            # from under the engine, which is the same lifetime trap as the
            # request jobs in `scheme.py`.
            self._page = RoutedPage(route, webprofile.get(QApplication.instance()), self.view)
            self.view.setPage(self._page)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.view)
        if floating:
            # **The page must be transparent, or the corners are square.**
            #
            # A web view paints its own base color across the whole rectangle
            # before the document draws anything, so a `border-radius` on `body`
            # rounds the document and leaves white behind it in the corners. The
            # radius is real; what was showing through it was the engine's own
            # background.
            self.view.page().setBackgroundColor(Qt.GlobalColor.transparent)
            self.view.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        # How much of the blurred backdrop shows through.
        #
        # `ext-background-effect-v1` has no strength — the blur radius is the
        # compositor's own setting, the same for every window. What a per-panel
        # "amount" can honestly mean is how translucent the panel's own surface
        # is, so this is handed to the page as a CSS variable and the page
        # paints its background with it.
        self.view.loadFinished.connect(
            lambda ok: ok and self.view.page().runJavaScript(
                f"document.documentElement.style.setProperty("
                f"'--surface-alpha', '{frosting_alpha():.2f}')"
            )
        )
        #: Whether the page has finished loading, and what is waiting for it.
        #: See `when_loaded`. A reload — after a sync, after settings — starts
        #: the wait over.
        self._loaded = False
        self._waiting: list = []
        self.view.loadStarted.connect(self._load_started)
        self.view.loadFinished.connect(self._load_finished)
        self.view.load(url)
        QShortcut(QKeySequence("Escape"), self, activated=self.hide)

    def closeEvent(self, event) -> None:  # noqa: N802 — Qt's name
        event.ignore()
        self.hide()

    def event(self, e):  # noqa: ANN001, N802 — Qt's names
        """
        Go away when somebody looks elsewhere.

        The Mac watches for a click outside and calls this "the right trade for
        a thing summoned by a hotkey and the wrong one for a document" — so it
        applies to the panels and not to the Hermes window, which is exactly the
        `floating` split already made here. Wayland gives no global click
        monitor, but it does say when a window stops being active, which is the
        same moment from this side of it.
        """
        from PySide6.QtCore import QEvent

        # **Losing focus only means something if it was ever held.**
        #
        # On Wayland a window that asks to be activated usually is not, so a
        # panel summoned over the desk comes up without focus while the desk
        # keeps it — and a deactivation arriving in that state is not somebody
        # looking away, it is the summon itself. Remembering whether this window
        # was ever the active one tells the two apart, which "is anything of ours
        # active?" could not: that question answers the same way whether you just
        # opened the panel or just clicked off it.
        if e.type() == QEvent.Type.WindowActivate:
            self._had_focus = True

        if (
            e.type() == QEvent.Type.WindowDeactivate
            and getattr(self, "dismisses", False)
            and getattr(self, "_had_focus", False)
            and self.isVisible()
        ):
            # Deferred: a deactivation arrives while a menu or a file dialog of
            # our own is opening too, and hiding underneath one of those makes
            # the panel vanish mid-interaction.
            QTimer.singleShot(120, self._hide_if_still_inactive)
        return super().event(e)

    def _hide_if_still_inactive(self) -> None:
        """
        Gone, if the focus really has gone somewhere else.

        Clicking off Glance or Ask dismisses it — onto the desk, onto another
        panel, or out of Talaria entirely. All three are "somebody looked
        elsewhere", and the one case that is not is handled before this ever
        runs: `event` only schedules a hide for a window that had the focus to
        lose.
        """
        if self.isActiveWindow():
            return
        # **Unless the pointer is still on it.**
        #
        # Where the keyboard follows the mouse — Hyprland's default, and not
        # something Talaria should change on somebody's desktop — a hand
        # brushing the mouse while typing into New Block moves the focus to
        # whatever is under the pointer, and this panel would close in the
        # middle of a sentence. A panel the pointer is resting on is not a
        # panel anybody looked away from.
        if wm.focus_follows_mouse() and self.underMouse():
            return
        self.hide()

    def _frost(self) -> None:
        """
        Ask the compositor to blur what is behind this panel.

        After showing, never before: blur attaches to a Wayland surface and a
        window that has not been shown has none yet. Asked once — the effect
        stays with the surface, and the surface outlives every summon.

        Only the panels. The Hermes window is a browser you work in, and a
        page of text over a blurred desktop is harder to read than a page of
        text over a page.
        """
        if not getattr(self, "view_is_panel", False) or self._frosted:
            return
        if wm.frost(self):
            self._frosted = True

    def when_loaded(self, call) -> None:
        """
        Run `call` now if the page is ready, or as soon as it is.

        Panels are built on first summon, so the first New Block after a start
        handed its selection to a page that was still `about:blank`:
        `window.composeWith && …` found nothing, did nothing, and the text was
        gone. Glance guarded the same case with `url().isEmpty()`, which is
        never true — the URL is set the moment loading *starts* — so it had the
        same hole. Asking whether the load finished is the actual question.
        """
        if self._loaded:
            call()
        else:
            self._waiting.append(call)

    def _load_started(self) -> None:
        self._loaded = False

    def _load_finished(self, _ok: bool) -> None:
        # Run on failure too: every waiting script guards on the function it
        # calls, so a page that did not load simply declines, which beats
        # holding the call forever.
        self._loaded = True
        waiting, self._waiting = self._waiting, []
        for call in waiting:
            call()

    def summon(self) -> None:
        """
        Show, raise and focus — centred on the screen the pointer is on.

        The Mac positions the assistant and compose panels near the top of that
        screen rather than dead centre, "where a prompt belongs, rather than
        dead center over whatever is being read". Wayland does not let a client
        place its own windows, so that intent is the compositor's to honour and
        this asks for nothing.
        """
        # A fresh summon starts having held nothing. Without this a panel that
        # was clicked into, dismissed and summoned again would still be carrying
        # the focus it had the last time and could vanish on the deactivation
        # that comes with its own reappearance.
        self._had_focus = False
        self.show()
        self.raise_()
        self.activateWindow()
        self._frost()


class Reader(QObject):
    """
    The Glance ladder, off the thread that draws.

    Every rung below our own windows is a blocking call: `wl-paste` is a process
    to spawn and wait for, the accessibility walk is synchronous D-Bus, and the
    synthetic copy presses a key and waits to see what lands. Run on the GUI
    thread — which is where a hotkey arrives — they freeze the application for as
    long as they take, and KWin marks the window *(Not Responding)* while a panel
    that was summoned sits there unpainted. That was visible the moment panels
    stopped dismissing themselves and stayed on screen long enough to be seen
    doing it.

    One thread per read, not a pool: these happen when somebody presses a key,
    the ladder is bounded by its own timeouts, and a queue would only add the
    chance of two of them overlapping on the same clipboard.

    The answer comes back on a signal, which is how it re-enters the GUI thread —
    the reading is a value and the panel is a window, and only one of those may
    be touched from here.
    """

    done = Signal(object)

    def read(self, **kwargs) -> None:
        def work() -> None:
            try:
                reading = glance.read(on_gui_thread=False, **kwargs)
            except Exception as err:  # noqa: BLE001
                # A ladder that fell over is a reading of nothing, not a dead
                # panel: the caller has a window to open either way.
                reading = glance.Reading(None, "nothing", f"the read failed — {err}")
            self.done.emit(reading)

        threading.Thread(target=work, name="talaria-glance", daemon=True).start()


class Shell(QObject):
    """
    The tray item and everything it opens.

    **A QObject, and that is load-bearing rather than tidiness.** `Shortcuts`
    emits `pressed` from the GLib thread the portal is driven on, and Qt decides
    a connection's type from the *receiver's* thread affinity — a plain Python
    object has none, so an AutoConnection to one of its methods is a **direct**
    call. `toggle` then ran on the GLib thread and built QWidgets outside the
    GUI thread, which does not raise and does not draw: hotkeys bound, fired,
    and appeared to do nothing at all. Inheriting QObject gives the slot an
    affinity, so the same connection becomes queued and lands on the main loop.
    """

    def __init__(self, app: QApplication) -> None:
        super().__init__()
        # Said once, because everything below behaves differently depending on
        # the answer and a log that does not name the session makes every
        # report of "the panels are in the wrong place" start with a question.
        print(f"talaria: session — {wm.session()}", file=sys.stderr, flush=True)
        self.app = app
        self.settings = QSettings("talaria", "shell")
        self.panels: dict[str, Panel] = {}
        #: Readers in flight. Held because a QObject with no Python reference is
        #: collected, and a collected reader emits nothing.
        self._readers: list[Reader] = []
        self._settings_window = None
        self.tray = QSystemTrayIcon()
        self.tray.setIcon(self._icon())
        self.tray.setToolTip("Talaria")
        self.tray.activated.connect(self._activated)
        # Held, not just handed over. `setContextMenu` does not take ownership,
        # and a QMenu with no parent and no Python reference is a menu that can
        # be collected while the tray still points at it.
        self._context = self._menu()
        self.tray.setContextMenu(self._context)
        self.tray.show()

        self._listen()

        # Started before the shortcuts: Glance is the one panel that needs to
        # know what was in front *before* it opened, and the answer has to have
        # arrived by the time a hotkey can fire.
        self.frontmost = Frontmost()
        # Ambient Glance: redrawn when the desktop says the window changed, once
        # the changes stop coming. See `_ambient`.
        self._ambient_at = None
        self._ambient_timer = QTimer(self)
        self._ambient_timer.setSingleShot(True)
        self._ambient_timer.timeout.connect(self._ambient_read)
        self.frontmost.changed.connect(self._ambient)
        self.frontmost.start()

        self.shortcuts = Shortcuts()
        # Queued because this Shell is a QObject on the main thread — see the
        # class note. Spelled out rather than left to AutoConnection so that
        # removing the base class breaks loudly instead of silently.
        self.shortcuts.pressed.connect(self.toggle, Qt.ConnectionType.QueuedConnection)
        for action, (title, _page, default) in PANELS.items():
            self.shortcuts.bind(action, title, config_hotkey(action, default))
        self.shortcuts.settled.connect(self._report_shortcuts)
        self.shortcuts.start(rebind="--rebind" in sys.argv)

        # The other entrance: KDE's search box, which is reached by typing on
        # the desktop and does not need a hotkey of ours at all. Queued for the
        # same reason as the shortcuts — it answers on a GLib thread, and
        # opening a window is the main thread's.
        # Only where there is a search box to answer into. Hyprland has none
        # of its own — the launcher is a separate program the distribution
        # chooses — so this would be a D-Bus service nothing ever calls.
        self.krunner = Runner() if wm.offers_search_entrance() else None
        if self.krunner is not None:
            self.krunner.open_url.connect(self._open_from_runner, Qt.ConnectionType.QueuedConnection)
            self.krunner.put.connect(self._put_from_runner, Qt.ConnectionType.QueuedConnection)
            self.krunner.said.connect(self._note, Qt.ConnectionType.QueuedConnection)
            self.krunner.start()


    def _listen(self) -> None:
        """Somewhere for `--toggle` to land."""
        # A previous run that was killed rather than quit leaves the name taken
        # and the socket dead. Removing it is safe precisely because a live
        # instance would have answered `forward` and this process would never
        # have got here.
        QLocalServer.removeServer(IPC_NAME)
        self._server = QLocalServer()
        if not self._server.listen(IPC_NAME):
            return
        self._server.newConnection.connect(self._accept)

    def _accept(self) -> None:
        conn = self._server.nextPendingConnection()
        if conn is None:
            return

        def read() -> None:
            action = bytes(conn.readAll()).decode("utf8", "replace").strip()
            if action:
                self.toggle(action)
            conn.disconnectFromServer()

        conn.readyRead.connect(read)

    # ------------------------------------------------------------------ icon

    def _icon(self) -> QIcon:
        """
        The tray mark, monochrome like everything else in that row.

        **By theme name, not by file**, and that is the whole trick. A tray icon
        handed over as a picture is drawn as given — which is how this shipped a
        black feather onto a dark panel, and then a full-color glyph that was
        visible but looked nothing like its neighbours. An icon named from the
        theme is drawn by the *desktop*, which substitutes its own foreground
        color: white on a dark panel, black on a light one, the same as every
        other item there.

        What makes that possible is the stylesheet in `icons/talaria-symbolic.svg`.
        Breeze's monochrome icons are not shipped in two colors; they are shipped
        colorless, with a `ColorScheme-Text` class the desktop fills in. Ours is
        the same file with the same class.

        `install.sh` puts it in the user's icon theme. The fallbacks below are
        for a machine where that has not happened yet, and both are worse: a
        colored glyph does not match the row, and a drawn letter is a letter.
        """
        icon = QIcon.fromTheme("talaria-symbolic")
        if not icon.isNull():
            return icon

        glyph = os.path.join(HERE, "..", "..", "app", "glyph-1024.png")
        if os.path.isfile(glyph):
            icon = QIcon(glyph)
            if not icon.isNull():
                return icon

        # Last resort, and deliberately legible: a mark nobody can find is an
        # application nobody can quit.
        pixmap = QPixmap(22, 22)
        pixmap.fill(Qt.GlobalColor.transparent)
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QApplication.palette().windowText().color())
        font = painter.font()
        font.setPixelSize(16)
        font.setBold(True)
        painter.setFont(font)
        painter.drawText(pixmap.rect(), Qt.AlignmentFlag.AlignCenter, "T")
        painter.end()
        return QIcon(pixmap)

    # ------------------------------------------------------------------ menu

    def _menu(self) -> QMenu:
        menu = QMenu()
        menu.addAction(self._act("Open Hermes Notes", lambda: self.toggle("hermes")))
        menu.addSeparator()
        menu.addAction(self._act("Ask Hermes Notes", lambda: self.toggle("assistant")))
        menu.addAction(self._act("Hermes Notes Collections", lambda: self.toggle("board")))
        menu.addAction(self._act("Glance", lambda: self.toggle("glance")))
        menu.addAction(self._act("Link to a block…", lambda: self.toggle("reference")))
        menu.addAction(self._act("Noticed", lambda: self.toggle("proposals")))
        menu.addAction(self._act("New Block…", lambda: self.toggle("compose")))

        menu.addSeparator()
        # Which of them a plain click opens. The Mac's reasoning applies
        # unchanged: a tray item has exactly one left click to give, and which
        # one you want depends on how you work.
        opens = menu.addMenu("Click opens")
        group = QActionGroup(opens)
        group.setExclusive(True)
        for action, (title, _page, _hk) in PANELS.items():
            item = QAction(title, opens, checkable=True)
            item.setChecked(self.primary == action)
            item.triggered.connect(lambda _checked, a=action: self.settings.setValue("primaryPanel", a))
            group.addAction(item)
            opens.addAction(item)

        menu.addSeparator()
        menu.addAction(self._act("Settings…", self._settings))
        menu.addAction(self._act("Refresh", self._refresh))
        menu.addAction(self._act("Quit Talaria", self.app.quit))
        return menu

    def _act(self, title: str, slot) -> QAction:
        action = QAction(title, self.app)
        action.triggered.connect(lambda _checked=False: slot())
        return action

    @property
    def primary(self) -> str:
        return str(self.settings.value("primaryPanel", "board"))

    def _activated(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self.toggle(self.primary)

    # --------------------------------------------------------------- panels

    def toggle(self, action: str) -> None:
        """Visible means hide; anything else means show. The Mac's semantics."""
        print(f"talaria: toggle {action!r}", flush=True)
        # Not a panel, but it is a thing worth reaching by name — so a hotkey or
        # `--toggle settings` can open it like anything else.
        if action == "settings":
            self._settings()
            return
        if action not in PANELS:
            return
        panel = self.panels.get(action)
        if panel is not None and panel.isVisible():
            panel.hide()
            return

        # **Read before showing anything.** Summoning a panel makes Talaria the
        # front window, and from that moment the only window in front is this
        # one — so a Glance that reads after it has opened is a Glance reading
        # itself. `main.swift` carries the same note over its compose panel, for
        # the same reason, and this had it the wrong way round: the selection
        # was fetched a line after the window that destroyed it.
        #
        # Glance leaves here, because rung 2 answers through a callback and the
        # rest of the summon has to happen inside it.
        if action == "glance":
            self._ask_our_own(self._summon_glance)
            return

        # Same order, same reason. A new block made out of what you were reading
        # is the other half of Glance — one asks the library about the selection
        # and the other puts the selection *in* the library — so the reading has
        # to happen before this panel becomes the front window.
        if action == "compose":
            self._ask_our_own(self._summon_compose)
            return

        # What was in front a moment ago, kept before this panel becomes the
        # front window itself. The picker needs it to choose a link's shape, and
        # asking after it is open answers "Talaria" — the trap `link.ts`
        # documents under `--for`.
        was_in_front = None
        if action == "reference":
            front = self.frontmost.current
            was_in_front = front.window_class or front.resource_name if front else None

        if panel is None:
            panel = self._build(action)
            if panel is None:
                return
            self.panels[action] = panel
        panel.summon()
        if action == "proposals":
            panel.view.page().runJavaScript("window.proposalsRefresh && window.proposalsRefresh()")
        if action == "reference":
            import json as _json

            told = _json.dumps(was_in_front)
            panel.view.page().runJavaScript(f"window.pickFor && window.pickFor({told})")

    # --------------------------------------------------------------- krunner

    def _open_from_runner(self, url: str) -> None:
        """
        A result was chosen in KDE's search box.

        Through `_opened` rather than around it, so a block lands in the Hermes
        window and somebody's website lands in a browser — the same split every
        other surface here gets, decided in one place. `"krunner"` names no
        panel of ours, which is exactly right: there is nothing of ours on
        screen to step out of the way.
        """
        self._opened(QUrl(url), "krunner")

    def _note(self, title: str, body: str) -> None:
        """
        A word from the search box, where there is no window to put one in.

        The tray rather than `_complain`'s dialog: by the time this fires
        KRunner has closed and nothing of ours is on screen, and a modal that
        appears over whatever you turned to next has to be dismissed before you
        can carry on. Neither of the two things it says is worth that.
        """
        self.tray.showMessage(title, body, self._icon(), 4000)

    @staticmethod
    def _put_from_runner(text: str, paste: bool) -> None:
        """A rendered link, onto the clipboard and optionally into the window."""
        if paste:
            scheme._insert(text)
            return
        board = QApplication.instance().clipboard()
        if board is not None:
            board.setText(text)

    # --------------------------------------------------------------- ambient

    def _ambient(self, window) -> None:
        """
        Glance follows what you are looking at.

        AMBIENT's third capability, and the whole of it: "not a search box you
        invoke — a surface that is always showing what the library knows about
        what you are looking at, **redrawn on the context signal rather than on a
        timer**."

        The Mac cannot do that and says so: it polls every four seconds because
        "nothing on this machine emits a 'the focused document changed' event".
        KWin emits one. So this is the same feature arriving by the route the
        design asked for, and the reason it is a signal here and a timer there is
        the desktop, not the intent.

        **Only while something is showing it.** A panel nobody has open is not
        ambient, it is a background job reading windows — which is the one thing
        this must never be.

        **And never with a synthetic copy.** Rung 6 presses keys in somebody
        else's window; doing that every time the focus moves would be a hand
        reaching across the desk all day. It is for the moment you *asked*, which
        is the first read after a summon — the Mac draws the same line, allowing
        a copy on `startFollowing` and not on the timer that follows it.
        """
        if not self._following():
            return
        # A burst of changes is one gesture — alt-tabbing through five windows is
        # not five questions. Read when it settles.
        self._ambient_at = window
        self._ambient_timer.start(450)

    def _following(self) -> bool:
        glance = self.panels.get("glance")
        desk = self.panels.get("desk")
        return bool((glance and glance.isVisible()) or (desk and desk.isVisible()))

    def _ambient_read(self) -> None:
        window = getattr(self, "_ambient_at", None)
        if not self._following():
            return
        self._reading(
            lambda reading, w=window: self._ambient_drew(w, reading),
            window,
            allow_copy=False,
        )

    def _ambient_drew(self, window, reading) -> None:
        if not self._following():
            return
        print(
            f"talaria: ambient — front={window.name if window else 'unknown'} "
            f"rung={reading.rung} chars={len(reading.text or '')}",
            file=sys.stderr, flush=True,
        )
        panel = self.panels.get("glance")
        if panel is not None and panel.isVisible():
            self._glance(panel, reading)
        # The desk's own Glance is a frame, which `runJavaScript` cannot reach;
        # the desk relays it, the way it relays frosting.
        desk = self.panels.get("desk")
        if desk is not None and desk.isVisible():
            self._glance(desk, reading, relay=True)

    # ---------------------------------------------------------------- glance

    def _ask_our_own(self, then) -> None:
        """
        Rung 2: what one of *our* windows is showing.

        The Mac takes this rung through its own JS bridge and this is the same
        move, but it matters more here because of the desk. `frontmost.py`
        ignores Talaria's own windows on purpose — a window source that answers
        "Talaria" to "what were you doing?" is wrong — so with the desk up,
        every rung below is describing whatever was in front before it opened.
        Text selected on the desk read the window behind it.

        The desk wins when it is visible, because it is full screen and frosted
        over everything: if it is up, it is what somebody is looking at.
        Otherwise the ordinary panel that has focus, and usually neither, in
        which case this costs one dictionary lookup and the ladder runs as it
        always did.
        """
        found_key, panel = None, None
        desk = self.panels.get("desk")
        if desk is not None and desk.isVisible():
            found_key, panel = "desk", desk
        else:
            for key, other in self.panels.items():
                if key != "glance" and other.isVisible() and other.isActiveWindow():
                    found_key, panel = key, other
                    break
        if panel is None:
            print("talaria: rung 2 — none of our windows is showing", file=sys.stderr, flush=True)
            then(None, None)
            return

        def answered(raw, key=found_key):
            import json as _json

            try:
                found = _json.loads(raw) if isinstance(raw, str) and raw else None
            except ValueError:
                found = None
            # What it found and where, never what it says. Rung 2 was silent
            # until it went wrong, and "Glance is not reading the desk" is not a
            # thing anybody can debug from the outside: the harvest either found
            # the surface or it did not, and only this knows which.
            said = found.get("text") if isinstance(found, dict) else None
            how = (found.get("error") or found.get("how")) if isinstance(found, dict) else "nothing"
            print(
                f"talaria: rung 2 — {key} how={how} chars={len(said or '')}",
                file=sys.stderr, flush=True,
            )
            then(found, key)

        panel.view.page().runJavaScript(_harvest(), answered)

    def _reading(self, then, window, allow_copy: bool) -> None:
        """
        Climb the ladder on a worker, and hand the answer back here.

        The reader is held on `self` for the length of the read: a `QObject`
        whose only Python reference is a local goes away when the method
        returns, taking the signal that was about to be emitted with it.
        """
        reader = Reader()
        self._readers.append(reader)

        def landed(reading, r=reader) -> None:
            if r in self._readers:
                self._readers.remove(r)
            then(reading)

        reader.done.connect(landed, Qt.ConnectionType.QueuedConnection)
        reader.read(
            window=window,
            allow_copy=allow_copy,
            asked=allow_copy,
            changed_at=self.frontmost.selection.changed_at,
            focused_at=self.frontmost.focused_at,
            clock_blind=self.frontmost.selection.blind,
        )

    def _summon_glance(self, found, from_key) -> None:
        """The reading, then the panel — in that order, and never the reverse."""
        if isinstance(found, dict) and str(found.get("text") or "").strip():
            # The short name, which is the one on the hotkey toast. The window
            # title is "Talaria — Desk" and this sentence is already inside
            # Talaria.
            where = SHORT.get(from_key, from_key or "a Talaria window")
            return self._glance_read(glance.Reading(
                text=str(found["text"]),
                rung="our own window",
                why=(f"selected in {where}" if found.get("how") == "selected"
                     else f"everything showing in {where}"),
            ))
        # `allow_copy` for this read and no other. Glance is summoned, reads
        # once, and shows what it found — there is no poll here to hijack the
        # clipboard on, which is the fence the Mac has to state explicitly
        # because it re-reads every four seconds while open.
        #
        # Off the GUI thread — see `Reader` — and the panel is opened by the
        # callback, which keeps the order this method exists for: the reading is
        # taken before anything of ours is in front.
        self._reading(self._glance_read, self.frontmost.current, allow_copy=True)

    def _glance_read(self, reading) -> None:
        # What it looked at and where it got it, but never the text itself:
        # this is a log, and the text is the user's document.
        front = self.frontmost.current
        print(
            f"talaria: glance — front={front.name if front else 'unknown'} "
            f"rung={reading.rung} chars={len(reading.text or '')} why={reading.why}",
            file=sys.stderr, flush=True,
        )

        panel = self.panels.get("glance")
        if panel is None:
            panel = self._build("glance")
            if panel is None:
                return
            self.panels["glance"] = panel
        panel.summon()
        self._glance(panel, reading)

    #: Rungs that found text somebody *chose*. A window title or the whole of a
    #: focused field is a fine thing to tell Glance about and a bad thing to put
    #: in a new block: neither was selected, and one of them is a filename.
    CHOSEN = {"accessibility", "synthetic copy", "primary selection"}

    def _summon_compose(self, found, from_key) -> None:
        """
        New Block, with what you were looking at already in it.

        The panel first and the text after, which is the reverse of Glance's
        order and is not an inconsistency: Glance's panel *is* the reading, so
        showing it before it has one would show an empty window. This one is a
        form that stands on its own, and the text is an improvement to it.
        """
        # Our own window, and only when something was actually selected in it —
        # "everything showing in the desk" is not a block. A harvest that found
        # the desk but no selection falls through to the ladder rather than
        # stopping here, which is the difference between "nothing was selected
        # in Talaria" and "nothing was selected".
        if isinstance(found, dict) and found.get("how") == "selected" and str(found.get("text") or "").strip():
            return self._compose_show(str(found["text"]), "our own window")
        self._reading(self._compose_read, self.frontmost.current, allow_copy=True)

    def _compose_read(self, reading) -> None:
        """The ladder answered. Only text somebody chose goes in a new block."""
        usable = reading.usable and reading.rung in self.CHOSEN
        self._compose_show(reading.text if usable else None, reading.rung)

    def _compose_show(self, text, rung) -> None:
        # What it looked at and which rung answered, never the text itself.
        front = self.frontmost.current
        print(
            f"talaria: compose — front={front.name if front else 'unknown'} "
            f"rung={rung} used={bool(text)} chars={len(text or '')}",
            file=sys.stderr, flush=True,
        )

        panel = self.panels.get("compose")
        if panel is None:
            panel = self._build("compose")
            if panel is None:
                return
            self.panels["compose"] = panel
        panel.summon()
        if text:
            import json

            # Through `runJavaScript` rather than a URL, for the reason `_glance`
            # gives: the argument is the user's selected text. Once the page has
            # loaded — see `Panel.when_loaded`.
            script = f"window.composeWith && window.composeWith({json.dumps(text)})"
            panel.when_loaded(lambda: panel.view.page().runJavaScript(script))

    def _glance(self, panel: Panel, reading, relay: bool = False) -> None:
        """
        Tell the panel what was read.

        The reading is taken in `toggle`, before this panel exists on screen —
        see the note there.

        The rungs are subprocesses and an accessibility tree, so the shell
        climbs the ladder and hands the answer down — through `runJavaScript`
        rather than a URL, because the argument is the user's selected text.
        """
        import json

        # The three Glance settings travel with the reading. The page cannot
        # read `config.json` — it has no filesystem — and the daemon does not
        # apply them either: on the Mac they are the *reader's* preferences
        # about how an answer is arranged, not part of the answer.
        settings = {}
        try:
            with open(os.path.join(os.path.dirname(daemon.socket_path()), "config.json"),
                      encoding="utf8") as handle:
                raw = json.load(handle)
            settings = {
                "threshold": float(raw.get("glanceThreshold") or 0),
                "separateDone": bool(raw.get("glanceSeparateDone")),
                "undatedFurtherOut": bool(raw.get("glanceUndatedFurtherOut")),
                # Clamped rather than trusted: zero would fold away everything
                # dated, including today's.
                "horizon": min(365, max(1, int(raw.get("glanceHorizonDays") or 21))),
            }
        except Exception:  # noqa: BLE001
            settings = {"threshold": 0, "separateDone": False,
                        "undatedFurtherOut": False, "horizon": 21}

        payload = json.dumps({
            "text": reading.text, "rung": reading.rung, "why": reading.why,
            "settings": settings,
        })

        def ask() -> None:
            call = "window.glanceRelay" if relay else "window.glanceAsk"
            panel.view.page().runJavaScript(f"{call} && {call}({payload})")

        # The page may still be loading on the first summon; asking a blank
        # document does nothing and leaves the panel saying it is waiting.
        panel.when_loaded(ask)

    def _build(self, action: str) -> Panel | None:
        title, page, _hotkey = PANELS[action]
        if page is None:
            origin = daemon.origin()
            if not origin:
                self._complain(
                    "Talaria can't reach the daemon",
                    "So it doesn't know where Hermes lives.\n\n"
                    "Check it with:  systemctl --user status talaria",
                )
                return None
            # The Hermes window follows Hermes' own links itself — it *is* the
            # browser for them. Only somebody else's website is handed on.
            return Panel(title, QUrl(origin), QSize(1200, 850),
                         route=lambda url: self._opened(url, "hermes"), floating=False)
        # Sized to what each one is for, rather than one number for all of
        # them. Glance is a narrow list you read down; the composer is a form;
        # a board wants width for its columns.
        # Small, because these are summoned over your work rather than places
        # to live in. A hotkey panel filling the screen is a context switch; one
        # that takes a corner is a glance.
        if action == "desk":
            # Full screen, and deliberately *not* stays-on-top.
            #
            # The other panels keep that flag, so Glance and Ask and New Block
            # come up above the desk rather than behind it — which is the whole
            # arrangement asked for: the desk is a surface you put things on.
            screen = QApplication.primaryScreen().availableGeometry()
            panel = Panel(title, QUrl(f"{scheme.ORIGIN}/ui/{page}"),
                          QSize(screen.width(), screen.height()),
                          route=lambda url, a=action: self._opened(url, a))
            panel.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, False)
            # **And it does not go away when something else takes focus.**
            #
            # The desk looks like a panel — frameless, translucent, drawing its
            # own frosted sheet — so it is built as one, and inherited the rule
            # that a summoned thing dismisses itself when you look elsewhere.
            # That rule is right for Glance and wrong here, and the wrongness
            # was invisible: pressing the Glance key over the desk summoned
            # Glance, Glance took focus, and the desk underneath it vanished. A
            # KWin probe found exactly one Talaria window in the stack at any
            # moment, which is not what "the desk is a surface you put things
            # on" means.
            panel.dismisses = False
            return panel

        size = {
            "proposals": QSize(620, 460),
            "reference": QSize(560, 420),
            "glance": QSize(680, 380),
            "assistant": QSize(720, 460),
            "compose": QSize(620, 500),
        }.get(action, QSize(1080, 560))
        return Panel(title, QUrl(f"{scheme.ORIGIN}/ui/{page}"), size,
                     route=lambda url, a=action: self._opened(url, a))

    def _opened(self, url: QUrl, source: str) -> bool:
        """
        Something was opened. Put it where it belongs, then get out of the way.

        A port of `Opener` and the `didOpen` observer in `main.swift`, including
        the reasoning the observer is written around: "A panel is a way of
        getting somewhere. Once you have gone, it has done its job and should
        get out of the way rather than sit in front of what it just opened."

        Where it belongs is the split the Mac makes too — a block in this
        library opens in the Hermes window, and anything else is somebody's
        website and belongs in a browser.
        """
        origin = daemon.origin()
        ours = bool(origin) and url.toString().startswith(origin)

        if ours and source == "hermes":
            # Already where it belongs. Left to the view so Hermes stays a web
            # app: intercepting its own links would make every one of them a
            # fresh page load with the scroll and the session thrown away.
            return False

        if ours:
            panel = self.panels.get("hermes") or self._build("hermes")
            if panel is None:
                return True  # complained already; going nowhere is the answer
            self.panels["hermes"] = panel
            panel.view.load(url)
            panel.summon()
        else:
            subprocess.Popen(["xdg-open", url.toString()], start_new_session=True)

        # The panel that offered the link steps back. Not the Hermes window,
        # which is what was just asked for.
        if source != "hermes":
            offered = self.panels.get(source)
            if offered is not None:
                offered.hide()
        return True

    # -------------------------------------------------------------- plumbing

    def _settings(self) -> None:
        """
        The settings window, carrying every field the Mac panel has.

        Held rather than rebuilt so a second summon returns to the same window
        instead of stacking another one behind it.
        """
        from settings import SettingsWindow

        if self._settings_window is None:
            self._settings_window = SettingsWindow()
            # A saved config means a restarted daemon, so anything already on
            # screen is reading from a socket that just went away and came back.
            self._settings_window.saved.connect(self._reload_panels)
        self._settings_window.show()
        self._settings_window.raise_()
        self._settings_window.activateWindow()

    def _reload_panels(self) -> None:
        # The daemon takes a moment to bind its socket again; reloading into the
        # gap shows every panel an error it will then keep.
        QTimer.singleShot(2500, lambda: [p.view.reload() for p in self.panels.values()])

    def _refresh(self) -> None:
        try:
            daemon.request("POST", "/sync", b"{}", timeout=30.0)
        except Exception as err:  # noqa: BLE001
            self._complain("Couldn't refresh", str(err))
            return
        for panel in self.panels.values():
            panel.view.reload()

    def _report_shortcuts(self) -> None:
        """
        Say what the portal *refused*, and nothing else.

        A hotkey that silently did not bind is the failure mode this whole
        surface has — you press it, nothing happens, and there is nowhere to
        look — so that still earns a notification. What does not is the list of
        the ones that worked: it appeared on every start, said the same eight
        things every time, and by the second day it was a popup to dismiss
        rather than a thing to read. The bindings are printed to the journal on
        every start regardless, which is where you go when one of them is
        missing.
        """
        if self.shortcuts.failures:
            self.tray.showMessage(
                "Talaria: some hotkeys didn't take",
                "\n".join(self.shortcuts.failures),
                QSystemTrayIcon.MessageIcon.Warning,
                10000,
            )

    def _complain(self, title: str, body: str) -> None:
        QMessageBox.warning(None, title, body)


# One name for the running shell, so a second launch talks to the first rather
# than becoming a second tray icon.
IPC_NAME = "talaria-shell"


def forward(action: str) -> bool:
    """
    Hand an action to the running shell, if there is one.

    This exists so hotkeys work even where the portal does not. A person can
    bind `talaria-shell --toggle board` in System Settings by hand and get the
    same behavior, which is the arrangement the brief predicted: the shortcut is
    configuration, and the only code needed is somewhere for it to land.
    """
    client = QLocalSocket()
    client.connectToServer(IPC_NAME)
    if not client.waitForConnected(500):
        return False
    client.write(action.encode("utf8"))
    client.flush()
    client.waitForBytesWritten(500)
    client.disconnectFromServer()
    return True


def only_one() -> object | None:
    """
    Refuse to be the second copy.

    `_listen` reasons that a live instance would have answered `forward` and
    this process would never have reached it — which is true of `--toggle` and
    not of an ordinary start, because that path never asks. So a second launch
    used to take the socket name over and sit there as a second tray icon,
    identical to the first. Autostart plus one manual launch is all it takes.

    A lock file under the runtime directory rather than a D-Bus name: that
    directory is cleared when the session ends, so a copy that was killed rather
    than quit leaves nothing to be tidied by hand before the next start, and
    `QLockFile` already treats a lock held by a dead pid as stale.
    """
    from PySide6.QtCore import QLockFile, QStandardPaths

    runtime = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.RuntimeLocation)
    lock = QLockFile(os.path.join(runtime or "/tmp", "talaria-shell.lock"))
    lock.setStaleLockTime(0)
    return lock if lock.tryLock(100) else None


#: The one profile every page in the shell uses. Held for the life of the
#: process — a profile collected while a page still points at it takes the page
#: with it.
def _save_as(download) -> None:
    """
    Somewhere to put a file the page is handing over.

    The canvas saves a document by offering it as a download, which is the one
    mechanism a page has for producing a file. Without this the offer is
    declined in silence: Qt cancels every download a profile does not accept,
    and "Save…" looks like a button that does nothing.

    A dialog rather than a fixed directory, because this is Save *As* — the Mac
    puts up the same panel and lets somebody say where their canvas lives. The
    suggested name is whatever the page asked for.
    """
    from PySide6.QtWidgets import QFileDialog

    # What was offered and from where. A download that never arrives and a
    # dialog that never opens look identical from outside the process.
    print(
        f"talaria: download — {download.suggestedFileName()!r}",
        file=sys.stderr, flush=True,
    )
    suggested = os.path.join(
        QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DocumentsLocation)
        or os.path.expanduser("~"),
        download.suggestedFileName() or "canvas.json",
    )
    where, _filter = QFileDialog.getSaveFileName(None, "Save", suggested)
    if not where:
        # Dismissed, which is a decision and not a failure — the Mac's words for
        # the same moment.
        download.cancel()
        return
    download.setDownloadDirectory(os.path.dirname(where))
    download.setDownloadFileName(os.path.basename(where))
    download.accept()


def hypr_binds() -> int:
    """
    Print the `bind` lines Hyprland needs, and say nothing else.

    **Why this is a thing you run rather than something Talaria does.** Hotkeys
    go through `org.freedesktop.portal.GlobalShortcuts` on both desktops, but
    the two implementations divide the work differently: KDE's portal asks you
    to press a key and stores the binding, while Hyprland's leaves the key to
    the compositor's own config. So Talaria registers the same shortcuts either
    way, and on Hyprland one line per shortcut has to reach `hyprland.conf`.

    Printed rather than written. That file is the user's, the distributions
    assemble it differently — Omarchy keeps Hyprland's own syntax, Ryoku writes
    its desktop in Lua — and a tool that edits it behind somebody is a tool that
    eventually eats their setup.
    """
    from wm import hypr

    print("# Talaria's hotkeys. Add these to hyprland.conf (or source this file")
    print("# from it), then reload with:  hyprctl reload")
    for action, (_title, _page, default) in PANELS.items():
        line = hypr.bind_line(action, config_hotkey(action, default))
        if line:
            print(line)
    return 0


def main() -> int:
    if "--hypr-binds" in sys.argv:
        return hypr_binds()

    if "--toggle" in sys.argv:
        action = sys.argv[sys.argv.index("--toggle") + 1]
        # QLocalSocket needs an application object but not a window; this path
        # must never start a web engine, because it is on the hot end of a
        # keypress and QtWebEngine takes the best part of a second to come up.
        QApplication(sys.argv)
        if forward(action):
            return 0
        print("talaria: the shell isn't running", file=sys.stderr)
        return 1

    # Before any profile exists — see the note in `scheme.register_scheme`.
    scheme.register_scheme()
    app = QApplication(sys.argv)
    app.setApplicationName("Talaria")
    app.setDesktopFileName("dev.talaria.shell")
    # Without this every window gets the desktop's placeholder — the stray
    # letter in the corner of each panel. `Icon=talaria` in the desktop entry
    # only helps once an icon by that name is installed in a theme, which this
    # is not, so the file is named directly.
    icon = QIcon(os.path.join(HERE, "..", "..", "app", "glyph-1024.png"))
    if not icon.isNull():
        app.setWindowIcon(icon)
    # The tray is the application; the last window closing is not the end of it.
    app.setQuitOnLastWindowClosed(False)

    if not QSystemTrayIcon.isSystemTrayAvailable():
        # Said, and carried on. This used to be fatal, which was right when the
        # only desktop was Plasma — it always has a tray, so its absence meant
        # something was badly wrong. Hyprland has no tray of its own: it comes
        # from whichever bar the distribution ships, and a session without one
        # is an ordinary setup rather than a broken one. The hotkeys are the
        # main entrance anyway; what is lost without a tray is the menu and the
        # balloons, which is worth a line on stderr and not a refusal to start.
        print("talaria: no system tray on this session — the menu will be "
              "unreachable, but the hotkeys still work", file=sys.stderr, flush=True)

    # Before the tray, so a second icon never appears even briefly. A second
    # copy asked to start is told to go away rather than treated as an error —
    # "it is already running" is the outcome the person wanted.
    lock = only_one()
    if lock is None:
        print("talaria: already running", file=sys.stderr)
        return 0

    handler = scheme.DaemonScheme(app)
    from PySide6.QtWebEngineCore import QWebEngineProfile

    the_profile = webprofile.get(app)
    the_profile.installUrlSchemeHandler(scheme.SCHEME, handler)
    the_profile.downloadRequested.connect(_save_as)

    shell = Shell(app)
    _ = shell, lock  # both held for the life of the event loop
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
