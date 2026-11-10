#!/usr/bin/env python3
"""Generate PWA icons for the planner app: gradient teal background + white calendar/checkmark glyph."""
from PIL import Image, ImageDraw
import os

OUT = "/home/z/my-project/public/icons"
os.makedirs(OUT, exist_ok=True)

C_TOP = (13, 148, 136)    # teal-600
C_BOT = (4, 120, 87)      # emerald-700


def gradient_bg(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), C_TOP)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        c = tuple(int(a + (b - a) * t) for a, b in zip(C_TOP, C_BOT))
        d.line([(0, y), (size, y)], fill=c)
    return img


def draw_glyph(img: Image.Image, scale: float):
    """White calendar with rings + big checkmark, scale relative to size."""
    S = img.size[0]
    u = S * scale  # glyph unit box
    d = ImageDraw.Draw(img)
    margin = (S - u) / 2
    x0, y0 = margin, margin + S * 0.02
    x1, y1 = margin + u, margin + u
    r = u * 0.16
    lw = u * 0.09

    # calendar body (white rounded rect)
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=(255, 255, 255))

    # header band (tint inside top of body)
    band_h = u * 0.22
    d.rounded_rectangle([x0, y0, x1, y0 + band_h], radius=r, fill=(209, 250, 229))
    d.rectangle([x0, y0 + band_h - r, x1, y0 + band_h], fill=(209, 250, 229))

    # binding rings
    ring_w = u * 0.075
    for rx in (x0 + u * 0.26, x1 - u * 0.26):
        d.rounded_rectangle(
            [rx - ring_w / 2, y0 - u * 0.10, rx + ring_w / 2, y0 + u * 0.14],
            radius=ring_w / 2,
            fill=(255, 255, 255),
        )
        d.ellipse(
            [rx - ring_w * 0.22, y0 - u * 0.02, rx + ring_w * 0.22, y0 + u * 0.02],
            fill=(4, 120, 87),
        )

    # checkmark
    cx, cy = (x0 + x1) / 2, (y0 + y1 + band_h) / 2 + u * 0.02
    k = u * 0.30
    pts = [(cx - k, cy - k * 0.05), (cx - k * 0.25, cy + k * 0.55), (cx + k, cy - k * 0.55)]
    d.line(pts, fill=(13, 148, 136), width=int(lw * 1.35), joint="curve")
    for p in (pts[0], pts[1], pts[2]):
        d.ellipse(
            [p[0] - lw * 0.68, p[1] - lw * 0.68, p[0] + lw * 0.68, p[1] + lw * 0.68],
            fill=(13, 148, 136),
        )
    return img


def make(size: int, glyph_scale: float, path: str):
    img = gradient_bg(size)
    draw_glyph(img, glyph_scale)
    img.save(path)
    print("saved", path)


make(180, 0.58, f"{OUT}/apple-touch-icon.png")
make(192, 0.58, f"{OUT}/icon-192.png")
make(512, 0.58, f"{OUT}/icon-512.png")
make(512, 0.42, f"{OUT}/icon-512-maskable.png")
make(96, 0.62, f"{OUT}/favicon-96.png")
fav = gradient_bg(32)
draw_glyph(fav, 0.62)
fav.save("/home/z/my-project/public/favicon.ico", sizes=[(32, 32)])
print("saved /home/z/my-project/public/favicon.ico")
