"""Playwright code the gate runs itself through `browser_run_code_unsafe` (never offered to the model).

Every snippet is generated here from a fixed template; the only variable parts are JSON literals of
values the gate validated (element refs, CSS selectors it chose, a file path in its private output
directory). The snippets run in the Playwright server process; locator queries, `inputValue` and
screenshots run in Playwright's isolated world, so the page never sees what the gate asks for. Only
the form-target probe reads the form in the page's own world, where a hostile page could at worst
misreport its own form. The snippets return small verdicts only (a field's emptiness, a form's
submission URL, mask boxes); no value the gate typed ever travels back through them.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from .errors import PolicyViolation

RUN_CODE_TOOL = "browser_run_code_unsafe"
RESULT_HEADER = "### Result"
_SECTION = re.compile(r"^### ", re.MULTILINE)
ARIA_REF = re.compile(r"^(?:f\d+)?e\d+$")
MAX_TARGET_CHARS = 500

# JS helper shared by the snippets: a snapshot ref -> Playwright's aria-ref engine, else a selector.
_LOCATE = "const locate = (t) => page.locator(/^(?:f\\d+)?e\\d+$/.test(t) ? 'aria-ref=' + t : t);"


def check_target(target: object) -> str:
    if not isinstance(target, str) or not target.strip() or len(target) > MAX_TARGET_CHARS:
        raise PolicyViolation("a target element ref or selector is required")
    return target.strip()


def result_json(text: str) -> Any:
    """The JSON value in the `### Result` section of a browser_evaluate / run_code reply."""
    _, sep, rest = text.partition(RESULT_HEADER)
    if not sep:
        raise PolicyViolation("the browser gave no result; refused")
    section = _SECTION.split(rest, maxsplit=1)[0]
    line = next((ln.strip() for ln in section.splitlines() if ln.strip()), "")
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        raise PolicyViolation("the browser result could not be read; refused") from None


def field_state_code(target: str) -> str:
    """'empty' | 'nonempty' | 'unknown' for exactly one input/textarea/select; the value stays in Playwright."""
    return (
        "async (page) => { " + _LOCATE + f" const field = locate({json.dumps(check_target(target))});"
        " try { if (await field.count() !== 1) return 'unknown';"
        " const value = await field.inputValue({ timeout: 2000 }); return value.length ? 'nonempty' : 'empty'; }"
        " catch { return 'unknown'; } }"
    )


MAIN_FRAME_REF = re.compile(r"^e\d+$")


def frame_chain_code(target: str) -> str:
    """URLs of the frame holding the target and of every frame above it, innermost first.

    Playwright tracks frame URLs itself (`frame.url()`), so a page cannot misreport them.
    """
    return (
        "async (page) => { " + _LOCATE + f" const field = locate({json.dumps(check_target(target))});"
        " if (await field.count() !== 1) return { error: 'target is not exactly one element' };"
        " const handle = await field.elementHandle(); const frame = await handle.ownerFrame(); await handle.dispose();"
        " if (!frame) return { error: 'target has no frame' };"
        " const urls = []; for (let f = frame; f; f = f.parentFrame()) urls.push(f.url());"
        " return { urls }; }"
    )


def form_target_code(target: str) -> str:
    """Where the target's form can submit: {actions: [url, ...]} (the form's action and every submitter's
    formaction, including buttons outside the form tied to it with form="id"), or {actions: []} without a form."""
    return (
        "async (page) => { " + _LOCATE + f" const field = locate({json.dumps(check_target(target))});"
        " if (await field.count() !== 1) return { error: 'target is not exactly one element' };"
        " return await field.evaluate((el) => { const form = el.form || el.closest('form');"
        " if (!form) return { actions: [] };"
        " const submitters = Array.from(form.elements).filter((c) => (c.type === 'submit' || c.type === 'image') && 'formAction' in c);"
        " return { actions: [form.action, ...submitters.map((c) => c.formAction)] }; }); }"
    )


@dataclass(frozen=True)
class MaskPlan:
    refs: tuple[str, ...]  # aria refs from the gate's own snapshot or its fill history
    selectors: tuple[str, ...]  # CSS chosen by the gate (password inputs, canvases)
    path: str  # PNG inside the gate's private output directory
    full_page: bool = False
    target: str | None = None  # element screenshot
    color: str = "#FF00FF"

    def spec(self) -> dict[str, Any]:
        refs = [r for r in self.refs if ARIA_REF.match(r)]
        target = None if self.target is None else check_target(self.target)
        return {"refs": refs, "selectors": list(self.selectors), "path": self.path, "fullPage": self.full_page,
                "target": target, "color": self.color}


def masked_screenshot_code(plan: MaskPlan) -> str:
    """Screenshot with Playwright's native `mask`, returning the masked boxes in image coordinates.

    A ref that no longer resolves is skipped (the fresh snapshot the plan was built from is the
    authority); boxes are measured before capture so the gate can check every one is covered.
    """
    return (
        "async (page) => { " + _LOCATE + f" const spec = {json.dumps(plan.spec())};"
        " const masks = [];"
        " for (const ref of spec.refs) { const l = locate(ref); try { await l.count(); masks.push(l); } catch {} }"
        " for (const css of spec.selectors) { masks.push(page.locator(css));"
        " for (const frame of page.frames().slice(1)) masks.push(frame.locator(css)); }"
        " const element = spec.target ? locate(spec.target) : null;"
        " if (element) await element.scrollIntoViewIfNeeded({ timeout: 5000 });"
        " const boxes = [];"
        " for (const m of masks) { for (const h of await m.all()) { const b = await h.boundingBox();"
        " if (b && b.width > 0 && b.height > 0) boxes.push(b); } }"
        " const options = { path: spec.path, type: 'png', mask: masks, maskColor: spec.color,"
        " animations: 'disabled', caret: 'hide', scale: 'css', timeout: 15000 };"
        " let origin = { x: 0, y: 0 };"
        " if (element) { const b = await element.boundingBox(); if (!b) return { error: 'element is not visible' };"
        " origin = b; await element.screenshot(options); }"
        " else { if (spec.fullPage) { const r = await page.locator(':root').boundingBox(); if (r) origin = { x: r.x, y: r.y }; }"
        " await page.screenshot({ ...options, fullPage: spec.fullPage }); }"
        " return { boxes: boxes.map((b) => ({ x: b.x - origin.x, y: b.y - origin.y, width: b.width, height: b.height })) }; }"
    )
