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

logo = Image.open(src).convert("RGBA")

def square(size: int, inset: float = 0.10) -> Image.Image:
    """The logo centred on a transparent square.

    macOS icons sit inside a margin rather than filling the tile; without one
    this reads as a screenshot of a logo instead of an icon. The logo is wider
    than it is tall, so it is fitted by whichever dimension runs out first.
    """
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    box = int(size * (1 - 2 * inset))
    art = logo.copy()
    art.thumbnail((box, box), Image.LANCZOS)
    canvas.paste(art, ((size - art.width) // 2, (size - art.height) // 2), art)
    return canvas

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
