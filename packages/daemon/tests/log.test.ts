import { describe, expect, it } from "vitest";
import { RoutingLog, taskHash } from "../src/router/log.js";
import type { RouteResult } from "../src/router/route.js";

const ok: RouteResult = {
  verdict: { ok: true, harness: "codex", model: "gpt-6-astra", effort: "high", chosen: "router", queue: false, notes: ["a", "b"] },
  decision: { harness: "codex", model: "gpt-6-astra", effort: "high", brief: "x", needs_browser: false, category: null, kind: null, thread: null, thread_confidence: null, question: null, expected_size: "small", risk: null, fallbacks: [], reason: "", confidence: 0.9, action: "redispatch", repair: null, handoff_note: null },
  source: "router",
  routerError: null,
  routerMs: 1234,
  attempts: 1,
};
const failed: RouteResult = { verdict: { ok: false, notes: ["no candidate can run"] }, decision: null, source: "default", routerError: "timed out", routerMs: 20000, attempts: 1 };

describe("RoutingLog", () => {
  it("records, updates outcome and lists newest first", () => {
    const log = new RoutingLog(":memory:");
    const id1 = log.record("task one", "/tmp/a", ok, 1000);
    const id2 = log.record("task two", "/tmp/b", failed, 2000);
    log.setOutcome(id1, "done");
    const rows = log.recent();
    expect(rows.map((r) => r.id)).toEqual([id2, id1]);
    expect(rows[1]).toMatchObject({ taskHash: taskHash("task one"), harness: "codex", model: "gpt-6-astra", chosen: "router", notes: "a | b", routerMs: 1234, outcome: "done" });
    expect(JSON.parse(rows[1]!.decision!)).toMatchObject({ brief: "x" });
    expect(rows[0]).toMatchObject({ harness: null, model: null, chosen: null, decision: null, routerError: "timed out", outcome: null });
    log.close();
  });

  it("task hash is stable, short and not the task text", () => {
    expect(taskHash("密码 enc:v1:abc")).toHaveLength(16);
    expect(taskHash("x")).toBe(taskHash("x"));
    expect(taskHash("x")).not.toContain("x");
  });
});
