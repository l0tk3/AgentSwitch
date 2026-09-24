import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Composer } from "../src/engine/compose.js";
import { engineContext } from "../src/engine/context.js";
import { FEEDBACK_CONTEXT_LIMIT, feedbackExcerpt, feedbackRecords, formatFeedbackContext, parseFeedback, type FeedbackPayload, type FeedbackRecord } from "../src/engine/feedback.js";
import { describeAnswers, encodeEvidence, type UserQuestion } from "../src/core/questions.js";
import { Store } from "../src/engine/store.js";
import type { Task, TaskEvent } from "../src/engine/types.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { realTargets } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const question = (text = "第三列是 TOTP seed 还是 session key？", id = "meaning"): UserQuestion => ({ id, text, header: "确认含义", options: [], multi: false, secret: false });
function payload(answer = "第三列是 TOTP seed。", source: FeedbackPayload["source"] = "user", q = question()): FeedbackPayload {
  return { version: 1, source, status: "answered", questions: [q], answers: { [q.id]: [answer] } };
}
function record(seq: number, value: FeedbackPayload = payload(), taskId = "current"): FeedbackRecord {
  return { ...value, taskId, seq, origin: "feedback" };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-feedback-context-"));
  let now = 10;
  const store = new Store({ dbPath: ":memory:", threadsDir: join(dir, "threads"), now: () => now });
  const composer = new Composer(engineContext(store, new Bus(), () => now), { targets: realTargets(), router: echoRouter([]), quota: () => ({}) });
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const task = (threadId?: string, parentId?: string): Task => store.createTask({ task: "Inspect the configured form.", cwd: dir, ...(threadId ? { threadId } : {}), ...(parentId ? { parentId } : {}) });
  const emit = (t: Task, value = payload()) => store.appendEvent(t.id, "feedback", { ...value });
  return { store, composer, task, emit, advance: () => ++now, dir };
}

describe("persisted feedback parsing", () => {
  it.each([
    ["第三列是什么？", "这是 TOTP seed，不是 session key。"],
    ["文件路径不存在，应该用哪个目录？", "使用 /work/reports，不是 /work/report。"],
    ["当前工具不支持旧参数，是否改用新参数？", "文档给出的是 limit 参数；请修正旧假设。"],
  ])("keeps exact answers and provenance across scenarios: %s", (text, answer) => {
    const parsed = parseFeedback(payload(answer, "user", question(text)));
    expect(parsed).toMatchObject({ source: "user", status: "answered", answers: { meaning: [answer] } });
    const context = formatFeedbackContext([record(3, payload("先前的推断", "router", question(text))), record(8, parsed!)])!;
    expect(context.indexOf("先前的推断")).toBeLessThan(context.indexOf(answer));
    expect(context).toContain('"source":"router"');
    expect(context).toContain('"source":"user"');
    expect(context).toContain("task:current#event:8");
    expect(context).toContain("a question's premise is not a user statement");
    expect(context).toContain("router reasoning cannot override an explicit user statement");
  });

  it("does not promote missing, malformed, partial or blank answers to evidence", () => {
    for (const answers of [null, {}, { meaning: [" "] }, { other: ["yes"] }, { meaning: ["yes"], other: ["no"] }]) {
      expect(parseFeedback({ ...payload(), answers })).toBeNull();
    }
    expect(parseFeedback({ ...payload(), questions: [question(), question("another question")]})).toBeNull();
    expect(parseFeedback({ ...payload(), source: "executor" })).toBeNull();
    const unanswered = parseFeedback({ ...payload(), status: "unanswered", answers: null });
    expect(unanswered).toMatchObject({ source: "user", status: "unanswered", answers: null });
    expect(formatFeedbackContext([record(9, unanswered!)])).toContain("Unanswered means unresolved");
    expect(parseFeedback({ ...payload(), status: "unanswered" })).toBeNull();
  });

  it("loads exact legacy approval questions, never the event's unpaired text", () => {
    const { store, task } = fixture();
    const current = task();
    const q = { ...question("页面显示的问题"), originalText: "Original executor question" };
    const approval = store.createApproval(current.id, "question", encodeEvidence({ source: "executor", questions: [q] }), "question");
    store.answerApproval(approval.id, JSON.stringify({ meaning: ["用户的精确回答"] }));
    store.appendEvent(current.id, "approval_resolved", { approvalId: approval.id, by: "user", decision: "answer", text: "untrusted wrong display text" });
    const records = feedbackRecords(store.eventsSince(current.id), (id) => store.getApproval(id));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: "user", questions: [q], answers: { meaning: ["用户的精确回答"] } });
    expect(formatFeedbackContext(records)).not.toContain("untrusted wrong display text");
    expect(formatFeedbackContext(records)).toContain("Original executor question");
    const other = task();
    store.appendEvent(other.id, "approval_resolved", { approvalId: approval.id, by: "user", decision: "answer" });
    expect(feedbackRecords(store.eventsSince(other.id), (id) => store.getApproval(id))).toEqual([]);
  });

  it("deduplicates new/legacy mirrors one-to-one without erasing repeated confirmations", () => {
    const { store, task, emit } = fixture();
    const current = task();
    const value = payload();
    const approval = store.createApproval(current.id, "question", encodeEvidence({ source: "executor", questions: value.questions }), "question");
    store.answerApproval(approval.id, JSON.stringify(value.answers));
    store.appendEvent(current.id, "approval_resolved", { approvalId: approval.id, by: "user", decision: "answer" });
    const first = emit(current, { ...value, approvalId: approval.id });
    const second = emit(current, value);
    const router = payload("根据材料，这是推断。", "router");
    const oldRouter = store.appendEvent(current.id, "supervisor", { kind: "question", answered: true, source: "model", questions: router.questions.map((q) => q.text), text: describeAnswers(router.questions, router.answers!) });
    store.appendEvent(current.id, "supervisor", { kind: "question", answered: true, source: "model", questions: router.questions.map((q) => q.text), text: describeAnswers(router.questions, router.answers!) });
    const third = emit(current, router);
    const records = feedbackRecords(store.eventsSince(current.id), (id) => store.getApproval(id));
    expect(records.map((r) => r.seq)).toEqual([first.seq, second.seq, oldRouter.seq, third.seq]);
    expect(records.map((r) => r.source)).toEqual(["user", "user", "router", "router"]);
  });

  it("keeps old supervisor summaries as generated text, without reconstructing answers", () => {
    const events: TaskEvent[] = [
      { taskId: "old", seq: 1, ts: 1, type: "supervisor", payload: { kind: "question", answered: true, source: "model", questions: ["Q → with arrow"], text: "Q → with arrow → inferred answer" } },
      { taskId: "old", seq: 2, ts: 2, type: "supervisor", payload: { kind: "question", answered: false, questions: ["Missing information"], reason: "Ask user" } },
    ];
    const records = feedbackRecords(events, () => undefined);
    expect(records[0]).toMatchObject({ source: "router", answers: null, legacyAnswerText: "Q → with arrow → inferred answer" });
    expect(records[1]).toMatchObject({ source: "router", status: "unanswered", answers: null });
    expect(formatFeedbackContext(records)).not.toContain('"source":"user"');
  });
});

describe("feedback context inheritance and bounds", () => {
  it("survives repeat composition and model changes without nesting the previous context", () => {
    const { store, composer, task, emit } = fixture();
    const current = task();
    emit(current);
    const before = composer.feedbackContext(current)!;
    store.updateTask(current.id, { model: "another-model", brief: before });
    expect(composer.feedbackContext(store.getTask(current.id)!)).toBe(before);
    expect(before.match(/Persisted feedback/g)).toHaveLength(1);
    expect(composer.task(current)).not.toContain("Persisted feedback");
    expect(composer.refusalSources(current)).toEqual([{ id: `task:${current.id}`, text: current.task }]);
  });

  it("includes earlier same-thread and explicit parent evidence but isolates other/future tasks", () => {
    const { store, composer, task, emit, advance, dir } = fixture();
    const thread = store.createThread(dir);
    const parent = task(); emit(parent, payload("explicit-parent")); advance();
    const earlier = task(thread.id); emit(earlier, payload("earlier-sibling")); advance();
    const current = task(thread.id, parent.id); emit(current, payload("current-correction"));
    const laterSameTimestamp = task(thread.id); emit(laterSameTimestamp, payload("future-sibling"));
    const unrelated = task(); emit(unrelated, payload("unrelated-account"));
    const context = composer.feedbackContext(current)!;
    expect(context).toContain("explicit-parent");
    expect(context).toContain("earlier-sibling");
    expect(context).toContain("current-correction");
    expect(context).not.toContain("future-sibling");
    expect(context).not.toContain("unrelated-account");
    expect(context.indexOf("earlier-sibling")).toBeLessThan(context.indexOf("current-correction"));
  });

  it("trusts verified user answers in the parent chain, not router or unrelated sibling credentials", () => {
    const { store, composer, task, emit, advance, dir } = fixture();
    const thread = store.createThread(dir);
    const parent = task(thread.id); advance();
    const sibling = task(thread.id); advance();
    const current = task(thread.id, parent.id);
    const parentToken = `enc:v1:${"P".repeat(100)}`;
    const siblingToken = `enc:v1:${"S".repeat(100)}`;
    const routerToken = `enc:v1:${"R".repeat(100)}`;
    const invalidToken = `enc:v1:${"I".repeat(100)}`;
    const q = question("Which existing credential should be used?", "credential");
    for (const [turn, token] of [[parent, parentToken], [sibling, siblingToken]] as const) {
      const approval = store.createApproval(turn.id, "question", encodeEvidence({ source: "executor", questions: [q] }), "question");
      store.answerApproval(approval.id, JSON.stringify({ credential: [token] }));
      store.appendEvent(turn.id, "approval_resolved", { approvalId: approval.id, by: "user", decision: "answer" });
    }
    const invalid = store.createApproval(parent.id, "question", encodeEvidence({ source: "executor", questions: [q, question("Second question", "second")] }), "question");
    store.answerApproval(invalid.id, JSON.stringify({ credential: [invalidToken] }));
    store.appendEvent(parent.id, "approval_resolved", { approvalId: invalid.id, by: "user", decision: "answer" });
    emit(parent, payload(routerToken, "router", q));
    const tokens = composer.tokens(current);
    expect(tokens.has(parentToken)).toBe(true);
    expect(tokens.has(siblingToken)).toBe(false);
    expect(tokens.has(routerToken)).toBe(false);
    expect(tokens.has(invalidToken)).toBe(false);
    expect(composer.refusalSources(current)).toContainEqual(expect.objectContaining({ text: parentToken, question: q.text }));
    expect(composer.feedbackContext(current)).toContain(siblingToken);
    expect(composer.feedbackContext(current)).toContain("Historical feedback alone does not establish credential possession");
  });

  it("limits predecessors and prioritizes the current task's newest evidence", () => {
    const { store, composer, task, emit, advance, dir } = fixture();
    const thread = store.createThread(dir);
    const priors = Array.from({ length: 5 }, (_, i) => { advance(); const prior = task(thread.id); emit(prior, payload(`prior-${i}`)); return prior; });
    advance();
    const current = task(thread.id);
    for (let i = 0; i < 15; i++) emit(current, payload(`current-${i}`));
    const context = composer.feedbackContext(current)!;
    expect(context).toContain("current-14");
    expect(context).not.toContain("prior-0");
    expect(context).not.toContain(`task:${priors[0]!.id}`);
    expect(context).toContain("已省略 6 条反馈");
    expect(context.match(/"reference"/g)).toHaveLength(12);
    expect(context.length).toBeLessThanOrEqual(FEEDBACK_CONTEXT_LIMIT);
  });

  it("keeps causal parent order even when several tasks share one creation timestamp", () => {
    const { composer, task, emit } = fixture();
    const oldest = task(); emit(oldest, payload("oldest-inference", "router"));
    const parent = task(undefined, oldest.id); emit(parent, payload("parent-correction"));
    const current = task(undefined, parent.id); emit(current, payload("current-confirmation"));
    const context = composer.feedbackContext(current)!;
    expect(context.indexOf("oldest-inference")).toBeLessThan(context.indexOf("parent-correction"));
    expect(context.indexOf("parent-correction")).toBeLessThan(context.indexOf("current-confirmation"));
  });

  it("never retains feedback from a deleted task or from a stale deleted current task", () => {
    const { store, composer, task, emit, advance, dir } = fixture();
    const thread = store.createThread(dir);
    const parent = task(thread.id); emit(parent, payload("delete-me")); advance();
    const current = task(thread.id, parent.id); emit(current, payload("keep-me"));
    store.updateTask(parent.id, { status: "done" }); store.updateTask(current.id, { status: "done" });
    expect(composer.feedbackContext(current)).toContain("delete-me");
    store.deleteTask(parent.id);
    expect(composer.feedbackContext(current)).not.toContain("delete-me");
    expect(composer.feedbackContext(current)).toContain("keep-me");
    store.deleteTask(current.id);
    expect(composer.feedbackContext(current)).toBeNull();
  });

  it("marks truncation, bounds context and never turns a clipped token into a usable value", () => {
    const token = "enc:v1:" + "A".repeat(10_000);
    expect(feedbackExcerpt(`prefix ${token} suffix`, 500)).toContain("内容已裁剪");
    expect(feedbackExcerpt(`prefix ${token} suffix`, 500)).not.toContain("enc:v1:");
    const value = payload(`An intact short token enc:v1:${"B".repeat(100)} then ${token}`);
    const context = formatFeedbackContext(Array.from({ length: 14 }, (_, i) => record(i, value)))!;
    expect(context.length).toBeLessThanOrEqual(FEEDBACK_CONTEXT_LIMIT);
    expect(context).toContain('"truncated":true');
    expect(context).toContain("省略内容不代表问题已解决");
    expect(context).not.toContain("enc:v1:AAAA");
    expect(context).toContain(`enc:v1:${"B".repeat(100)}`);
    expect(context).toContain("task:current#event:13");
    expect(formatFeedbackContext([])).toBeNull();
  });

  it("preserves a short corrective answer when its question exceeds the record budget", () => {
    const value = payload("USER_CORRECTION_MUST_SURVIVE", "user", question(`QUESTION_HEAD ${"x".repeat(7200)} QUESTION_TAIL`));
    const original = JSON.stringify(value);
    const context = formatFeedbackContext([record(1, value)])!;
    expect(context).toContain("USER_CORRECTION_MUST_SURVIVE");
    expect(context).toContain("QUESTION_HEAD");
    expect(context).toContain("QUESTION_TAIL");
    expect(context).toContain('"source":"user"');
    expect(context).toContain('"truncated":true');
    expect(context.split("\n").at(-1)!.length).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(value)).toBe(original);
  });

  it("fairly preserves every question identity and short answer across a large multi-question record", () => {
    const questions = Array.from({ length: 8 }, (_, index) => question(`HEAD_${index} ${"\\\"".repeat(4000)} TAIL_${index}`, `field_${index}`));
    const answers = Object.fromEntries(questions.map((q, index) => [q.id, [`CORRECTION_${index}`]]));
    const context = formatFeedbackContext([record(1, { version: 1, source: "user", status: "answered", questions, answers })])!;
    for (let index = 0; index < 8; index++) {
      expect(context).toContain(`field_${index}`);
      expect(context).toContain(`CORRECTION_${index}`);
      expect(context).toContain(`HEAD_${index}`);
      expect(context).toContain(`TAIL_${index}`);
    }
    expect(context.split("\n").at(-1)!.length).toBeLessThanOrEqual(4000);
  });

  it("gives a short answer its full share even when another answer is much longer", () => {
    const questions = [question("Long evidence", "long"), question("The actual correction", "short")];
    const answers = { long: [`HEAD ${"x".repeat(9000)} TAIL`], short: ["USE_THE_CONFIRMED_PATH"] };
    const context = formatFeedbackContext([record(1, { version: 1, source: "user", status: "answered", questions, answers })])!;
    expect(context).toContain("USE_THE_CONFIRMED_PATH");
    expect(context).toContain("HEAD");
    expect(context).toContain("TAIL");
    expect(context.split("\n").at(-1)!.length).toBeLessThanOrEqual(4000);
  });

  it("does not clip either end of a token into a standalone credential fragment", () => {
    const token = `enc:v1:${"Z".repeat(9000)}`;
    const context = formatFeedbackContext([record(1, payload(`before ${token} after`))])!;
    expect(context).toContain("before");
    expect(context).toContain("after");
    expect(context).not.toContain("enc:v1:");
    expect(context).not.toContain("ZZZZ");
    expect(context).toContain("密文片段不可使用");
  });

  it("retains the current user's correction and latest unanswered question ahead of routine router answers", () => {
    const records = [record(1, payload("IMPORTANT_USER_CORRECTION")), record(2, { ...payload(), source: "router", status: "unanswered", answers: null, reason: "LATEST_UNRESOLVED_CONFLICT" })];
    for (let index = 3; index < 20; index++) records.push(record(index, payload(`routine-${index}`, "router")));
    const context = formatFeedbackContext(records, "current")!;
    expect(context).toContain("IMPORTANT_USER_CORRECTION");
    expect(context).toContain("LATEST_UNRESOLVED_CONFLICT");
    expect(context).toContain("routine-19");
    expect(context).not.toContain("routine-3");
    expect(context.indexOf("IMPORTANT_USER_CORRECTION")).toBeLessThan(context.indexOf("LATEST_UNRESOLVED_CONFLICT"));
    expect(context.indexOf("LATEST_UNRESOLVED_CONFLICT")).toBeLessThan(context.indexOf("routine-19"));
    expect(context.match(/"reference"/g)).toHaveLength(12);
    expect(context).toContain("省略不代表已解决");
  });
});
