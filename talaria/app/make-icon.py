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


def tile(size: int, bleed: bool) -> Image.Image:
    """The mark on a tile.

    Two shapes, for two consumers that want opposite things.

    `bleed=True` is the app icon: an opaque square, corner to corner, no
    rounding of our own. Since macOS 26 the system masks app icons to its own
    shape, and an icon that arrives already rounded with transparent corners is
    treated as non-conforming — it gets inset inside a generic dark frame, which
    is then what Spotlight badges every result with.

    `bleed=False` is the Spotlight thumbnail, which is drawn as given and looks
    better as a squircle.

    Either way there is a tile rather than transparency: this is line art in a
    mid-tone teal, and Spotlight picks the background, not us.
    """
    scale = 4  # supersample, so the rounding isn't jagged at 16px
    big = size * scale
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    if bleed:
        draw.rectangle([(0, 0), (big, big)], fill=(255, 255, 255, 255))
    else:
        draw.rounded_rectangle(
            [(0, 0), (big - 1, big - 1)],
            radius=int(big * 0.2237),  # the macOS squircle, near enough
            fill=(255, 255, 255, 255),
        )
    # Apple insets app artwork inside the masked shape; matching that keeps the
    # glyph from running under the rounded corners the system adds.
    inset = int(big * (0.20 if bleed else 0.16))
    box = big - inset * 2
    # resize, not thumbnail: thumbnail only ever shrinks, and the glyph is a few
    # hundred pixels being placed on a supersampled canvas several times larger,
    # so it needs to grow.
    ratio = min(box / mark.width, box / mark.height)
    glyph = mark.resize((max(1, round(mark.width * ratio)), max(1, round(mark.height * ratio))), Image.LANCZOS)
    canvas.paste(glyph, ((big - glyph.width) // 2, (big - glyph.height) // 2), glyph)
    return canvas.resize((size, size), Image.LANCZOS)


# The thumbnail Spotlight shows beside a result.
tile(512, bleed=False).save(out / "Talaria.png")

# An iconset is a directory of exact sizes with exact names; iconutil is fussy
# about both.
iconset = out / "Talaria.iconset"
iconset.mkdir(exist_ok=True)
for base in (16, 32, 128, 256, 512):
    tile(base, bleed=True).save(iconset / f"icon_{base}x{base}.png")
    tile(base * 2, bleed=True).save(iconset / f"icon_{base}x{base}@2x.png")

subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out / "Talaria.icns")], check=True)
print(f"icon: {out / 'Talaria.icns'}")
