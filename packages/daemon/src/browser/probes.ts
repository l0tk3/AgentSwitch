/** The only code the agent bridge lets run (docs/browser-v0.md §6; packages/secret-gate/BOUNDARY.md). Playwright MCP's
 *  `browser_run_code_unsafe` runs its code in a Node `vm` with the real `page`, in the daemon: `page.constructor
 *  .constructor` is the daemon's `Function`, `page.context()` every tab. The gate never offers it to the model and uses it
 *  for its own checks only, with code from fixed templates (`secret_gate/browser_probe.py`): a field's emptiness, the
 *  frame chain of a field, where a form submits, and a masked screenshot. The bridge takes exactly those templates —
 *  the fixed text below, mirrored from the gate, with only the gate's JSON literals in between, checked by type — and
 *  refuses any other code, whoever calls (a process with the session's token can skip the gate). `browser_evaluate`
 *  (code in the page, where it would read what a person typed) is likewise held to the gate's one probe,
 *  `() => location.href`.
 *
 *  When the gate's templates change, this file changes with them: the gate's tests pin the templates
 *  (`tests/test_browser_probe_templates.py`) and the daemon's test runs the gate's own code generation against this
 *  check when the gate's environment is there (`tests/browserProbes.test.ts`). */

import { basename, isAbsolute, normalize } from "node:path";

export const RUN_CODE_TOOL = "browser_run_code_unsafe";
export const EVALUATE_TOOL = "browser_evaluate";
/** The gate's URL probe (`HREF_PROBE_FUNCTION`). */
export const HREF_PROBE = "() => location.href";

export const CODE_REFUSED = "AgentSwitch's shared browser runs no code for agents: browser_run_code_unsafe takes only secret-gate's own checks.";
export const EVALUATE_REFUSED = "AgentSwitch's shared browser runs no page scripts for agents: browser_evaluate takes only secret-gate's URL check.";

const LOCATE = "const locate = (t) => page.locator(/^(?:f\\d+)?e\\d+$/.test(t) ? 'aria-ref=' + t : t);";
const OPEN = `async (page) => { ${LOCATE}`;
/** `check_target`: a ref or selector, 1–500 characters once trimmed. */
const MAX_TARGET_CHARS = 500;
const ARIA_REF = /^(?:f\d+)?e\d+$/;
/** The masked screenshot's file: in the gate's own output folder, under a name the gate makes. */
const MASK_FILE = /^secret-gate-mask-[0-9a-f]{16}\.png$/;
const MAX_SELECTORS = 64;
const MAX_REFS = 2_000;

type Template = { readonly name: string; readonly before: string; readonly after: string; readonly literal: (value: unknown) => boolean };

const isTarget = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0 && [...value].length <= MAX_TARGET_CHARS;

/** The masked screenshot's spec (`MaskPlan.spec()`): exactly these keys, each of its type. */
function isMaskSpec(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const spec = value as Record<string, unknown>;
  const keys = Object.keys(spec).sort().join(",");
  if (keys !== "color,fullPage,path,refs,selectors,target") return false;
  const strings = (v: unknown, max: number, each: (s: string) => boolean) => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && each(s));
  return strings(spec.refs, MAX_REFS, (r) => ARIA_REF.test(r))
    && strings(spec.selectors, MAX_SELECTORS, (s) => s.length > 0 && s.length <= MAX_TARGET_CHARS)
    && typeof spec.fullPage === "boolean"
    && (spec.target === null || isTarget(spec.target))
    && typeof spec.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(spec.color)
    && typeof spec.path === "string" && isMaskFile(spec.path);
}

/** An absolute, plain path to a file the gate names `secret-gate-mask-<16 hex>.png`. */
function isMaskFile(path: string): boolean {
  return isAbsolute(path) && normalize(path) === path && MASK_FILE.test(basename(path));
}

/** `browser_probe.py`'s templates, each as the text before and after its one JSON literal. */
const TEMPLATES: readonly Template[] = [
  {
    name: "field_state",
    before: `${OPEN} const field = locate(`,
    after: "); try { if (await field.count() !== 1) return 'unknown'; const value = await field.inputValue({ timeout: 2000 }); return value.length ? 'nonempty' : 'empty'; } catch { return 'unknown'; } }",
    literal: isTarget,
  },
  {
    name: "frame_chain",
    before: `${OPEN} const field = locate(`,
    after: "); if (await field.count() !== 1) return { error: 'target is not exactly one element' }; const handle = await field.elementHandle(); const frame = await handle.ownerFrame(); await handle.dispose(); if (!frame) return { error: 'target has no frame' }; const urls = []; for (let f = frame; f; f = f.parentFrame()) urls.push(f.url()); return { urls }; }",
    literal: isTarget,
  },
  {
    name: "form_target",
    before: `${OPEN} const field = locate(`,
    after: "); if (await field.count() !== 1) return { error: 'target is not exactly one element' }; return await field.evaluate((el) => { const form = el.form || el.closest('form'); if (!form) return { actions: [] }; const submitters = Array.from(form.elements).filter((c) => (c.type === 'submit' || c.type === 'image') && 'formAction' in c); return { actions: [form.action, ...submitters.map((c) => c.formAction)] }; }); }",
    literal: isTarget,
  },
  {
    name: "masked_screenshot",
    before: `${OPEN} const spec = `,
    after: "; const masks = []; for (const ref of spec.refs) { const l = locate(ref); try { await l.count(); masks.push(l); } catch {} } for (const css of spec.selectors) { masks.push(page.locator(css)); for (const frame of page.frames().slice(1)) masks.push(frame.locator(css)); } const element = spec.target ? locate(spec.target) : null; if (element) await element.scrollIntoViewIfNeeded({ timeout: 5000 }); const boxes = []; for (const m of masks) { for (const h of await m.all()) { const b = await h.boundingBox(); if (b && b.width > 0 && b.height > 0) boxes.push(b); } } const options = { path: spec.path, type: 'png', mask: masks, maskColor: spec.color, animations: 'disabled', caret: 'hide', scale: 'css', timeout: 15000 }; let origin = { x: 0, y: 0 }; if (element) { const b = await element.boundingBox(); if (!b) return { error: 'element is not visible' }; origin = b; await element.screenshot(options); } else { if (spec.fullPage) { const r = await page.locator(':root').boundingBox(); if (r) origin = { x: r.x, y: r.y }; } await page.screenshot({ ...options, fullPage: spec.fullPage }); } return { boxes: boxes.map((b) => ({ x: b.x - origin.x, y: b.y - origin.y, width: b.width, height: b.height })) }; }",
    literal: isMaskSpec,
  },
];

/** The template `code` is one of, with its literal checked; null for anything else. The literal must be JSON on its own
 *  (JSON.parse is strict: no code fits in it), so the code is the template's and nothing more. */
export function probeTemplate(code: string): string | null {
  for (const t of TEMPLATES) {
    if (code.length <= t.before.length + t.after.length || !code.startsWith(t.before) || !code.endsWith(t.after)) continue;
    let value: unknown;
    try { value = JSON.parse(code.slice(t.before.length, code.length - t.after.length)); } catch { continue; }
    if (t.literal(value)) return t.name;
  }
  return null;
}

type Args = Record<string, unknown>;

/** Why a call of the code tools is refused, or null: `browser_run_code_unsafe` only with a template's code (no file),
 *  `browser_evaluate` only as the URL probe (no element, no file). */
export function codeRefusal(tool: string, args: Args): string | null {
  if (tool === RUN_CODE_TOOL) {
    const keys = Object.keys(args);
    const ok = keys.length === 1 && keys[0] === "code" && typeof args.code === "string" && probeTemplate(args.code) !== null;
    return ok ? null : CODE_REFUSED;
  }
  if (tool === EVALUATE_TOOL) {
    const keys = Object.keys(args);
    return keys.length === 1 && keys[0] === "function" && args.function === HREF_PROBE ? null : EVALUATE_REFUSED;
  }
  return null;
}
