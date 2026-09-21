import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { EMPTY_FOLD, foldMessage, outcomeFromFold } from "../src/executors/claude.js";
import { applyNotification, EMPTY_TURN, outcomeFromTurn } from "../src/executors/codex.js";
import { echoExecutor } from "../src/executors/echo.js";
import { outcomeFromRun, summarizeRun } from "../src/executors/opencode.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();

function build(replies: string[] | ((input: { task: string }, n: number) => string), maxConcurrentTasks = 4) {
  const store = new Store({ dbPath: ":memory:", threadsDir: join(mkdtempSync(join(tmpdir(), "agentswitch-bg-")), "threads") });
  const bus = new Bus();
  const events: TaskEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const echo = Object.keys(targets.harnesses).map((h) => echoExecutor(h));
  const engine = new Engine({ store, bus, executors: echo, targets, router: echoRouter(replies), quota: () => ({}), approvalTimeoutMs: 200, retryBackoffMs: 1, maxConcurrentTasks });
  return { store, engine, events, bus };
}

const to = (h: string, m: string) => decisionJson({ harness: h, model: m, effort: null });
const waits = (events: TaskEvent[], id: string) => events.filter((e) => e.taskId === id && e.type === "waiting").map((e) => e.payload.for);

describe("Engine: concurrency (background-v0 §1)", () => {
  it("independent tasks run in parallel; the same cwd serialises with a waiting event", async () => {
    const { engine, store, events } = build(() => to("opencode", "deepseek/deepseek-flash"));
    const t0 = Date.now();
    const a = engine.submit({ task: 'a @echo {"delayMs":300}', cwd: "/tmp/a" });
    const b = engine.submit({ task: 'b @echo {"delayMs":300}', cwd: "/tmp/b" });
    await engine.idle();
    expect(Date.now() - t0).toBeLessThan(550);
    expect([a, b].map((t) => store.getTask(t.id)!.status)).toEqual(["done", "done"]);
    expect(waits(events, b.id)).toEqual([]);
    const t1 = Date.now();
    const c = engine.submit({ task: 'c @echo {"delayMs":250}', cwd: "/tmp/same" });
    const d = engine.submit({ task: 'd @echo {"delayMs":250}', cwd: "/tmp/same" });
    await engine.idle();
    expect(Date.now() - t1).toBeGreaterThanOrEqual(480);
    expect(waits(events, d.id)).toEqual(["cwd"]);
    expect(store.getTask(c.id)!.threadId).not.toBe(store.getTask(d.id)!.threadId);
  });

  it("harness max_concurrent gates dispatch: claude-code (1) serialises, opencode (2) runs two at once", async () => {
    const claude = build(() => to("claude-code", "claude-sonnet-5"));
    const t0 = Date.now();
    const a = claude.engine.submit({ task: 'a @echo {"delayMs":250}', cwd: "/tmp/x1" });
    const b = claude.engine.submit({ task: 'b @echo {"delayMs":250}', cwd: "/tmp/x2" });
    await claude.engine.idle();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(480);
    expect(waits(claude.events, b.id)).toEqual(["harness:claude-code"]);
    expect(waits(claude.events, a.id)).toEqual([]);
    const oc = build(() => to("opencode", "deepseek/deepseek-flash"));
    const t1 = Date.now();
    oc.engine.submit({ task: 'a @echo {"delayMs":250}', cwd: "/tmp/y1" });
    oc.engine.submit({ task: 'b @echo {"delayMs":250}', cwd: "/tmp/y2" });
    const third = oc.engine.submit({ task: 'c @echo {"delayMs":250}', cwd: "/tmp/y3" });
    await oc.engine.idle();
    const ms = Date.now() - t1;
    expect(ms).toBeGreaterThanOrEqual(480);
    expect(ms).toBeLessThan(720);
    expect(waits(oc.events, third.id)).toEqual(["harness:opencode"]);
  });

  it("global cap queues FIFO; a follow-up waits for its parent; cancelling a waiting task works", async () => {
    const { engine, store, events } = build(() => to("opencode", "deepseek/deepseek-flash"), 1);
    const a = engine.submit({ task: 'a @echo {"delayMs":200}', cwd: "/tmp/g1" });
    const b = engine.submit({ task: 'b @echo {"delayMs":10}', cwd: "/tmp/g2" });
    const c = engine.submit({ task: "c", cwd: "/tmp/g3" });
    await new Promise((r) => setTimeout(r, 30));
    expect(store.getTask(b.id)!.status).toBe("queued");
    expect(engine.cancel(c.id)!.status).toBe("cancelled");
    await engine.idle();
    expect(store.getTask(a.id)!.updatedAt).toBeLessThanOrEqual(store.getTask(b.id)!.updatedAt);
    expect(waits(events, b.id)).toEqual(["global"]);
    expect(store.getTask(c.id)!.status).toBe("cancelled");
    expect(store.getTask(c.id)!.harness).toBeNull();
    const big = build(() => to("opencode", "deepseek/deepseek-flash"));
    const p = big.engine.submit({ task: 'p @echo {"delayMs":200}', cwd: "/tmp/p" });
    const q = big.engine.submit({ task: "q", cwd: "/tmp/p", parentId: p.id });
    await big.engine.idle();
    expect(waits(big.events, q.id)).toEqual(["parent"]);
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
