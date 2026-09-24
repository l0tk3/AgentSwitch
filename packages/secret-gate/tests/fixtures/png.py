"""Tiny PNG writer for tests: a white RGB(A) canvas with coloured rectangles, any PNG row filter."""

from __future__ import annotations

import struct
import zlib

WHITE = (255, 255, 255)


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else (b if pb <= pc else c)


def _filter(kind: int, line: bytes, prev: bytes, bpp: int) -> bytes:
    out = bytearray(len(line))
    for i, value in enumerate(line):
        left = line[i - bpp] if i >= bpp else 0
        up = prev[i]
        corner = prev[i - bpp] if i >= bpp else 0
        predictor = (0, left, up, (left + up) // 2, _paeth(left, up, corner))[kind]
        out[i] = (value - predictor) & 0xFF
    return bytes(out)


def make_png(width: int, height: int, rects=(), *, alpha: bool = False, filters=(0,)) -> bytes:
    """`rects`: iterable of (x, y, w, h, (r, g, b)). Row y uses filters[y % len(filters)]."""
    bpp = 4 if alpha else 3
    pixels = [bytearray(bytes(WHITE) + (b"\xff" if alpha else b"")) * width for _ in range(height)]
    for x, y, w, h, rgb in rects:
        for yy in range(max(0, y), min(height, y + h)):
            for xx in range(max(0, x), min(width, x + w)):
                pixels[yy][xx * bpp:xx * bpp + 3] = bytes(rgb)
    raw = bytearray()
    prev = bytes(width * bpp)
    for y, line in enumerate(pixels):
        kind = filters[y % len(filters)]
        raw += bytes([kind]) + _filter(kind, bytes(line), prev, bpp)
        prev = bytes(line)
    header = struct.pack(">IIBBBBB", width, height, 8, 6 if alpha else 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header) + _chunk(b"IDAT", zlib.compress(bytes(raw))) + _chunk(b"IEND", b"")
