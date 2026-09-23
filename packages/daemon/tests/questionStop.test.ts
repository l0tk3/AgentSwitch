/** Router questions are a blocking boundary; a denial or expiry is never permission to keep dispatching. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { echoExecutor } from "../src/executors/echo.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, realTargets } from "./helpers.js";

type Mode = "initial" | "router" | "planner";
const modes: Mode[] = ["initial", "router", "planner"];
const question = "允许将这条记录提交到已指定的平台吗？";
const decision = (extra: Record<string, unknown> = {}) => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, ...extra });
const ask = JSON.stringify({ action: "ask_user", question });
const finish = JSON.stringify({ action: "finish", result: "已完成", reason: "完成", completion: "complete", remaining: [] });
const fixtures: { engine: Engine; store: Store; dir: string }[] = [];

afterEach(async () => {
  for (const { engine, store, dir } of fixtures.splice(0)) {
    for (const task of store.listTasks()) engine.cancel(task.id);
    await engine.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function build(mode: Mode, timeoutMs = 1000) {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-question-stop-"));
  const store = new Store({ dbPath: ":memory:", threadsDir: join(dir, "threads") });
  const bus = new Bus();
  const events: TaskEvent[] = [];
  let resolveQuestion!: (id: string) => void;
  const pendingQuestion = new Promise<string>((resolve) => { resolveQuestion = resolve; });
  bus.subscribe("*", (event) => {
    events.push(event);
    if (event.type === "approval_request") resolveQuestion(String(event.payload.approvalId));
  });
  const router = echoRouter(mode === "initial"
    ? [decision({ action: "clarify", question }), decision()]
    : mode === "router" ? [decision({ purpose: "research" }), ask, decision(), finish]
    : [decision({ plan: "multi" })]);
  const planner = mode === "planner" ? echoRouter([ask, decision(), finish]) : null;
  const executor = echoExecutor("codex");
  const engine = new Engine({
    store, bus, router, executors: [executor], targets: realTargets(), quota: () => ({}), approvalTimeoutMs: timeoutMs,
    supervisor: {
      config: { approvals: false, watchdog_ms: 0, acceptance: false, max_continues: 0 },
      approve: async () => ({ decision: "ask_user", reason: "", ms: 0, source: "router" }),
      checkIn: async () => ({ action: "continue", note: "", ms: 0, source: "router" }),
      accept: async () => ({ accepted: true, missing: [], note: "verified", ms: 0, source: "router" }),
    },
    ...(planner ? { planner: () => ({ router: planner, target: { harness: "codex", model: "gpt-5.5" } }) } : {}),
  });
  fixtures.push({ engine, store, dir });
  const task = engine.submit({ task: "处理一条测试记录", cwd: dir });
  return { store, engine, task, router, planner, executor, events, pendingQuestion };
}

function expectStopped(f: ReturnType<typeof build>, mode: Mode) {
  expect(f.store.getTask(f.task.id)).toMatchObject({ status: "blocked", error: `waiting for your answer: ${question}` });
  expect(f.executor.runs).toHaveLength(mode === "router" ? 1 : 0);
  expect(f.router.calls).toHaveLength(mode === "router" ? 2 : 1);
  if (f.planner) expect(f.planner.calls).toHaveLength(1);
  expect(f.events.some((event) => event.type === "done")).toBe(false);
  expect(f.store.pendingApprovals(f.task.id)).toEqual([]);
}

describe("unanswered router questions stop execution", () => {
  it.each(modes)("%s: explicit denial stops without asking a model again or dispatching", async (mode) => {
    const f = build(mode);
    const id = await f.pendingQuestion;
    expect(f.engine.resolveApproval(id, "deny")).toBe(true);
    await f.engine.idle();
    expectStopped(f, mode);
    expect(f.store.getApproval(id)?.status).toBe("denied");
  });

  it.each(modes)("%s: expiry stops instead of treating a missing answer as a skippable step", async (mode) => {
    const f = build(mode, 25);
    const id = await f.pendingQuestion;
    await f.engine.idle();
    expectStopped(f, mode);
    expect(f.store.getApproval(id)?.status).toBe("expired");
  });

  it.each(modes)("%s: cancellation preserves cancelled status and performs no later dispatch", async (mode) => {
    const f = build(mode);
    await f.pendingQuestion;
    f.engine.cancel(f.task.id);
    await f.engine.idle();
    expect(f.store.getTask(f.task.id)?.status).toBe("cancelled");
    expect(f.executor.runs).toHaveLength(mode === "router" ? 1 : 0);
    expect(f.events.some((event) => event.type === "failed" || event.type === "done")).toBe(false);
    if (f.planner) expect(f.planner.calls).toHaveLength(1);
  });

  it.each(modes)("%s: an actual answer still reaches the next model call and permits progress", async (mode) => {
    const f = build(mode);
    const id = await f.pendingQuestion;
    expect(f.engine.answer(id, { text: "允许提交这条测试记录" })).toEqual({ ok: true });
    await f.engine.idle();
    expect(f.store.getTask(f.task.id)?.status).toBe("done");
    expect(f.executor.runs).toHaveLength(mode === "router" ? 2 : 1);
    const next = f.planner?.calls[1] ?? f.router.calls[mode === "router" ? 2 : 1];
    expect(next?.task).toContain("允许提交这条测试记录");
  });

  it("a generic allow button without an answer cannot satisfy a planner question", async () => {
    const f = build("planner");
    const id = await f.pendingQuestion;
    expect(f.engine.resolveApproval(id, "allow")).toBe(true);
    await f.engine.idle();
    expectStopped(f, "planner");
  });
});
