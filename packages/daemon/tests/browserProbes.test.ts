/** The bridge's code allowlist (src/browser/probes.ts; docs/browser-v0.md §6): `browser_run_code_unsafe` runs only the
 *  gate's fixed probe templates (`secret_gate/browser_probe.py`) with their JSON literals, `browser_evaluate` only the
 *  gate's URL probe. Code that would escape Playwright MCP's `vm` into the daemon, or reach other tabs, is refused before
 *  Playwright MCP sees it. When the gate's environment is there, its own code generation is run against the check. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserAgents, type EngineConnection, type EngineOptions, type JsonRpcMessage } from "../src/browser/agents.js";
import { BrowserHost } from "../src/browser/host.js";
import { CODE_REFUSED, codeRefusal, EVALUATE_REFUSED, HREF_PROBE, probeTemplate } from "../src/browser/probes.js";
import type { TabOwner } from "../src/browser/types.js";
import { FakeDriver } from "./fakeBrowser.js";

const LOCATE = "const locate = (t) => page.locator(/^(?:f\\d+)?e\\d+$/.test(t) ? 'aria-ref=' + t : t);";
const FIELD_STATE = (literal: string) => `async (page) => { ${LOCATE} const field = locate(${literal}); try { if (await field.count() !== 1) return 'unknown'; const value = await field.inputValue({ timeout: 2000 }); return value.length ? 'nonempty' : 'empty'; } catch { return 'unknown'; } }`;
const SPEC = { refs: ["e1", "f2e7"], selectors: ["input[type=password]", "canvas"], path: "/g/out/secret-gate-mask-0123456789abcdef.png", fullPage: false, target: null, color: "#FF00FF" };
const SCREENSHOT_TAIL = "; const masks = []; for (const ref of spec.refs) { const l = locate(ref); try { await l.count(); masks.push(l); } catch {} } for (const css of spec.selectors) { masks.push(page.locator(css)); for (const frame of page.frames().slice(1)) masks.push(frame.locator(css)); } const element = spec.target ? locate(spec.target) : null; if (element) await element.scrollIntoViewIfNeeded({ timeout: 5000 }); const boxes = []; for (const m of masks) { for (const h of await m.all()) { const b = await h.boundingBox(); if (b && b.width > 0 && b.height > 0) boxes.push(b); } } const options = { path: spec.path, type: 'png', mask: masks, maskColor: spec.color, animations: 'disabled', caret: 'hide', scale: 'css', timeout: 15000 }; let origin = { x: 0, y: 0 }; if (element) { const b = await element.boundingBox(); if (!b) return { error: 'element is not visible' }; origin = b; await element.screenshot(options); } else { if (spec.fullPage) { const r = await page.locator(':root').boundingBox(); if (r) origin = { x: r.x, y: r.y }; } await page.screenshot({ ...options, fullPage: spec.fullPage }); } return { boxes: boxes.map((b) => ({ x: b.x - origin.x, y: b.y - origin.y, width: b.width, height: b.height })) }; }";
const SCREENSHOT = (spec: unknown) => `async (page) => { ${LOCATE} const spec = ${typeof spec === "string" ? spec : JSON.stringify(spec)}${SCREENSHOT_TAIL}`;

describe("the gate's probe templates", () => {
  it("are taken with their literals", () => {
    expect(probeTemplate(FIELD_STATE('"e12"'))).toBe("field_state");
    expect(probeTemplate(FIELD_STATE('"#login input[name=\\"password\\"]"'))).toBe("field_state");
    expect(probeTemplate(FIELD_STATE('"f1e2"'))).toBe("field_state");
    expect(probeTemplate(SCREENSHOT(SPEC))).toBe("masked_screenshot");
    expect(probeTemplate(SCREENSHOT({ ...SPEC, target: "e3", fullPage: true }))).toBe("masked_screenshot");
    expect(codeRefusal("browser_run_code_unsafe", { code: FIELD_STATE('"e12"') })).toBeNull();
    expect(codeRefusal("browser_evaluate", { function: HREF_PROBE })).toBeNull();
    expect(codeRefusal("browser_click", { target: "e1" })).toBeNull();
  });

  it("refuse any other code: escapes into the daemon, other tabs, code smuggled around or inside a literal", () => {
    const escapes = [
      "async (page) => page.constructor.constructor('return process')().mainModule.require('child_process').execSync('id').toString()",
      "async (page) => (await page.context().pages()).map((p) => p.url())",
      "async (page) => { const x = page.context(); return x.cookies(); }",
      // A template's text with code after the literal, or the literal closed early.
      FIELD_STATE('"e1"); page.constructor.constructor("return process")(); ("'),
      FIELD_STATE('"e1" + page.constructor.constructor("return process")()'),
      FIELD_STATE("`e1`"),
      FIELD_STATE("'e1'"),
      FIELD_STATE('("e1")'),
      `${FIELD_STATE('"e1"')}; process.exit(1)`,
      `(${FIELD_STATE('"e1"')})`,
      // Not a target: empty, too long, not a string.
      FIELD_STATE('""'), FIELD_STATE('"   "'), FIELD_STATE(JSON.stringify("x".repeat(501))), FIELD_STATE("12"), FIELD_STATE("null"), FIELD_STATE('["e1"]'),
      // The screenshot's spec: anything but the gate's shape, or a file it would not write.
      SCREENSHOT({ ...SPEC, path: "/Users/me/.zshrc" }),
      SCREENSHOT({ ...SPEC, path: "/g/out/../../Users/me/secret-gate-mask-0123456789abcdef.png" }),
      SCREENSHOT({ ...SPEC, path: "out/secret-gate-mask-0123456789abcdef.png" }),
      SCREENSHOT({ ...SPEC, refs: ["e1", "text=Password"] }),
      SCREENSHOT({ ...SPEC, color: "red; }" }),
      SCREENSHOT({ ...SPEC, extra: 1 }),
      SCREENSHOT('{"refs": [], "selectors": [], "path": "/g/secret-gate-mask-0123456789abcdef.png", "fullPage": false, "target": null, "color": "#FF00FF", "__proto__": {"refs": ["e1"]}}'),
      SCREENSHOT('{"refs": [], "selectors": [], "path": "/g/secret-gate-mask-0123456789abcdef.png", "fullPage": false, "target": null, "color": "#FF00FF"}, x = page.context()'),
      "",
    ];
    for (const code of escapes) {
      expect(probeTemplate(code), code.slice(0, 80)).toBeNull();
      expect(codeRefusal("browser_run_code_unsafe", { code }), code.slice(0, 80)).toBe(CODE_REFUSED);
    }
    expect(codeRefusal("browser_run_code_unsafe", {})).toBe(CODE_REFUSED);
    expect(codeRefusal("browser_run_code_unsafe", { code: FIELD_STATE('"e12"'), filename: "x.js" })).toBe(CODE_REFUSED);
    expect(codeRefusal("browser_run_code_unsafe", { code: 7 })).toBe(CODE_REFUSED);
  });

  it("browser_evaluate is the URL probe and nothing else", () => {
    for (const args of [
      { function: "() => document.querySelector('input[type=password]').value" },
      { function: "() => location.href", target: "e3" },
      { function: "(el) => el.value", target: "e3", element: "Password" },
      { function: "() => location.href " },
      {},
    ]) expect(codeRefusal("browser_evaluate", args), JSON.stringify(args)).toBe(EVALUATE_REFUSED);
  });

  // The gate makes the code (packages/secret-gate); run it, when its environment is there, to be sure both agree.
  const gatePython = resolve(__dirname, "..", "..", "secret-gate", ".venv", "bin", "python");
  it.skipIf(!existsSync(gatePython))("match what the gate's own browser_probe.py generates", () => {
    const script = [
      "import json",
      "from secret_gate.browser_probe import MaskPlan, field_state_code, frame_chain_code, form_target_code, masked_screenshot_code",
      "from secret_gate.browser_policy import HREF_PROBE_FUNCTION",
      "targets = ['e12', 'f3e45', '#login input[name=\"pw\"]', 'Pässwört ünïcode \\u2028 sep']",
      "codes = [f(t) for t in targets for f in (field_state_code, frame_chain_code, form_target_code)]",
      "codes.append(masked_screenshot_code(MaskPlan(refs=('e1', 'f2e9'), selectors=('input[type=password]', 'canvas', '.admin-region'), path='/Users/me/.secret-gate/out/secret-gate-mask-0123456789abcdef.png')))",
      "codes.append(masked_screenshot_code(MaskPlan(refs=(), selectors=('input[type=password]',), path='/g/secret-gate-mask-fedcba9876543210.png', full_page=True, target='e7')))",
      "print(json.dumps({'codes': codes, 'href': HREF_PROBE_FUNCTION}))",
    ].join("\n");
    const run = spawnSync(gatePython, ["-c", script], { cwd: resolve(__dirname, "..", "..", "secret-gate"), encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: mkdtempSync(join(tmpdir(), "agentswitch-probe-home-")) } });
    expect(run.status, run.stderr).toBe(0);
    const { codes, href } = JSON.parse(run.stdout) as { codes: string[]; href: string };
    expect(codes).toHaveLength(14);
    for (const code of codes) expect(probeTemplate(code), code.slice(0, 120)).not.toBeNull();
    expect(href).toBe(HREF_PROBE);
  });
});

const CODEX: TabOwner = { kind: "terminal", id: "t1", label: "codex · AgentSwitch" };

describe("through the bridge", () => {
  const hosts: BrowserHost[] = [];
  afterEach(async () => { for (const h of hosts.splice(0)) await h.shutdown(); });

  it("an escape attempt never reaches Playwright MCP; the gate's probe does", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-probes-")));
    const host = new BrowserHost({ driver: new FakeDriver(), profileDir: join(root, "profile"), files: { protected: { roots: [], exempt: [] }, home: root }, log: () => undefined });
    hosts.push(host);
    const forwarded: string[] = [];
    const engine = async (opts: EngineOptions): Promise<EngineConnection> => ({
      receive: (m: JsonRpcMessage) => {
        if (m.method !== "tools/call") return;
        forwarded.push(JSON.stringify(m.params));
        opts.send({ jsonrpc: "2.0", id: m.id!, result: { content: [{ type: "text", text: "### Result\n\"empty\"" }] } });
      },
      currentTab: () => null, tabAt: () => null, box: async () => null, close: async () => undefined,
    });
    const agents = new BrowserAgents({ host, engine, dir: join(root, "browser"), log: () => undefined });
    const s = agents.mint(CODEX);
    const answers = new Map<number, JsonRpcMessage>();
    const conn = await agents.connect(s.id, s.token, (m) => { if (typeof m.id === "number") answers.set(m.id, m); });
    const ask = async (id: number, name: string, args: Record<string, unknown>) => {
      conn.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      for (let i = 0; i < 50 && !answers.has(id); i++) await new Promise((r) => setTimeout(r, 2));
      return answers.get(id)!;
    };
    const escape = await ask(1, "browser_run_code_unsafe", { code: "async (page) => page.constructor.constructor('return process')().pid" });
    expect((escape.result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(escape.result)).toContain("runs no code for agents");
    const evaluate = await ask(2, "browser_evaluate", { function: "() => document.cookie" });
    expect((evaluate.result as { isError?: boolean }).isError).toBe(true);
    expect(forwarded).toEqual([]);
    const probe = await ask(3, "browser_run_code_unsafe", { code: FIELD_STATE('"e12"') });
    expect((probe.result as { isError?: boolean }).isError).toBeUndefined();
    expect(forwarded).toHaveLength(1);
    await agents.shutdown();
  });
});
