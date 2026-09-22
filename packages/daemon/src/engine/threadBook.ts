/** Thread bookkeeping (threads-v0): which thread a task runs in, the state folded from the thread log, the
 *  handoff package that crosses a harness boundary, and the end-of-task record + summary + memory. */

import { existsSync, rmSync } from "node:fs";
import type { Decision } from "../router/decision.js";
import { kindOf } from "../router/route.js";
import type { TargetRef, Targets } from "../router/targets.js";
import { foldThread } from "../threads/fold.js";
import { buildHandoff, gitDiffSummary, renderHandoff } from "../threads/handoff.js";
import { appendMemory } from "../threads/memory.js";
import type { Summarizer } from "../threads/summary.js";
import type { HandoffReason, ThreadBrief, ThreadState } from "../threads/types.js";
import type { Attempt } from "../router/reroute.js";
import type { RoutingLog } from "../router/log.js";
import { defaultCleanupPaths, isDeletableWorkDir, type CleanupPaths } from "./cleanup.js";
import type { EngineContext } from "./context.js";
import type { HandoffFrom, Task } from "./types.js";

export type ThreadBookDeps = {
  readonly targets: Targets;
  readonly routingLog?: RoutingLog;
  readonly summarizer?: Summarizer;
  readonly memoryPath?: string;
  readonly cleanupPaths?: CleanupPaths;
};

export const THREAD_BRIEFS_LIMIT = 20;

export class ThreadBook {
  constructor(private readonly ctx: EngineContext, private readonly deps: ThreadBookDeps) {}

  state(threadId: string): ThreadState {
    return foldThread(this.ctx.store.threadEvents(threadId));
  }

  /** Open threads as the router sees them: newest first, title + one line of summary + last target. */
  briefs(limit = THREAD_BRIEFS_LIMIT): ThreadBrief[] {
    return this.ctx.store.listThreads({ status: "open", limit }).map((t) => {
      const st = this.state(t.id);
      return { id: t.id, title: t.title ?? st.title, cwd: t.cwd, goal: st.summary?.goal ?? "", progress: st.summary?.progress ?? "", lastTarget: st.lastTarget, lastActivity: st.lastActivity ?? t.updatedAt };
    });
  }

  /** Same harness in the same thread and the same cwd → resume its last session (threads-v0 §4). */
  continuation(task: Task, harness: string): { threadHome: string | null; resume: string | null } {
    const thread = task.threadId ? this.ctx.store.getThread(task.threadId) : undefined;
    if (!thread) return { threadHome: null, resume: null };
    const session = this.state(thread.id).sessions[harness];
    return { threadHome: thread.home, resume: session && thread.cwd === task.cwd ? session.sessionId : null };
  }

  /** threads-v0 §6: the parent's thread; else the router's pick above the threshold, the user's say below it, else a new
   *  thread. An ephemeral task that joins a thread moves into the thread's cwd (its empty temp dir is dropped). */
  async assign(task: Task, decision: Decision | null, askUser: (question: string, evidence: string) => Promise<"allow" | "deny">): Promise<Task> {
    if (task.threadId) return task;
    const parent = task.parentId ? this.ctx.store.getTask(task.parentId) : undefined;
    if (parent?.threadId) return this.place(task, parent.threadId, "parent", null, false);
    const wanted = decision?.thread && decision.thread !== "new" ? this.ctx.store.getThread(decision.thread) : undefined;
    const confidence = decision?.thread_confidence ?? 0;
    const candidate = wanted && wanted.status === "open" ? wanted : undefined;
    if (!candidate) return this.place(task, this.ctx.store.createThread(task.cwd).id, "new", decision?.thread_confidence ?? null, false);
    if (confidence >= this.deps.targets.router.thread_confidence) return this.place(task, candidate.id, "router", confidence, true);
    const answer = await askUser(`归到线程「${candidate.title ?? candidate.id}」？允许 = 归入并接着做，拒绝 = 新开线程`, `路由器置信度 ${confidence}；线程目录 ${candidate.cwd}`);
    return answer === "allow" ? this.place(task, candidate.id, "user", confidence, true) : this.place(task, this.ctx.store.createThread(task.cwd).id, "new", confidence, false);
  }

  private place(task: Task, threadId: string, source: "parent" | "router" | "user" | "new", confidence: number | null, joined: boolean): Task {
    const thread = this.ctx.store.getThread(threadId);
    const moves = joined && thread && task.ephemeral && !task.attachments.length && existsSync(thread.cwd) && thread.cwd !== task.cwd;
    if (moves && isDeletableWorkDir(task.cwd, this.deps.cleanupPaths ?? defaultCleanupPaths())) rmSync(task.cwd, { recursive: true, force: true });
    const updated = this.ctx.store.updateTask(task.id, { threadId, status: "routing", ...(moves && thread ? { cwd: thread.cwd, ephemeral: false } : {}) });
    this.ctx.emit(task.id, "thread", { threadId, source, confidence, cwd: updated.cwd });
    return updated;
  }

  /** The handoff text the next executor reads: thread summary + files + diff, plus the router's or user's note. */
  handoffText(task: Task, from: HandoffFrom, note: string | null): string {
    const summary = task.threadId ? this.state(task.threadId).summary : null;
    return renderHandoff(buildHandoff({ from, reason: from.reason, summary, note, cwd: task.cwd }));
  }

  /** Mid-task handoff (re-dispatch to another target): thread + task events, and the package for the next executor. */
  recordHandoff(task: Task, failed: Attempt, reason: HandoffReason, to: TargetRef, note: string | null): string {
    const from: HandoffFrom = { harness: failed.harness, model: failed.model, taskId: task.id, reason };
    if (task.threadId) {
      const st = this.state(task.threadId);
      this.ctx.store.appendThreadEvent(task.threadId, "handoff", { from: { harness: from.harness, model: from.model, taskId: task.id }, to: { ...to, taskId: task.id }, reason, summaryRef: st.summarySeq });
    }
    this.ctx.emit(task.id, "handoff", { from: { harness: from.harness, model: from.model }, to, reason, taskId: task.id });
    return this.handoffText(task, from, note);
  }

  /** The user handed the task over: thread event with the session handle, task event, and the record's negative signal. */
  recordUserHandoff(task: Task, from: HandoffFrom, to: TargetRef | undefined, nextTaskId: string): void {
    this.ctx.store.markUserHandoff(task.id);
    if (task.threadId) {
      const st = this.state(task.threadId);
      const session = st.sessions[from.harness];
      this.ctx.store.appendThreadEvent(task.threadId, "handoff", { from: { harness: from.harness, model: from.model, taskId: task.id, ...(session ? { sessionId: session.sessionId } : {}) }, to: { ...(to ?? {}), taskId: nextTaskId }, reason: "user", summaryRef: st.summarySeq });
    }
    this.ctx.emit(task.id, "handoff", { to: to ?? null, taskId: nextTaskId, reason: "user" });
  }

  /** End of every execution: the thread's task event, the track record, then the summary (never blocking on failure). */
  async finish(taskId: string): Promise<void> {
    const task = this.ctx.store.getTask(taskId);
    if (!task?.threadId) return;
    const failed = task.attempts.at(-1);
    const failureKind = task.status === "failed" ? failed?.kind ?? "unknown" : null;
    if (task.routeLogId !== null) this.deps.routingLog?.setOutcome(task.routeLogId, failureKind ? `${task.status}:${failureKind}` : task.status);
    const events = this.ctx.store.eventsSince(task.id);
    const tokens = events.filter((e) => e.type === "done").reduce((n, e) => n + Number(e.payload.tokens ?? 0), 0);
    this.ctx.store.appendThreadEvent(task.threadId, "task", { taskId: task.id, harness: task.harness, model: task.model, status: task.status, kind: failureKind, tokens });
    if (task.harness && task.model) {
      this.ctx.store.saveRecord({
        taskId: task.id, ts: this.ctx.now(), kind: kindOf(task.task, task.decision), harness: task.harness, model: task.model, status: task.status, failureKind,
        ms: Math.max(0, this.ctx.now() - task.createdAt), tokens,
        approvals: events.filter((e) => e.type === "approval_resolved" && e.payload.decision === "allow").length,
        handedOff: events.some((e) => e.type === "handoff"), pinned: task.pin !== null,
        userHandoff: events.some((e) => e.type === "handoff" && e.payload.reason === "user"), rating: task.rating,
      });
    }
    await this.summarize(task);
  }

  private async summarize(task: Task): Promise<void> {
    const summarizer = this.deps.summarizer;
    if (!summarizer || !task.threadId) return;
    const previous = this.state(task.threadId).summary;
    const r = await summarizer({ previous, task: task.task, brief: task.brief, target: `${task.harness ?? "?"}/${task.model ?? "?"}`, status: task.status, result: task.result ?? task.error ?? "", diff: gitDiffSummary(task.cwd), cwd: task.cwd });
    if (!r.summary) { this.ctx.emit(task.id, "summary", { ok: false, error: r.error, ms: r.ms }); return; }
    const ev = this.ctx.store.appendThreadEvent(task.threadId, "summary", { ...r.summary });
    if (!previous) this.ctx.store.updateThread(task.threadId, { title: r.summary.title });
    if (r.summary.spoken) this.ctx.store.updateTask(task.id, { spoken: r.summary.spoken });
    // Memory is about the user's environment: a throwaway chat in a temp dir has nothing worth keeping.
    const worthRemembering = !task.ephemeral || kindOf(task.task, task.decision) === "browser";
    const memory = this.deps.memoryPath && worthRemembering && r.summary.facts.length ? appendMemory(this.deps.memoryPath, r.summary.facts, { taskId: task.id, ts: this.ctx.now() }) : null;
    this.ctx.emit(task.id, "summary", { ok: true, seq: ev.seq, title: r.summary.title, spoken: r.summary.spoken, ms: r.ms, ...(memory ? { remembered: memory.added } : {}) });
  }
}
