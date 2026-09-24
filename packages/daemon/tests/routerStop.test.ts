import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { parseEvidence } from "../src/core/questions.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import type { Executor } from "../src/executors/types.js";
import { echoRouter, type EchoScript } from "../src/router/routers/echo.js";
import { decisionJson, realTargets } from "./helpers.js";

const homes: string[] = [];
const stores: Store[] = [];
const targets = realTargets();
const reason = "The operation cannot proceed with the current context.";

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function build(replies: EchoScript) {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-router-stop-"));
  homes.push(home);
  const store = new Store({ dbPath: ":memory:", threadsDir: join(home, "threads") });
  stores.push(store);
  const bus = new Bus();
  const events: TaskEvent[] = [];
  const runs: string[] = [];
  bus.subscribe("*", (event) => events.push(event));
  const executors: Executor[] = Object.keys(targets.harnesses).map((harness) => ({
    harness, run: async () => { runs.push(harness); return { ok: true, lastText: "Unexpected execution." }; },
  }));
  const router = echoRouter(replies);
  const engine = new Engine({ store, bus, executors, targets, router, quota: () => ({}), contextPath: join(home, "CONTEXT.md"), approvalTimeoutMs: 5_000 });
  const firstQuestion = () => new Promise<string>((resolve) => {
    const unsubscribe = bus.subscribe("*", (event) => {
      if (event.type === "approval_request") { unsubscribe(); resolve(String(event.payload.approvalId)); }
    });
  });
  return { home, store, engine, events, runs, router, firstQuestion };
}

describe("Engine: router stops never dispatch", () => {
  it("keeps a first-route No dispatch decision away from every executor", async () => {
    const f = build([decisionJson({ action: "give_up", brief: `No dispatch. ${reason}`, reason })]);
    const task = f.engine.submit({ task: "Inspect the internal management page.", cwd: f.home });
    await f.engine.idle();

    expect(f.store.getTask(task.id)).toMatchObject({ status: "failed", error: expect.stringContaining(reason) });
    expect(f.runs).toEqual([]);
    expect(f.router.calls).toHaveLength(1);
    expect(f.events.filter((event) => event.type === "done")).toEqual([]);
  });

  it.each([
    decisionJson({ action: "give_up", brief: `No dispatch. ${reason}`, reason }),
    JSON.stringify({ action: "give_up", reason }),
    JSON.stringify({ action: "give_up", reason, harness: false, brief: null, confidence: 2 }),
  ])("after a user clarification, surfaces the router stop without invoking an executor: %s", async (stop) => {
    const questionText = "要检查哪个管理页面？";
    const f = build([decisionJson({ action: "clarify", question: questionText }), stop]);
    const question = f.firstQuestion();
    const task = f.engine.submit({ task: "Inspect the internal management page.", cwd: f.home });
    const approvalId = await question;
    expect(f.store.getTask(task.id)?.status).toBe("waiting_approval");
    expect(f.engine.answer(approvalId, { text: "The local test page." })).toEqual({ ok: true });
    await f.engine.idle();

    expect(f.store.getTask(task.id)).toMatchObject({ status: "failed", error: expect.stringContaining(reason) });
    expect(f.runs).toEqual([]);
    expect(f.router.calls).toHaveLength(2);
    expect(f.router.calls[1]!.task).toContain("The local test page.");
    expect(f.events.filter((event) => event.type === "approval_request")).toHaveLength(1);
    expect(f.events.filter((event) => event.type === "done")).toEqual([]);
    expect(f.store.pendingApprovals(task.id)).toEqual([]);
  });

  it("shows a Chinese router question while preserving the original question with the user's answer", async () => {
    const original = "Which management page should be inspected?";
    const translated = "要检查哪个管理页面？";
    const answer = "本地测试页面。";
    const f = build([
      decisionJson({ action: "clarify", question: original }),
      JSON.stringify({ question: translated }),
      JSON.stringify({ action: "give_up", reason }),
    ]);
    const question = f.firstQuestion();
    const task = f.engine.submit({ task: "检查内部管理页面。", cwd: f.home });
    const approvalId = await question;
    const approval = f.store.getApproval(approvalId)!;
    expect(approval.action).toBe(translated);
    expect(parseEvidence(approval.evidence)).toMatchObject({ source: "router", questions: [{ text: translated, originalText: original }] });
    expect(f.engine.answer(approvalId, { text: answer })).toEqual({ ok: true });
    await f.engine.idle();

    expect(f.store.getTask(task.id)).toMatchObject({ status: "failed", error: expect.stringContaining(reason) });
    expect(f.runs).toEqual([]);
    expect(f.router.calls).toHaveLength(3);
    expect(f.router.calls[2]!.task).toContain(original);
    expect(f.router.calls[2]!.task).toContain(answer);
    expect(f.events.filter((event) => event.type === "approval_request")).toHaveLength(1);
    expect(f.store.pendingApprovals(task.id)).toEqual([]);
  });

  it("cancellation during translation creates no approval card and dispatches nothing", async () => {
    let taskId = "";
    const f = build((_input, call) => {
      if (call === 0) return decisionJson({ action: "clarify", question: "Which management page should be inspected?" });
      f.engine.cancel(taskId);
      return JSON.stringify({ question: "要检查哪个管理页面？" });
    });
    const task = f.engine.submit({ task: "检查内部管理页面。", cwd: f.home });
    taskId = task.id;
    await f.engine.idle();

    expect(f.store.getTask(task.id)?.status).toBe("cancelled");
    expect(f.runs).toEqual([]);
    expect(f.router.calls).toHaveLength(2);
    expect(f.events.filter((event) => event.type === "approval_request" || event.type === "done" || event.type === "failed")).toEqual([]);
    expect(f.store.pendingApprovals(task.id)).toEqual([]);
  });
});
