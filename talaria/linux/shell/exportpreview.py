"""
A finished export, before anything is done with it.

Exporting used to ask where to put the file and then draw it, which is the wrong
order for this particular thing: a canvas export is the whole extent of the
drawing rather than the part anybody was looking at, so what comes out is
routinely a surprise — a stray node three screens to the left, a region that grew
when nobody noticed. Looking first costs one window and saves the round trip of
saving, opening, tutting, and going back.

Three things can be done with it, and **none of them closes the window**. Saving
and sending are not alternatives: keeping a copy on disk *and* putting one on
today's page is an ordinary thing to want, and a dialog that vanished after the
first would make the second a matter of exporting all over again. Dismiss is a
decision, and it is the only thing that ends this.
"""

from __future__ import annotations

import base64
import json
import os
import shutil

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (
    QDialog,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
)

import daemon


class _Sender(QThread):
    """
    The attach, off the UI thread.

    It is a network write through the daemon, and a dialog that stops redrawing
    while it happens reads as a hang — which on a canvas somebody has just spent
    an hour on is the wrong impression to give.
    """

    finished_with = Signal(str)  # empty string means it worked

    def __init__(self, path: str, filename: str, media_type: str) -> None:
        super().__init__()
        self._path = path
        self._filename = filename
        self._media_type = media_type

    def run(self) -> None:
        try:
            with open(self._path, "rb") as handle:
                payload = base64.b64encode(handle.read()).decode("ascii")
            status, body, _ = daemon.request(
                "POST",
                "/today/attach",
                json.dumps(
                    {
                        "filename": self._filename,
                        "mediaType": self._media_type,
                        "bytes": payload,
                    }
                ).encode("utf-8"),
                timeout=60.0,
            )
            if status == 200:
                self.finished_with.emit("")
                return
            try:
                said = json.loads(body.decode("utf-8", "replace"))
                self.finished_with.emit(said.get("error") or f"the daemon answered {status}")
            except ValueError:
                self.finished_with.emit(f"the daemon answered {status}")
        except daemon.DaemonDown as err:
            self.finished_with.emit(str(err))
        except OSError as err:
            self.finished_with.emit(f"could not read the export — {err}")


class ExportPreview(QDialog):
    """The preview, with the three things somebody might want to do with it."""

    def __init__(self, kind: str, path: str, picture: str) -> None:
        super().__init__()
        self._kind = kind
        self._path = path
        self._sender: _Sender | None = None

        self.setWindowTitle(f"{kind.upper()} export")
        self.setMinimumSize(520, 480)

        outer = QVBoxLayout(self)

        size = os.path.getsize(path) if os.path.exists(path) else 0
        human = f"{size / 1024:.0f} KB" if size < 1024 * 1024 else f"{size / 1024 / 1024:.1f} MB"
        heading = QLabel(f"{'PNG' if kind == 'png' else 'PDF'} export · {human}")
        outer.addWidget(heading)

        # A PNG even when a PDF is being exported: what is being previewed is
        # the drawing, not the container.
        shown = QLabel()
        shown.setAlignment(Qt.AlignmentFlag.AlignCenter)
        pixmap = QPixmap(picture)
        if pixmap.isNull():
            shown.setText("This export cannot be shown, but it can still be saved.")
        else:
            shown.setPixmap(
                pixmap.scaled(
                    900,
                    600,
                    Qt.AspectRatioMode.KeepAspectRatio,
                    Qt.TransformationMode.SmoothTransformation,
                )
            )
        # A canvas export is transparent everywhere nobody drew, and a
        # transparent image on the dialog's own background can read as an empty
        # one. White behind it says "this is the paper" rather than "this failed".
        shown.setStyleSheet("background: white; border: 1px solid rgba(0,0,0,0.15);")
        outer.addWidget(shown, 1)

        self._note = QLabel("")
        self._note.setWordWrap(True)
        outer.addWidget(self._note)

        row = QHBoxLayout()
        save = QPushButton("Save…")
        save.clicked.connect(self._save)
        row.addWidget(save)

        self._send = QPushButton("Send to Today's Note")
        self._send.clicked.connect(self._send_today)
        row.addWidget(self._send)

        row.addStretch(1)
        dismiss = QPushButton("Dismiss")
        dismiss.clicked.connect(self.close)
        row.addWidget(dismiss)
        outer.addLayout(row)

    @property
    def _filename(self) -> str:
        return f"canvas.{'pdf' if self._kind == 'pdf' else 'png'}"

    @property
    def _media_type(self) -> str:
        return "application/pdf" if self._kind == "pdf" else "image/png"

    def _say(self, text: str, bad: bool = False) -> None:
        self._note.setText(text)
        self._note.setStyleSheet("color: #a11;" if bad else "color: rgba(0,0,0,0.6);")

    def _save(self) -> None:
        suggested = os.path.join(os.path.expanduser("~"), self._filename)
        where, _ = QFileDialog.getSaveFileName(self, f"Save {self._kind.upper()}", suggested)
        if not where:
            return
        try:
            shutil.copyfile(self._path, where)
        except OSError as err:
            self._say(f"could not save — {err}", bad=True)
            return
        self._say(f"Saved to {os.path.basename(where)}")

    def _send_today(self) -> None:
        if self._sender is not None:
            return
        self._send.setEnabled(False)
        self._send.setText("Sending…")
        self._sender = _Sender(self._path, self._filename, self._media_type)
        self._sender.finished_with.connect(self._sent)
        self._sender.start()

    def _sent(self, trouble: str) -> None:
        self._send.setEnabled(True)
        self._send.setText("Send to Today's Note")
        self._sender = None
        if trouble:
            self._say(trouble, bad=True)
        else:
            self._say("Added to today's note")

    def closeEvent(self, event) -> None:  # noqa: N802 — Qt's spelling
        """The temporary goes when the window does, saved copies excepted.

        The export lives in a temp file until somebody says where they want it;
        leaving those behind would fill the directory with every canvas anybody
        ever looked at and thought better of.
        """
        for path in (self._path, self._path + ".preview.png"):
            try:
                os.unlink(path)
            except OSError:
                pass
        super().closeEvent(event)
