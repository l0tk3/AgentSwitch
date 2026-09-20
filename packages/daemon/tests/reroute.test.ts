import { describe, expect, it } from "vitest";
import { Decision } from "../src/router/decision.js";
import { NO_SIDE_EFFECTS } from "../src/router/failure.js";
import { excludedTargets, nextStep, quotaAfter, type Attempt, type RerouteInput } from "../src/router/reroute.js";
import { realTargets } from "./helpers.js";

const targets = realTargets();
const decision = Decision.parse({
  harness: "codex", model: "gpt-6-astra", effort: "high", brief: "do it", confidence: 0.9,
  fallbacks: [{ harness: "claude-code", model: "claude-opus-5" }, { harness: "opencode", model: "deepseek/deepseek-flash" }],
});
const attempt = (over: Partial<Attempt> = {}): Attempt => ({ harness: "codex", model: "gpt-6-astra", kind: "transport", excerpt: "x", sideEffects: NO_SIDE_EFFECTS, ...over });
const input = (attempts: Attempt[], over: Partial<RerouteInput> = {}): RerouteInput =>
  ({ decision, attempts, routerAsks: 0, targets, quota: {}, running: {}, lowConfidenceTarget: { harness: "claude-code", model: "claude-sonnet-5" }, ...over });

describe("nextStep", () => {
  it("transport without side effects: retry the same target once, then switch", () => {
    expect(nextStep(input([attempt()]))).toEqual({ kind: "retry", target: { harness: "codex", model: "gpt-6-astra" }, backoffMs: 5000 });
    const twice = nextStep(input([attempt(), attempt()]));
    expect(twice).toMatchObject({ kind: "switch", target: { harness: "claude-code", model: "claude-opus-5" } });
  });

  it("transport with side effects goes straight to the fallback chain", () => {
    const s = nextStep(input([attempt({ sideEffects: { ...NO_SIDE_EFFECTS, filesChanged: 2 } })]));
    expect(s).toMatchObject({ kind: "switch", target: { harness: "claude-code", model: "claude-opus-5" } });
  });

  it("quota: harness marked empty, next fallback that passes the floor", () => {
    const s = nextStep(input([attempt({ kind: "quota" })]));
    expect(s).toMatchObject({ kind: "switch", target: { harness: "claude-code" } });
    const both = nextStep(input([attempt({ kind: "quota" }), attempt({ harness: "claude-code", model: "claude-opus-5", kind: "quota" })]));
    expect(both).toMatchObject({ kind: "switch", target: { harness: "opencode", model: "deepseek/deepseek-flash" } });
    expect(quotaAfter([attempt({ kind: "quota" })], { codex: 0.8 })).toEqual({ codex: 0 });
  });

  it("chain exhausted: stop with the reasons", () => {
    const all = [attempt({ kind: "quota" }), attempt({ harness: "claude-code", model: "claude-opus-5", kind: "quota" })];
    const s = nextStep(input(all, { quota: { opencode: 0 }, limits: { maxAttempts: 5, maxRouterAsks: 2 } }));
    expect(s).toMatchObject({ kind: "stop", security: false });
    expect((s as { reason: string }).reason).toContain("no remaining target");
  });

  it("refusal asks the router with the tried targets excluded, even after side effects", () => {
    const s = nextStep(input([attempt({ kind: "refusal", sideEffects: { ...NO_SIDE_EFFECTS, commandsRun: 3 } })]));
    expect(s).toEqual({ kind: "ask-router", exclude: [{ harness: "codex", model: "gpt-6-astra" }] });
  });

  it("task_failed: ask the router only when nothing was done yet", () => {
    expect(nextStep(input([attempt({ kind: "task_failed" })]))).toMatchObject({ kind: "ask-router" });
    expect(nextStep(input([attempt({ kind: "unknown", sideEffects: { ...NO_SIDE_EFFECTS, filesChanged: 1 } })]))).toMatchObject({ kind: "stop" });
  });

  it("gate denial and approved actions stop immediately", () => {
    expect(nextStep(input([attempt({ kind: "gate_denied" })]))).toMatchObject({ kind: "stop", security: true });
    expect(nextStep(input([attempt({ kind: "refusal", sideEffects: { ...NO_SIDE_EFFECTS, approvalsGranted: 1 } })]))).toMatchObject({ kind: "stop", security: false });
  });

  it("limits: attempts and router asks", () => {
    expect(nextStep(input([attempt(), attempt(), attempt()]))).toMatchObject({ kind: "stop", reason: expect.stringContaining("max attempts") });
    expect(nextStep(input([attempt({ kind: "refusal" })], { routerAsks: 2 }))).toMatchObject({ kind: "stop", reason: expect.stringContaining("router already asked") });
    expect(nextStep(input([]))).toMatchObject({ kind: "stop" });
  });

  it("without a decision, switching uses the router default", () => {
    const s = nextStep(input([attempt({ kind: "quota" })], { decision: null }));
    expect(s).toMatchObject({ kind: "switch", target: { harness: "opencode" } });
    expect(excludedTargets([attempt(), attempt(), attempt({ model: "gpt-5.5" })])).toHaveLength(2);
  });
});
