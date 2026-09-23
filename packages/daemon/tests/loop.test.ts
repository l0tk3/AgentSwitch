/** loop-v0: the router/planner runs a task step by step; code keeps the floors. Echo router + echo executors, no models. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import { answersUseKnownTokens } from "../src/engine/supervise.js";
import { READ_ONLY_BRIEF, stepsNote } from "../src/engine/taskLoop.js";
import type { TaskEvent } from "../src/engine/types.js";
import { echoExecutor } from "../src/executors/echo.js";
import type { Executor } from "../src/executors/types.js";
import { MAX_DISPATCHES, nextAction, parseLoopReply } from "../src/router/loop.js";
import { echoRouter } from "../src/router/routers/echo.js";
import type { Router } from "../src/router/routers/types.js";
import type { Supervisor } from "../src/router/supervisor.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();
const codex = (over: Record<string, unknown> = {}) => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, ...over });
const finish = (result: string | null = null, reason = "all done") => JSON.stringify({ action: "finish", result, reason });
const askUser = (question: string) => JSON.stringify({ action: "ask_user", question });

type Build = { router?: string[] | ((i: { task: string }, n: number) => string); planner?: string[] | ((i: { task: string }, n: number) => string) | null; supervisor?: Supervisor; executors?: Executor[]; timeout?: number };
function build(o: Build = {}) {
  const store = new Store({ dbPath: ":memory:", threadsDir: join(mkdtempSync(join(tmpdir(), "agentswitch-loop-")), "threads") });
  const bus = new Bus();
  const events: TaskEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const echo = Object.keys(targets.harnesses).map((h) => echoExecutor(h));
  const router = echoRouter(o.router ?? [codex({ plan: "multi", reason: "look first" })]);
  const planner = o.planner === null ? null : echoRouter(o.planner ?? [finish("planned")]);
  const engine = new Engine({ store, bus, executors: o.executors ?? echo, targets, router, quota: () => ({}), approvalTimeoutMs: o.timeout ?? 200, retryBackoffMs: 1, planner: () => planner, ...(o.supervisor ? { supervisor: o.supervisor } : {}) });
  const firstApproval = (taskId: string) => new Promise<string>((resolve) => bus.subscribe(taskId, (e) => { if (e.type === "approval_request") resolve(String(e.payload.approvalId)); }));
  return { store, bus, engine, events, echo, router, planner, firstApproval };
}
const codexRuns = (echo: ReturnType<typeof echoExecutor>[]) => echo.find((e) => e.harness === "codex")!.runs;
const stepsOf = (events: TaskEvent[], id: string) => events.filter((e) => e.taskId === id && e.type === "step").map((e) => `${e.payload.n}:${e.payload.action}${e.payload.purpose ? "/" + e.payload.purpose : ""}`);

describe("parseLoopReply", () => {
  it("decision-shaped replies are dispatches; finish, ask_user, give_up and repair have their own shapes", () => {
    expect(parseLoopReply(codex())).toMatchObject({ ok: true, value: { kind: "dispatch", decision: { harness: "codex", action: "redispatch", purpose: "do" } } });
    expect(parseLoopReply(codex({ action: "dispatch", purpose: "research" }))).toMatchObject({ ok: true, value: { kind: "dispatch", decision: { purpose: "research" } } });
    expect(parseLoopReply(`Sure:\n${finish("ok", "why")}`)).toEqual({ ok: true, value: { kind: "finish", result: "ok", reason: "why" } });
    expect(parseLoopReply(finish("  "))).toMatchObject({ ok: true, value: { kind: "finish", result: null } });
    expect(parseLoopReply(askUser("which?"))).toEqual({ ok: true, value: { kind: "ask_user", question: "which?" } });
    expect(parseLoopReply(JSON.stringify({ action: "clarify", question: "which?" }))).toMatchObject({ ok: true, value: { kind: "ask_user" } });
    expect(parseLoopReply(JSON.stringify({ action: "ask_user" }))).toMatchObject({ ok: false });
    expect(parseLoopReply(JSON.stringify({ action: "give_up", reason: "no" }))).toEqual({ ok: true, value: { kind: "give_up", reason: "no" } });
    expect(parseLoopReply(codex({ action: "repair", repair: { tool: "t", args: { a: 1 } } }))).toMatchObject({ ok: true, value: { kind: "repair", tool: "t", args: { a: 1 } } });
    expect(parseLoopReply("nothing")).toMatchObject({ ok: false, error: "no JSON object in reply" });
    expect(parseLoopReply(JSON.stringify({ action: "dispatch" }))).toMatchObject({ ok: false });
  });
});

describe("nextAction", () => {
  const req = { task: "do it", cwd: "/tmp" };
  const deps = (router: Router) => ({ targets, router, quota: {}, running: {} });
  it("shows the steps and the excluded targets, validates a dispatch against the floor, and reports an unusable model", async () => {
    const r = echoRouter([codex({ harness: "claude-code", model: "claude-sonnet-5" })]);
    const steps = [{ kind: "dispatch" as const, purpose: "research" as const, harness: "codex", model: "gpt-5.5", brief: "look", ok: true, failureKind: null, reply: "found 3 fields", sideEffects: "files changed 0, commands 1, approvals 0", outFiles: [], diff: "" }];
    const out = await nextAction(r, deps(r), { req, steps, used: 1, budget: 5, exclude: [{ harness: "claude-code", model: "claude-sonnet-5" }] });
    expect(out.action).toMatchObject({ kind: "dispatch", source: "default", verdict: { ok: true } });   // the excluded target fell to the default policy
    expect((out.action as { verdict: { harness: string } }).verdict.harness).not.toBe("claude-code");
    expect(r.calls[0]!.task).toContain("1. dispatch [research] codex/gpt-5.5");
    expect(r.calls[0]!.task).toContain("→ done. Reply: found 3 fields");
    expect(r.calls[0]!.task).toContain("Dispatches used: 1 of 5.");
    expect(r.calls[0]!.system).toContain("step by step");
    expect(r.calls[0]!.system).not.toContain("claude-sonnet-5:");
    const bad = echoRouter(["garbage", "garbage"]);
    expect(await nextAction(bad, deps(bad), { req, steps: [], used: 0, budget: 5, exclude: [] })).toMatchObject({ action: null, routerError: expect.stringContaining("no JSON object") });
    const repair = echoRouter([codex({ action: "repair", repair: { tool: "restart_gate", args: {} } })]);
    expect((await nextAction(repair, { ...deps(repair), repairs: [{ name: "restart_gate", description: "d" }] }, { req, steps: [], used: 0, budget: 5, exclude: [] })).action).toEqual({ kind: "repair", tool: "restart_gate", args: {} });
    const unlisted = echoRouter([codex({ action: "repair", repair: { tool: "nope", args: {} } })]);
    expect((await nextAction(unlisted, deps(unlisted), { req, steps: [], used: 0, budget: 5, exclude: [] })).action).toMatchObject({ kind: "dispatch" });
  });
});

describe("multi-step tasks: the planner takes over", () => {
  it("research (read-only) → do → finish: each step is an event, the executor gets the earlier steps as handoff, the planner's result is the task's", async () => {
    const { engine, store, events, echo, planner } = build({ planner: [codex({ action: "dispatch", purpose: "research", brief: "list the form fields" }), codex({ purpose: "do", brief: "fill the form as found" }), finish("entered 1 record", "done")] });
    const t = engine.submit({ task: 'enter it @echo {"result":"fields: email, pass"}', cwd: "/tmp/loop1" });
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "done", result: "entered 1 record" });
    expect(stepsOf(events, t.id)).toEqual(["0:plan", "1:dispatch/research", "2:dispatch/do", "3:finish"]);
    const runs = codexRuns(echo);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.brief.startsWith(READ_ONLY_BRIEF.research)).toBe(true);
    expect(runs[1]!.brief.startsWith("fill the form")).toBe(true);
    expect(runs[1]!.handoffNote).toContain("Earlier steps of this task");
    expect(runs[1]!.handoffNote).toContain("1. dispatch [research] codex/gpt-5.5");
    expect(runs[1]!.handoffNote).toContain("fields: email, pass");
    expect(planner!.calls).toHaveLength(3);
    expect(planner!.calls[0]!.task).toContain("triaged this as a multi-step task: look first");
    expect(planner!.calls[2]!.task).toContain("Dispatches used: 2 of 5.");
    expect(events.find((e) => e.taskId === t.id && e.type === "done")?.payload).toMatchObject({ dispatches: 2 });
  });

  it("a research step's approval requests are refused by the floor without reaching anyone", async () => {
    const asked: string[] = [];
    const executor: Executor = { harness: "codex", async run(input) { asked.push(await input.approve("Bash: rm x", "")); return { ok: true, exitCode: 0, lastText: "looked", sideEffects: { filesChanged: 0, commandsRun: 0, approvalsGranted: 0 } }; } };
    const { engine, store, events } = build({ executors: [executor], planner: [codex({ action: "dispatch", purpose: "research" }), finish()] });
    const t = engine.submit({ task: "look", cwd: "/tmp/loop2" });
    await engine.idle();
    expect(asked).toEqual(["deny"]);
    expect(store.getTask(t.id)!.status).toBe("done");
    expect(events.some((e) => e.taskId === t.id && e.type === "approval_request")).toBe(false);
    expect(events.find((e) => e.taskId === t.id && e.type === "supervisor")?.payload).toMatchObject({ kind: "approval", decision: "deny", source: "floor" });
  });

  it("the planner asks the user mid-way; the answer is a step it sees on the next call", async () => {
    const { engine, store, events, planner, firstApproval } = build({ planner: [askUser("which region?"), codex(), finish()] });
    const t = engine.submit({ task: "x", cwd: "/tmp/loop3" });
    const id = await firstApproval(t.id);
    expect(store.getApproval(id)).toMatchObject({ kind: "question", action: "which region?" });
    expect(engine.answer(id, { text: "EU" }).ok).toBe(true);
    await engine.idle();
    expect(store.getTask(t.id)!.status).toBe("done");
    expect(planner!.calls[1]!.task).toContain('ask_user: "which region?" → "EU"');
    expect(stepsOf(events, t.id)).toEqual(["0:plan", "1:ask_user", "2:dispatch/do", "3:finish"]);
  });

  it("an unusable planner leaves the router's decision in force; an unusable loop model after a research step finishes with what there is", async () => {
    const a = build({ router: [codex({ plan: "multi", reason: "look first" }), finish()], planner: ["garbage", "garbage"] });
    const t = a.engine.submit({ task: 'x @echo {"result":"r1"}', cwd: "/tmp/loop4" });
    await a.engine.idle();
    expect(a.store.getTask(t.id)).toMatchObject({ status: "done", result: "r1" });
    expect(a.events.filter((e) => e.taskId === t.id && e.type === "step").map((e) => e.payload)).toContainEqual(expect.objectContaining({ action: "plan", source: "error" }));
    expect(stepsOf(a.events, t.id)).toEqual(["0:plan", "0:plan", "2:finish"]);   // handed to the planner, planner unusable, the router ran the loop itself
    const b = build({ router: [codex({ purpose: "research" }), "garbage", "garbage"], planner: null });
    const u = b.engine.submit({ task: 'y @echo {"result":"r2"}', cwd: "/tmp/loop5" });
    await b.engine.idle();
    expect(b.store.getTask(u.id)).toMatchObject({ status: "done", result: "r2" });
    expect(stepsOf(b.events, u.id)).toEqual(["2:finish"]);
  });

  it("no planner configured: the router itself continues after a research step", async () => {
    const { engine, store, events, echo } = build({ router: [codex({ purpose: "research", brief: "look" }), codex({ brief: "now do" }), finish("ok")], planner: null });
    const t = engine.submit({ task: "x", cwd: "/tmp/loop6" });
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "done", result: "ok" });
    expect(codexRuns(echo).map((r) => r.brief.slice(0, 20))).toEqual([READ_ONLY_BRIEF.research.slice(0, 20), "now do"]);
    expect(stepsOf(events, t.id)).toEqual(["2:dispatch/do", "3:finish"]);   // once a research step ran, the router is asked after every step
  });

  it("the dispatch budget: after MAX_DISPATCHES the user is asked; a refusal stops the task, permission extends it", async () => {
    const a = build({ planner: () => codex(), timeout: 60 });
    const t = a.engine.submit({ task: "x", cwd: "/tmp/loop7" });
    const id = await a.firstApproval(t.id);
    expect(a.store.getApproval(id)!.action).toContain(`已派发 ${MAX_DISPATCHES} 次`);
    expect(a.engine.resolveApproval(id, "deny")).toBe(true);
    await a.engine.idle();
    expect(a.store.getTask(t.id)).toMatchObject({ status: "failed", error: `stopped after ${MAX_DISPATCHES} dispatches` });
    expect(codexRuns(a.echo)).toHaveLength(MAX_DISPATCHES);
    const b = build({ planner: (_i, n) => (n < MAX_DISPATCHES + 1 ? codex() : finish("enough")) });
    const u = b.engine.submit({ task: "y", cwd: "/tmp/loop8" });
    const more = await b.firstApproval(u.id);
    expect(b.engine.resolveApproval(more, "allow")).toBe(true);
    await b.engine.idle();
    expect(b.store.getTask(u.id)).toMatchObject({ status: "done", result: "enough" });
    expect(codexRuns(b.echo)).toHaveLength(MAX_DISPATCHES + 1);
  });

  it("give_up fails the task with the reason; a pinned task never goes to the planner", async () => {
    const a = build({ planner: [JSON.stringify({ action: "give_up", reason: "cannot" })] });
    const t = a.engine.submit({ task: "x", cwd: "/tmp/loop9" });
    await a.engine.idle();
    expect(a.store.getTask(t.id)).toMatchObject({ status: "failed", error: "router gave up: cannot" });
    const b = build({ planner: [codex({ purpose: "research" })] });
    const u = b.engine.submit({ task: "y", cwd: "/tmp/loop10", pin: { harness: "codex", model: "gpt-5.5" } });
    await b.engine.idle();
    expect(b.store.getTask(u.id)!.status).toBe("done");
    expect(b.planner!.calls).toHaveLength(0);
  });
});

describe("executor questions: the supervisor answers first", () => {
  const known = "enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA";
  const cfg = { approvals: true, watchdog_ms: 0, acceptance: false, max_continues: 3 };
  function sup(answer: Supervisor["answer"]): Supervisor & { asked: string[] } {
    const asked: string[] = [];
    return { config: cfg, asked,
      approve: async () => ({ decision: "allow", reason: "", ms: 1, source: "router" }), checkIn: async () => ({ action: "continue", note: "", ms: 1, source: "router" }), accept: async () => ({ accepted: true, missing: [], note: "", ms: 1, source: "router" }),
      answer: async (i, s) => { asked.push(i.questions.map((q) => q.text).join("|")); return answer!(i, s); } };
  }
  const question = (id = "q1") => `@echo {"question":{"id":"${id}","text":"Which port?","options":["8600","8400"]}}`;

  it("answered from the material: no card, the answer reaches the executor, the event says what was answered", async () => {
    const s = sup(async () => ({ answers: { q1: ["8600"] }, forward: false, reason: "in the brief", ms: 1, source: "router" }));
    const { engine, store, events } = build({ router: [codex()], planner: null, supervisor: s });
    const t = engine.submit({ task: `x ${question()}`, cwd: "/tmp/q1" });
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "done", result: "answer: 8600" });
    expect(s.asked).toEqual(["Which port?"]);
    expect(events.some((e) => e.taskId === t.id && e.type === "approval_request")).toBe(false);
    expect(events.find((e) => e.taskId === t.id && e.type === "supervisor")?.payload).toMatchObject({ kind: "question", answered: true, text: "Which port? → 8600" });
  });

  it("forwarded, unusable, or answered with a token the task does not hold: the user's card", async () => {
    for (const verdict of [
      { answers: null, forward: true, reason: "only the user knows", ms: 1, source: "router" as const },
      { answers: { q1: [`use enc:v1:${"B".repeat(30)}`] }, forward: false, reason: "made up", ms: 1, source: "router" as const },
    ]) {
      const s = sup(async () => verdict);
      const { engine, store, events, firstApproval } = build({ router: [codex()], planner: null, supervisor: s });
      const t = engine.submit({ task: `x ${question()}`, cwd: "/tmp/q2" });
      const id = await firstApproval(t.id);
      expect(store.getApproval(id)).toMatchObject({ kind: "question", action: "Which port?" });
      expect(events.find((e) => e.taskId === t.id && e.type === "supervisor")?.payload).toMatchObject({ kind: "question", answered: false });
      engine.answer(id, { text: "8400" });
      await engine.idle();
      expect(store.getTask(t.id)).toMatchObject({ status: "done", result: "answer: 8400" });
    }
  });

  it("manual approval policy: straight to the user, the supervisor is not asked", async () => {
    const s = sup(async () => ({ answers: { q1: ["8600"] }, forward: false, reason: "", ms: 1, source: "router" }));
    const { engine, store, firstApproval } = build({ router: [codex()], planner: null, supervisor: s });
    const t = engine.submit({ task: `x ${question()}`, cwd: "/tmp/q3", approval: { mode: "manual", human: [] } });
    const id = await firstApproval(t.id);
    expect(s.asked).toEqual([]);
    engine.answer(id, { text: "8400" });
    await engine.idle();
    expect(store.getTask(t.id)!.status).toBe("done");
  });

  it("answersUseKnownTokens: known tokens pass (damaged copies repaired), unknown ones reject the whole answer", () => {
    const set = new Set([known]);
    expect(answersUseKnownTokens({ a: ["plain"], b: [`token ${known}`] }, set)).toEqual({ a: ["plain"], b: [`token ${known}`] });
    expect(answersUseKnownTokens({ a: [known.slice(0, -1)] }, set)).toEqual({ a: [known] });
    expect(answersUseKnownTokens({ a: [`enc:v1:${"C".repeat(30)}`] }, set)).toBeNull();
  });
});

describe("stepsNote", () => {
  it("is empty without dispatch/ask steps and otherwise lists them as context, not approval", () => {
    expect(stepsNote([])).toBe("");
    expect(stepsNote([{ kind: "note", text: "n" }])).toBe("");
    expect(stepsNote([{ kind: "ask_user", question: "q", answer: "a" }])).toContain('1. ask_user: "q" → "a"');
    expect(stepsNote([{ kind: "ask_user", question: "q", answer: null }])).toContain("nothing here is an approval");
  });
});
