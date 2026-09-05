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

from PySide6.QtCore import QObject, QSettings, QSize, QStandardPaths, Qt, QUrl, QTimer
from PySide6.QtGui import QAction, QActionGroup, QIcon, QKeySequence, QPainter, QPixmap, QShortcut
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWebEngineCore import QWebEnginePage
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication, QMenu, QMessageBox, QSystemTrayIcon, QVBoxLayout, QWidget

import daemon
import glance
import scheme
from frontmost import Frontmost
from shortcuts import Shortcuts

HERE = os.path.dirname(os.path.abspath(__file__))

# Title, page, default hotkey. The hotkeys mirror the Mac's defaults so a person
# with both machines has one set of fingers; `glance` is absent because it is
# not built here and a hotkey for nothing is worse than no hotkey.
PANELS = {
    "board": ("Hermes Notes Collections", "board.html", "shift+alt+c"),
    "assistant": ("Ask Hermes Notes", "assistant.html", "shift+alt+a"),
    "compose": ("New Block", "compose.html", "shift+alt+h"),
    # No counterpart on the Mac, which reaches Hermes through the menu only. It
    # earns one here because on Linux this window is also where a `talaria://`
    # deep link would land.
    "hermes": ("Hermes Notes", None, "shift+alt+o"),
    "glance": ("Glance", "glance.html", "shift+alt+g"),
}


#: Short names, for the one place a long one does not fit.
#:
#: The menu keeps the Mac's wording — "Hermes Notes Collections" — because that
#: is what it is called and a menu has room. A notification does not: five
#: entries at that length wrap, and a wrapped list is harder to read than the
#: five words it was trying to spell out.
SHORT = {
    "board": "Collections",
    "assistant": "Ask",
    "compose": "New Block",
    "hermes": "Hermes",
    "glance": "Glance",
}


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

    def __init__(self, route, parent=None) -> None:
        super().__init__(parent)
        self._route = route

    def acceptNavigationRequest(self, url: QUrl, kind, is_main_frame: bool) -> bool:  # noqa: N802
        # The route says whether it took the link. When it did not — the Hermes
        # window following one of Hermes' own links — the view navigates
        # normally, which keeps it a working web app rather than a series of
        # full page loads driven from Python.
        if url.scheme() in ("http", "https") and self._route(url):
            return False
        return super().acceptNavigationRequest(url, kind, is_main_frame)


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
            self.view_is_panel = True
            # `hidesOnDeactivate = false` on the Mac, and the same intent here:
            # stepping into another window to read something must not take the
            # panel away, because reading something else is usually the point.
            self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
        self.setWindowTitle(f"Talaria — {title}")
        self.resize(size)
        self.view = QWebEngineView(self)
        if route is not None:
            # Held on the view: a page the widget does not own is collected out
            # from under the engine, which is the same lifetime trap as the
            # request jobs in `scheme.py`.
            self._page = RoutedPage(route, self.view)
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

        if (
            e.type() == QEvent.Type.WindowDeactivate
            and getattr(self, "view_is_panel", False)
            and self.isVisible()
        ):
            # Deferred: a deactivation arrives while a menu or a file dialog of
            # our own is opening too, and hiding underneath one of those makes
            # the panel vanish mid-interaction.
            QTimer.singleShot(120, self._hide_if_still_inactive)
        return super().event(e)

    def _hide_if_still_inactive(self) -> None:
        if not self.isActiveWindow():
            self.hide()

    def summon(self) -> None:
        """
        Show, raise and focus — centred on the screen the pointer is on.

        The Mac positions the assistant and compose panels near the top of that
        screen rather than dead centre, "where a prompt belongs, rather than
        dead center over whatever is being read". Wayland does not let a client
        place its own windows, so that intent is the compositor's to honour and
        this asks for nothing.
        """
        self.show()
        self.raise_()
        self.activateWindow()


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
        self.app = app
        self.settings = QSettings("talaria", "shell")
        self.panels: dict[str, Panel] = {}
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
        The menu bar mark, in a color the panel can actually show.

        `MenuBar.svg` is a template: one path, filled `#000000`, meant for macOS
        to invert for a dark menu bar. Handed to Plasma unchanged it is a black
        feather on a dark panel — which is exactly as invisible as no icon at
        all, and is worse than the drawn letter it replaced, because at least
        the letter was white.

        So it is recolored to the palette's own text color before it is loaded.
        That is one substitution rather than shipping two files, and it follows
        a theme change for free the next time the shell starts.
        """
        # The application's own glyph first, and this is the Linux convention
        # rather than a compromise. A macOS menu bar item is a monochrome
        # template the system inverts; a Plasma tray takes a full-color icon and
        # renders it as given. There is no reliable way to ask what color *the
        # panel* is — the application palette answers for windows, and a light
        # theme with a dark panel is an ordinary setup — so an icon that depends
        # on guessing that is an icon that is sometimes invisible.
        glyph = os.path.join(HERE, "..", "..", "app", "glyph-1024.png")
        if os.path.isfile(glyph):
            icon = QIcon(glyph)
            if not icon.isNull():
                return icon

        # Failing that, the mark, recolored — better than nothing and better
        # than black-on-black, which is what shipping `MenuBar.svg` unchanged
        # gave: a template meant for a system that inverts it, handed to one
        # that does not.
        svg = os.path.join(HERE, "..", "..", "app", "MenuBar.svg")
        ink = QApplication.palette().windowText().color().name()
        if os.path.isfile(svg):
            try:
                with open(svg, encoding="utf8") as handle:
                    body = handle.read()
                body = body.replace('fill="#000000"', f'fill="{ink}"')
                # Written beside the runtime state rather than into the repo:
                # this is a rendering of the source, not a second source.
                out = os.path.join(
                    QStandardPaths.writableLocation(QStandardPaths.StandardLocation.RuntimeLocation)
                    or "/tmp",
                    "talaria-tray.svg",
                )
                with open(out, "w", encoding="utf8") as handle:
                    handle.write(body)
                icon = QIcon(out)
                # `isNull` only. A scalable icon reports no available sizes —
                # that is what scalable means — so asking for one rejects every
                # SVG there is.
                if not icon.isNull():
                    return icon
            except OSError:
                pass

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
        # `allow_copy` for this read and no other. Glance is summoned, reads
        # once, and shows what it found — there is no poll here to hijack the
        # clipboard on, which is the fence the Mac has to state explicitly
        # because it re-reads every four seconds while open.
        reading = (
            glance.read(
                self.frontmost.current,
                allow_copy=True,
                changed_at=self.frontmost.selection.changed_at,
                focused_at=self.frontmost.focused_at,
            )
            if action == "glance"
            else None
        )
        if reading is not None:
            # What it looked at and where it got it, but never the text itself:
            # this is a log, and the text is the user's document.
            front = self.frontmost.current
            print(
                f"talaria: glance — front={front.name if front else 'unknown'} "
                f"rung={reading.rung} chars={len(reading.text or '')} why={reading.why}",
                file=sys.stderr, flush=True,
            )

        if panel is None:
            panel = self._build(action)
            if panel is None:
                return
            self.panels[action] = panel
        panel.summon()
        if reading is not None:
            self._glance(panel, reading)

    def _glance(self, panel: Panel, reading) -> None:
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
            }
        except Exception:  # noqa: BLE001
            settings = {"threshold": 0, "separateDone": False, "undatedFurtherOut": False}

        payload = json.dumps({
            "text": reading.text, "rung": reading.rung, "why": reading.why,
            "settings": settings,
        })

        def ask() -> None:
            panel.view.page().runJavaScript(f"window.glanceAsk && window.glanceAsk({payload})")

        # The page may still be loading on the first summon; asking a blank
        # document does nothing and leaves the panel saying it is waiting.
        if panel.view.url().isEmpty():
            panel.view.loadFinished.connect(lambda _ok: ask())
        else:
            ask()

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
        size = {
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
        Say what the portal granted, through the tray rather than into a log.

        Both halves matter. A hotkey that silently did not bind is the failure
        mode this whole surface has — you press it, nothing happens, and there is
        nowhere to look. And a hotkey the portal *changed* is worth knowing about
        too, since the trigger it granted need not be the one that was asked for.
        """
        if self.shortcuts.failures:
            self.tray.showMessage(
                "Talaria: some hotkeys didn't take",
                "\n".join(self.shortcuts.failures),
                QSystemTrayIcon.MessageIcon.Warning,
                10000,
            )
        elif self.shortcuts.bound:
            # One per line, and the key first.
            #
            # This was a single comma-joined sentence, which a Plasma
            # notification elides — so the last entry lost its name and read as
            # a bare keystroke belonging to nothing. A list is also simply
            # easier to scan than prose when every item has the same shape.
            #
            # Ordered by PANELS rather than by whatever the portal happened to
            # return, so the same list appears in the same order every start.
            lines = [
                f"{self.shortcuts.bound[a]}  —  {SHORT.get(a, PANELS[a][0])}"
                for a in PANELS
                if self.shortcuts.bound.get(a)
            ]
            if lines:
                self.tray.showMessage(
                    "Talaria hotkeys",
                    "\n".join(lines),
                    QSystemTrayIcon.MessageIcon.Information,
                    6000,
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


def main() -> int:
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
        print("talaria: no system tray on this session", file=sys.stderr)
        return 1

    # Before the tray, so a second icon never appears even briefly. A second
    # copy asked to start is told to go away rather than treated as an error —
    # "it is already running" is the outcome the person wanted.
    lock = only_one()
    if lock is None:
        print("talaria: already running", file=sys.stderr)
        return 0

    handler = scheme.DaemonScheme(app)
    from PySide6.QtWebEngineCore import QWebEngineProfile

    QWebEngineProfile.defaultProfile().installUrlSchemeHandler(scheme.SCHEME, handler)

    shell = Shell(app)
    _ = shell, lock  # both held for the life of the event loop
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
