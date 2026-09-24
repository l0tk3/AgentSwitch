/** Questions passed straight from an executor to the user (docs/supervisor-v0.md §1c), and the shared helpers. */
import { describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { answersFromText, clarifyQuestion, describeAnswers, encodeEvidence, NO_ANSWER_MESSAGE, parseEvidence, validateAnswers, type UserQuestion } from "../src/core/questions.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { claudeAnswers, claudeQuestions } from "../src/executors/claude.js";
import { codexAnswers, codexQuestions } from "../src/executors/codex.js";
import { echoExecutor } from "../src/executors/echo.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();
const codex = () => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null });

function build(timeoutMs = 200) {
  const store = new Store({ dbPath: ":memory:" });
  const bus = new Bus();
  const events: TaskEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const engine = new Engine({ store, bus, executors: [echoExecutor("codex")], targets, router: echoRouter([codex()]), quota: () => ({}), approvalTimeoutMs: timeoutMs, retryBackoffMs: 1 });
  const firstQuestion = (taskId: string) => new Promise<string>((resolve) => bus.subscribe(taskId, (e) => { if (e.type === "approval_request") resolve(String(e.payload.approvalId)); }));
  return { store, bus, engine, events, firstQuestion };
}

const q = (over: Partial<UserQuestion> = {}): UserQuestion => ({ id: "which", header: "Target", text: "Which system?", options: [{ label: "finance", description: "" }, { label: "mail", description: "" }], multi: false, secret: false, ...over });

describe("question helpers", () => {
  it("evidence round-trips and rejects anything that is not a question record", () => {
    const ev = { source: "executor" as const, questions: [q()] };
    expect(parseEvidence(encodeEvidence(ev))).toEqual(ev);
    expect(parseEvidence("requested by @echo directive")).toBeNull();
    expect(parseEvidence(JSON.stringify({ source: "nobody", questions: [] }))).toBeNull();
  });

  it("retains the original router question through evidence storage after translation", () => {
    const translated = "要检查哪个管理页面？";
    const original = "Which management page should be inspected?";
    const question = clarifyQuestion(translated, original);
    expect(question).toMatchObject({ header: "路由器", text: translated, originalText: original });
    const evidence = { source: "router" as const, questions: [question] };
    expect(parseEvidence(encodeEvidence(evidence))).toEqual(evidence);
    expect(clarifyQuestion(translated, translated)).not.toHaveProperty("originalText");
    expect(clarifyQuestion(translated)).not.toHaveProperty("originalText");
    expect(describeAnswers([question], { clarify: ["本地测试页面。"] })).toBe(`${translated} → 本地测试页面。`);
  });

  it("validateAnswers wants every question answered, nothing extra, non-empty strings", () => {
    expect(validateAnswers([q(), q({ id: "b", text: "B?" })], { which: ["finance"], b: ["x"] })).toEqual({ ok: true, answers: { which: ["finance"], b: ["x"] } });
    expect(validateAnswers([q(), q({ id: "b", text: "B?" })], { which: ["finance"] })).toMatchObject({ ok: false, error: "unanswered: b" });
    expect(validateAnswers([q()], { which: ["finance"], other: ["?"] })).toMatchObject({ ok: false, error: expect.stringContaining("unknown question ids: other") });
    expect(validateAnswers([q()], { which: [] })).toMatchObject({ ok: false });
    expect(validateAnswers([q()], { which: "finance" })).toMatchObject({ ok: false });
  });

  it("text answers the first question; clarify is one plain question; describe is one line per answer", () => {
    expect(answersFromText([clarifyQuestion("哪个？")], "这个")).toEqual({ clarify: ["这个"] });
    expect(describeAnswers([q(), q({ id: "b", text: "B?" })], { which: ["finance", "mail"], b: ["x"] })).toBe("Which system? → finance / mail\nB? → x");
  });
});

describe("harness mappings", () => {
  it("Claude: AskUserQuestion input ↔ answers keyed by question text, multi-select joined", () => {
    const input = { questions: [{ question: "Which one?", header: "Pick", options: [{ label: "a", description: "first" }, { label: "" }], multiSelect: true }, { question: "" }] };
    const qs = claudeQuestions(input);
    expect(qs).toEqual([{ id: "Which one?", header: "Pick", text: "Which one?", options: [{ label: "a", description: "first" }], multi: true, secret: false }]);
    expect(claudeAnswers(input, { "Which one?": ["a", "b"] })).toEqual({ ...input, answers: { "Which one?": "a, b" } });
    expect(claudeQuestions({})).toEqual([]);
  });

  it("Codex: request_user_input params ↔ {answers: {id: {answers}}}; no answer tells the model so", () => {
    const params = { itemId: "i", threadId: "t", turnId: "u", questions: [{ id: "q1", header: "H", question: "Token?", isSecret: true, options: null }, { id: "q2", header: "", question: "Which?", options: [{ label: "x", description: "d" }] }] };
    const qs = codexQuestions(params);
    expect(qs.map((x) => [x.id, x.secret, x.options.length])).toEqual([["q1", true, 0], ["q2", false, 1]]);
    expect(codexAnswers(qs, { q1: ["enc:v1:abc"], q2: ["x"] })).toEqual({ answers: { q1: { answers: ["enc:v1:abc"] }, q2: { answers: ["x"] } } });
    expect(codexAnswers(qs, null)).toEqual({ answers: { q1: { answers: [NO_ANSWER_MESSAGE] }, q2: { answers: [NO_ANSWER_MESSAGE] } } });
  });
});

describe("HTTP: POST /tasks/:id/answer", () => {
  it("takes text or an answers map, 400 on a bad shape, 404 for another task's question", async () => {
    const { engine, store, bus, firstQuestion } = build(10_000);
    const { createApp } = await import("../src/api/app.js");
    const app = createApp({ engine, store, bus, quota: { snapshot: async () => [], refresh: async () => [] } as never, targets, uploadsDir: "/tmp", policyPath: "/tmp/agentswitch-q-policy.json", extensions: { list: () => [] } as never } as never);
    const t = engine.submit({ task: 'x @echo {"question":{"id":"which","text":"Which?","options":["a","b"]}}', cwd: "/tmp" });
    const id = await firstQuestion(t.id);
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect((await post(`/tasks/${t.id}/answer`, { approval_id: id })).status).toBe(400);
    expect((await post(`/tasks/${t.id}/answer`, { approval_id: id, answers: { other: ["a"] } })).status).toBe(400);
    expect((await post(`/tasks/nope/answer`, { approval_id: id, text: "a" })).status).toBe(404);
    expect((await post(`/tasks/${t.id}/answer`, { approval_id: id, answers: { which: ["b"] } })).status).toBe(200);
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "done", result: "answer: b" });
  });
});

describe("Engine: an executor's question goes straight to the user", () => {
  it("the card carries the questions; the answer resumes the run and reaches the executor; the router is not asked again", async () => {
    const { engine, store, events, firstQuestion } = build(10_000);
    const t = engine.submit({ task: 'x @echo {"question":{"id":"which","text":"Which system?","options":["finance","mail"]}}', cwd: "/tmp" });
    const id = await firstQuestion(t.id);
    const a = store.getApproval(id)!;
    expect(a).toMatchObject({ kind: "question", action: "Which system?" });
    expect(parseEvidence(a.evidence)).toMatchObject({ source: "executor", questions: [{ id: "which", options: [{ label: "finance" }, { label: "mail" }] }] });
    expect(store.getTask(t.id)!.status).toBe("waiting_approval");
    expect(engine.answer(id, { answers: { which: ["mail"] } })).toEqual({ ok: true });
    expect(store.getTask(t.id)!.status).toBe("running");
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "done", result: "answer: mail" });
    expect(events.filter((e) => e.taskId === t.id && e.type === "routed")).toHaveLength(1);
    const resolved = events.find((e) => e.taskId === t.id && e.type === "approval_resolved")!;
    expect(resolved.payload).toMatchObject({ decision: "answer", source: "executor", text: "Which system? → mail", answers: { which: ["mail"] } });
  });

  it("plain text answers a one-question card; a wrong answer shape is rejected without consuming the question", async () => {
    const { engine, store, firstQuestion } = build(10_000);
    const t = engine.submit({ task: 'x @echo {"question":{"text":"Port?"}}', cwd: "/tmp" });
    const id = await firstQuestion(t.id);
    expect(engine.answer(id, { answers: { nope: ["1"] } })).toMatchObject({ ok: false, code: "bad_answer" });
    expect(engine.answer(id, {})).toMatchObject({ ok: false, code: "bad_answer" });
    expect(engine.answer(id, { text: "8600" })).toEqual({ ok: true });
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "done", result: "answer: 8600" });
    expect(engine.answer(id, { text: "again" })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("deny or timeout aborts the executor and preserves the unanswered question as blocked", async () => {
    const { engine, store, firstQuestion } = build(10_000);
    const t = engine.submit({ task: 'x @echo {"question":{"text":"Port?"}}', cwd: "/tmp" });
    const id = await firstQuestion(t.id);
    expect(engine.resolveApproval(id, "deny")).toBe(true);
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "blocked", error: expect.stringContaining("等待你的答复") });
    const { engine: e2, store: s2 } = build(30);
    const u = e2.submit({ task: 'x @echo {"question":{"text":"Port?"}}', cwd: "/tmp" });
    await e2.idle();
    expect(s2.getTask(u.id)).toMatchObject({ status: "blocked", error: expect.stringContaining("Port?") });
    expect(s2.pendingApprovals()).toEqual([]);
  });
});
