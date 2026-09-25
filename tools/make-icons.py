"""Generate the extension icon set geometrically.

An AI image model cannot hit exact pixel grids, and at 16x16 every stray pixel
shows; the generated candidates also drifted off the panel's palette. So the mark
is drawn from primitives at 8x supersampling and box-filtered down, which keeps
edges clean at every size.

Mark: a delta (triangle) cut out of a rounded-square plate, with a notch that
reads as a code slot. Palette is taken from src/ui/theme.css so the toolbar icon
matches the drawer.
"""
import math
import os
import sys
from PIL import Image, ImageDraw

PANEL = (11, 19, 23, 255)      # --panel  #0b1317
VOID = (5, 8, 10, 255)         # --void   #05080a
PRIMARY = (46, 230, 200, 255)  # --primary #2ee6c8
PRIM_DIM = (20, 166, 147, 255)  # --primary-dim #14a693
LINE = (28, 44, 51, 255)       # --line   #1c2c33

SS = 8  # supersample factor


def rounded_rect(draw, box, radius, fill, outline=None, width=0):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_mark(size):
    """Draw the icon at `size` px, supersampled then reduced."""
    s = size * SS
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Plate: rounded square, slightly inset so the shape is not clipped by the
    # browser's own icon padding.
    pad = s * 0.045
    radius = s * 0.235
    rounded_rect(d, (pad, pad, s - pad, s - pad), radius, PANEL)
    # A hairline keeps the plate from vanishing on dark toolbars.
    rounded_rect(d, (pad, pad, s - pad, s - pad), radius, None, outline=LINE,
                 width=max(1, int(s * 0.012)))

    # Delta: an equilateral-ish triangle pointing up, the Delta Force cue.
    cx = s / 2
    top = s * 0.215
    bottom = s * 0.775
    half = s * 0.275
    tri = [(cx, top), (cx + half, bottom), (cx - half, bottom)]

    # Solid triangle in primary, then a concentric cut-out to leave a thick ring.
    d.polygon(tri, fill=PRIMARY)

    # Inner triangle (the hole). Scaled about the centroid so the ring is even.
    gx = sum(p[0] for p in tri) / 3
    gy = sum(p[1] for p in tri) / 3
    k = 0.44  # hole size relative to the outer triangle
    inner = [(gx + (x - gx) * k, gy + (y - gy) * k) for x, y in tri]
    d.polygon(inner, fill=PANEL)

    # Code slot: a horizontal bar across the lower third, reading as a key/code
    # line. Drawn in the dim primary so it stays visible but does not compete.
    bar_h = s * 0.075
    bar_y = bottom - s * 0.105
    d.rectangle((cx - half * 0.62, bar_y - bar_h / 2, cx + half * 0.62, bar_y + bar_h / 2),
                fill=PANEL)
    d.rectangle((cx - half * 0.46, bar_y - bar_h * 0.30, cx + half * 0.46, bar_y + bar_h * 0.30),
                fill=PRIM_DIM)

    return img.resize((size, size), Image.LANCZOS)


def draw_small(size):
    """16px needs a simpler mark: the ring and the slot merge at that scale."""
    s = size * SS
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = s * 0.03
    rounded_rect(d, (pad, pad, s - pad, s - pad), s * 0.22, PANEL)

    cx = s / 2
    top = s * 0.20
    bottom = s * 0.80
    half = s * 0.30
    tri = [(cx, top), (cx + half, bottom), (cx - half, bottom)]
    d.polygon(tri, fill=PRIMARY)
    gx = sum(p[0] for p in tri) / 3
    gy = sum(p[1] for p in tri) / 3
    k = 0.40
    inner = [(gx + (x - gx) * k, gy + (y - gy) * k) for x, y in tri]
    d.polygon(inner, fill=PANEL)
    return img.resize((size, size), Image.LANCZOS)


def draw_16():
    """16x16 is hand-plotted.

    Supersampling a triangle into 16px leaves the diagonals stepped unevenly and
    the apex off-centre by a subpixel, which is visible in a toolbar. At this size
    the mark is drawn as an explicit symmetric pixel mask instead: a 2px-thick
    delta outline, no inner slot (it merges into the hole at 16px).
    """
    img = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
    px = img.load()

    # Plate with manually clipped corners (a 1px notch reads as a rounded square).
    for y in range(16):
        for x in range(16):
            px[x, y] = PANEL
    for cx, cy in ((0, 0), (15, 0), (0, 15), (15, 15)):
        px[cx, cy] = (0, 0, 0, 0)

    # Delta outline: rows 3..12, mirrored around the 7/8 column pair so the shape
    # is exactly symmetric. The half-width ramps proportionally from the apex to
    # the base — clamping it instead made the lower rows equal width, which read
    # as an arch rather than a triangle.
    top_y, base_y = 3, 12
    span = base_y - top_y
    max_spread = 6  # widest row is x=1..14, inside the 16px plate
    rows = []
    for i, y in enumerate(range(top_y, base_y + 1)):
        spread = round(i * max_spread / span)
        rows.append((y, 7 - spread, 8 + spread))

    for y, left, right in rows:
        for x in (left, left + 1, right - 1, right):
            if 0 <= x < 16:
                px[x, y] = PRIMARY

    # Close the base on the bottom row of the triangle.
    base_left, base_right = rows[-1][1], rows[-1][2]
    for x in range(base_left, base_right + 1):
        px[x, base_y] = PRIMARY
        px[x, base_y - 1] = PRIMARY

    return img


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'extension/icons'
    os.makedirs(out, exist_ok=True)
    made = []
    for size in (16, 32, 48, 128):
        if size == 16:
            img = draw_16()
        elif size == 32:
            img = draw_small(size)
        else:
            img = draw_mark(size)
        path = os.path.join(out, f'icon{size}.png')
        img.save(path, optimize=True)
        made.append((path, os.path.getsize(path)))

    # A flat 512 for store listings / README.
    big = draw_mark(512)
    p512 = os.path.join(out, 'icon512.png')
    big.save(p512, optimize=True)
    made.append((p512, os.path.getsize(p512)))

    for path, size in made:
        print(f'{path} {size}B')


if __name__ == '__main__':
    main()
