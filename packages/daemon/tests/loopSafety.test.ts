/** Execution boundaries with fake models only: completion evidence, cancellation, budgets and durable checkpoints. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import type { ExecutionInput } from "../src/executors/types.js";
import type { ExecutionOutcome } from "../src/router/failure.js";
import { MAX_LOOP_STEPS, nextAction, parseLoopReply } from "../src/router/loop.js";
import { evidenceExcerpt } from "../src/router/prompt.js";
import { echoRouter, type EchoScript } from "../src/router/routers/echo.js";
import type { AcceptInput, Supervisor } from "../src/router/supervisor.js";
import { decisionJson, realTargets } from "./helpers.js";

const decision = (extra: Record<string, unknown> = {}) => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, ...extra });
const finish = (completion = "complete", remaining: string[] = [], result = "已核对全部目标") => JSON.stringify({ action: "finish", completion, remaining, result });
const ask = JSON.stringify({ action: "ask_user", question: "请确认已完成步骤的记录。" });
const goal = "先查看字段，再录入一条记录，并确认该账号能够登录。";
const noEffects = { filesChanged: 0, commandsRun: 0, approvalsGranted: 0 };
const accepted = { accepted: true, missing: [], note: "verified original goal", source: "router" as const, ms: 0 };
const fixtures: { engine: Engine; store: Store; dir: string }[] = [];

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const task of f.store.listTasks()) f.engine.cancel(task.id);
    await f.engine.idle();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

function build(opts: { router?: EchoScript; planner?: EchoScript; accept?: Supervisor["accept"]; noSupervisor?: boolean; singleAcceptance?: boolean; run?: (input: ExecutionInput) => Promise<ExecutionOutcome>; timeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-loop-safety-"));
  const store = new Store({ dbPath: ":memory:", threadsDir: join(dir, "threads") });
  const bus = new Bus();
  const events: TaskEvent[] = [];
  const runs: ExecutionInput[] = [];
  const targets = realTargets();
  targets.router.timeout_ms = opts.timeoutMs ?? 500;
  targets.router.planner_timeout_ms = opts.timeoutMs ?? 500;
  const router = echoRouter(opts.router ?? [decision({ plan: opts.planner ? "multi" : "single" })]);
  const planner = opts.planner ? echoRouter(opts.planner) : null;
  const accept = vi.fn(opts.accept ?? (async () => accepted));
  const supervisor: Supervisor = {
    config: { approvals: false, acceptance: opts.singleAcceptance ?? false, watchdog_ms: 0, max_continues: 0 },
    approve: async () => ({ decision: "ask_user", reason: "", ms: 0, source: "router" }),
    checkIn: async () => ({ action: "continue", note: "", ms: 0, source: "router" }), accept,
  };
  const engine = new Engine({ store, bus, router, targets, quota: () => ({}), retryBackoffMs: 1, approvalTimeoutMs: 1000,
    executors: [{ harness: "codex", async run(input) { runs.push(input); return opts.run ? opts.run(input) : { ok: true, lastText: "已完成当前步骤", sideEffects: noEffects }; } }],
    ...(planner ? { planner: () => ({ router: planner, target: { harness: "codex", model: "gpt-5.5" } }) } : {}),
    ...(opts.noSupervisor ? {} : { supervisor }),
  });
  bus.subscribe("*", (event) => events.push(event));
  fixtures.push({ engine, store, dir });
  const submit = () => engine.submit({ task: goal, cwd: dir });
  return { engine, store, bus, events, runs, router, planner, accept, submit, targets, dir };
}

describe("loop budgets and cancellation", () => {
  it.each(["allow", "deny", "cancel"] as const)("loop budget %s never repeats the completed dispatch or invents completion", async (choice) => {
    const f = build({ planner: (_input, n) => n === 0 ? decision({ brief: "只提交一次" }) : n < MAX_LOOP_STEPS ? ask : finish() });
    f.bus.subscribe("*", (event) => {
      if (event.type !== "approval_request") return;
      setImmediate(() => {
        const id = String(event.payload.approvalId);
        if (event.payload.kind === "question") f.engine.answer(id, { text: "记录已保存" });
        else if (choice === "cancel") f.engine.cancel(event.taskId);
        else f.engine.resolveApproval(id, choice);
      });
    });
    const task = f.submit();
    await f.engine.idle();
    expect(f.runs).toHaveLength(1);
    expect(f.store.getTask(task.id)?.status).toBe(choice === "allow" ? "done" : choice === "deny" ? "partial" : "cancelled");
    expect(f.planner!.calls).toHaveLength(choice === "allow" ? MAX_LOOP_STEPS + 1 : MAX_LOOP_STEPS);
    if (choice !== "allow") expect(f.events.some((e) => e.type === "done")).toBe(false);
  });

  it("cancelling a dispatch-budget question preserves cancellation", async () => {
    const f = build({ planner: () => decision() });
    f.bus.subscribe("*", (e) => { if (e.type === "approval_request") setImmediate(() => f.engine.cancel(e.taskId)); });
    const task = f.submit();
    await f.engine.idle();
    expect(f.runs).toHaveLength(5);
    expect(f.store.getTask(task.id)?.status).toBe("cancelled");
    expect(f.events.some((e) => e.type === "done" || e.type === "failed" || e.type === "partial")).toBe(false);
  });

  it("a verifier that ignores cancellation cannot hold execution open or overwrite cancelled", async () => {
    let entered!: () => void, resolveVerification!: (value: typeof accepted) => void;
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    const f = build({ singleAcceptance: true, accept: async () => { entered(); return new Promise((resolve) => { resolveVerification = resolve; }); } });
    const task = f.submit();
    await checking;
    f.engine.cancel(task.id);
    await f.engine.idle();
    resolveVerification(accepted);
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.store.getTask(task.id)?.status).toBe("cancelled");
    expect(f.events.some((e) => e.type === "done")).toBe(false);
  });

  it("an unanswered executor question ends even an executor that ignores abort and discards its late callbacks", async () => {
    let resolveLate!: (value: ExecutionOutcome) => void;
    let received!: ExecutionInput;
    const f = build({ run: async (input) => {
      received = input;
      await input.ask([{ id: "q", header: "确认", text: "填写哪个区域？", options: [], multi: false, secret: false }]);
      return new Promise((resolve) => { resolveLate = resolve; });
    } });
    f.bus.subscribe("*", (e) => { if (e.type === "approval_request") setImmediate(() => f.engine.resolveApproval(String(e.payload.approvalId), "deny")); });
    const task = f.submit();
    await f.engine.idle();
    expect(f.store.getTask(task.id)).toMatchObject({ status: "blocked", error: expect.stringContaining("填写哪个区域") });
    expect(received.signal.aborted).toBe(true);
    const count = f.events.length;
    expect(await received.approve("submit record", "")).toBe("deny");
    expect(await received.ask([{ id: "late", header: "", text: "迟到的问题", options: [], multi: false, secret: false }])).toBeNull();
    received.emit("tool_call", { tool: "late write" });
    resolveLate({ ok: true, lastText: "late success", sideEffects: noEffects });
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.events).toHaveLength(count);
    expect(f.runs).toHaveLength(1);
    expect(f.events.some((e) => e.type === "checkpoint" && e.payload.sideEffectsKnown === false)).toBe(true);
  });

  it("holds the execution locks while an aborted adapter is reaping its process", async () => {
    let entered!: () => void, retire!: (outcome: ExecutionOutcome) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let retired = false, calls = 0;
    const f = build({ run: async () => {
      if (calls++ === 0) { entered(); return new Promise((resolve) => { retire = (outcome) => { retired = true; resolve(outcome); }; }); }
      expect(retired).toBe(true);
      return { ok: true, lastText: "successor", sideEffects: noEffects };
    } });
    const first = f.submit();
    await started;
    f.engine.cancel(first.id);
    const second = f.submit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.runs).toHaveLength(1);
    retire({ ok: false, stderr: "cancelled", sideEffects: noEffects });
    await f.engine.idle();
    expect(f.store.getTask(first.id)?.status).toBe("cancelled");
    expect(f.store.getTask(second.id)?.status).toBe("done");
    expect(f.runs).toHaveLength(2);
  });
});

describe("completion requires evidence for the original goal", () => {
  it.each([
    { action: "finish", result: "done" },
    { action: "finish", completion: "complete", remaining: ["登录尚未确认"], result: "录入成功" },
    { action: "finish", completion: "complete", remaining: [], result: "" },
    { action: "finish", completion: "blocked", remaining: [], result: "" },
  ])("rejects an incomplete or contradictory finish protocol: %j", (reply) => {
    expect(parseLoopReply(JSON.stringify(reply)).ok).toBe(false);
  });

  it.each(["partial", "blocked"])("preserves explicit %s and its remaining work without calling acceptance", async (completion) => {
    const f = build({ planner: [decision(), finish(completion, ["账号登录尚未确认"], "已录入记录")] });
    const task = f.submit();
    await f.engine.idle();
    expect(f.store.getTask(task.id)).toMatchObject({ status: completion, result: "已录入记录", error: "账号登录尚未确认" });
    expect(f.accept).not.toHaveBeenCalled();
  });

  it("verifies the original goal instead of the last dispatch's narrow brief", async () => {
    let seen!: AcceptInput;
    const f = build({ planner: [decision({ purpose: "research", brief: "仅列出字段标签" }), finish()], accept: async (input) => {
      seen = input;
      return { ...accepted, accepted: false, missing: ["尚未录入或验证登录"] };
    } });
    const task = f.submit();
    await f.engine.idle();
    expect(seen.brief).toContain(goal);
    expect(seen.brief).not.toBe("仅列出字段标签");
    expect(seen.result).toContain("[research]");
    expect(f.store.getTask(task.id)).toMatchObject({ status: "partial", error: expect.stringContaining("尚未录入") });
    expect(f.runs).toHaveLength(1);
  });

  it("uses a bounded text verifier when no supervisor is configured", async () => {
    const f = build({ noSupervisor: true, planner: [decision(), finish(), JSON.stringify({ accepted: false, missing: ["登录未完成"], note: "need verification" })] });
    const task = f.submit();
    await f.engine.idle();
    expect(f.planner!.calls).toHaveLength(3);
    expect(f.planner!.calls[2]!.task).toContain(goal);
    expect(f.store.getTask(task.id)?.status).toBe("partial");
  });

  it("an unavailable verifier never turns its permissive fallback into success", async () => {
    const f = build({ planner: [decision(), finish()], accept: async () => ({ ...accepted, source: "error", note: "service down" }) });
    const task = f.submit();
    await f.engine.idle();
    expect(f.store.getTask(task.id)).toMatchObject({ status: "partial", error: expect.stringContaining("service down") });
  });

  it("a verifier ignoring its deadline cannot finish late", async () => {
    let resolveLate!: (value: typeof accepted) => void;
    const f = build({ timeoutMs: 30, planner: [decision(), finish()], accept: async () => new Promise((resolve) => { resolveLate = resolve; }) });
    const task = f.submit();
    await f.engine.idle();
    expect(f.store.getTask(task.id)?.status).toBe("partial");
    resolveLate(accepted);
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.events.some((e) => e.type === "done")).toBe(false);
  });
});

describe("checkpoints and bounded observations", () => {
  it("reported zero effects cannot erase an observed browser operation or permit transport replay", async () => {
    const f = build({ run: async (input) => {
      input.emit("tool_call", { tool: "browser submit", count: 2 });
      return { ok: false, stderr: "ECONNRESET", sideEffects: noEffects, sideEffectsKnown: true };
    } });
    const task = f.submit();
    await f.engine.idle();
    expect(f.store.getTask(task.id)).toMatchObject({ status: "blocked", attempts: [expect.objectContaining({ sideEffects: { ...noEffects, commandsRun: 2 }, sideEffectsKnown: false })] });
    expect(f.runs).toHaveLength(1);
    expect(f.events.find((e) => e.type === "checkpoint")?.payload).toMatchObject({ sideEffects: { commandsRun: 2 }, sideEffectsKnown: false });
    expect(f.events.some((e) => e.type === "redispatch")).toBe(false);
  });

  it("keeps reported edits without counting each observed edit a second time", async () => {
    const f = build({ run: async (input) => {
      input.emit("tool_call", { tool: "edit", count: 2 });
      return { ok: true, lastText: "updated", sideEffects: { ...noEffects, filesChanged: 2 }, sideEffectsKnown: true };
    } });
    const task = f.submit();
    await f.engine.idle();
    expect(f.store.getTask(task.id)?.status).toBe("done");
    expect(f.events.find((e) => e.type === "checkpoint")?.payload).toMatchObject({ sideEffects: { filesChanged: 2, commandsRun: 0 }, sideEffectsKnown: true });
  });

  it("records observed tools on an exception and blocks instead of retrying unknown effects", async () => {
    const f = build({ run: async (input) => {
      input.emit("tool_call", { tool: "browser submit", count: 2 });
      input.emit("text", { text: "已提交记录；尚未验证登录。" });
      throw new Error("ECONNRESET after submit");
    } });
    const task = f.submit();
    await f.engine.idle();
    expect(f.store.getTask(task.id)?.status).toBe("blocked");
    expect(f.runs).toHaveLength(1);
    const checkpoint = f.events.find((e) => e.type === "checkpoint")!.payload;
    expect(checkpoint).toMatchObject({ purpose: "do", ok: false, result: expect.stringContaining("ECONNRESET after submit"), harness: "codex", model: "gpt-5.5", sideEffects: { commandsRun: 2 }, sideEffectsKnown: false });
    expect(String(checkpoint.result)).toContain("已提交记录；尚未验证登录");
    expect(String(checkpoint.result)).toContain("unverified");
    expect(f.events.some((e) => e.type === "redispatch")).toBe(false);
  });

  it("keeps a blocking fact in the middle and the final conclusion of long evidence", async () => {
    const result = `${"a".repeat(10_000)}\n登录未完成：必须等待用户确认。\n${"b".repeat(15_000)}\n最终结论：不能报告任务完成。`;
    const compact = evidenceExcerpt(result, 3000);
    expect(compact.length).toBeLessThanOrEqual(3000);
    expect(compact).toContain("登录未完成");
    expect(compact).toContain("最终结论");
    expect(compact).toContain("abbreviated");
    const f = build({ router: [decision({ purpose: "research" }), "invalid", "invalid"], run: async () => ({ ok: true, lastText: result, sideEffects: noEffects }) });
    const task = f.submit();
    await f.engine.idle();
    expect(f.store.getTask(task.id)?.status).toBe("partial");
    const checkpoint = f.events.find((e) => e.type === "checkpoint")!.payload;
    expect(String(checkpoint.result)).toContain("登录未完成");
    expect(String(checkpoint.result)).toContain("最终结论");
    expect(String(checkpoint.result).length).toBeLessThanOrEqual(20_000);
  });

  it("the loop model has a deadline even if its implementation ignores abort", async () => {
    const f = build({ timeoutMs: 20 });
    const router = { name: "hung fake", route: async () => new Promise<never>(() => {}) };
    const out = await nextAction(router, { router, targets: f.targets, running: {}, quota: {} }, { req: { task: goal, cwd: f.dir }, steps: [], used: 0, budget: 5, exclude: [] });
    expect(out).toMatchObject({ action: null, routerError: expect.stringContaining("超时"), failure: { kind: "timeout", tries: 1 } });
  });
});
