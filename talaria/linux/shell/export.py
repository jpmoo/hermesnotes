"""
Turning a canvas into a picture, or into a page.

The Mac prints its canvas from its own drawing code — `CanvasPrint.swift` walks
the items and draws them again into a PDF context. Nothing here can do that: the
canvas is a web page, and its drawing lives in a browser.

So the browser draws it, and Qt takes the picture. A second, off-screen view
loads the same canvas page with `?export=1`, which hides every piece of chrome
and fits the whole document into the window; then the view is sized to the
content and either grabbed as a PNG or printed to a PDF. What comes out is what
the canvas looks like, because it *is* the canvas, rendered by the same code at
a different size.

Off-screen rather than hidden: a widget that has never been shown has nothing to
grab, and a window moved far off the desktop is the cheapest way to have one
without putting it in front of somebody.
"""

from __future__ import annotations

import os

from PySide6.QtCore import QPoint, QSize, QTimer, QUrl, Qt
from PySide6.QtWidgets import QFileDialog
from PySide6.QtWebEngineWidgets import QWebEngineView

import scheme

#: How much room to leave around the drawing, in canvas points.
MARGIN = 40
#: A ceiling, because a canvas can be enormous and a bitmap of one can be
#: enormous squared. Wide enough for a poster and small enough to survive being
#: made.
MAX_EDGE = 6000


def canvas(kind: str, done=None) -> None:
    """Export the canvas as `png` or `pdf`, asking where to put it."""
    suggested = os.path.join(
        os.path.expanduser("~"),
        f"canvas.{'pdf' if kind == 'pdf' else 'png'}",
    )
    where, _filter = QFileDialog.getSaveFileName(None, f"Export {kind.upper()}", suggested)
    if not where:
        if done:
            done(None)
        return

    view = QWebEngineView()
    view.setAttribute(Qt.WidgetAttribute.WA_DontShowOnScreen, False)
    view.setWindowFlag(Qt.WindowType.Tool, True)
    view.resize(1400, 900)
    # Far enough off that no desktop shows it, and still a real window with a
    # backing store — which is what `grab` needs.
    view.move(QPoint(-20000, -20000))
    view.show()
    view.load(QUrl(f"{scheme.ORIGIN}/ui/canvas/index.html?export=1"))

    held = {"view": view}  # kept alive until the picture is taken

    def say(what: str) -> None:
        # Exporting is slow, invisible and easy to get wrong; a line each way is
        # what makes "nothing happened" answerable.
        print(f"talaria: export {kind} — {what}", file=__import__("sys").stderr, flush=True)

    def measure() -> None:
        say("loaded, asking how big the drawing is")
        view.page().runJavaScript("window.__exportSize && JSON.stringify(window.__exportSize())", fit)

    def fit(answer) -> None:
        import json

        try:
            size = json.loads(answer) if answer else None
        except Exception:  # noqa: BLE001
            size = None
        if not size:
            # The page never said. Take the window as it stands rather than
            # nothing at all — a picture of the visible canvas is still a
            # picture of the canvas.
            return QTimer.singleShot(300, shoot)
        w = min(MAX_EDGE, max(320, int(size.get("w", 1200)) + MARGIN * 2))
        h = min(MAX_EDGE, max(240, int(size.get("h", 800)) + MARGIN * 2))
        say(f"drawing is {w}x{h}")
        view.resize(QSize(w, h))
        # A resize is a re-layout; the canvas re-fits itself and needs a moment
        # before it is worth photographing.
        QTimer.singleShot(500, shoot)

    def shoot() -> None:
        say("taking the picture")
        if kind == "pdf":
            view.page().printToPdf(where)
            # `printToPdf` answers on a signal; the file is not there until it
            # does, and the view may not be released before it is.
            view.page().pdfPrintingFinished.connect(lambda *_: finish())
            return
        shot = view.grab()
        say(f"grabbed {shot.width()}x{shot.height()}, null={shot.isNull()}")
        shot.save(where)
        finish()

    def finish() -> None:
        held.pop("view", None)
        view.deleteLater()
        if done:
            done(where)

    def loaded(ok: bool) -> None:
        say(f"page {'loaded' if ok else 'FAILED to load'}")
        if ok:
            QTimer.singleShot(900, measure)
        else:
            finish()

    view.loadFinished.connect(loaded)
