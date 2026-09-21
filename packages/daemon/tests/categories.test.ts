import { describe, expect, it } from "vitest";
import { parseDecision } from "../src/router/decision.js";
import { defaultTarget } from "../src/router/defaultPolicy.js";
import { systemPrompt } from "../src/router/prompt.js";
import { route } from "../src/router/route.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { allowedFor, catalogText, categoryOf, parseTargets } from "../src/router/targets.js";
import { validateDecision, validatePin } from "../src/router/validate.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();
const OPUS48 = { harness: "claude-code", model: "claude-opus-4-8" };
const FLASH = { harness: "opencode", model: "deepseek/deepseek-flash" };
const ctxOf = (category: string | null, quota: Record<string, number> = {}) => ({ targets, quota, running: {}, lowConfidenceTarget: FLASH, category });

describe("security category", () => {
  it("is declared in targets.yaml with an allow list of catalog models", () => {
    const sec = targets.categories.security!;
    expect(sec.allow).toEqual(expect.arrayContaining([OPUS48, { harness: "claude-code", model: "claude-opus-4-7" }, { harness: "claude-code", model: "claude-opus-4-6" }, FLASH]));
    expect(allowedFor(targets, "security", OPUS48)).toBe(true);
    expect(allowedFor(targets, "security", { harness: "codex", model: "gpt-6-astra" })).toBe(false);
    expect(allowedFor(targets, "security", { harness: "claude-code", model: "claude-fable-5-1" })).toBe(false);
    expect(allowedFor(targets, "nope", { harness: "codex", model: "gpt-6-astra" })).toBe(true);   // unknown category = no restriction
    expect(() => parseTargets(`
harnesses:
  a: {quota: balance, max_concurrent: 1, browser: false, default_model: m, models: {m: {cost: low}}}
router: {harness: a, model: m, default: {harness: a, model: m}}
categories:
  security: {description: x, allow: [{harness: a, model: ghost}]}
`)).toThrow(/categories\.security.*ghost/);
  });

  it("is detected from task text by the keyword floor", () => {
    expect(categoryOf("帮我做这道 pwn 题，附件是 binary", targets)).toBe("security");
    expect(categoryOf("CTF 逆向题，分析这个 ELF 的校验逻辑", targets)).toBe("security");
    expect(categoryOf("write an exploit for the heap overflow in ./vuln", targets)).toBe("security");
    expect(categoryOf("翻译 README 里的表格", targets)).toBeNull();
    expect(categoryOf("fix the failing unit test in parser.ts", targets)).toBeNull();
    expect(categoryOf("drop the europe column, it is a property of the old schema", targets)).toBeNull();   // "rop" is a whole word
    expect(categoryOf("check CVE-2024-3094 in our xz build", targets)).toBe("security");
  });

  it("reaches the router: catalog text lists the category and the decision keeps it", () => {
    const text = catalogText(targets);
    expect(text).toContain("security");
    expect(text).toContain("claude-code/claude-opus-4-8");
    expect(systemPrompt(targets)).toContain('"category"');
    const parsed = parseDecision(decisionJson({ category: "security" }));
    expect(parsed.ok && parsed.decision.category).toBe("security");
    const none = parseDecision(decisionJson({}));
    expect(none.ok && none.decision.category).toBeNull();
  });

  it("rejects disallowed models for a security task and takes the first allowed fallback", () => {
    const d = parseDecision(decisionJson({ harness: "codex", model: "gpt-6-astra", fallbacks: [{ harness: "claude-code", model: "claude-sonnet-5" }, OPUS48] }));
    if (!d.ok) throw new Error(d.error);
    const v = validateDecision(d.decision, ctxOf("security"));
    expect(v).toMatchObject({ ok: true, harness: "claude-code", model: "claude-opus-4-8", chosen: "fallback" });
    expect(v.notes.join("\n")).toMatch(/gpt-6-astra.*security.*refuse/);
    expect(v.notes.join("\n")).toMatch(/claude-sonnet-5.*security/);
    // the router may declare the category itself even when the keyword floor missed it
    const declared = parseDecision(decisionJson({ harness: "codex", model: "gpt-6-astra", category: "security", fallbacks: [OPUS48] }));
    if (!declared.ok) throw new Error(declared.error);
    expect(validateDecision(declared.decision, ctxOf(null))).toMatchObject({ ok: true, model: "claude-opus-4-8" });
    // a pin is the user's call: allowed, with a warning
    const pinned = validatePin({ harness: "codex", model: "gpt-6-astra" }, ctxOf("security"));
    expect(pinned).toMatchObject({ ok: true, harness: "codex" });
    expect(pinned.notes.join("\n")).toMatch(/security/);
  });

  it("default policy walks the allow list in order and skips harnesses without quota", () => {
    expect(defaultTarget("这是一道 pwn 题", targets, { "claude-code": 0.8, opencode: 0.9 })).toEqual(OPUS48);
    expect(defaultTarget("这是一道 pwn 题", targets, { "claude-code": 0.01, opencode: 0.9 })).toEqual(FLASH);
    expect(defaultTarget("修一下 parser.ts 的测试", targets, { "claude-code": 0.8 })).not.toEqual(OPUS48);
  });

  it("end to end: the router picks Codex for a CTF task, the floor redirects to Opus", async () => {
    const router = echoRouter([decisionJson({ harness: "codex", model: "gpt-6-astra", fallbacks: [OPUS48] })]);
    const r = await route({ task: "CTF pwn: 分析 ./chall 并写 exploit", cwd: "/tmp" }, { targets, router, quota: {}, running: {} });
    expect(r.verdict).toMatchObject({ ok: true, harness: "claude-code", model: "claude-opus-4-8" });
    expect(r.source).toBe("router");
  });
});
