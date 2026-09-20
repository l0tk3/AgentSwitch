import { describe, expect, it } from "vitest";
import { Decision } from "../src/router/decision.js";
import { validateDecision, validatePin, type Context } from "../src/router/validate.js";
import { markUnavailable } from "../src/router/targets.js";
import { realTargets } from "./helpers.js";

const targets = realTargets();
const base: Context = { targets, quota: {}, running: {}, lowConfidenceTarget: { harness: "claude-code", model: "claude-sonnet-5" } };
const d = (over: Record<string, unknown> = {}) =>
  Decision.parse({ harness: "codex", model: "gpt-6-astra", effort: "high", brief: "x", confidence: 0.9, ...over });

describe("validateDecision", () => {
  it("passes a listed harness/model/effort straight through", () => {
    expect(validateDecision(d(), base)).toMatchObject({ ok: true, harness: "codex", model: "gpt-6-astra", effort: "high", chosen: "router", queue: false });
  });

  it("null model resolves to the harness default", () => {
    expect(validateDecision(d({ model: null, effort: null }), base)).toMatchObject({ ok: true, model: "gpt-6-astra" });
  });

  it("unknown harness or model falls through to fallbacks, then router.default", () => {
    const v = validateDecision(d({ harness: "gemini", fallbacks: [{ harness: "codex", model: "nope" }, { harness: "claude-code", model: "claude-opus-5" }] }), base);
    expect(v).toMatchObject({ ok: true, harness: "claude-code", model: "claude-opus-5", chosen: "fallback" });
    expect(v.notes).toEqual([expect.stringContaining("unknown harness gemini"), expect.stringContaining("nope not in catalog")]);
    const v2 = validateDecision(d({ harness: "gemini" }), base);
    expect(v2).toMatchObject({ ok: true, harness: "opencode", model: "deepseek/deepseek-flash", chosen: "default" });
  });

  it("effort must exist for that model; fallbacks are not given an effort", () => {
    const v = validateDecision(d({ model: "gpt-5.5", effort: "ultra", fallbacks: [{ harness: "codex", model: "gpt-5.5" }] }), base);
    expect(v).toMatchObject({ ok: true, model: "gpt-5.5", effort: null, chosen: "fallback" });
    expect(v.notes[0]).toContain("no effort ultra");
  });

  it("browser tasks need a browser-capable harness", () => {
    const v = validateDecision(d({ harness: "opencode", model: null, effort: null, needs_browser: true, fallbacks: [{ harness: "claude-code", model: "claude-sonnet-5" }] }), base);
    expect(v).toMatchObject({ ok: true, harness: "claude-code", chosen: "fallback" });
    const none = validateDecision(d({ harness: "opencode", model: null, effort: null, needs_browser: true }), base);
    expect(none).toMatchObject({ ok: false });
    expect(none.notes.at(-1)).toBe("no candidate can run");
  });

  it("exhausted quota and unavailable models are skipped", () => {
    const ctx = { ...base, quota: { codex: 0.01 } };
    expect(validateDecision(d({ fallbacks: [{ harness: "claude-code", model: "claude-haiku-4-5-20251001" }] }), ctx)).toMatchObject({ ok: true, harness: "claude-code", chosen: "fallback" });
    const gone = { ...base, targets: markUnavailable(targets, [{ harness: "codex", model: "gpt-6-astra" }]) };
    expect(validateDecision(d(), gone)).toMatchObject({ ok: true, chosen: "default" });
    expect(validateDecision(d(), gone).notes[0]).toContain("unavailable");
  });

  it("full harness queues instead of switching", () => {
    expect(validateDecision(d(), { ...base, running: { codex: 1 } })).toMatchObject({ ok: true, harness: "codex", queue: true });
    expect(validateDecision(d(), { ...base, running: { codex: 0 } })).toMatchObject({ queue: false });
  });

  it("low confidence keeps only the brief: target comes from the default policy", () => {
    const v = validateDecision(d({ confidence: 0.2 }), base);
    expect(v).toMatchObject({ ok: true, harness: "claude-code", model: "claude-sonnet-5", chosen: "default", effort: null });
    expect(v.notes[0]).toContain("below 0.5");
  });
});

describe("validatePin", () => {
  it("accepts listed targets and rejects everything else with a reason", () => {
    expect(validatePin({ harness: "claude-code", model: "claude-fable-5-1[1m]" }, base)).toMatchObject({ ok: true, chosen: "pin" });
    expect(validatePin({ harness: "claude-code", model: "claude-9" }, base)).toMatchObject({ ok: false, notes: [expect.stringContaining("not in catalog")] });
    expect(validatePin({ harness: "opencode", model: "deepseek/deepseek-flash" }, base, true)).toMatchObject({ ok: false });
  });
});
