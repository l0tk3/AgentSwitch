import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepThreads } from "../src/daemon.js";
import { ApprovalDesk } from "../src/engine/approvals.js";
import { Bus } from "../src/engine/bus.js";
import { engineContext } from "../src/engine/context.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import { watchdog } from "../src/engine/supervise.js";
import { echoExecutor } from "../src/executors/echo.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { SupervisorConfig, type Supervisor } from "../src/router/supervisor.js";
import { decisionJson, realTargets } from "./helpers.js";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((f) => f()));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function build(overrides: Partial<Supervisor>) {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-late-delete-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store({ dbPath: ":memory:", tasksDir: join(home, "tasks"), threadsDir: join(home, "threads") });
  cleanup.push(() => store.close());
  const bus = new Bus();
  const events: string[] = [];
  bus.subscribe("*", (event) => events.push(event.type));
  const supervisor: Supervisor = {
    config: SupervisorConfig.parse({ watchdog_ms: 0, acceptance: false }),
    approve: async () => ({ decision: "allow", reason: "", source: "router", ms: 0 }),
    accept: async () => ({ accepted: true, missing: [], note: "", source: "router", ms: 0 }),
    checkIn: async () => ({ action: "continue", note: "", source: "router", ms: 0 }),
    ...overrides,
  };
  const engine = new Engine({ store, bus, supervisor, targets: realTargets(), router: echoRouter([decisionJson({ harness: "codex", model: "gpt-6-astra", effort: null })]), executors: [echoExecutor("codex")], quota: () => ({}), approvalTimeoutMs: 5000 });
  return { home, store, bus, events, supervisor, engine };
}

describe("deleted tasks ignore detached callbacks", () => {
  it("a failed archive deletion does not stop cleanup of the remaining expired threads", () => {
    const f = build({});
    const first = f.store.createThread(f.home);
    const second = f.store.createThread(f.home);
    for (const id of [first.id, second.id]) f.store.archiveThread(id, -1);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const gone = sweepThreads(f.store, Date.now(), { deleteThread: (id) => {
        if (id === first.id) throw new Error("filesystem cleanup unavailable");
        return f.engine.deleteThread(id);
      } });
      expect(gone).toEqual([second.id]);
      expect(f.store.getThread(first.id)).toBeDefined();
      expect(f.store.getThread(second.id)).toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("could not be deleted"));
    } finally { log.mockRestore(); }
  });

  it("a supervisor rejection after the user answered and deleted the finished task cannot recreate its log", async () => {
    const late = deferred<Awaited<ReturnType<Supervisor["approve"]>>>();
    const started = deferred<void>();
    const f = build({ approve: () => { started.resolve(); return late.promise; } });
    const task = f.engine.submit({ task: 'check @echo {"approval":"npm test"}', cwd: f.home });
    await started.promise;
    const approval = f.store.pendingApprovals(task.id)[0]!;
    expect(f.engine.resolveApproval(approval.id, "allow")).toBe(true);
    await f.engine.idle();
    expect(f.engine.deleteTask(task.id)).toEqual({ ok: true });
    const before = f.events.length;
    late.reject(new Error("late supervisor response"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.store.eventsSince(task.id)).toEqual([]);
    expect(existsSync(join(f.home, "tasks", `${task.id}.jsonl`))).toBe(false);
    expect(f.events).toHaveLength(before);
  });

  it("a watchdog rejection after stopping and deleting its task leaves no events or JSONL", async () => {
    const late = deferred<Awaited<ReturnType<Supervisor["checkIn"]>>>();
    const started = deferred<void>();
    const f = build({ config: SupervisorConfig.parse({ watchdog_ms: 1 }), checkIn: () => { started.resolve(); return late.promise; } });
    const task = f.store.createTask({ task: "watchdog fixture", cwd: f.home });
    const ctx = engineContext(f.store, f.bus);
    const dog = watchdog(ctx, f.supervisor, new ApprovalDesk(ctx, 1000), task, new AbortController());
    await started.promise;
    dog.stop();
    f.store.updateTask(task.id, { status: "done" });
    expect(f.engine.deleteTask(task.id)).toEqual({ ok: true });
    const before = f.events.length;
    late.reject(new Error("late watchdog response"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.store.eventsSince(task.id)).toEqual([]);
    expect(existsSync(join(f.home, "tasks", `${task.id}.jsonl`))).toBe(false);
    expect(f.events).toHaveLength(before);
  });
});
