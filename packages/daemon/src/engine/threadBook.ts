/** Thread bookkeeping (threads-v0): which thread a task runs in, the state folded from the thread log, the
 *  handoff package that crosses a harness boundary, and the end-of-task record + summary + memory. */

import { existsSync, rmSync } from "node:fs";
import type { Decision } from "../router/decision.js";
import { kindOf } from "../router/route.js";
import type { Targets } from "../router/targets.js";
import type { TargetRef } from "../core/target.js";
import { foldThread } from "../threads/fold.js";
import { buildHandoff, gitDiffSummary, renderHandoff } from "../threads/handoff.js";
import { appendMemory } from "../threads/memory.js";
import type { Summarizer } from "../threads/summary.js";
import type { HandoffReason, ThreadState } from "../threads/types.js";
import type { ThreadBrief } from "../router/prompt.js";
import type { Attempt } from "../router/reroute.js";
import type { RoutingLog } from "../router/log.js";
import { defaultCleanupPaths, isDeletableWorkDir, type CleanupPaths } from "./cleanup.js";
import type { EngineContext } from "./context.js";
import type { HandoffFrom, Task } from "./types.js";
import { loadContext } from "../core/contextDoc.js";
import { platformCheckpoint, platformOrigins, rememberPlatformFacts, safePlatformText } from "../threads/platformMemory.js";

export type ThreadBookDeps = {
  readonly targets: Targets;
  readonly routingLog?: RoutingLog;
  readonly summarizer?: Summarizer;
  readonly memoryPath?: string;
  readonly platformMemoryPath?: string;
  readonly contextPath?: string;
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

  /** A provider's safety classifier flagged a run of this harness: its session (and the one it resumed) holds the
   *  flagged turn, so the thread forgets it and the next run of that harness starts a new session (router-v0 §6.2). */
  dropSession(threadId: string, harness: string, taskId: string): void {
    this.ctx.store.appendThreadEvent(threadId, "session", { harness, dropped: true, reason: "provider_safety", taskId });
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
    const answer = await askUser(`是否归入话题「${candidate.title ?? candidate.id}」？允许：归入并继续；拒绝：新建话题`, `调度模型置信度 ${confidence}；话题目录 ${candidate.cwd}`);
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
  async finish(taskId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
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
    // A queued cancellation may reach finish before acquiring the thread/cwd locks. It has no
    // execution to summarize, and must not overwrite the preceding task's still-pending summary.
    // Routing/planner-only failures remain in the task record and events above for follow-up.
    if (events.some((event) => event.type === "dispatched")) await this.summarize(task, signal);
  }

  private async summarize(task: Task, signal?: AbortSignal): Promise<void> {
    const summarizer = this.deps.summarizer;
    if (!summarizer || !task.threadId) return;
    if (signal?.aborted) return;
    const previous = this.state(task.threadId).summary;
    const evidence = this.ctx.store.eventsSince(task.id).map(platformCheckpoint).filter((point) => point !== null);
    const context = loadContext(this.deps.contextPath).text;
    const knownPlatformOrigins = platformOrigins(task.task, context);
    const r = await summarizer({ previous, task: task.task, brief: task.brief, target: `${task.harness ?? "?"}/${task.model ?? "?"}`, status: task.status, result: task.result ?? "", error: task.error, diff: gitDiffSummary(task.cwd), cwd: task.cwd, evidence, knownPlatformOrigins }, signal);
    if (signal?.aborted || !this.ctx.store.getTask(task.id) || !this.ctx.store.getThread(task.threadId)) return;
    if (!r.summary) { this.ctx.emit(task.id, "summary", { ok: false, error: r.error, ms: r.ms }); return; }
    const ev = this.ctx.store.appendThreadEvent(task.threadId, "summary", { ...r.summary });
    if (!previous) this.ctx.store.updateThread(task.threadId, { title: r.summary.title });
    // A newer summary of the task replaces its script, an empty one included (a stale script is never read).
    this.ctx.store.updateTask(task.id, { ...(r.summary.spoken ? { spoken: r.summary.spoken } : {}), speech: r.summary.speech || null });
    // Browser experience requires checkpoint evidence; it never goes into the unscoped legacy facts file.
    const browser = task.needsBrowser || task.decision?.needs_browser || kindOf(task.task, task.decision) === "browser";
    const facts = r.summary.facts.filter(safePlatformText);
    const memory = this.deps.memoryPath && !browser && !task.ephemeral && facts.length ? appendMemory(this.deps.memoryPath, facts, { taskId: task.id, ts: this.ctx.now() }) : null;
    const platform = this.deps.platformMemoryPath && r.summary.platformFacts?.length
      ? rememberPlatformFacts(this.deps.platformMemoryPath, r.summary.platformFacts, { taskId: task.id, task: task.task, context, checkpoints: evidence, now: this.ctx.now() }) : null;
    this.ctx.emit(task.id, "summary", { ok: true, seq: ev.seq, title: r.summary.title, spoken: r.summary.spoken, ...(r.summary.speech ? { speech: r.summary.speech } : {}), ms: r.ms, ...(memory ? { remembered: memory.added } : {}), ...(platform ? { platformRemembered: platform.added.map((entry) => entry.id), platformSkipped: platform.skipped.length } : {}) });
  }
}
