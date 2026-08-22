#!/usr/bin/env python3
"""
Turn the Hermes logo into what macOS wants: a square .icns for the bundle, and
a PNG the indexer can hand to Spotlight as each result's thumbnail.

Generated at build time rather than committed. The source of truth is the logo
in assets/, so the artwork stays in one place — and a binary that is derived
from something else in the same repo is a thing to rebuild, not to keep.
"""
import json
import subprocess
import sys
from pathlib import Path
from PIL import Image, ImageFilter

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
# The mark and the words touch — the wing sweeps up and to the right, over
# where "Hermes" begins — so there is no gap to cut at, and a square taken off
# the left clips the wing tip. They do differ in colour, though: the mark is
# teal and the lettering is neutral grey. So separate them that way, and keep
# only the teal, which also drops the sliver of the "H" the wing passes over.
def is_mark(px):
    r, g, b, a = px
    return a > 32 and (b - r) > 25 and (g - r) > 10


glyph_only = Image.new("RGBA", art.size, (0, 0, 0, 0))
src, dst = art.load(), glyph_only.load()
for y in range(art.height):
    for x in range(art.width):
        if is_mark(src[x, y]):
            dst[x, y] = src[x, y]

box = glyph_only.getbbox()
if box is None:
    raise SystemExit("no mark found in the artwork — has the logo changed?")
mark = glyph_only.crop(box)


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

# Two consumers, two formats.
#
# The .icns is the legacy path and still what CFBundleIconFile points at. On its
# own, though, macOS treats the icon as non-conforming and insets it inside a
# generic frame — which is then what Spotlight badges every result with. The
# asset catalog is what current apps ship (Notes and Reminders both carry
# CFBundleIconName plus an Assets.car), so we build both and let the system
# prefer the one it likes.
SIZES = (16, 32, 128, 256, 512)

iconset = out / "Talaria.iconset"
iconset.mkdir(exist_ok=True)
for base in SIZES:
    tile(base, bleed=True).save(iconset / f"icon_{base}x{base}.png")
    tile(base * 2, bleed=True).save(iconset / f"icon_{base}x{base}@2x.png")

subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out / "Talaria.icns")], check=True)

appiconset = out / "Talaria.xcassets" / "AppIcon.appiconset"
appiconset.mkdir(parents=True, exist_ok=True)
images = []
for base in SIZES:
    for scale in (1, 2):
        name = f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png"
        tile(base * scale, bleed=True).save(appiconset / name)
        images.append({"idiom": "mac", "size": f"{base}x{base}", "scale": f"{scale}x", "filename": name})
(appiconset / "Contents.json").write_text(
    json.dumps({"images": images, "info": {"version": 1, "author": "talaria"}}, indent=2)
)
(out / "Talaria.xcassets" / "Contents.json").write_text(
    json.dumps({"info": {"version": 1, "author": "talaria"}}, indent=2)
)

# The menu bar wants a different drawing of the same mark.
#
# It is drawn at 18 points, and at that size the logo's line work all but
# vanishes: undilated, eleven pixels of a possible 324 carry any real alpha, so
# macOS faithfully draws almost nothing and the item looks missing while the
# system insists it is visible. Thickening the strokes first is what makes it
# survive the reduction — enough to read, not so much that the bubbles fill in.
#
# Black plus alpha, because a template image is recoloured by macOS to suit a
# light or dark menu bar, and a teal one would not survive that either.
flat = Image.merge("RGBA", (Image.new("L", mark.size, 0),) * 3 + (mark.split()[3],))
radius = max(1, round(flat.height * 0.022))
bold = flat.split()[3].filter(ImageFilter.MaxFilter(radius * 2 + 1))
bold_rgba = Image.merge("RGBA", (Image.new("L", flat.size, 0),) * 3 + (bold,))
for scale, name in ((1, "MenuBar.png"), (2, "MenuBar@2x.png")):
    side = 18 * scale
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    ratio = min(side / bold_rgba.width, side / bold_rgba.height)
    small = bold_rgba.resize(
        (max(1, round(bold_rgba.width * ratio)), max(1, round(bold_rgba.height * ratio))), Image.LANCZOS
    )
    canvas.paste(small, ((side - small.width) // 2, (side - small.height) // 2), small)
    canvas.save(out / name)

print(f"icon: {out / 'Talaria.icns'} and {appiconset}")
