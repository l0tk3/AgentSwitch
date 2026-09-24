import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import { echoExecutor } from "../src/executors/echo.js";
import { echoRouter } from "../src/router/routers/echo.js";
import type { Router } from "../src/core/modelCall.js";
import type { Summarizer, SummaryInput } from "../src/threads/summary.js";
import { decisionJson, realTargets } from "./helpers.js";

const clean: { dir: string; store: Store; engine: Engine }[] = [];
afterEach(async () => {
  for (const { dir, store, engine } of clean.splice(0)) {
    for (const task of store.listTasks()) engine.cancel(task.id);
    await engine.idle(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
const result = (title: string): Awaited<ReturnType<Summarizer>> => ({ summary: { title, goal: "fixture", progress: title, files: [], unresolved: [], decisions: [], facts: [], spoken: title }, error: null, ms: 1 });
function fixture(summarizer: Summarizer, options: { router?: Router; planner?: Router } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-queued-summary-"));
  const store = new Store({ dbPath: ":memory:", threadsDir: join(dir, "threads") });
  const executor = echoExecutor("codex"), thread = store.createThread(dir);
  const engine = new Engine({ store, bus: new Bus(), targets: realTargets(), executors: [executor], router: options.router ?? echoRouter([]), quota: () => ({}), summarizer, summaryTimeoutMs: 2000, approvalTimeoutMs: 1000,
    ...(options.planner ? { planner: () => ({ router: options.planner!, target: { harness: "codex", model: "gpt-5.5" } }) } : {}),
  });
  clean.push({ dir, store, engine });
  return { dir, store, engine, executor, thread };
}

describe("queued cancellation and thread summaries", () => {
  it("records a cancelled waiter without generating a competing summary while its predecessor is still finishing", async () => {
    const calls: SummaryInput[] = [];
    let completeFirst!: (value: Awaited<ReturnType<Summarizer>>) => void;
    const pendingFirst = new Promise<Awaited<ReturnType<Summarizer>>>((resolve) => { completeFirst = resolve; });
    const f = fixture(async (input) => { calls.push(input); return calls.length === 1 ? pendingFirst : result("cancelled waiter summary"); });
    const submit = (task: string) => f.engine.submit({ task, cwd: f.dir, threadId: f.thread.id, pin: { harness: "codex", model: "gpt-5.5" } });
    const first = submit("finish the earlier operation");
    await vi.waitUntil(() => calls.length === 1, { interval: 1 });
    const queued = submit("later operation that the user cancels");
    try {
      expect(f.store.getTask(first.id)?.status).toBe("done");
      expect(f.store.getTask(queued.id)?.status).toBe("queued");
      f.engine.cancel(queued.id);
      await vi.waitUntil(() => f.engine.threadState(f.thread.id).tasks.some((task) => task.taskId === queued.id), { interval: 1 });
      expect(calls).toHaveLength(1);
      expect(f.executor.runs).toHaveLength(1);
      expect(f.engine.threadState(f.thread.id).tasks.find((task) => task.taskId === queued.id)?.status).toBe("cancelled");
      expect(f.store.eventsSince(queued.id).some((event) => event.type === "summary" || event.type === "dispatched")).toBe(false);
    } finally {
      completeFirst(result("the preceding operation summary"));
      await f.engine.idle();
    }
    expect(f.engine.threadState(f.thread.id).summary?.title).toBe("the preceding operation summary");
    expect(f.store.getTask(queued.id)?.spoken).toBeNull();
  });

  it("preserves a planner blocker and task history even when no executor ever ran", async () => {
    const calls: SummaryInput[] = [];
    const question = "缺少必填字段，请补充后继续";
    const planner = echoRouter([JSON.stringify({ action: "ask_user", question })]);
    const router = echoRouter([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, plan: "multi" })]);
    const f = fixture(async (input) => { calls.push(input); return result("should not replace earlier work"); }, { router, planner });
    f.store.appendThreadEvent(f.thread.id, "summary", { ...result("earlier executed work").summary! });
    const task = f.engine.submit({ task: "Process a test record", cwd: f.dir, threadId: f.thread.id });
    await vi.waitUntil(() => f.store.pendingApprovals(task.id).length === 1, { interval: 1 });
    f.engine.resolveApproval(f.store.pendingApprovals(task.id)[0]!.id, "deny");
    await f.engine.idle();
    expect(f.executor.runs).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(f.store.getTask(task.id)).toMatchObject({ status: "blocked", error: `waiting for your answer: ${question}` });
    expect(f.engine.threadState(f.thread.id).tasks).toMatchObject([{ taskId: task.id, status: "blocked" }]);
    expect(f.store.eventsSince(task.id).some((event) => event.type === "blocked")).toBe(true);
    expect(f.engine.threadState(f.thread.id).summary?.title).toBe("earlier executed work");
  });
});
