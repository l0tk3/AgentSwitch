import { describe, expect, it } from "vitest";
import { classifyFailure, detectRefusal, excerpt, hasSideEffects, NO_SIDE_EFFECTS } from "../src/router/failure.js";

describe("classifyFailure", () => {
  it("success is not a failure", () => {
    expect(classifyFailure({ ok: true })).toBeNull();
  });

  it("gate denial wins over everything", () => {
    expect(classifyFailure({ ok: false, gateDenied: true, httpStatus: 429 })).toBe("gate_denied");
    expect(classifyFailure({ ok: true, gateDenied: true, refusal: { source: "provider", reason: "blocked" } })).toBe("gate_denied");
  });

  it("quota: status codes and wording", () => {
    expect(classifyFailure({ ok: false, httpStatus: 429 })).toBe("quota");
    expect(classifyFailure({ ok: false, httpStatus: 402 })).toBe("quota");
    expect(classifyFailure({ ok: false, stderr: "Error: insufficient balance" })).toBe("quota");
    expect(classifyFailure({ ok: false, lastText: "You have hit your usage limit for today." })).toBe("quota");
    expect(classifyFailure({ ok: false, lastText: "余额不足，请充值" })).toBe("quota");
  });

  it("transport: network and proxy errors, silent timeouts, silent crashes, 5xx", () => {
    expect(classifyFailure({ ok: false, stderr: "connect ECONNREFUSED 127.0.0.1:8080" })).toBe("transport");
    expect(classifyFailure({ ok: false, stderr: "proxy connect failed: tunnel error" })).toBe("transport");
    expect(classifyFailure({ ok: false, timedOut: true })).toBe("transport");
    expect(classifyFailure({ ok: false, exitCode: 137 })).toBe("transport");
    expect(classifyFailure({ ok: false, httpStatus: 502 })).toBe("transport");
    expect(classifyFailure({ ok: false, stderr: "unable to get local issuer certificate (SSL)" })).toBe("transport");
  });

  it("refusal: model declines in English or Chinese", () => {
    expect(classifyFailure({ ok: false, exitCode: 0, lastText: "I can't help with automating logins to third-party sites." })).toBe("refusal");
    expect(classifyFailure({ ok: false, exitCode: 0, lastText: "抱歉，我无法协助完成这个操作。" })).toBe("refusal");
    expect(classifyFailure({ ok: false, exitCode: 0, lastText: "This request goes against our safety guidelines" })).toBe("refusal");
  });

  it("a successful process can still refuse the task", () => {
    const outcome = { ok: true, exitCode: 0, lastText: "I cannot help with that request." };
    expect(classifyFailure(outcome)).toBe("refusal");
    expect(detectRefusal(outcome)).toEqual({ source: "text", reason: outcome.lastText });
  });

  it("explicit provider refusal takes precedence over ordinary failure classification", () => {
    const refusal = { source: "provider" as const, reason: "provider policy" };
    expect(detectRefusal({ ok: true, refusal, lastText: "anything" })).toEqual(refusal);
    expect(classifyFailure({ ok: false, refusal, httpStatus: 429 })).toBe("refusal");
  });

  it("task_failed: executor finished and reported a problem; unknown otherwise", () => {
    expect(classifyFailure({ ok: false, exitCode: 0, lastText: "3 tests failed, see output above" })).toBe("task_failed");
    expect(classifyFailure({ ok: false, exitCode: 1, lastText: "file not found: foo.py" })).toBe("task_failed");
    expect(classifyFailure({ ok: false })).toBe("unknown");
  });

  it("excerpt is one line and bounded; side effects helper", () => {
    expect(excerpt({ ok: false, lastText: "  a\n\n b   c " })).toBe("a b c");
    expect(excerpt({ ok: false, stderr: "x".repeat(300) })).toHaveLength(240);
    expect(excerpt({ ok: false, lastText: "", stderr: "err" })).toBe("err");
    expect(hasSideEffects(NO_SIDE_EFFECTS)).toBe(false);
    expect(hasSideEffects({ ...NO_SIDE_EFFECTS, filesChanged: 1 })).toBe(true);
    expect(hasSideEffects(undefined)).toBe(false);
  });
});
