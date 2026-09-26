"""
Reading a window's text off its pixels. Glance's screen rung.

Every other rung asks an application what it holds, and most applications on
this desktop will not say: a terminal exposes nothing to AT-SPI, Electron
exposes nothing unless launched with a flag, and a browser drawing Google Docs
to a canvas exposes nothing at all. So the ladder used to fall to the window
title — "~", or "Claude" — which is a word, not a reading. The pixels are the
one thing every window has, and `tesseract` turns them back into text locally,
with nothing leaving the machine.

Measured on this machine (Lunar Lake, 8 cores) before any of it was built, on a
half-screen window of dense text:

| | |
|---|---|
| tesseract as it comes | 4.2s |
| one thread (`OMP_THREAD_LIMIT=1`) | 1.1s |
| columns and strips, one thread each, in parallel | 0.3–0.5s |

Four things this does to the picture before tesseract sees it, each found by
reading a real window and getting it wrong:

**Tesseract's own threading is the trap.** Left to use every core on one image
it was four times *slower* than one core, three runs out of three. So each
process gets one thread, and the parallelism comes from cutting the window up
and reading the pieces side by side.

**Text is what differs from its surroundings, not what is dark.** Ghostty here
is translucent, so its text sits over a photograph of a plant. One threshold for
the whole window — tesseract's own, or Otsu's — split the *wallpaper*, stems
against sky, and kept about a dozen words of a full screen. So the background
is estimated locally (the window scaled right down and back up, which is a
blur Qt does in C) and a pixel is ink if it differs from that by enough, in
either direction. That also makes light-on-dark and dark-on-light the same
case, and leaves every background plain white — which the next two depend on.

**Columns first.** Cut into horizontal strips, a sidebar and the page beside it
came back interleaved line by line — "+ New that haven't changed" — because a
strip is too short for tesseract to notice there are two columns. Read whole,
it kept them apart. So a gap of white running the full height splits the
window into columns before anything is cut across.

**Cut where there is no text.** A strip boundary through a line loses it from
both strips; overlapping them reads it twice. Each cut moves to the nearest
blank row, so the strips meet exactly.

Not a selection: this reads everything in the window, chrome included, so it
ranks below anything the user highlighted.

**Nothing is written to disk, and that is a promise, not an accident.** `grim`
writes the capture to stdout, the pieces are encoded in memory and piped into
`tesseract stdin stdout`, and the text comes back on a pipe. Traced with
`strace`: tesseract opens no file for writing when it reads from stdin. The
pixels live as long as this call and the text as long as the reading, and
nothing about either is logged but its length. Keep it that way — a temp file
here would be a screenshot of somebody's screen left lying around.
"""

from __future__ import annotations

import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

#: Pieces read at once, whatever the core count. Past this the fixed cost of
#: starting a tesseract (about 40ms each) stops being paid back.
MAX_PIECES = 4

#: A strip shorter than this is mostly line-height and startup cost.
MIN_STRIP = 280

#: How far a cut may move to find a blank row, either way.
SEARCH = 90

#: The background is the window shrunk by this much and grown back — wider than
#: a glyph, so text does not count as its own background.
BLUR = 20

#: How far a pixel has to differ from its surroundings to be ink. Measured
#: against a dense dark-theme window and a translucent terminal: lower keeps
#: the wallpaper's texture, higher starts losing thin strokes.
INK = 40

#: A gap has to be this wide, and run the full height, to split two columns.
#: Narrower than that it is the space between two words.
GUTTER = 24

#: A column narrower than this share of the widest is chrome, not content.
SIDE = 0.5

#: Per piece. A piece that has not finished in this long is not going to.
TIMEOUT = 12

#: A line needs this many letters or digits to be text rather than an icon read
#: as punctuation — the sidebar's glyphs came back as `oO<o>` and `&`.
MIN_ALNUM = 3


def recognize(ppm: bytes) -> tuple[str | None, str]:
    """The text in a captured window, or None and why not."""
    from PySide6.QtGui import QImage

    image = QImage.fromData(ppm, "PPM")
    if image.isNull():
        return None, "the capture could not be decoded"
    if image.width() < 16 or image.height() < 16:
        return None, "the window is too small to read"

    ink = _ink(image.convertToFormat(QImage.Format.Format_Grayscale8))
    columns = _content(_columns(ink))
    # The strips are shared out by width: a sidebar is one piece, and the page
    # beside it gets the rest. Every column gets at least one.
    budget = max(1, min(MAX_PIECES, (os.cpu_count() or 2) // 2 or 1))
    span = sum(right - left for left, right in columns)
    pieces = [_encode(ink.copy(left, top, right - left, bottom - top))
              for left, right in columns
              for top, bottom in _strips(ink, left, right,
                                         max(1, round(budget * (right - left) / span)))]

    env = dict(os.environ, OMP_THREAD_LIMIT="1")

    def one(data: bytes) -> str:
        done = subprocess.run(
            ["tesseract", "stdin", "stdout"],
            input=data, capture_output=True, timeout=TIMEOUT, env=env,
        )
        return done.stdout.decode("utf8", "replace") if done.returncode == 0 else ""

    try:
        with ThreadPoolExecutor(max_workers=min(len(pieces), MAX_PIECES)) as pool:
            parts = list(pool.map(one, pieces))
    except FileNotFoundError:
        return None, "tesseract isn't installed"
    except subprocess.TimeoutExpired:
        return None, "tesseract took too long"

    text = _clean("\n".join(parts))
    return (text, f"{len(pieces)} piece(s)") if text else (None, "no text was found on screen")


def _ink(gray):
    """Black where a pixel stands out from its surroundings, white elsewhere."""
    from PySide6.QtCore import Qt
    from PySide6.QtGui import QImage, QPainter

    width, height = gray.width(), gray.height()
    shrink = Qt.AspectRatioMode.IgnoreAspectRatio
    smooth = Qt.TransformationMode.SmoothTransformation
    background = gray.scaled(max(1, width // BLUR), max(1, height // BLUR), shrink, smooth) \
                     .scaled(width, height, shrink, smooth)
    # |pixel − background|, in C. QPainter will not paint onto grayscale, so the
    # difference is taken in RGB and brought back.
    canvas = gray.convertToFormat(QImage.Format.Format_RGB32)
    painter = QPainter(canvas)
    painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_Difference)
    painter.drawImage(0, 0, background.convertToFormat(QImage.Format.Format_RGB32))
    painter.end()
    diff = canvas.convertToFormat(QImage.Format.Format_Grayscale8)
    # A lookup table through `bytes.translate` is the threshold — also in C.
    lut = bytes(0 if v >= INK else 255 for v in range(256))
    return QImage(_packed(diff).translate(lut), width, height, width,
                  QImage.Format.Format_Grayscale8).copy()


def _packed(gray) -> bytes:
    """The pixels with the row padding taken out, so row y starts at y × width."""
    width, stride = gray.width(), gray.bytesPerLine()
    raw = bytes(gray.constBits())
    if stride == width:
        return raw[: width * gray.height()]
    return b"".join(raw[y * stride: y * stride + width] for y in range(gray.height()))


def _columns(ink) -> list[tuple[int, int]]:
    """Left and right edges of each column, split at full-height gaps."""
    width, height = ink.width(), ink.height()
    data = _packed(ink)
    # Every other row of each pixel column: a glyph is taller than two rows.
    empty = [min(data[x::width * 2]) == 255 for x in range(width)]
    spans, start, gap = [], None, 0
    for x, blank in enumerate(empty):
        if blank:
            gap += 1
            if start is not None and gap == GUTTER:
                spans.append((start, x - GUTTER + 1))
                start = None
        else:
            if start is None:
                start = x
            gap = 0
    if start is not None:
        spans.append((start, width))
    # A divider between a sidebar and its page is ink too, and would come back as
    # a column one pixel wide — a tesseract started to read a line. No text is
    # that narrow.
    spans = [(a, b) for a, b in spans if b - a >= 16]
    # Padded a little each side, so an edge stroke is not clipped.
    return [(max(0, a - 4), min(width, b + 4)) for a, b in spans] or [(0, width)]


def _content(columns: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """
    The columns worth reading, widest first.

    **A sidebar is somebody else's subject.** The first Glance over a chat
    application read its history list — a dozen other conversations' titles,
    one of them about sourdough — ahead of the conversation on screen, and
    matched the library against all of it. The page is the widest column, so it
    goes first, and a column less than `SIDE` of its width is chrome: a
    sidebar, a toolbar, a gutter of icons. Two documents side by side are both
    wide, and both kept.
    """
    if len(columns) < 2:
        return columns
    widest = max(right - left for left, right in columns)
    kept = [c for c in columns if c[1] - c[0] >= SIDE * widest]
    return sorted(kept, key=lambda c: c[0] - c[1])


def _strips(ink, left: int, right: int, share: int) -> list[tuple[int, int]]:
    """Strip bounds within one column, each cut moved onto a blank row."""
    width, height = ink.width(), ink.height()
    data = _packed(ink)
    blank = [min(data[y * width + left: y * width + right]) == 255 for y in range(height)]
    count = max(1, min(share, height // MIN_STRIP))
    edges = [0]
    for k in range(1, count):
        ideal = k * height // count
        best = ideal
        for d in range(SEARCH):
            if ideal - d > edges[-1] and blank[ideal - d]:
                best = ideal - d
                break
            if ideal + d < height and blank[ideal + d]:
                best = ideal + d
                break
        if best > edges[-1]:
            edges.append(best)
    edges.append(height)
    return list(zip(edges, edges[1:]))


def _encode(piece) -> bytes:
    """A piece as PGM bytes, for tesseract's stdin."""
    from PySide6.QtCore import QBuffer, QIODevice

    buffer = QBuffer()
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    piece.save(buffer, "PGM")
    return bytes(buffer.data())


def _clean(raw: str) -> str:
    """Lines that are text, with runs of blank lines folded to one."""
    out: list[str] = []
    for line in raw.splitlines():
        line = line.strip()
        if sum(ch.isalnum() for ch in line) >= MIN_ALNUM:
            out.append(line)
        elif out and out[-1]:
            out.append("")
    return "\n".join(out).strip()
