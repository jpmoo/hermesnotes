#!/usr/bin/env python3
"""
Turn the Hermes logo into what macOS wants: a square .icns for the bundle, and
a PNG the indexer can hand to Spotlight as each result's thumbnail.

Generated at build time rather than committed. The source of truth is the logo
in assets/, so the artwork stays in one place — and a binary that is derived
from something else in the same repo is a thing to rebuild, not to keep.
"""
import subprocess
import sys
from pathlib import Path
from PIL import Image

src = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

from PIL import ImageDraw

art = Image.open(src).convert("RGBA")

# The artwork is a wordmark: a small glyph followed by "Hermes" and a tagline,
# far wider than it is tall. Squared as-is it becomes a thin band across an empty
# tile, and at the ~32px Spotlight actually draws it that band is an illegible
# smudge. So take the glyph and leave the words behind — the words are
# unreadable at this size anyway, which is what a mark is for.
bbox = art.getbbox()
art = art.crop(bbox)
# The glyph is roughly as tall as it is wide and sits at the left, so a square
# taken off the left edge is it.
mark = art.crop((0, 0, min(art.height, art.width), art.height))
mark = mark.crop(mark.getbbox())


def square(size: int) -> Image.Image:
    """The mark on a rounded tile.

    A tile rather than transparency: this is line art in a mid-tone teal, and
    Spotlight draws results on backgrounds it chooses, not ones we do. On the
    dark one it disappeared entirely.
    """
    scale = 4  # supersample, so the rounded corners aren't jagged at 16px
    big = size * scale
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        [(0, 0), (big - 1, big - 1)],
        radius=int(big * 0.2237),  # the macOS squircle, near enough
        fill=(255, 255, 255, 255),
    )
    inset = int(big * 0.16)
    box = big - inset * 2
    # resize, not thumbnail: thumbnail only ever shrinks, and the glyph is a few
    # hundred pixels being placed on a supersampled canvas several times larger,
    # so it needs to grow.
    ratio = min(box / mark.width, box / mark.height)
    glyph = mark.resize((max(1, round(mark.width * ratio)), max(1, round(mark.height * ratio))), Image.LANCZOS)
    canvas.paste(glyph, ((big - glyph.width) // 2, (big - glyph.height) // 2), glyph)
    return canvas.resize((size, size), Image.LANCZOS)


# The thumbnail Spotlight shows beside a result.
square(512).save(out / "Talaria.png")

# An iconset is a directory of exact sizes with exact names; iconutil is fussy
# about both.
iconset = out / "Talaria.iconset"
iconset.mkdir(exist_ok=True)
for base in (16, 32, 128, 256, 512):
    square(base).save(iconset / f"icon_{base}x{base}.png")
    square(base * 2).save(iconset / f"icon_{base}x{base}@2x.png")

subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out / "Talaria.icns")], check=True)
print(f"icon: {out / 'Talaria.icns'}")
