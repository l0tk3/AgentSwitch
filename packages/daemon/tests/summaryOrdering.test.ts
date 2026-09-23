import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { engineContext } from "../src/engine/context.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import { echoExecutor } from "../src/executors/echo.js";
import { echoRouter } from "../src/router/routers/echo.js";
import type { Summarizer, SummaryInput } from "../src/threads/summary.js";
import { realTargets } from "./helpers.js";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function summary(title: string): Awaited<ReturnType<Summarizer>> {
  return { summary: { title, goal: "fixture", progress: title, files: [], unresolved: [], decisions: [], facts: [], spoken: title }, error: null, ms: 1 };
}
function fixture(summarizer: Summarizer, timeout = 1000) {
  const cwd = mkdtempSync(join(tmpdir(), "agentswitch-summary-order-"));
  clean.push(() => rmSync(cwd, { recursive: true, force: true }));
  const store = new Store({ dbPath: ":memory:", threadsDir: join(cwd, "threads") }); clean.push(() => store.close());
  const bus = new Bus(), executor = echoExecutor("codex"), thread = store.createThread(cwd);
  const engine = new Engine({ store, bus, targets: realTargets(), executors: [executor], router: echoRouter([]), quota: () => ({}), summarizer, summaryTimeoutMs: timeout });
  const submit = (text: string) => engine.submit({ task: text, cwd, threadId: thread.id, pin: { harness: "codex", model: "gpt-5.5" } });
  return { cwd, store, bus, executor, engine, thread, submit };
}

describe("summary ordering and terminal persistence", () => {
  it("holds the preceding summary through terminal status and exposes it to the next same-thread execution", async () => {
    const first = deferred<Awaited<ReturnType<Summarizer>>>(), calls: SummaryInput[] = [];
    const f = fixture(async (input) => { calls.push(input); return calls.length === 1 ? first.promise : summary("second summary"); });
    const a = f.submit("first operation");
    await vi.waitUntil(() => calls.length === 1);
    expect(f.store.getTask(a.id)?.status).toBe("done");
    const b = f.submit("second operation");
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.executor.runs).toHaveLength(1);
    expect(f.store.getTask(b.id)?.status).toBe("queued");
    first.resolve(summary("first summary"));
    await f.engine.idle();
    expect(calls[1]?.previous?.title).toBe("first summary");
    expect(f.engine.threadState(f.thread.id).summary?.title).toBe("second summary");
    expect(f.executor.runs).toHaveLength(2);
  });

  it("releases locks after a non-cooperative summarizer times out and rejects its late commit", async () => {
    const first = deferred<Awaited<ReturnType<Summarizer>>>(); let calls = 0;
    const f = fixture(async () => ++calls === 1 ? first.promise : summary("fresh summary"), 30);
    const a = f.submit("first operation");
    await vi.waitUntil(() => calls === 1, { interval: 1 });
    const b = f.submit("second operation");
    await f.engine.idle();
    expect(f.store.getTask(b.id)?.status).toBe("done");
    expect(f.store.eventsSince(a.id).some((e) => e.type === "summary" && e.payload.ok === false)).toBe(true);
    first.resolve(summary("obsolete late summary"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.engine.threadState(f.thread.id).summary?.title).toBe("fresh summary");
    expect(f.store.getTask(a.id)?.spoken).not.toBe("obsolete late summary");
  });

  it("does not overwrite cancellation or partial completion through late writes or events", () => {
    const f = fixture(async () => summary("unused"));
    const ctx = engineContext(f.store, f.bus);
    for (const status of ["cancelled", "partial", "blocked"] as const) {
      const task = f.store.createTask({ task: "fixture", cwd: f.cwd });
      f.store.updateTask(task.id, { status, result: "preserved", error: "preserved reason" });
      ctx.emit(task.id, status, {});
      f.store.updateTask(task.id, { status: "done", result: "late success", error: null });
      expect(ctx.emit(task.id, "done", { result: "late success" })).toBeUndefined();
      expect(ctx.emit(task.id, "dispatched", {})).toBeUndefined();
      expect(f.store.getTask(task.id)).toMatchObject({ status, result: "preserved", error: "preserved reason" });
      f.store.updateTask(task.id, { rating: -1 });
      expect(f.store.getTask(task.id)?.rating).toBe(-1);
    }
  });
});
