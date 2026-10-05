#!/usr/bin/env python3
"""Rasterise Tadkhir's icon geometry to PNG, stdlib only.

The mark is an open ring with a solid dot sitting in its gap: a day is a
cycle, and the dot is the one thing in it worth keeping. Every asset is drawn
from the same constants as the SVG files, so the PNGs and the SVGs cannot drift
apart.

Usage: python3 tools/make-icons.py
"""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "app" / "icons"

BG = (0, 0, 0, 255)
FG = (255, 255, 255, 255)

# Geometry in a 64x64 design space.
#
# An annulus with a gap at the top, and a disc in that gap. The gap is centred
# on straight up (-90 degrees, because y grows downward here) and is 52 degrees
# wide: wide enough that the ring reads as OPEN at 16px, which is the size the
# favicon is actually seen at, and still only a ninth of the circumference.
CENTER = (32.0, 34.0)
RING_RADIUS = 17.0
RING_WIDTH = 6.4
GAP_CENTER_DEG = -90.0
GAP_HALF_DEG = 26.0

# The dot rides on the ring, so it sits at the ring's radius, in the gap. It is
# well over half the stroke (3.2), and wide enough to span most of the gap's
# arc — asin(5.6 / 17) is about 19 degrees either side of straight up against a
# 26-degree half-gap. Anything smaller stops reading as a mark and starts
# reading as a speck floating above a broken circle.
DOT_RADIUS = 5.6


def angle_ok(deg):
    """True when an angle measured from CENTER falls inside the ring's arc."""
    # Compare on the shortest path around the circle, since the gap is a single
    # interval and everything else is the complement of it.
    off = (deg - GAP_CENTER_DEG + 180.0) % 360.0 - 180.0
    return abs(off) > GAP_HALF_DEG


def render(size, mark_scale=1.0):
    """Return RGBA rows, antialiased by 3x3 supersampling."""
    scale = size / 64 * mark_scale
    # Recentre. The design is drawn around (32, 32) and shrunk toward it, so
    # without this the mark sits in the TOP-LEFT of the canvas at any mark_scale
    # other than 1.0 — which is exactly what the maskable icon uses, and a
    # maskable icon is cropped to a circle about the canvas centre.
    off = (size - 64 * scale) / 2
    cx, cy = CENTER[0] * scale + off, CENTER[1] * scale + off
    r = RING_RADIUS * scale
    half = RING_WIDTH * scale / 2
    dot_r = DOT_RADIUS * scale
    # The dot rides on the ring, so it sits at the ring's radius, in the gap.
    dot_cx = cx
    dot_cy = cy - r

    samples = 3
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            hits = 0
            for sy in range(samples):
                for sx in range(samples):
                    px = x + (sx + 0.5) / samples
                    py = y + (sy + 0.5) / samples

                    dx, dy = px - dot_cx, py - dot_cy
                    if math.hypot(dx, dy) <= dot_r:
                        hits += 1
                        continue

                    dx, dy = px - cx, py - cy
                    dist = math.hypot(dx, dy)
                    if abs(dist - r) <= half:
                        deg = math.degrees(math.atan2(dy, dx))
                        if angle_ok(deg):
                            hits += 1
            a = hits / (samples * samples)
            if a == 0:
                row += bytes(BG)
            else:
                # White over black, coverage in the value.
                v = int(round(255 * a))
                row += bytes((v, v, v, 255))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)
    print(f"{path.name}: {size}x{size} ({len(png)} bytes)")


def main():
    assert DOT_RADIUS > RING_WIDTH / 2, (
        "the dot must out-measure the stroke it interrupts, or the gap reads as a "
        "lump instead of a mark"
    )
    write_png(ROOT / "icon-192.png", 192, render(192))
    write_png(ROOT / "icon-512.png", 512, render(512))
    write_png(ROOT / "apple-touch-icon.png", 180, render(180))
    # A maskable icon is cropped to a circle of 80% of its area, so the mark has
    # to sit inside the middle of the canvas, not fill it.
    write_png(ROOT / "maskable-512.png", 512, render(512, mark_scale=0.78))


if __name__ == "__main__":
    main()