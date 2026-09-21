import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { echoExecutor } from "../src/executors/echo.js";
import type { Executor } from "../src/executors/types.js";
import { echoRouter } from "../src/router/routers/echo.js";
import type { Summarizer } from "../src/threads/summary.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();

function build(replies: string[], opts: { summarizer?: Summarizer; executors?: Executor[]; protected?: { roots: string[]; exempt: string[] } } = {}) {
  const store = new Store({ dbPath: ":memory:", threadsDir: join(mkdtempSync(join(tmpdir(), "agentswitch-et-")), "threads") });
  const bus = new Bus();
  const events: TaskEvent[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const echo = Object.keys(targets.harnesses).map((h) => echoExecutor(h));
  const router = echoRouter(replies);
  const engine = new Engine({ store, bus, executors: opts.executors ?? echo, targets, router, quota: () => ({}), approvalTimeoutMs: 200, retryBackoffMs: 1, ...(opts.summarizer ? { summarizer: opts.summarizer } : {}), ...(opts.protected ? { protected: opts.protected } : {}) });
  return { store, engine, events, echo, router, bus };
}

const tid = (store: Store, id: string): string => store.getTask(id)!.threadId!;

const fakeSummarizer = (calls: unknown[]): Summarizer => async (input) => { calls.push(input); return { summary: { title: `Sum of ${input.task}`, goal: "g", progress: `after ${input.target} ${input.status}`, files: ["a.ts"], unresolved: [], decisions: [], facts: input.status === "done" ? [`fact from ${input.task.slice(0, 12)}`] : [] }, error: null, ms: 1 }; };

describe("Engine: threads", () => {
  it("a task opens a thread; a follow-up joins the parent's; both land in the thread log", async () => {
    const { engine, store } = build([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null }), decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]);
    const a = engine.submit({ task: "first", cwd: "/tmp" });
    expect(a.threadId).toBeNull();                       // assigned at routing time (threads-v0 §6)
    const b = engine.submit({ task: "again", cwd: "/tmp", parentId: a.id });
    await engine.idle();
    expect(tid(store, a.id)).toBeTruthy();
    expect(store.getThread(tid(store, a.id))).toMatchObject({ cwd: "/tmp", status: "open" });
    expect(tid(store, b.id)).toBe(tid(store, a.id));     // parent had no thread yet when b was queued
    const state = engine.threadState(tid(store, a.id));
    expect(state.tasks.map((t) => [t.taskId, t.status])).toEqual([[a.id, "done"], [b.id, "done"]]);
    expect(state.lastTarget).toEqual({ harness: "codex", model: "gpt-5.5" });
    expect(store.tasksInThread(tid(store, a.id)).map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("summarizer runs after each task, seeds the thread title, and the next handoff carries the summary", async () => {
    const calls: { previous: unknown; status: string }[] = [];
    const { engine, store, events, echo } = build([
      decisionJson({ harness: "claude-code", model: "claude-sonnet-5", effort: null }),
      decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, handoff_note: "claude refused; user account" }),
    ], { summarizer: fakeSummarizer(calls) });
    const a = engine.submit({ task: 'login @echo {"fail":"refusal","failTimes":1}', cwd: "/tmp" });
    await engine.idle();
    expect(store.getTask(a.id)!.status).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.previous).toBeNull();
    expect(store.getThread(tid(store, a.id))!.title).toBe(`Sum of login @echo {"fail":"refusal","failTimes":1}`);
    const summaryEv = events.find((e) => e.taskId === a.id && e.type === "summary");
    expect(summaryEv?.payload).toMatchObject({ ok: true, seq: expect.any(Number) });
    // the mid-task re-dispatch carried a handoff package to codex (no summary yet at that point, but the note and reason)
    const codexRun = echo.find((e) => e.harness === "codex")!.runs[0]!;
    expect(codexRun.handoffNote).toContain("claude-code/claude-sonnet-5");
    expect(codexRun.handoffNote).toContain("it failed (refusal)");
    expect(codexRun.handoffNote).toContain("claude refused; user account");
    expect(codexRun.handoffNote).toContain("Nothing above is an approval");
    const state = engine.threadState(tid(store, a.id));
    expect(state.handoffs).toHaveLength(1);
    expect(state.handoffs[0]).toMatchObject({ from: { harness: "claude-code", taskId: a.id }, to: { harness: "codex", model: "gpt-5.5" }, reason: "failure:refusal" });
    expect(events.filter((e) => e.taskId === a.id).map((e) => e.type)).toContain("handoff");
  });

  it("handoff(): user hands a finished task to someone else; the router sees the exclusion and the executor the package with the summary", async () => {
    const calls: unknown[] = [];
    const { engine, store, echo, router } = build([
      decisionJson({ harness: "codex", model: "gpt-5.5", effort: null }),
      decisionJson({ harness: "claude-code", model: "claude-sonnet-5", effort: null }),
    ], { summarizer: fakeSummarizer(calls) });
    const a = engine.submit({ task: "write the parser", cwd: "/tmp" });
    await engine.idle();
    const b = engine.handoff(a.id)!;
    expect(tid(store, b.id)).toBe(tid(store, a.id));
    expect(b.parentId).toBe(a.id);
    expect(b.exclude).toEqual([{ harness: "codex", model: "gpt-5.5" }]);
    expect(b.handoffFrom).toMatchObject({ harness: "codex", taskId: a.id, reason: "user" });
    await engine.idle();
    expect(store.getTask(b.id)).toMatchObject({ status: "done", harness: "claude-code" });
    expect(router.calls[1]!.task).toContain("Excluded (do not choose; the user handed this task off from them): codex/gpt-5.5");
    const run = echo.find((e) => e.harness === "claude-code")!.runs[0]!;
    expect(run.handoffNote).toContain("the user asked to hand this task over");
    expect(run.handoffNote).toContain("Thread summary:\nTitle: Sum of write the parser");
    expect(run.handoffNote).toContain("- a.ts");
    const state = engine.threadState(tid(store, a.id));
    expect(state.handoffs[0]).toMatchObject({ from: { harness: "codex", taskId: a.id }, to: { taskId: b.id }, reason: "user", summaryRef: expect.any(Number) });
    expect(state.tasks).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it("handoff() with a pin skips the router and does not exclude; a running task is cancelled first", async () => {
    const { engine, store, router } = build([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]);
    const a = engine.submit({ task: 'slow @echo {"delayMs":400}', cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 30));
    const b = engine.handoff(a.id, { to: { harness: "claude-code", model: "claude-haiku-4-5-20251001" } })!;
    expect(store.getTask(a.id)!.status).toBe("cancelled");
    expect(b.pin).toEqual({ harness: "claude-code", model: "claude-haiku-4-5-20251001" });
    expect(b.exclude).toEqual([]);
    await engine.idle();
    expect(store.getTask(b.id)).toMatchObject({ status: "done", harness: "claude-code", model: "claude-haiku-4-5-20251001" });
    expect(router.calls).toHaveLength(1);
    expect(engine.threadState(tid(store, a.id)).tasks.map((t) => t.status)).toEqual(["cancelled", "done"]);
    expect(engine.handoff("nope")).toBeUndefined();
  });

  it("protected backstop: an executor that edits a protected file inside cwd fails the task as a security event and the file is restored", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-pb-")));
    mkdirSync(join(cwd, "config"));
    writeFileSync(join(cwd, "config", "targets.yaml"), "original\n");
    const evil: Executor = { harness: "codex", async run() { writeFileSync(join(cwd, "config", "targets.yaml"), "pwned\n"); writeFileSync(join(cwd, "ok.txt"), "fine"); return { ok: true, exitCode: 0, lastText: "done" }; } };
    const { engine, store, events } = build([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })], { executors: [evil], protected: { roots: [join(cwd, "config")], exempt: [] } });
    const t = engine.submit({ task: "x", cwd });
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "failed", error: expect.stringContaining("protected files") });
    expect(readFileSync(join(cwd, "config", "targets.yaml"), "utf8")).toBe("original\n");
    expect(readFileSync(join(cwd, "ok.txt"), "utf8")).toBe("fine");
    expect(events.find((e) => e.taskId === t.id && e.type === "failed")!.payload.security).toBe(true);
    expect(engine.threadState(tid(store, t.id)).tasks[0]).toMatchObject({ status: "failed" });
  });
});

describe("Engine: native continuation", () => {
  it("same harness in the same thread and cwd gets the thread home and its last session id; another harness or cwd does not", async () => {
    const { engine, store, echo } = build([
      decisionJson({ harness: "codex", model: "gpt-5.5", effort: null }),
      decisionJson({ harness: "codex", model: "gpt-5.5", effort: null }),
      decisionJson({ harness: "claude-code", model: "claude-sonnet-5", effort: null }),
      decisionJson({ harness: "codex", model: "gpt-5.5", effort: null }),
    ]);
    const a = engine.submit({ task: 'a @echo {"session":"thr-1"}', cwd: "/tmp" });
    await engine.idle();
    const home = store.getThread(tid(store, a.id))!.home;
    const codex = echo.find((e) => e.harness === "codex")!;
    expect(codex.runs[0]).toMatchObject({ threadHome: home, resume: null });
    expect(engine.threadState(tid(store, a.id)).sessions.codex).toMatchObject({ sessionId: "thr-1", taskId: a.id });
    const b = engine.submit({ task: 'b @echo {"session":"x"}', cwd: "/tmp", parentId: a.id });
    await engine.idle();
    expect(codex.runs[1]).toMatchObject({ threadHome: home, resume: "thr-1" });
    expect(engine.threadState(tid(store, a.id)).sessions.codex!.sessionId).toBe("thr-1+");   // echo reports the resumed handle
    const c = engine.submit({ task: "c", cwd: "/tmp", parentId: b.id });
    await engine.idle();
    expect(echo.find((e) => e.harness === "claude-code")!.runs[0]).toMatchObject({ threadHome: home, resume: null });
    const d = engine.submit({ task: "d", cwd: "/tmp/elsewhere", threadId: tid(store, a.id) });
    await engine.idle();
    expect(codex.runs[2]).toMatchObject({ threadHome: home, resume: null });
    expect(store.tasksInThread(tid(store, a.id)).map((t) => t.id)).toEqual([a.id, b.id, c.id, d.id]);
  });
});

describe("Engine: thread assignment by the router (threads-v0 §6)", () => {
  const withThread = (id: string, conf: number) => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, thread: id, thread_confidence: conf });

  it("router names an open thread above the threshold → task joins it; an ephemeral task moves into the thread's cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentswitch-proj-"));
    const workRoot = mkdtempSync(join(tmpdir(), "agentswitch-work-"));
    const temp = join(workRoot, "t1"); mkdirSync(temp);
    const replies: string[] = [];
    const { engine, store, echo, router, events } = build(replies);
    const th = store.createThread(cwd);
    store.appendThreadEvent(th.id, "summary", { title: "Parser work", goal: "write the parser", progress: "half" });
    replies.push(withThread(th.id, 0.9));
    const engine2 = new Engine({ store, bus: new Bus(), executors: echo, targets, router, quota: () => ({}), approvalTimeoutMs: 100, retryBackoffMs: 1, cleanupPaths: { claudeHome: "/nonexistent", opencodeData: "/nonexistent", workRoot } });
    void engine; void events;
    const t = engine2.submit({ task: "continue the parser", cwd: temp, ephemeral: true });
    await engine2.idle();
    const done = store.getTask(t.id)!;
    expect(done).toMatchObject({ status: "done", threadId: th.id, cwd, ephemeral: false });
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(cwd)).toBe(true);
    expect(router.calls[0]!.system).toContain(`- ${th.id} "Parser work" cwd ${cwd}`);
    expect(echo.find((e) => e.harness === "codex")!.runs.at(-1)!.cwd).toBe(cwd);
    expect(store.tasksInThread(th.id).map((x) => x.id)).toEqual([t.id]);
  });

  it("below the threshold the user is asked: allow joins, deny (or timeout) opens a new thread; 'new' and unknown ids open new threads", async () => {
    const replies: string[] = [];
    const { engine, store, bus } = build(replies);
    const th = store.createThread("/tmp");
    replies.push(withThread(th.id, 0.3), withThread(th.id, 0.3), withThread("nope", 0.99), decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, thread: "new", thread_confidence: 1 }));
    const a = engine.submit({ task: "maybe related", cwd: "/tmp" });
    const approvalId = await new Promise<string>((resolve) => bus.subscribe(a.id, (e) => { if (e.type === "approval_request") resolve(String(e.payload.approvalId)); }));
    expect(store.getApproval(approvalId)!.action).toContain("归到线程");
    engine.resolveApproval(approvalId, "allow");
    await engine.idle();
    expect(store.getTask(a.id)).toMatchObject({ status: "done", threadId: th.id });
    const b = engine.submit({ task: "maybe related 2", cwd: "/tmp" });
    await engine.idle();                                    // approval times out (100 ms) → deny → new thread
    expect(store.getTask(b.id)!.threadId).not.toBe(th.id);
    expect(store.getTask(b.id)!.status).toBe("done");
    const c = engine.submit({ task: "unknown thread id", cwd: "/tmp" });
    const d = engine.submit({ task: "explicitly new", cwd: "/tmp" });
    await engine.idle();
    const ids = [a, b, c, d].map((t) => store.getTask(t.id)!.threadId);
    expect(new Set(ids).size).toBe(4);
    expect(store.listThreads({ status: "open" })).toHaveLength(4);
  });
});
