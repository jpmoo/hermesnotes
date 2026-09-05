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
import sys

from PySide6.QtCore import QSettings, QSize, Qt, QUrl, QTimer
from PySide6.QtGui import QAction, QActionGroup, QIcon, QKeySequence, QPainter, QPixmap, QShortcut
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication, QMenu, QMessageBox, QSystemTrayIcon, QVBoxLayout, QWidget

import daemon
import scheme
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


class Panel(QWidget):
    """
    A window around a web view.

    Escape hides rather than closes, and closing hides too: these are summoned
    things, and rebuilding a web view per summon would throw away the page's
    scroll position, its half-typed message and its session every time.
    """

    def __init__(self, title: str, url: QUrl, size: QSize) -> None:
        super().__init__()
        self.setWindowTitle(f"Talaria — {title}")
        self.resize(size)
        self.view = QWebEngineView(self)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.view)
        self.view.load(url)
        QShortcut(QKeySequence("Escape"), self, activated=self.hide)

    def closeEvent(self, event) -> None:  # noqa: N802 — Qt's name
        event.ignore()
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


class Shell:
    def __init__(self, app: QApplication) -> None:
        self.app = app
        self.settings = QSettings("talaria", "shell")
        self.panels: dict[str, Panel] = {}
        self._settings_window = None
        self.tray = QSystemTrayIcon()
        self.tray.setIcon(self._icon())
        self.tray.setToolTip("Talaria")
        self.tray.activated.connect(self._activated)
        self.tray.setContextMenu(self._menu())
        self.tray.show()

        self._listen()

        self.shortcuts = Shortcuts()
        self.shortcuts.pressed.connect(self.toggle)
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
        The menu bar mark.

        `MenuBar.svg` beside the Mac app is the same one path, and Qt renders SVG
        only with the svg module present — so this falls back to a drawn glyph
        rather than to an empty space where the tray item should be. A tray icon
        that fails to load is an application the user cannot find.
        """
        svg = os.path.join(HERE, "..", "..", "app", "MenuBar.svg")
        if os.path.isfile(svg):
            icon = QIcon(svg)
            if not icon.isNull() and icon.availableSizes():
                return icon
        pixmap = QPixmap(22, 22)
        pixmap.fill(Qt.GlobalColor.transparent)
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(Qt.GlobalColor.white)
        font = painter.font()
        font.setPixelSize(16)
        font.setBold(True)
        painter.setFont(font)
        painter.drawText(pixmap.rect(), Qt.AlignmentFlag.AlignCenter, "T")
        painter.end()
        icon = QIcon(pixmap)
        icon.setIsMask(True)  # let Plasma tint it for the panel's theme
        return icon

    # ------------------------------------------------------------------ menu

    def _menu(self) -> QMenu:
        menu = QMenu()
        menu.addAction(self._act("Open Hermes Notes", lambda: self.toggle("hermes")))
        menu.addSeparator()
        menu.addAction(self._act("Ask Hermes Notes", lambda: self.toggle("assistant")))
        menu.addAction(self._act("Hermes Notes Collections", lambda: self.toggle("board")))
        glance = self._act("Glance", lambda: None)
        glance.setEnabled(False)
        glance.setToolTip("Not built on Linux yet — it is the last step of the port")
        menu.addAction(glance)
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
        if panel is None:
            panel = self._build(action)
            if panel is None:
                return
            self.panels[action] = panel
        panel.summon()

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
            return Panel(title, QUrl(origin), QSize(1200, 850))
        return Panel(title, QUrl(f"{scheme.ORIGIN}/ui/{page}"), QSize(980, 720))

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
            named = ", ".join(
                f"{PANELS[a][0]}: {t}" for a, t in self.shortcuts.bound.items() if a in PANELS and t
            )
            if named:
                self.tray.showMessage("Talaria hotkeys", named, QSystemTrayIcon.MessageIcon.Information, 6000)

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
