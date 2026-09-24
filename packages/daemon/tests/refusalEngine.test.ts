import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import type { ExecutionInput, Executor } from "../src/executors/types.js";
import { NO_SIDE_EFFECTS, type ExecutionOutcome } from "../src/core/outcome.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { SupervisorConfig, type Supervisor } from "../src/router/supervisor.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();
const brief = "Inspect the sample CSV structure.";
const fact = "The attached rows are synthetic examples generated for this local parser test.";
const taskText = `${brief}\n${fact}`;
const refusalText = "I can't help with processing private personal data without more context.";
const refused: ExecutionOutcome = { ok: true, lastText: refusalText, sideEffects: NO_SIDE_EFFECTS, sessionId: "refused-session" };
const succeeded: ExecutionOutcome = { ok: true, lastText: "The sample contains three well-formed columns.", sideEffects: NO_SIDE_EFFECTS };
const homes: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

type Diagnostic = (taskId: string, call: number) => string;
const clarification = (sourceId: string, quote = fact, extra: Record<string, unknown> = {}) => JSON.stringify({
  action: "clarify", reason: "missing_context", note: "The original brief omitted the nature of the sample.",
  question: null, facts: [{ sourceId, quote }], ...extra,
});
const askForContext = () => JSON.stringify({ action: "ask_user", reason: "missing_context", note: "The sample's origin is not given.", question: "这些样本数据来自哪里？", facts: [] });

function build(outcomes: readonly ExecutionOutcome[], diagnostic: Diagnostic = (id) => clarification(`task:${id}`), opts: { context?: string; timeoutMs?: number; accept?: Supervisor["accept"] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-refusal-"));
  homes.push(home);
  const store = new Store({ dbPath: ":memory:", threadsDir: join(home, "threads") });
  stores.push(store);
  const bus = new Bus();
  const events: TaskEvent[] = [];
  const runs: { harness: string; input: ExecutionInput }[] = [];
  const accepted: string[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const supervisor: Supervisor = {
    config: SupervisorConfig.parse({ watchdog_ms: 60_000 }),
    approve: async () => ({ decision: "ask_user", reason: "", ms: 0, source: "router" }),
    checkIn: async () => ({ action: "continue", note: "", ms: 0, source: "router" }),
    accept: async (input) => {
      accepted.push(input.result);
      return opts.accept ? opts.accept(input) : { accepted: true, missing: [], note: "", ms: 0, source: "router" };
    },
  };
  const executors: Executor[] = Object.keys(targets.harnesses).map((harness) => ({
    harness,
    run: async (input) => {
      runs.push({ harness, input });
      return outcomes[runs.length - 1] ?? succeeded;
    },
  }));
  const router = echoRouter((_input, call) => call === 0
    ? decisionJson({ harness: "codex", model: "gpt-6-astra", effort: "high", brief })
    : diagnostic(runs[0]!.input.taskId, call));
  const contextPath = join(home, "CONTEXT.md");
  if (opts.context) writeFileSync(contextPath, opts.context);
  const engine = new Engine({
    store, bus, executors, targets, router, supervisor, quota: () => ({}),
    contextPath, approvalTimeoutMs: opts.timeoutMs ?? 100, retryBackoffMs: 1,
  });
  const firstQuestion = () => new Promise<string>((resolve) => {
    const unsubscribe = bus.subscribe("*", (event) => {
      if (event.type === "approval_request") { unsubscribe(); resolve(String(event.payload.approvalId)); }
    });
  });
  return { engine, store, events, runs, accepted, router, home, firstQuestion };
}

const refusalEvents = (events: TaskEvent[]) => events.filter((event) => event.type === "refusal");

function expectStopped(fixture: ReturnType<typeof build>, taskId: string, dispatches = 1) {
  expect(fixture.store.getTask(taskId)?.status).toBe("failed");
  expect(fixture.runs).toHaveLength(dispatches);
  expect(fixture.runs.map((run) => [run.harness, run.input.model, run.input.effort]))
    .toEqual(Array.from({ length: dispatches }, () => ["codex", "gpt-6-astra", "high"]));
  expect(fixture.accepted).toEqual([]);
  expect(fixture.events.filter((event) => event.type === "done")).toEqual([]);
  expect(refusalEvents(fixture.events).at(-1)?.payload).toMatchObject({ action: "stop" });
}

describe("Engine: bounded, sourced refusal clarification", () => {
  it("an ok:true direct refusal gets one sourced retry on the same model, effort and session; only the completed result reaches acceptance", async () => {
    const f = build([refused, succeeded]);
    const task = f.engine.submit({ task: taskText, cwd: f.home });
    await f.engine.idle();

    expect(f.store.getTask(task.id)).toMatchObject({ status: "done", result: succeeded.lastText });
    expect(f.store.getTask(task.id)!.attempts.map((attempt) => attempt.kind)).toEqual(["refusal"]);
    expect(f.router.calls).toHaveLength(2);
    expect(f.runs).toHaveLength(2);
    expect(f.runs.map((run) => [run.harness, run.input.model, run.input.effort]))
      .toEqual([["codex", "gpt-6-astra", "high"], ["codex", "gpt-6-astra", "high"]]);
    expect(f.runs[1]!.input.resume).toBe("refused-session");
    expect(f.runs[1]!.input.brief).toContain(brief);
    expect(f.runs[1]!.input.brief).toContain(fact);
    expect(f.runs[1]!.input.brief).toContain(refusalText);
    expect(f.accepted).toEqual([succeeded.lastText]);
    expect(refusalEvents(f.events).map((event) => event.payload)).toContainEqual(expect.objectContaining({
      action: "clarify", reason: "missing_context", facts: [expect.objectContaining({ sourceId: `task:${task.id}`, quote: fact, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) })],
      target: expect.objectContaining({ harness: "codex", model: "gpt-6-astra" }),
    }));
  });

  it("uses verbatim CONTEXT.md facts with their source instead of invented authorization", async () => {
    const contextFact = "The CSV rows are local parser fixtures containing generated names.";
    const f = build([refused, succeeded], () => clarification("context", contextFact), { context: `${contextFact}\n` });
    const task = f.engine.submit({ task: brief, cwd: f.home });
    await f.engine.idle();

    expect(f.store.getTask(task.id)?.status).toBe("done");
    expect(f.runs[1]!.input.brief).toContain(contextFact);
    expect(f.runs[1]!.input.brief).not.toContain("user owns all accounts");
    expect(refusalEvents(f.events).map((event) => event.payload)).toContainEqual(expect.objectContaining({
      action: "clarify", facts: [expect.objectContaining({ sourceId: "context", quote: contextFact, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) })],
    }));
  });

  // A provider's safety classifier (e.g. `[cyber]`) is not the model refusing: the same request usually passes when
  // sent again (router-v0 §6.2). One identical retry, same model, a new session; never another model or a rewrite.
  const blocked: ExecutionOutcome = { ok: false, lastText: "API Error: safeguards flagged this message.", sideEffects: NO_SIDE_EFFECTS, sessionId: "flagged-session", refusal: { source: "provider", reason: "Claude assistant stop_reason: refusal" } };
  const decideAlways = () => decisionJson({ harness: "codex", model: "gpt-6-astra", effort: "high", brief });

  it("a provider safety block is retried once, unchanged, on the same model in a new session, without asking a model", async () => {
    const f = build([blocked, { ...succeeded, sessionId: "fresh-session" }], decideAlways);
    const task = f.engine.submit({ task: taskText, cwd: f.home });
    await f.engine.idle();

    expect(f.store.getTask(task.id)).toMatchObject({ status: "done", result: succeeded.lastText });
    expect(f.runs.map((run) => [run.harness, run.input.model, run.input.effort])).toEqual([["codex", "gpt-6-astra", "high"], ["codex", "gpt-6-astra", "high"]]);
    expect(f.runs[1]!.input.brief).toBe(f.runs[0]!.input.brief);
    expect(f.runs[1]!.input.resume).toBeNull();
    expect(f.router.calls).toHaveLength(1);   // routing only: no diagnosis, no other model
    expect(refusalEvents(f.events).map((event) => event.payload)).toEqual([expect.objectContaining({ action: "retry", reason: "provider_safety" })]);

    // The flagged session is never resumed; the thread continues from the retry's session.
    const next = f.engine.submit({ task: "Continue with the same sample.", cwd: f.home, parentId: task.id });
    await f.engine.idle();
    expect(f.store.getTask(next.id)?.status).toBe("done");
    expect(f.runs[2]!.input.resume).toBe("fresh-session");
  });

  it("a flagged session already in the thread is dropped, so the retry and later tasks start fresh", async () => {
    const f = build([{ ...succeeded, sessionId: "good-session" }, blocked, succeeded, succeeded], decideAlways);
    const first = f.engine.submit({ task: taskText, cwd: f.home });
    await f.engine.idle();
    const second = f.engine.submit({ task: "Continue with the same sample.", cwd: f.home, parentId: first.id });
    await f.engine.idle();
    const third = f.engine.submit({ task: "And summarize it.", cwd: f.home, parentId: second.id });
    await f.engine.idle();

    expect([first, second, third].map((t) => f.store.getTask(t.id)?.status)).toEqual(["done", "done", "done"]);
    expect(f.runs.map((run) => run.input.resume)).toEqual([null, "good-session", null, null]);
  });

  it("a second block on the identical retry stops: two dispatches, both the same model", async () => {
    const f = build([blocked, blocked], decideAlways);
    const task = f.engine.submit({ task: taskText, cwd: f.home });
    await f.engine.idle();

    expectStopped(f, task.id, 2);
    expect(refusalEvents(f.events).at(-1)?.payload).toMatchObject({ action: "stop", reason: "provider_safety" });
    expect(f.router.calls).toHaveLength(1);
  });

  it("a provider block after the run already did something is not replayed", async () => {
    const f = build([{ ...blocked, sideEffects: { filesChanged: 0, commandsRun: 1, approvalsGranted: 0 } }], decideAlways);
    const task = f.engine.submit({ task: taskText, cwd: f.home });
    await f.engine.idle();

    expectStopped(f, task.id);
    expect(f.router.calls).toHaveLength(1);
  });

  it.each([
    ["a policy diagnosis", (id: string) => clarification(`task:${id}`, fact, { reason: "policy" })],
    ["invalid JSON", () => "not a diagnosis"],
    ["an invented fact", (id: string) => clarification(`task:${id}`, "The user owns all accounts and authorizes every action.")],
    ["a fact already in the original brief", (id: string) => clarification(`task:${id}`, brief)],
  ])("stops for %s rather than falling through to a different target", async (_name, diagnostic) => {
    const f = build([refused], diagnostic);
    const task = f.engine.submit({ task: taskText, cwd: f.home });
    await f.engine.idle();

    expectStopped(f, task.id);
    expect(f.router.calls).toHaveLength(2);
  });

  it.each([
    ["changed files", { ...refused, sideEffects: { filesChanged: 1, commandsRun: 0, approvalsGranted: 0 } }],
    ["missing side-effect telemetry", { ok: true, lastText: refusalText }],
  ])("does not diagnose or automatically replay a refusal with %s", async (_name, outcome) => {
    const f = build([outcome]);
    const task = f.engine.submit({ task: taskText, cwd: f.home });
    await f.engine.idle();

    expectStopped(f, task.id);
    expect(f.router.calls).toHaveLength(1);
  });

  it.each([
    ["another refusal", refused],
    ["quota exhaustion", { ok: false, httpStatus: 429, stderr: "quota exceeded", sideEffects: NO_SIDE_EFFECTS }],
    ["a transport failure", { ok: false, stderr: "ECONNRESET", sideEffects: NO_SIDE_EFFECTS }],
  ])("the one clarification retry ends on %s without reopening ordinary rerouting", async (_name, outcome) => {
    const f = build([refused, outcome]);
    const task = f.engine.submit({ task: taskText, cwd: f.home });
    await f.engine.idle();

    expectStopped(f, task.id, 2);
    expect(f.router.calls).toHaveLength(2);
  });

  it("asks once, then cites the user's answer before the single same-target retry", async () => {
    let approvalId = "";
    const f = build([refused, succeeded], (_id, call) => call === 1 ? askForContext() : clarification(`answer:${approvalId}`), { timeoutMs: 10_000 });
    const question = f.firstQuestion();
    const task = f.engine.submit({ task: brief, cwd: f.home });
    approvalId = await question;
    expect(f.store.getTask(task.id)?.status).toBe("waiting_approval");
    expect(f.engine.answer(approvalId, { text: fact })).toEqual({ ok: true });
    await f.engine.idle();

    expect(f.store.getTask(task.id)?.status).toBe("done");
    expect(f.runs).toHaveLength(2);
    expect(f.runs[1]!.input).toMatchObject({ model: "gpt-6-astra", effort: "high", resume: "refused-session" });
    expect(f.runs[1]!.input.brief).toContain(fact);
    expect(f.events.filter((event) => event.type === "approval_request")).toHaveLength(1);
    expect(f.router.calls).toHaveLength(3);
    expect(refusalEvents(f.events).map((event) => event.payload)).toContainEqual(expect.objectContaining({
      action: "clarify", facts: [expect.objectContaining({ sourceId: `answer:${approvalId}`, quote: fact, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) })],
    }));
    expect(f.accepted).toEqual([succeeded.lastText]);
  });

  it("a missing answer times out and leaves no pending question or extra dispatch", async () => {
    const f = build([refused], askForContext, { timeoutMs: 20 });
    const task = f.engine.submit({ task: brief, cwd: f.home });
    await f.engine.idle();

    expectStopped(f, task.id);
    expect(f.events.filter((event) => event.type === "approval_request")).toHaveLength(1);
    expect(f.store.pendingApprovals(task.id)).toEqual([]);
    expect(f.router.calls).toHaveLength(2);
  });

  it("a diagnostic that asks again after an answer stops instead of opening another question", async () => {
    const f = build([refused], askForContext, { timeoutMs: 10_000 });
    const question = f.firstQuestion();
    const task = f.engine.submit({ task: brief, cwd: f.home });
    const approvalId = await question;
    expect(f.engine.answer(approvalId, { text: fact })).toEqual({ ok: true });
    await f.engine.idle();

    expectStopped(f, task.id);
    expect(f.events.filter((event) => event.type === "approval_request")).toHaveLength(1);
    expect(f.store.pendingApprovals(task.id)).toEqual([]);
    expect(f.router.calls).toHaveLength(3);
  });

  it("does not ignore the user's answer by citing only an older source after asking for context", async () => {
    const f = build([refused], (id, call) => call === 1 ? askForContext() : clarification(`task:${id}`), { timeoutMs: 10_000 });
    const question = f.firstQuestion();
    const task = f.engine.submit({ task: taskText, cwd: f.home });
    const approvalId = await question;
    expect(f.engine.answer(approvalId, { text: "I do not know where these rows came from." })).toEqual({ ok: true });
    await f.engine.idle();

    expectStopped(f, task.id);
    expect(f.router.calls).toHaveLength(3);
  });

  it("does not retry when the second diagnosis quotes only one line and omits the answer's restriction", async () => {
    let approvalId = "";
    const f = build([refused], (_id, call) => call === 1 ? askForContext() : clarification(`answer:${approvalId}`), { timeoutMs: 10_000 });
    const question = f.firstQuestion();
    const task = f.engine.submit({ task: brief, cwd: f.home });
    approvalId = await question;
    expect(f.engine.answer(approvalId, { text: `${fact}\nDo not process any real customer data or contact a service.` })).toEqual({ ok: true });
    await f.engine.idle();

    expectStopped(f, task.id);
    expect(f.router.calls).toHaveLength(3);
  });

  it("cancellation during diagnosis remains cancelled and never dispatches a clarification", async () => {
    const f = build([refused], (id) => {
      f.engine.cancel(id);
      return clarification(`task:${id}`);
    });
    const task = f.engine.submit({ task: taskText, cwd: f.home });
    await f.engine.idle();

    expect(f.store.getTask(task.id)?.status).toBe("cancelled");
    expect(f.runs).toHaveLength(1);
    expect(f.accepted).toEqual([]);
    expect(f.router.calls).toHaveLength(2);
    expect(f.events.filter((event) => event.type === "done" || event.type === "failed")).toEqual([]);
    expect(refusalEvents(f.events).some((event) => event.payload.action === "clarify")).toBe(false);
  });

  it("cancellation while awaiting context closes the question without a diagnosis or retry", async () => {
    const f = build([refused], askForContext, { timeoutMs: 10_000 });
    const question = f.firstQuestion();
    const task = f.engine.submit({ task: brief, cwd: f.home });
    const approvalId = await question;
    f.engine.cancel(task.id);
    await f.engine.idle();

    expect(f.store.getTask(task.id)?.status).toBe("cancelled");
    expect(f.runs).toHaveLength(1);
    expect(f.accepted).toEqual([]);
    expect(f.router.calls).toHaveLength(2);
    expect(f.store.pendingApprovals(task.id)).toEqual([]);
    expect(f.engine.answer(approvalId, { text: fact })).toMatchObject({ ok: false, code: "not_found" });
    expect(f.events.filter((event) => event.type === "done" || event.type === "failed")).toEqual([]);
  });

  it.each([
    ["yes", "这些样本行是否完全由程序合成？"],
    ["no", "这些样本行是否包含真实个人的数据？"],
  ])("keeps the original question attached to the short answer %s in diagnosis, retry and persisted facts", async (answer, questionText) => {
    let approvalId = "";
    const f = build([refused, succeeded], (_id, call) => call === 1
      ? JSON.stringify({ action: "ask_user", reason: "missing_context", note: "The sample's origin is not given.", question: questionText, facts: [] })
      : clarification(`answer:${approvalId}`, answer), { timeoutMs: 10_000 });
    const question = f.firstQuestion();
    const task = f.engine.submit({ task: brief, cwd: f.home });
    approvalId = await question;
    expect(f.engine.answer(approvalId, { text: answer })).toEqual({ ok: true });
    await f.engine.idle();

    expect(f.store.getTask(task.id)?.status).toBe("done");
    expect(f.router.calls).toHaveLength(3);
    const diagnosticInput = JSON.parse(f.router.calls[2]!.task);
    expect(diagnosticInput.sources).toContainEqual({ id: `answer:${approvalId}`, text: answer, question: questionText });
    expect(f.runs).toHaveLength(2);
    expect(f.runs[1]!.input.brief).toContain(questionText);
    expect(f.runs[1]!.input.brief).toContain(`"quote": "${answer}"`);
    expect(refusalEvents(f.store.eventsSince(task.id)).map((event) => event.payload)).toContainEqual(expect.objectContaining({
      action: "clarify", facts: [expect.objectContaining({ sourceId: `answer:${approvalId}`, quote: answer, question: questionText, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) })],
    }));
  });

  it("a successful clarification execution rejected by acceptance fails without another target or dispatch", async () => {
    const f = build([refused, succeeded], undefined, {
      accept: async () => ({ accepted: false, missing: ["the required column summary"], note: "The requested result is incomplete.", ms: 0, source: "router" }),
    });
    const task = f.engine.submit({ task: taskText, cwd: f.home });
    await f.engine.idle();

    expect(f.store.getTask(task.id)?.status).toBe("failed");
    expect(f.store.getTask(task.id)!.attempts.map((attempt) => attempt.kind)).toEqual(["refusal", "rejected"]);
    expect(f.runs.map((run) => [run.harness, run.input.model, run.input.effort]))
      .toEqual([["codex", "gpt-6-astra", "high"], ["codex", "gpt-6-astra", "high"]]);
    expect(f.router.calls).toHaveLength(2);
    expect(f.accepted).toEqual([succeeded.lastText]);
    expect(f.events.filter((event) => event.type === "done")).toEqual([]);
    expect(refusalEvents(f.events).at(-1)?.payload).toMatchObject({ action: "stop" });
  });
});
