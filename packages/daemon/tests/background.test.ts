import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { EMPTY_FOLD, foldMessage, outcomeFromFold } from "../src/executors/claude.js";
import { applyNotification, EMPTY_TURN, outcomeFromTurn } from "../src/executors/codex.js";
import { outcomeFromRun, summarizeRun } from "../src/executors/opencode.js";
import type { Executor } from "../src/executors/types.js";
import { NO_SIDE_EFFECTS } from "../src/core/outcome.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();
/** Bounds a failure only: a passing wait returns as soon as the engine reaches the awaited state. */
const SETTLE = { timeout: 4_000, interval: 5 };

/** Executors that hold every run until the test finishes it, so concurrency is observed as overlap rather than inferred from elapsed time. */
function held() {
  const running = new Map<string, () => void>();
  const started: string[] = [];
  const executors: Executor[] = Object.keys(targets.harnesses).map((harness) => ({
    harness,
    run: (input) => new Promise((resolve, reject) => {
      started.push(input.taskId);
      const settle = () => { running.delete(input.taskId); input.signal.removeEventListener("abort", onAbort); };
      const onAbort = () => { settle(); reject(input.signal.reason); };
      input.signal.addEventListener("abort", onAbort, { once: true });
      running.set(input.taskId, () => { settle(); resolve({ ok: true, exitCode: 0, lastText: `done ${input.taskId}`, sideEffects: NO_SIDE_EFFECTS }); });
    }),
  }));
  /** Waits until exactly these tasks are inside an executor at the same time. */
  const runningExactly = (...ids: string[]) => vi.waitFor(() => expect([...running.keys()].sort()).toEqual([...ids].sort()), SETTLE);
  const finish = (...ids: string[]) => { for (const id of ids) running.get(id)!(); };
  return { executors, started, runningExactly, finish };
}

function build(replies: string[] | ((input: { task: string }, n: number) => string), maxConcurrentTasks = 4) {
  const store = new Store({ dbPath: ":memory:", threadsDir: join(mkdtempSync(join(tmpdir(), "agentswitch-bg-")), "threads") });
  const bus = new Bus();
  const events: TaskEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const runs = held();
  const engine = new Engine({ store, bus, executors: runs.executors, targets, router: echoRouter(replies), quota: () => ({}), approvalTimeoutMs: 200, retryBackoffMs: 1, maxConcurrentTasks });
  return { store, engine, events, bus, runs };
}

const to = (h: string, m: string) => decisionJson({ harness: h, model: m, effort: null });
const waits = (events: TaskEvent[], id: string) => events.filter((e) => e.taskId === id && e.type === "waiting").map((e) => e.payload.for);
const at = (events: TaskEvent[], id: string, type: string) => events.findIndex((e) => e.taskId === id && e.type === type);

describe("Engine: concurrency (background-v0 §1)", () => {
  it("independent tasks run in parallel; the same cwd serialises with a waiting event", async () => {
    const { engine, store, events, runs } = build(() => to("opencode", "deepseek/deepseek-flash"));
    const a = engine.submit({ task: "a", cwd: "/tmp/a" });
    const b = engine.submit({ task: "b", cwd: "/tmp/b" });
    await runs.runningExactly(a.id, b.id);          // both inside an executor before either is allowed to finish
    runs.finish(a.id, b.id);
    await engine.idle();
    expect([a, b].map((t) => store.getTask(t.id)!.status)).toEqual(["done", "done"]);
    expect(waits(events, b.id)).toEqual([]);
    const c = engine.submit({ task: "c", cwd: "/tmp/same" });
    const d = engine.submit({ task: "d", cwd: "/tmp/same" });
    await runs.runningExactly(c.id);
    await vi.waitFor(() => expect(waits(events, d.id)).toEqual(["cwd"]), SETTLE);
    await runs.runningExactly(c.id);                // d is held at the cwd gate while c still runs
    runs.finish(c.id);
    await runs.runningExactly(d.id);
    runs.finish(d.id);
    await engine.idle();
    expect(at(events, c.id, "done")).toBeLessThan(at(events, d.id, "dispatched"));
    expect(store.getTask(c.id)!.threadId).not.toBe(store.getTask(d.id)!.threadId);
  });

  it("harness max_concurrent gates dispatch: claude-code (1) serialises, opencode (2) runs two at once", async () => {
    const claude = build(() => to("claude-code", "claude-sonnet-4-6"));
    const a = claude.engine.submit({ task: "a", cwd: "/tmp/x1" });
    const b = claude.engine.submit({ task: "b", cwd: "/tmp/x2" });
    await claude.runs.runningExactly(a.id);
    await vi.waitFor(() => expect(waits(claude.events, b.id)).toEqual(["harness:claude-code"]), SETTLE);
    await claude.runs.runningExactly(a.id);         // one claude-code slot: b cannot start beside a
    claude.runs.finish(a.id);
    await claude.runs.runningExactly(b.id);
    claude.runs.finish(b.id);
    await claude.engine.idle();
    expect(waits(claude.events, a.id)).toEqual([]);
    expect(at(claude.events, a.id, "done")).toBeLessThan(at(claude.events, b.id, "dispatched"));
    const oc = build(() => to("opencode", "deepseek/deepseek-flash"));
    const x = oc.engine.submit({ task: "a", cwd: "/tmp/y1" });
    const y = oc.engine.submit({ task: "b", cwd: "/tmp/y2" });
    const third = oc.engine.submit({ task: "c", cwd: "/tmp/y3" });
    await oc.runs.runningExactly(x.id, y.id);      // two opencode slots run together
    await vi.waitFor(() => expect(waits(oc.events, third.id)).toEqual(["harness:opencode"]), SETTLE);
    await oc.runs.runningExactly(x.id, y.id);      // the third waits for a free slot, not for both to end
    oc.runs.finish(x.id);
    await oc.runs.runningExactly(y.id, third.id);
    oc.runs.finish(y.id, third.id);
    await oc.engine.idle();
    expect([x, y, third].map((t) => oc.store.getTask(t.id)!.status)).toEqual(["done", "done", "done"]);
  });

  it("global cap queues FIFO; a follow-up waits for its parent; cancelling a waiting task works", async () => {
    const { engine, store, events, runs } = build(() => to("opencode", "deepseek/deepseek-flash"), 1);
    const a = engine.submit({ task: "a", cwd: "/tmp/g1" });
    const b = engine.submit({ task: "b", cwd: "/tmp/g2" });
    const c = engine.submit({ task: "c", cwd: "/tmp/g3" });
    await runs.runningExactly(a.id);
    await vi.waitFor(() => expect([b, c].map((t) => waits(events, t.id))).toEqual([["global"], ["global"]]), SETTLE);
    expect(store.getTask(b.id)!.status).toBe("queued");
    expect(engine.cancel(c.id)!.status).toBe("cancelled");
    runs.finish(a.id);
    await runs.runningExactly(b.id);
    runs.finish(b.id);
    await engine.idle();
    expect(runs.started).toEqual([a.id, b.id]);    // FIFO, and the cancelled waiter never reached an executor
    expect(store.getTask(c.id)!.status).toBe("cancelled");
    expect(store.getTask(c.id)!.harness).toBeNull();
    const big = build(() => to("opencode", "deepseek/deepseek-flash"));
    const p = big.engine.submit({ task: "p", cwd: "/tmp/p" });
    const q = big.engine.submit({ task: "q", cwd: "/tmp/p", parentId: p.id });
    await big.runs.runningExactly(p.id);
    await vi.waitFor(() => expect(waits(big.events, q.id)).toEqual(["parent"]), SETTLE);
    big.runs.finish(p.id);
    await big.runs.runningExactly(q.id);
    big.runs.finish(q.id);
    await big.engine.idle();
    expect(at(big.events, p.id, "done")).toBeLessThan(at(big.events, q.id, "dispatched"));
    expect(big.store.getTask(q.id)!.threadId).toBe(big.store.getTask(p.id)!.threadId);
    expect(big.store.getTask(q.id)!.status).toBe("done");
  });
});

describe("sub-agent events (background-v0 §2)", () => {
  it("Claude: task_started / task_progress / task_notification count and describe agents; ambient tasks are ignored", () => {
    let s = EMPTY_FOLD;
    s = foldMessage(s, { type: "system", subtype: "task_started", task_id: "t1", description: "review tests", is_backgrounded: true, subagent_type: "reviewer" } as never);
    s = foldMessage(s, { type: "system", subtype: "task_started", task_id: "amb", description: "watcher", ambient: true } as never);
    s = foldMessage(s, { type: "system", subtype: "task_progress", task_id: "t1", description: "review tests", summary: "reading", usage: { total_tokens: 500, tool_uses: 3, duration_ms: 100 } } as never);
    s = foldMessage(s, { type: "system", subtype: "task_notification", task_id: "t1", status: "completed", summary: "all good", output_file: "/x" } as never);
    s = foldMessage(s, { type: "system", subtype: "task_started", task_id: "t2", description: "flaky" } as never);
    s = foldMessage(s, { type: "system", subtype: "task_notification", task_id: "t2", status: "failed", summary: "boom", output_file: "/y" } as never);
    expect(s.agents).toEqual({ spawned: 2, completed: 1, failed: 1 });
    expect(s.agentEvents.map((a) => [a.agentId, a.status])).toEqual([["t1", "started"], ["t1", "progress"], ["t1", "completed"], ["t2", "started"], ["t2", "failed"]]);
    expect(s.agentEvents[0]).toMatchObject({ background: true, description: "review tests" });
    expect(s.agentEvents[1]).toMatchObject({ summary: "reading", tokens: 500 });
    const done = foldMessage(s, { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} } as never);
    expect(outcomeFromFold(done, 0, false).agents).toEqual({ spawned: 2, completed: 1, failed: 1 });
  });

  it("Codex: subAgentActivity bookends and collabAgentToolCall items", () => {
    let s = EMPTY_TURN;
    s = applyNotification(s, "item/started", { item: { type: "subAgentActivity", kind: "started", agentThreadId: "sub1", agentPath: "tester" } });
    s = applyNotification(s, "item/completed", { item: { type: "subAgentActivity", kind: "started", agentThreadId: "sub1", agentPath: "tester" } });   // completion of the same activity item: not counted twice
    s = applyNotification(s, "item/completed", { item: { type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["sub1"], prompt: "run the tests", senderThreadId: "main" } });
    s = applyNotification(s, "item/completed", { item: { type: "subAgentActivity", kind: "completed", agentThreadId: "sub1", agentPath: "tester" } });
    s = applyNotification(s, "item/completed", { item: { type: "collabAgentToolCall", tool: "spawnAgent", status: "failed", receiverThreadIds: ["sub2"], prompt: "x" } });
    s = applyNotification(s, "item/started", { item: { type: "subAgentActivity", kind: "started", agentThreadId: "sub3", agentPath: "x" } });
    s = applyNotification(s, "item/completed", { item: { type: "collabAgentToolCall", tool: "wait", status: "completed", receiverThreadIds: ["sub3"] } });   // Codex reports the end through wait, not always through subAgentActivity
    s = applyNotification(s, "turn/completed", {});
    expect(s.agents).toEqual({ spawned: 2, completed: 2, failed: 1 });
    expect(s.agentEvents.map((a) => a.status)).toEqual(["started", "progress", "completed", "failed", "started", "completed"]);
    expect(s.tools).toBe(3);
    expect(outcomeFromTurn(s, null).agents).toEqual({ spawned: 2, completed: 2, failed: 1 });
  });

  it("OpenCode: the task tool counts as a completed sub-agent", () => {
    const s = summarizeRun([JSON.stringify({ type: "tool_use", sessionID: "s", part: { tool: "task", input: { description: "grep it" } } }), JSON.stringify({ type: "text", sessionID: "s", part: { text: "done" } })].join("\n"));
    expect(outcomeFromRun(s, 0, "", false).agents).toEqual({ spawned: 1, completed: 1, failed: 0 });
  });
});
