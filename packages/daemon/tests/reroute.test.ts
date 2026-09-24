import { describe, expect, it } from "vitest";
import { Decision } from "../src/router/decision.js";
import { NO_SIDE_EFFECTS } from "../src/core/outcome.js";
import { excludedTargets, nextStep, quotaAfter, type Attempt, type RerouteInput } from "../src/router/reroute.js";
import { realTargets } from "./helpers.js";

const targets = realTargets();
const decision = Decision.parse({
  harness: "codex", model: "gpt-6-astra", effort: "high", brief: "do it", confidence: 0.9,
  fallbacks: [{ harness: "claude-code", model: "claude-opus-5" }, { harness: "opencode", model: "deepseek/deepseek-flash" }],
});
const attempt = (over: Partial<Attempt> = {}): Attempt => ({ harness: "codex", model: "gpt-6-astra", kind: "transport", excerpt: "x", sideEffects: NO_SIDE_EFFECTS, ...over });
const input = (attempts: Attempt[], over: Partial<RerouteInput> = {}): RerouteInput =>
  ({ decision, attempts, routerAsks: 0, targets, quota: {}, lowConfidenceTarget: { harness: "claude-code", model: "claude-sonnet-4-6" }, ...over });

describe("nextStep", () => {
  it("transport without side effects: retry the same target once, then ask the router", () => {
    expect(nextStep(input([attempt()]))).toEqual({ kind: "retry", target: { harness: "codex", model: "gpt-6-astra" }, backoffMs: 5000 });
    const twice = nextStep(input([attempt(), attempt()]));
    expect(twice).toEqual({ kind: "ask-router", exclude: [{ harness: "codex", model: "gpt-6-astra" }] });
  });

  it("transport with side effects stops before any retry or router fallback", () => {
    const s = nextStep(input([attempt({ sideEffects: { ...NO_SIDE_EFFECTS, filesChanged: 2 } })]));
    expect(s).toMatchObject({ kind: "stop", reason: expect.stringContaining("核对现场") });
  });

  it("incomplete telemetry never permits replay, even for quota or supervisor rejection", () => {
    for (const kind of ["transport", "quota", "task_failed", "unknown", "rejected"] as const) {
      expect(nextStep(input([attempt({ kind, sideEffectsKnown: false })]))).toMatchObject({ kind: "stop", reason: expect.stringContaining("核对现场") });
      expect(nextStep(input([attempt({ kind, sideEffects: { ...NO_SIDE_EFFECTS, commandsRun: 1 } })]))).toMatchObject({ kind: "stop" });
    }
    const missing = { ...attempt(), sideEffects: undefined } as unknown as Attempt;
    expect(nextStep(input([missing]))).toMatchObject({ kind: "stop" });
  });

  it("transport when the router asks are used up still moves along the chain", () => {
    const s = nextStep(input([attempt(), attempt()], { routerAsks: 2 }));
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

  it("refusal cannot enter the generic router fallback, even after side effects", () => {
    const s = nextStep(input([attempt({ kind: "refusal", sideEffects: { ...NO_SIDE_EFFECTS, commandsRun: 3 } })]));
    expect(s).toMatchObject({ kind: "stop", reason: expect.stringContaining("grounded clarification") });
    expect(nextStep(input([attempt({ kind: "refusal" })]))).toMatchObject({ kind: "stop" });
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
    expect(nextStep(input([attempt({ kind: "quota" }), attempt({ kind: "quota" }), attempt({ kind: "quota" })]))).toMatchObject({ kind: "stop", reason: expect.stringContaining("max attempts") });
    expect(nextStep(input([attempt({ kind: "task_failed" })], { routerAsks: 2 }))).toMatchObject({ kind: "stop", reason: expect.stringContaining("router already asked") });
    expect(nextStep(input([]))).toMatchObject({ kind: "stop" });
  });

  it("without a decision, switching uses the router default", () => {
    const s = nextStep(input([attempt({ kind: "quota" })], { decision: null }));
    expect(s).toMatchObject({ kind: "switch", target: { harness: "opencode" } });
    expect(excludedTargets([attempt(), attempt(), attempt({ model: "gpt-5.5" })])).toHaveLength(2);
  });
});
