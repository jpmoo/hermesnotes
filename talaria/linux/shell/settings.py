"""
The settings window.

A port of `app/Sources/Settings.swift` and `SettingsView.swift`, carrying every
field the Mac panel edits. Native Qt rather than a served page, for the reason
the Mac is native too: this edits `config.json` directly, and routing that
through the daemon would mean new endpoints handing the access key back out over
the socket to draw a form with.

Three rules come across unchanged, because each of them is a bug that has
already been paid for somewhere:

**A save is an overlay, never a replacement.** The repo's own invariant —
unknown fields survive byte-identical. This panel does not know every key the
daemon may grow, and a save that rebuilt the object from the form would silently
delete one. The file is re-read *at write time* rather than held from load, so a
change made in between is merged rather than clobbered.

**Atomic, then chmod — in that order.** An atomic write is a rename onto the
path, and the replacement arrives with the umask's mode rather than the mode the
old file had. This file holds an access key.

**An empty string is not a default, it is the absence of an answer.** Optional
keys are removed when blank rather than written as `""`, which the daemon would
take as a real value and go looking for.
"""

from __future__ import annotations

import json
import os
import re
import subprocess

from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, QTimer, Signal
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDialog, QDialogButtonBox, QDoubleSpinBox, QFormLayout, QGroupBox,
    QHBoxLayout, QLabel, QLineEdit, QMessageBox, QPlainTextEdit, QPushButton, QScrollArea,
    QSpinBox, QVBoxLayout, QWidget,
)

import daemon
import probe

#: Keys written only when they have a value. See the module note.
#:
#: The hotkey keys and `aerospaceCli` are not here and must not be added back:
#: this panel stopped showing them, the Mac still reads them, and a key this
#: panel does not display is a key it has no business writing or removing.
OPTIONAL = ["menuBarSymbol"]


def config_path() -> str:
    return os.path.join(os.path.dirname(daemon.socket_path()), "config.json")


def _raw() -> dict:
    """Whatever is on disk right now, unparsed. Missing or broken reads as empty."""
    try:
        with open(config_path(), encoding="utf8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


class _Probed(QObject):
    done = Signal(list, str, str)


class _Probe(QRunnable):
    """One `/api/tags`, off the UI thread — a server that is not there takes
    five seconds to say so, and a settings window frozen for five seconds is
    indistinguishable from one that has crashed."""

    def __init__(self, signals: _Probed, url: str, kind: str) -> None:
        super().__init__()
        self._signals, self._url, self._kind = signals, url, kind

    def run(self) -> None:
        try:
            found, (level, message) = probe.models(self._url, self._kind)
        except Exception as err:  # noqa: BLE001
            found, level, message = [], "bad", str(err)
        self._signals.done.emit(found, level, message)


class ModelPicker(QWidget):
    """
    An address, a Connect button, and what that address turned out to have.

    Editable on purpose. The list is what a server reports *now*, and a model
    that is not installed yet is still a legitimate thing to have configured —
    the Mac makes the same allowance and marks it "not installed" rather than
    refusing it. A picker that silently dropped a configured value on open would
    rewrite the config by being looked at.
    """

    def __init__(self, kind: str, source: QLineEdit) -> None:
        super().__init__()
        self._kind, self._source = kind, source
        self._pool = QThreadPool(self)

        self.box = QComboBox()
        self.box.setEditable(True)
        self.button = QPushButton("Connect")
        self.button.clicked.connect(self.refresh)
        # Enter in the address field means "try it", which is where a person's
        # hands already are after typing one.
        source.returnPressed.connect(self.refresh)

        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        row.addWidget(self.box, 1)
        row.addWidget(self.button)

        self.status = _hint("Not asked yet — press Connect.")

    def value(self) -> str:
        """
        The model's *name*, never the label shown for it.

        The label carries the vector width — `nomic-embed-text:latest  (768)` —
        and returning that is how a settings window writes a model name no
        server has ever heard of into the config. The real name rides along as
        the item's data; only a name typed by hand falls through to the text.
        """
        index = self.box.currentIndex()
        if index >= 0 and self.box.currentText() == self.box.itemText(index):
            data = self.box.itemData(index)
            if isinstance(data, str) and data:
                return data
        return self.box.currentText().strip()

    def setValue(self, name: str) -> None:  # noqa: N802 — matches Qt's casing nearby
        """Select by name, matching on the data rather than the label."""
        if not name:
            self.box.setCurrentText("")
            return
        for i in range(self.box.count()):
            if self.box.itemData(i) == name or self.box.itemText(i) == name:
                self.box.setCurrentIndex(i)
                return
        # Not offered by any server we have asked — kept as typed, so opening
        # the window cannot quietly change what is configured.
        self.box.addItem(name, name)
        self.box.setCurrentIndex(self.box.count() - 1)

    def refresh(self) -> None:
        url = self._source.text().strip()
        if not url:
            self._settle([], "bad", "Fill the address in first.")
            return
        self.button.setEnabled(False)
        self.button.setText("…")
        self.status.setText(f"Asking {url}…")
        signals = _Probed(self)
        signals.done.connect(self._settle, Qt.ConnectionType.QueuedConnection)
        self._pool.start(_Probe(signals, url, self._kind))

    def _settle(self, found: list, level: str, message: str) -> None:
        self.button.setEnabled(True)
        self.button.setText("Connect")
        keep = self.value()
        self.box.clear()
        for m in found:
            # The width is shown because a vector's meaning depends on the model
            # that made it, and the width is the visible part of that.
            label = f"{m.name}  ({m.dimensions})" if m.dimensions else m.name
            self.box.addItem(label, m.name)
        names = [m.name for m in found]
        if keep and keep not in names:
            # Kept, and said to be missing. Dropping it would quietly change the
            # setting; hiding that it is missing would quietly break Glance.
            self.box.addItem(f"{keep}  (not installed)", keep)
        if keep:
            self.setValue(keep)
        elif names:
            self.box.setCurrentIndex(0)
        colour = {"ok": "", "warn": "#b8860b", "bad": "#d9534f"}.get(level, "")
        self.status.setStyleSheet(f"color: {colour}" if colour else "")
        self.status.setEnabled(level != "ok")
        self.status.setText(message)


def _hint(text: str) -> QLabel:
    label = QLabel(text)
    label.setWordWrap(True)
    label.setEnabled(False)
    return label


class SettingsWindow(QDialog):
    """Edits `config.json`. Emits `saved` once the daemon has been restarted."""

    saved = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Talaria — Settings")
        self.resize(620, 760)
        self._build()
        self._load()

    # ------------------------------------------------------------------ layout

    def _build(self) -> None:
        body = QWidget()
        form = QVBoxLayout(body)

        # --- Hermes -----------------------------------------------------------
        hermes = QGroupBox("Hermes")
        rows = QFormLayout(hermes)
        self.origin = QLineEdit(placeholderText="https://example.com/hermesnotes")
        self.access_key = QLineEdit()
        # Hidden by default. It is a credential, this window is summoned over
        # whatever else is on screen, and the Mac panel treats it the same way.
        self.access_key.setEchoMode(QLineEdit.EchoMode.Password)
        reveal = QCheckBox("Show")
        reveal.toggled.connect(
            lambda on: self.access_key.setEchoMode(
                QLineEdit.EchoMode.Normal if on else QLineEdit.EchoMode.Password
            )
        )
        self.poll = QSpinBox(minimum=2, maximum=3600, suffix="  seconds while the network is up")
        rows.addRow("Address", self.origin)
        rows.addRow("Access key", self.access_key)
        rows.addRow("", reveal)
        rows.addRow("Poll every", self.poll)
        rows.addRow(_hint("Minted in Hermes under Settings → Access keys."))
        form.addWidget(hermes)

        # --- Chat -------------------------------------------------------------
        chat = QGroupBox("Talaria's chat")
        rows = QFormLayout(chat)
        self.inference_url = QLineEdit(placeholderText="http://localhost:11434")
        self.inference_model = ModelPicker(probe.CHAT, self.inference_url)
        rows.addRow("Address", self.inference_url)
        rows.addRow("Model", self.inference_model)
        rows.addRow(self.inference_model.status)
        rows.addRow(_hint(
            "A tool-capable chat model — llama3.1, qwen2.5 and the like. Separate from Glance's "
            "on purpose: an embedding model and a tool-calling chat model are rarely the same one, "
            "and often not even the same machine. Until one is chosen, the Draw tool is hidden on "
            "the canvas — an opener for a chat that cannot answer is worse than no opener."
        ))
        form.addWidget(chat)

        # --- Glance -----------------------------------------------------------
        glance = QGroupBox("Glance")
        rows = QFormLayout(glance)
        self.glance_url = QLineEdit(placeholderText="http://localhost:11434")
        self.glance_model = ModelPicker(probe.EMBEDDING, self.glance_url)
        self.glance_threshold = QDoubleSpinBox(minimum=0.0, maximum=1.0, singleStep=0.01, decimals=2)
        self.glance_separate_done = QCheckBox("Put finished things in their own section")
        self.glance_undated = QCheckBox("Include undated items in “Further Out/Undated”")
        rows.addRow("Address", self.glance_url)
        rows.addRow("Model", self.glance_model)
        rows.addRow(self.glance_model.status)
        rows.addRow("Threshold", self.glance_threshold)
        rows.addRow(_hint(
            "Anything scoring below this is filed under “less similar” instead of the main list. "
            "Zero is off. Every hit shows its score, so the way to pick a number is to glance at a "
            "few and see where the useful ones stop."
        ))
        rows.addRow("", self.glance_separate_done)
        rows.addRow(_hint(
            "Read through the type's own status and complete values, so it follows whatever a type "
            "calls finished rather than the word “done”. Things with no status at all — a note, a "
            "person — are never filed here."
        ))
        self.glance_horizon = QSpinBox(minimum=1, maximum=365, suffix="  days ahead")
        rows.addRow("Show up to", self.glance_horizon)
        rows.addRow(_hint(
            "How far ahead counts as current. Anything dated beyond this is folded away under "
            "“Beyond N days” rather than hidden. A week of the recent past is always current and "
            "is not adjustable: shortening this says “show me less of the future”, not “hide what "
            "I have already missed”."
        ))
        rows.addRow("", self.glance_undated)

        self.glance_placement = QComboBox()
        for value, label in (
            ("top-left", "Top left"), ("top-center", "Top centre"), ("top-right", "Top right"),
            ("middle-left", "Middle left"), ("middle-center", "Middle"), ("middle-right", "Middle right"),
            ("bottom-left", "Bottom left"), ("bottom-center", "Bottom centre"),
            ("bottom-right", "Bottom right"),
        ):
            self.glance_placement.addItem(label, value)
        rows.addRow("Appears", self.glance_placement)
        self.frosting = QDoubleSpinBox(minimum=0.35, maximum=1.0, singleStep=0.05, decimals=2)
        rows.addRow("Panel solidity", self.frosting)
        rows.addRow(_hint(
            "Applies to every summoned panel, not only Glance. What is behind them is genuinely "
            "blurred by the compositor — 1.00 is a solid panel that hides it, lower lets more of "
            "the frosted desktop through. The blur <i>radius</i> is not set here: the protocol has "
            "no strength, so that is the one in System Settings → Desktop Effects → Blur, shared "
            "by everything on the desktop. Clamped at 0.35, below which text over a busy desktop "
            "stops being readable however much it is blurred. The Hermes window is never frosted: "
            "it is a page of text, and a page of text over a blurred desktop reads badly."
        ))
        rows.addRow(_hint(
            "Where the panel comes up. It arrives from the nearest edge, so it always reads as "
            "coming in rather than crossing the screen. A client cannot place its own windows on "
            "Wayland, so this is handed to a KWin script — which means it takes effect when the "
            "shell next starts rather than immediately."
        ))
        rows.addRow(_hint(
            "Off, a note or a person with no date sits in the main list — which is most of what you "
            "want while writing something. On, they move below the divider with the far-off ones, "
            "leaving the top of the list to what is actually happening this week."
        ))
        rows.addRow(_hint(
            "⚠ Glance is not built on Linux yet — it is the last step of the port. These are kept "
            "and written so the file stays the same shape on both machines."
        ))
        form.addWidget(glance)

        # No hotkey fields. They seeded the portal's *first* request and
        # nothing after it: once a shortcut is granted, the portal owns the
        # binding and `talaria-shell --rebind` is the only way to change it. A
        # box that edits a value nobody reads again is worse than no box.
        #
        # The keys themselves are left in `config.json` untouched — the Mac
        # reads `boardHotkey` and the rest directly, and this panel has no
        # business deleting settings for a machine it is not running on.

        # --- Desktop ----------------------------------------------------------
        desk = QGroupBox("Desktop")
        rows = QFormLayout(desk)
        self.symbol = QLineEdit(placeholderText="talaria")
        self.context_exclude = QPlainTextEdit()
        self.context_exclude.setFixedHeight(90)
        rows.addRow("Tray icon", self.symbol)
        rows.addRow(_hint(
            "A freedesktop icon name from the current theme. The Mac reads this key as an SF Symbol "
            "name, so a file shared between the two will not name the same picture — it is one key "
            "with two meanings, which is the honest cost of one config file."
        ))
        rows.addRow("Never recorded", self.context_exclude)
        rows.addRow(_hint(
            "One per line. These are invisible to the context record — and so to ranking and "
            "defaulting, which is the price of being invisible. The Mac matches bundle ids; Linux "
            "will match window classes once the context poll is wired to KWin."
        ))
        form.addWidget(desk)

        form.addWidget(_hint(f"Written to {config_path()}, mode 0600."))
        form.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidget(body)
        scroll.setWidgetResizable(True)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self._save)
        buttons.rejected.connect(self.reject)

        outer = QVBoxLayout(self)
        outer.addWidget(scroll)
        outer.addWidget(buttons)

    # -------------------------------------------------------------------- load

    def _load(self) -> None:
        c = _raw()

        def s(key: str, fallback: str = "") -> str:
            value = c.get(key)
            return value if isinstance(value, str) and value else fallback

        self.origin.setText(s("origin"))
        self.access_key.setText(s("accessKey"))
        poll = c.get("pollSeconds")
        self.poll.setValue(poll if isinstance(poll, int) and 2 <= poll <= 3600 else 30)
        self.inference_url.setText(s("inferenceUrl", "http://localhost:11434"))
        self.inference_model.setValue(s("inferenceModel"))
        self.glance_url.setText(s("glanceUrl", "http://localhost:11434"))
        self.glance_model.setValue(s("glanceModel", "nomic-embed-text:latest"))
        threshold = c.get("glanceThreshold")
        self.glance_threshold.setValue(float(threshold) if isinstance(threshold, (int, float)) else 0.0)
        self.glance_separate_done.setChecked(bool(c.get("glanceSeparateDone")))
        self.glance_undated.setChecked(bool(c.get("glanceUndatedFurtherOut")))
        horizon = c.get("glanceHorizonDays")
        self.glance_horizon.setValue(int(horizon) if isinstance(horizon, int) and horizon > 0 else 21)
        placed = self.glance_placement.findData(c.get("glancePlacement") or "bottom-center")
        self.glance_placement.setCurrentIndex(placed if placed >= 0 else 7)
        amount = c.get("frostingAmount")
        self.frosting.setValue(float(amount) if isinstance(amount, (int, float)) else 0.82)
        self.symbol.setText(s("menuBarSymbol"))
        # Asked as the window opens rather than waiting for a press. The common
        # case is a server already running, and making somebody click Connect to
        # discover that is a step which almost never changes the answer. It runs
        # off the UI thread either way, so a dead address costs a sentence
        # rather than a five-second freeze.
        QTimer.singleShot(0, self.inference_model.refresh)
        QTimer.singleShot(0, self.glance_model.refresh)

        exclude = c.get("contextExclude")
        self.context_exclude.setPlainText(
            "\n".join(x for x in exclude if isinstance(x, str)) if isinstance(exclude, list) else ""
        )

    # -------------------------------------------------------------------- save

    def _validate(self) -> str | None:
        """
        The daemon's schema, checked here so the answer arrives in this window.

        Duplicated from `config.ts` and worth the duplication, for the reason the
        Mac panel gives: the alternative is a save that succeeds, a daemon that
        exits 78 on the next start, and a person looking at a settings window
        that told them everything was fine.
        """
        origin = self.origin.text().strip()
        if not re.match(r"^https?://[^\s/]+", origin):
            return "The address needs to be a URL, like https://example.com/hermesnotes"
        if not self.access_key.text().strip():
            return "An access key is required — mint one in Hermes under Settings → Access keys."
        if self.access_key.text().strip() == "PASTE_YOUR_ACCESS_KEY":
            return "That is still the placeholder access key."
        for label, field in (("Talaria's chat", self.inference_url), ("Glance", self.glance_url)):
            value = field.text().strip()
            if value and not re.match(r"^https?://[^\s/]+", value):
                return f"{label}'s address needs to be a URL, or blank for the default."
        return None

    def _save(self) -> None:
        if (complaint := self._validate()) is not None:
            QMessageBox.warning(self, "Not saved", complaint)
            return

        # Re-read now, not at load. See the module note.
        obj = _raw()
        obj["origin"] = self.origin.text().strip()
        obj["accessKey"] = self.access_key.text().strip()
        obj["pollSeconds"] = self.poll.value()
        obj["inferenceUrl"] = self.inference_url.text().strip() or "http://localhost:11434"
        obj["inferenceModel"] = self.inference_model.value()
        obj["glanceUrl"] = self.glance_url.text().strip() or "http://localhost:11434"
        obj["glanceModel"] = self.glance_model.value() or "nomic-embed-text:latest"

        # Only what this panel actually edits. `aerospaceCli` and the four
        # hotkey keys are deliberately absent: they are read by the Mac, this
        # panel no longer shows them, and a save that removed a field it stopped
        # displaying would quietly delete somebody's setting on another machine.
        # The overlay rule the whole file is built on — unknown fields survive —
        # applies to fields we knowingly stopped knowing about too.
        for key, field in {"menuBarSymbol": self.symbol}.items():
            value = field.text().strip()
            if value:
                obj[key] = value
            else:
                obj.pop(key, None)

        excluded = [line.strip() for line in self.context_exclude.toPlainText().splitlines() if line.strip()]
        if excluded:
            obj["contextExclude"] = excluded
        else:
            obj.pop("contextExclude", None)

        # A false is the default, so it is written only when true — which keeps a
        # file nobody has changed identical to the one first written.
        for key, box in {
            "glanceSeparateDone": self.glance_separate_done,
            "glanceUndatedFurtherOut": self.glance_undated,
        }.items():
            if box.isChecked():
                obj[key] = True
            else:
                obj.pop(key, None)
        obj["glancePlacement"] = self.glance_placement.currentData()
        obj["glanceHorizonDays"] = self.glance_horizon.value()
        obj["frostingAmount"] = round(self.frosting.value(), 2)
        if self.glance_threshold.value() > 0:
            obj["glanceThreshold"] = round(self.glance_threshold.value(), 4)
        else:
            obj.pop("glanceThreshold", None)

        try:
            self._write(obj)
        except OSError as err:
            QMessageBox.critical(self, "Couldn't save", str(err))
            return

        self._restart()
        self.saved.emit()
        self.accept()

    @staticmethod
    def _write(obj: dict) -> None:
        path = config_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temp = path + ".new"
        with open(temp, "w", encoding="utf8") as handle:
            json.dump(obj, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temp, path)
        # After the rename, never before: the replacement arrives with the
        # umask's mode, not the mode the old file had.
        os.chmod(path, 0o600)

    def _restart(self) -> None:
        """
        The daemon reads this file once, at start.

        The Mac panel restarts it for the same reason. A save that appeared to
        work and changed nothing until the next reboot is the kind of thing
        somebody debugs for an hour.
        """
        try:
            subprocess.run(
                ["systemctl", "--user", "restart", "talaria.service"],
                check=True, capture_output=True, timeout=30,
            )
        except Exception as err:  # noqa: BLE001
            QMessageBox.warning(
                self, "Saved, but the daemon didn't restart",
                f"{err}\n\nRestart it with:  systemctl --user restart talaria",
            )
