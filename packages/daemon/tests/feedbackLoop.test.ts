/** Scripted protocol tests: no business platform, model or credential service is contacted. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import { TERMINAL, type TaskEvent } from "../src/engine/types.js";
import type { UserQuestion } from "../src/core/questions.js";
import type { Executor, ExecutionInput } from "../src/executors/types.js";
import { composePrompt } from "../src/executors/instructions.js";
import { NO_SIDE_EFFECTS } from "../src/core/outcome.js";
import { echoRouter, type EchoScript } from "../src/router/routers/echo.js";
import { routerSupervisor, type AcceptInput, type AnswerInput, type AnswerVerdict, type Supervisor } from "../src/router/supervisor.js";
import { decisionJson, realTargets } from "./helpers.js";

const question = (id: string, text: string): UserQuestion => ({ id, text, header: "核对", options: [], multi: false, secret: false });
const success = (lastText = "步骤完成") => ({ ok: true, exitCode: 0, lastText, sideEffects: NO_SIDE_EFFECTS, sideEffectsKnown: true });
const dispatch = (over: Record<string, unknown> = {}) => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, ...over });
const finish = JSON.stringify({ action: "finish", completion: "complete", remaining: [], result: "原任务已验证完成" });
const answerVerdict = (answers: Record<string, string[]>): AnswerVerdict => ({ answers, forward: false, source: "router", reason: "按来源材料核对", ms: 1 });

function supervisor(answer?: Supervisor["answer"], accept?: Supervisor["accept"]): Supervisor {
  return {
    config: { approvals: false, acceptance: true, watchdog_ms: 0, max_continues: 0 },
    approve: async () => ({ decision: "ask_user", reason: "", source: "router", ms: 0 }),
    checkIn: async () => ({ action: "continue", note: "", source: "router", ms: 0 }),
    accept: accept ?? (async () => ({ accepted: true, missing: [], note: "fixture verified", source: "router", ms: 0 })),
    ...(answer ? { answer } : {}),
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });

function build(executors: Executor[], sup: Supervisor, script: EchoScript = [dispatch()], timeoutMs = 1_000) {
  const root = mkdtempSync(join(tmpdir(), "agentswitch-feedback-loop-"));
  const store = new Store({ dbPath: ":memory:", threadsDir: join(root, "threads") });
  const bus = new Bus();
  const router = echoRouter(script);
  const base = realTargets();
  const events: TaskEvent[] = [];
  bus.subscribe("*", (event) => events.push(event));
  const engine = new Engine({ store, bus, router, executors, supervisor: sup, targets: { ...base, router: { ...base.router, timeout_ms: timeoutMs } }, quota: () => ({}), approvalTimeoutMs: 1_000, retryBackoffMs: 1 });
  cleanups.push(async () => { for (const task of store.listTasks()) if (!TERMINAL.has(task.status)) engine.cancel(task.id); await engine.idle(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const nextQuestion = () => new Promise<string>((resolve) => {
    const off = bus.subscribe("*", (event) => { if (event.type === "approval_request" && event.payload.kind === "question") { off(); resolve(String(event.payload.approvalId)); } });
  });
  return { root, engine, store, router, events, nextQuestion };
}

describe("feedback closes the existing question → planner → executor loop", () => {
  it.each([
    { subject: "配置路径", observed: "项目清单中实际配置是 config/runtime.yaml", corrected: "配置路径改为 config/runtime.yaml，旧的 settings.json 是推断" },
    { subject: "接口参数", observed: "本地接口规范显示分页参数为 cursor", corrected: "使用 cursor 参数，先前的 page 参数判断有误" },
  ])("carries a $subject correction through another question, a model change and acceptance", async ({ subject, observed, corrected }) => {
    const asked: AnswerInput[] = [], accepted: AcceptInput[] = [], runs: ExecutionInput[] = [];
    const answers: unknown[] = [];
    const sup = supervisor(async (input) => { asked.push(input); return answerVerdict({ [input.questions[0]!.id]: [asked.length === 1 ? corrected : "采用刚才核对的结论，继续未完成步骤"] }); }, async (input) => {
      accepted.push(input); return { accepted: true, missing: [], note: "fixture verified", source: "router", ms: 0 };
    });
    const first: Executor = { harness: "codex", async run(input) {
      runs.push(input);
      input.emit("text", { text: observed });
      answers.push(await input.ask([question("conflict", `${subject}与简报不一致；${observed}。已完成只读检查，核对后再继续。`)]));
      answers.push(await input.ask([question("confirm", "后续步骤采用哪个结论？")]));
      return success("调研结束；具体核对答复由独立反馈记录保存");
    } };
    const second: Executor = { harness: "claude-code", async run(input) { runs.push(input); return success("仅执行未完成步骤并核验"); } };
    const fixture = build([first, second], sup, [dispatch({ purpose: "research", brief: "核对后再操作" }), dispatch({ harness: "claude-code", model: "claude-sonnet-4-6", brief: "来自旧计划的简报" }), finish]);
    const task = fixture.engine.submit({ task: `请处理${subject}并核验`, cwd: fixture.root });
    await fixture.engine.idle();
    expect(fixture.store.getTask(task.id)?.status).toBe("done");
    expect(runs.map((run) => run.model)).toEqual(["gpt-5.5", "claude-sonnet-4-6"]);
    expect(asked[0]!.observations?.join("\n")).toContain(observed);
    expect(answers[0]).toEqual({ conflict: [corrected] });
    expect(asked[1]!.feedback).toContain(corrected);
    expect(fixture.router.calls[1]!.task).toContain(corrected);
    expect(runs[1]!.feedback).toContain(corrected);
    expect(composePrompt(runs[1]!)).toContain(corrected);
    expect(composePrompt(runs[1]!).lastIndexOf(corrected)).toBeGreaterThan(composePrompt(runs[1]!).indexOf("来自旧计划的简报"));
    expect(accepted[0]!.feedback).toContain(corrected);
    expect(fixture.events.filter((event) => event.type === "feedback").map((event) => event.payload.source)).toEqual(["router", "router"]);
    expect(fixture.events.some((event) => event.type === "approval_request")).toBe(false);
    expect(fixture.router.calls).toHaveLength(3); // feedback adds no background planner call
  });

  it("retains a user's meaning correction in a follow-up even when the result omits it", async () => {
    const asked: AnswerInput[] = [], runs: ExecutionInput[] = [];
    const sup = supervisor(async (input) => { asked.push(input); return asked.length === 1
      ? { answers: null, forward: true, source: "router", reason: "原标签只是推断，含义需要用户确认", ms: 0 }
      : answerVerdict({ meaning: ["第三项是 TOTP 种子；这是用户前序答复，不是页面字段推断"] }); });
    const executor: Executor = { harness: "codex", async run(input) {
      runs.push(input);
      await input.ask([question("meaning", "第三项是什么类型？当前自动标签与表单不一致。")]);
      return success("本轮检查结束");
    } };
    const f = build([executor], sup);
    const pending = f.nextQuestion();
    const parent = f.engine.submit({ task: "录入已有记录；入口候选第三项为 session key", cwd: f.root });
    const id = await pending;
    expect(f.engine.answer(id, { text: "第三项是 TOTP 种子，之前标签识别错了" }).ok).toBe(true);
    await f.engine.idle();
    const child = f.engine.submit({ task: "继续核对字段", cwd: f.root, parentId: parent.id });
    await f.engine.idle();
    expect(f.store.getTask(child.id)?.status).toBe("done");
    expect(f.router.calls[1]!.task).toContain("第三项是 TOTP 种子，之前标签识别错了");
    expect(runs[1]!.feedback).toContain('"source":"user"');
    expect(asked[1]!.feedback).toContain("之前标签识别错了");
    expect(f.events.filter((event) => event.type === "approval_request")).toHaveLength(1);
    expect(f.events.filter((event) => event.type === "feedback").map((event) => event.payload.source)).toEqual(["user", "router"]);
  });

  it.each([
    { name: "empty map", verdict: answerVerdict({}) },
    { name: "missing question", verdict: answerVerdict({ a: ["x"] }) },
    { name: "blank answer", verdict: answerVerdict({ a: ["x"], b: ["  "] }) },
    { name: "extra question", verdict: answerVerdict({ a: ["x"], b: ["y"], extra: ["z"] }) },
    { name: "forward overrides answers", verdict: { ...answerVerdict({ a: ["x"], b: ["y"] }), forward: true } },
    { name: "error source", verdict: { ...answerVerdict({ a: ["x"], b: ["y"] }), source: "error" as const } },
    { name: "invented token", verdict: answerVerdict({ a: ["x"], b: [`enc:v1:${"B".repeat(60)}`] }) },
  ])("forwards $name rather than treating it as resolved", async ({ verdict }) => {
    let received: unknown;
    const f = build([{ harness: "codex", async run(input) { received = await input.ask([question("a", "路径是什么？"), question("b", "格式是什么？")]); return success(); } }], supervisor(async () => verdict));
    const pending = f.nextQuestion();
    const task = f.engine.submit({ task: "核对输入", cwd: f.root });
    const id = await pending;
    expect(f.engine.answer(id, { text: "只答第一题" })).toMatchObject({ ok: false, code: "bad_answer" });
    expect(f.engine.answer(id, { answers: { a: ["actual.yml"], b: ["YAML"] } }).ok).toBe(true);
    await f.engine.idle();
    expect(received).toEqual({ a: ["actual.yml"], b: ["YAML"] });
    expect(f.store.getTask(task.id)?.status).toBe("done");
    expect(f.events.filter((event) => event.type === "feedback").map((event) => event.payload.source)).toEqual(["user"]);
  });

  it("a non-cooperative supervisor times out, and a late answer cannot replace the user's correction", async () => {
    let late!: (verdict: AnswerVerdict) => void;
    let received: unknown;
    const f = build([{ harness: "codex", async run(input) { received = await input.ask([question("q", "确认配置路径")]); return success(); } }], supervisor(() => new Promise((resolve) => { late = resolve; })), [dispatch()], 25);
    const pending = f.nextQuestion();
    const task = f.engine.submit({ task: "修正路径", cwd: f.root });
    const id = await pending;
    f.engine.answer(id, { text: "actual.yml" });
    await f.engine.idle();
    late(answerVerdict({ q: ["stale.json"] }));
    await Promise.resolve();
    expect(received).toEqual({ q: ["actual.yml"] });
    expect(f.store.getTask(task.id)?.status).toBe("done");
    expect(f.events.filter((event) => event.type === "feedback")).toHaveLength(1);
    expect(f.events.some((event) => event.type === "supervisor" && String(event.payload.reason).includes("超时"))).toBe(true);
  });

  it("cancelling while the supervisor thinks prevents late feedback, cards and further work", async () => {
    let started!: () => void, late!: (verdict: AnswerVerdict) => void;
    const thinking = new Promise<void>((resolve) => { started = resolve; });
    let continued = false;
    const f = build([{ harness: "codex", async run(input) { const answer = await input.ask([question("q", "路径冲突")]); continued = answer !== null; return success(); } }], supervisor(() => new Promise((resolve) => { late = resolve; started(); })));
    const task = f.engine.submit({ task: "检查路径", cwd: f.root });
    await thinking;
    f.engine.cancel(task.id);
    await f.engine.idle();
    late(answerVerdict({ q: ["迟到回答"] }));
    await Promise.resolve();
    expect(continued).toBe(false);
    expect(f.store.getTask(task.id)?.status).toBe("cancelled");
    expect(f.events.filter((event) => event.type === "feedback" || event.type === "approval_request")).toHaveLength(0);
  });

  it("an unanswered conflict remains blocked and cannot be used as permission to skip", async () => {
    let continued = false;
    const f = build([{ harness: "codex", async run(input) { continued = (await input.ask([question("q", "输入与现场冲突，需确认含义")])) !== null; return success("即使执行者误报成功"); } }], supervisor());
    const pending = f.nextQuestion();
    const task = f.engine.submit({ task: "核对后录入", cwd: f.root });
    f.engine.resolveApproval(await pending, "deny");
    await f.engine.idle();
    expect(continued).toBe(false);
    expect(f.store.getTask(task.id)?.status).toBe("blocked");
    expect(f.events.find((event) => event.type === "feedback")?.payload).toMatchObject({ status: "unanswered", answers: null });
    expect(f.router.calls).toHaveLength(1);
  });
});

describe("text-only feedback adjudication boundaries", () => {
  const input: AnswerInput = { brief: "推断路径为 old.json", userMessage: "修改项目配置", context: "", steps: [], cwd: "/fixture", questions: [{ id: "q", text: "现场只有 actual.yml，核对路径", options: [], secret: false }], feedback: '来源user：路径为 actual.yml', observations: ["已读清单：actual.yml"] };

  it("includes current observations and sourced feedback without adding a model call", async () => {
    const router = echoRouter([JSON.stringify({ forward: false, answers: { q: ["actual.yml"] }, reason: "已确认" })]);
    const sup = routerSupervisor(router, supervisor().config, 100);
    expect(await sup.answer!(input)).toMatchObject({ forward: false, answers: { q: ["actual.yml"] } });
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]!.task).toContain(input.feedback);
    expect(router.calls[0]!.task).toContain(input.observations![0]);
  });

  it("does not call a pre-cancelled router, bounds a router ignoring abort, and hides raw provider errors", async () => {
    let calls = 0;
    const router = { name: "non-cooperative", route: async () => { calls++; return new Promise<never>(() => undefined); } };
    const sup = routerSupervisor(router, supervisor().config, 15);
    const ctl = new AbortController(); ctl.abort();
    expect(await sup.answer!(input, ctl.signal)).toMatchObject({ source: "error", answers: null, forward: true });
    expect(calls).toBe(0);
    expect(await sup.answer!(input)).toMatchObject({ source: "error", answers: null, forward: true, reason: "调度模型调用超时" });
    expect(calls).toBe(1);
    const bad = routerSupervisor({ name: "bad", route: async () => { throw new Error("private-provider-payload"); } }, supervisor().config, 100);
    expect(JSON.stringify(await bad.answer!(input))).not.toContain("private-provider-payload");
  });
});
