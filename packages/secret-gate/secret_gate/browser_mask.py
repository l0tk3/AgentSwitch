"""Screenshot masking (gate-next-v0 §5.1): what to cover, and proof that it was covered.

What to cover comes from the gate's own unredacted snapshot taken right before the capture: every
element whose line shows a value the gate filled or sealed, or a configured personal-data pattern,
is masked by its snapshot ref (a text line without a ref masks its nearest ancestor with one).
Password inputs are always masked, canvases whenever the page held a protected value. The page is
never told what is protected.

Proof: Playwright draws the masks, but the page could interfere with the overlay, so the gate
decodes the PNG itself and requires every interior pixel of every measured box to be the mask
colour. Anything it cannot verify (unexpected PNG format, a box it cannot check) refuses the image.
"""

from __future__ import annotations

import re
import struct
import zlib
from collections.abc import Iterable
from dataclasses import dataclass
from math import ceil, floor

import json
from pathlib import Path

from .errors import ValidationError
from .pii import KINDS, check_kinds, find_pii
from .policy import host_matches, normalize_host
from .redact import encodings

MASK_COLOR = "#FF00FF"
MASK_RGB = (0xFF, 0x00, 0xFF)
PASSWORD_SELECTOR = "input[type=password]"
CANVAS_SELECTOR = "canvas"
_REF = re.compile(r"\[ref=((?:f\d+)?e\d+)\]")
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_CHANNELS = {2: 3, 6: 4}  # colour type -> bytes per pixel at 8-bit depth


MASK_CONFIG_FILE = "screenshot-mask.json"
MAX_SELECTOR_CHARS = 200


@dataclass(frozen=True)
class MaskConfig:
    """Admin rules from `<gate home>/screenshot-mask.json`:
    {"kinds": ["email", ...], "regions": {"host[:port]": ["css selector", ...]}}.
    `kinds` defaults to every known kind; `regions` are always masked on matching hosts."""

    kinds: tuple[str, ...] = KINDS
    regions: tuple[tuple[str, tuple[str, ...]], ...] = ()

    @classmethod
    def load(cls, home: Path) -> MaskConfig:
        path = Path(home) / MASK_CONFIG_FILE
        if not path.exists():
            return cls()
        try:
            data = json.loads(path.read_text())
        except ValueError as exc:
            raise ValidationError(f"{MASK_CONFIG_FILE} is invalid: {exc}") from None
        return cls.parse(data)

    @classmethod
    def parse(cls, data: object) -> MaskConfig:
        """The parsed content of screenshot-mask.json (None: no file). With the gate service installed the
        browser component gets it from `browser.config` (gate-service-v0 §3.2)."""
        if data is None:
            return cls()
        try:
            if not isinstance(data, dict) or set(data) - {"kinds", "regions"}:
                raise ValueError("unexpected keys")
            kinds = check_kinds(data.get("kinds", KINDS))
            regions = data.get("regions", {})
            if not isinstance(regions, dict):
                raise ValueError("regions must be an object")
            parsed = []
            for host, selectors in regions.items():
                if not isinstance(selectors, list) or not all(
                        isinstance(sel, str) and 0 < len(sel) <= MAX_SELECTOR_CHARS for sel in selectors):
                    raise ValueError(f"regions of {host!r} must be a list of selectors")
                parsed.append((normalize_host(host), tuple(selectors)))
        except (ValueError, TypeError, ValidationError) as exc:
            raise ValidationError(f"{MASK_CONFIG_FILE} is invalid: {exc}") from None
        return cls(kinds=kinds, regions=tuple(parsed))

    def selectors_for(self, host_port: str) -> tuple[str, ...]:
        return tuple(sel for pattern, sels in self.regions if host_matches(pattern, host_port) for sel in sels)


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class Findings:
    refs: tuple[str, ...]
    unmapped: int  # sensitive lines with no ref to mask by: the capture must be refused


def sensitive_refs(snapshot: str, values: Iterable[str], kinds: Iterable[str] = ()) -> Findings:
    """Snapshot refs of elements showing any of `values` (any encoding) or a personal-data match."""
    forms = {form for v in values if v for form in encodings(v)}
    kinds = tuple(kinds)
    lines = page_tree(snapshot)
    refs: list[str] = []
    unmapped = 0
    for index, line in enumerate(lines):
        if not (any(form in line for form in forms) or (kinds and find_pii(line, kinds))):
            continue
        ref = _ref_for(lines, index)
        if ref is None:
            unmapped += 1
        elif ref not in refs:
            refs.append(ref)
    return Findings(tuple(refs), unmapped)


def page_tree(snapshot: str) -> list[str]:
    """The accessibility tree lines of a browser_snapshot reply (the ```yaml block of `### Snapshot`).

    Header lines (page URL, title) are not drawn in a page screenshot, so they are not scanned.
    """
    _, sep, rest = snapshot.partition("### Snapshot")
    body = rest if sep else snapshot
    fenced, fence, tail = body.partition("```yaml")
    if fence:
        body = tail.split("```", 1)[0]
    return body.splitlines()


def _ref_for(lines: list[str], index: int) -> str | None:
    """The line's own ref, else the nearest less-indented line above that has one."""
    own = _REF.search(lines[index])
    if own:
        return own.group(1)
    indent = len(lines[index]) - len(lines[index].lstrip())
    for line in reversed(lines[:index]):
        stripped = line.lstrip()
        depth = len(line) - len(stripped)
        if depth < indent and stripped.startswith("- "):
            found = _REF.search(line)
            if found:
                return found.group(1)
            indent = depth
    return None


def decode_png(data: bytes, rows: int | None = None) -> tuple[int, int, int, bytes]:
    """(width, height, bytes_per_pixel, pixel rows) of an 8-bit RGB/RGBA, non-interlaced PNG.

    Only the first `rows` rows are unfiltered (each row depends on the one above it); the rest is
    left out, which keeps a tall full-page capture cheap when the masks are near the top.
    """
    try:
        return _decode(data, rows)
    except (zlib.error, struct.error) as exc:
        raise ValueError("corrupt PNG") from exc


def _decode(data: bytes, rows: int | None) -> tuple[int, int, int, bytes]:
    if not data.startswith(_PNG_SIGNATURE):
        raise ValueError("not a PNG")
    pos, header, idat = len(_PNG_SIGNATURE), None, bytearray()
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", chunk)
        elif kind == b"IDAT":
            idat += chunk
        elif kind == b"IEND":
            break
    if header is None:
        raise ValueError("PNG without header")
    width, height, depth, colour, _compression, _filter, interlace = header
    if depth != 8 or colour not in _CHANNELS or interlace != 0:
        raise ValueError("unsupported PNG format")
    bpp = _CHANNELS[colour]
    wanted = height if rows is None else max(0, min(height, rows))
    return width, height, bpp, _unfilter(zlib.decompress(bytes(idat)), width, height, bpp, wanted)


def _unfilter(raw: bytes, width: int, height: int, bpp: int, rows: int) -> bytes:
    stride = width * bpp
    if len(raw) < height * (stride + 1):
        raise ValueError("truncated PNG data")
    out = bytearray(rows * stride)
    prev = bytearray(stride)
    for y in range(rows):
        kind = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            left = line[i - bpp] if i >= bpp else 0
            up = prev[i]
            corner = prev[i - bpp] if i >= bpp else 0
            if kind == 1:
                line[i] = (line[i] + left) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + up) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif kind == 4:
                line[i] = (line[i] + _paeth(left, up, corner)) & 0xFF
            elif kind != 0:
                raise ValueError("bad PNG filter")
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return bytes(out)


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else (b if pb <= pc else c)


def uncovered_boxes(png: bytes, boxes: Iterable[Box], rgb: tuple[int, int, int] = MASK_RGB) -> tuple[Box, ...]:
    """Boxes whose interior (1px inset, clipped to the image) is not entirely the mask colour."""
    boxes = tuple(boxes)
    bottom = max((floor(b.y + b.height) - 1 for b in boxes), default=0)
    width, height, bpp, pixels = decode_png(png, rows=bottom)
    stride = width * bpp
    bad: list[Box] = []
    for box in boxes:
        x0, y0 = max(0, ceil(box.x) + 1), max(0, ceil(box.y) + 1)
        x1, y1 = min(width, floor(box.x + box.width) - 1), min(height, floor(box.y + box.height) - 1)
        for y in range(y0, y1):
            row = pixels[y * stride:(y + 1) * stride]
            if any(tuple(row[x * bpp:x * bpp + 3]) != rgb or (bpp == 4 and row[x * bpp + 3] != 0xFF) for x in range(x0, x1)):
                bad.append(box)
                break
    return tuple(bad)


def parse_boxes(raw: object) -> tuple[Box, ...]:
    if not isinstance(raw, list):
        raise ValueError("mask boxes missing")
    out = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("bad mask box")
        values = [item.get(k) for k in ("x", "y", "width", "height")]
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in values):
            raise ValueError("bad mask box")
        out.append(Box(*values))
    return tuple(out)
