/** Planner diagnostics use fake routers only, never live tasks or model processes. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { nextAction } from "../src/router/loop.js";
import type { Router, RouterInput } from "../src/router/routers/types.js";
import type { Supervisor } from "../src/router/supervisor.js";
import { decisionJson, realTargets } from "./helpers.js";

const decision = (over: Record<string, unknown> = {}) => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, ...over });
const finish = JSON.stringify({ action: "finish", completion: "complete", remaining: [], result: "已验证原目标完成" });
const noEffects = { filesChanged: 0, commandsRun: 0, approvalsGranted: 0 };
const sentinel = "PRIVATE_REPLY_OR_PROVIDER_EXCEPTION";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fake(script: (call: number, input: RouterInput, signal: AbortSignal) => Promise<string> | string, name = "fake:planner") {
  const calls: RouterInput[] = [];
  const router: Router = { name, async route(input, signal) {
    const n = calls.push(input) - 1;
    return { text: await script(n, input, signal), elapsedMs: 999_999 };
  } };
  return { ...router, calls };
}
function direct(router: Router, timeoutMs = 200, signal?: AbortSignal) {
  return nextAction(router, { router, targets: realTargets(), running: {}, quota: {} }, {
    req: { task: "核对配置", cwd: "/tmp" }, steps: [], used: 0, budget: 5, exclude: [], timeoutMs,
  }, signal);
}
const fixtures: { engine: Engine; store: Store; dir: string }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const task of f.store.listTasks()) f.engine.cancel(task.id);
    await f.engine.idle();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
function build(planner: Router | null, options: { router?: Router; routerMs?: number; plannerMs?: number; failExecutor?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-planner-diagnostics-"));
  const store = new Store({ dbPath: ":memory:", threadsDir: join(dir, "threads") });
  const bus = new Bus(), events: TaskEvent[] = [];
  bus.subscribe("*", (event) => events.push(event));
  const targets = realTargets();
  targets.router.timeout_ms = options.routerMs ?? 100;
  targets.router.planner_timeout_ms = options.plannerMs ?? 200;
  const router = options.router ?? fake(() => decision({ plan: "multi" }), "fake:dispatcher");
  let runs = 0;
  const supervisor: Supervisor = {
    config: { approvals: false, acceptance: false, watchdog_ms: 0, max_continues: 0 },
    approve: async () => ({ decision: "ask_user", reason: "", ms: 0, source: "router" }),
    checkIn: async () => ({ action: "continue", note: "", ms: 0, source: "router" }),
    accept: async () => ({ accepted: true, missing: [], note: "original task verified", ms: 0, source: "router" }),
  };
  const engine = new Engine({ store, bus, targets, router, quota: () => ({}), supervisor,
    planner: () => planner ? { router: planner, target: { harness: "codex", model: "gpt-5.5" } } : null,
    executors: [{ harness: "codex", async run() {
      runs++;
      return options.failExecutor
        ? { ok: false, exitCode: 1, stderr: "fixture task failed", sideEffects: noEffects }
        : { ok: true, lastText: "已保存步骤进展", sideEffects: noEffects };
    } }],
  });
  fixtures.push({ engine, store, dir });
  return { engine, store, events, get runs() { return runs; }, submit: () => engine.submit({ task: "核对配置后保存结果", cwd: dir }) };
}
const failures = (events: TaskEvent[]) => events.filter((e) => e.type === "step" && e.payload.action === "plan" && e.payload.source === "error");

describe("safe loop failure diagnostics", () => {
  it.each(["invalid_response", "service_error"] as const)("classifies %s with actual attempts and wall time, without persisting raw model/provider text", async (kind) => {
    const router = fake(async () => {
      await delay(10);
      if (kind === "service_error") throw new Error(sentinel);
      return sentinel;
    });
    const result = await direct(router);
    expect(result).toMatchObject({ action: null, failure: { kind, tries: 2, timeoutMs: 200 } });
    expect(result.routerMs).toBeGreaterThanOrEqual(15);
    expect(result.routerMs).toBeLessThan(1000);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(router.calls).toHaveLength(2);
  });

  it("a deadline is total across JSON correction and blocks a late action from a router ignoring abort", async () => {
    let resolveLate!: (text: string) => void;
    const router = fake(async (n) => n === 0 ? sentinel : new Promise((resolve) => { resolveLate = resolve; }));
    const result = await direct(router, 30);
    expect(result).toMatchObject({ action: null, failure: { kind: "timeout", tries: 2, timeoutMs: 30 } });
    expect(result.routerMs).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    resolveLate(finish);
    await delay(0);
    expect(router.calls).toHaveLength(2);
    expect(result.action).toBeNull();
  });

  it("counts no model attempts when already cancelled and classifies an in-flight cancellation independently", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const neverCalled = fake(() => finish);
    expect(await direct(neverCalled, 200, ctl.signal)).toMatchObject({ failure: { kind: "cancelled", tries: 0 } });
    expect(neverCalled.calls).toHaveLength(0);
    const active = new AbortController();
    const hung = fake(() => new Promise<string>(() => {}));
    const result = direct(hung, 200, active.signal);
    active.abort();
    expect(await result).toMatchObject({ action: null, failure: { kind: "cancelled", tries: 1 } });
  });
});

describe("planner failure events and independent deadlines", () => {
  it("uses the selected planner deadline for its first and later calls instead of the shorter routing deadline", async () => {
    const planner = fake(async (n) => { await delay(40); return n === 0 ? decision() : finish; });
    const f = build(planner, { routerMs: 10, plannerMs: 200 });
    const task = f.submit();
    await f.engine.idle();
    expect(f.store.getTask(task.id)?.status).toBe("done");
    expect(planner.calls).toHaveLength(2);
    expect(f.runs).toBe(1);
    expect(failures(f.events)).toHaveLength(0);
  });

  it.each(["invalid_response", "service_error", "timeout"] as const)("first planner %s records the cause and explicitly states that no business dispatch ran", async (kind) => {
    const planner = fake(() => {
      if (kind === "service_error") throw new Error(sentinel);
      return kind === "timeout" ? new Promise<string>(() => {}) : sentinel;
    });
    const f = build(planner, { plannerMs: 30 });
    const task = f.submit();
    await f.engine.idle();
    expect(f.store.getTask(task.id)).toMatchObject({ status: "blocked", error: expect.stringContaining("未执行新的业务操作") });
    expect(f.runs).toBe(0);
    expect(failures(f.events)).toHaveLength(1);
    expect(failures(f.events)[0]!.payload).toMatchObject({ stage: "initial_plan", model: "codex/gpt-5.5", failureKind: kind, tries: kind === "timeout" ? 1 : 2, timeoutMs: 30, dispatches: 0 });
    expect(JSON.stringify({ events: f.events, task: f.store.getTask(task.id) })).not.toContain(sentinel);
  });

  it.each([false, true])("later planner failure preserves existing checkpoints and never replays operations (executor failed: %s)", async (failExecutor) => {
    const planner = fake((n) => n === 0 ? decision() : sentinel);
    const f = build(planner, { failExecutor });
    const task = f.submit();
    await f.engine.idle();
    expect(f.store.getTask(task.id)).toMatchObject({ status: failExecutor ? "blocked" : "partial", error: expect.stringContaining("已保存此前 1 次派发的进展") });
    if (!failExecutor) expect(f.store.getTask(task.id)?.result).toBe("已保存步骤进展");
    expect(f.runs).toBe(1);
    expect(f.events.filter((e) => e.type === "checkpoint")).toHaveLength(1);
    expect(f.events.some((e) => e.type === "redispatch")).toBe(false);
    expect(failures(f.events)[0]!.payload).toMatchObject({ stage: "next_action", model: planner.name, failureKind: "invalid_response", tries: 2, dispatches: 1, timeoutMs: 200 });
    expect(JSON.stringify({ events: f.events, task: f.store.getTask(task.id) })).not.toContain(sentinel);
  });

  it("a loop run by the dispatcher still uses router.timeout_ms and retains successful research", async () => {
    const router = fake((n) => n === 0 ? decision({ purpose: "research" }) : new Promise<string>(() => {}), "fake:dispatcher");
    const f = build(null, { router, routerMs: 25, plannerMs: 200 });
    const task = f.submit();
    await f.engine.idle();
    expect(f.store.getTask(task.id)).toMatchObject({ status: "partial", result: "已保存步骤进展", error: expect.stringContaining("超时") });
    expect(f.runs).toBe(1);
    expect(failures(f.events)[0]!.payload).toMatchObject({ stage: "next_action", failureKind: "timeout", tries: 1, timeoutMs: 25, dispatches: 1 });
  });

  it("cancelling the planner discards late success without replacing cancelled with an error terminal", async () => {
    let entered!: () => void, resolveLate!: (text: string) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const planner = fake(() => { entered(); return new Promise((resolve) => { resolveLate = resolve; }); });
    const f = build(planner);
    const task = f.submit();
    await started;
    f.engine.cancel(task.id);
    await f.engine.idle();
    resolveLate(decision());
    await delay(0);
    expect(f.store.getTask(task.id)?.status).toBe("cancelled");
    expect(f.runs).toBe(0);
    expect(failures(f.events)).toHaveLength(0);
    expect(f.events.some((e) => ["blocked", "partial", "done"].includes(e.type))).toBe(false);
  });
});
