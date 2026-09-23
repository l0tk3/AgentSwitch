/** What the router and the executor are given for a task: the composed request (follow-up history, attachments),
 *  the brief with damaged tokens repaired, and the per-dispatch route dependencies (context, memory, records…). */

import { attachmentsNote } from "../files/notes.js";
import { knownTokens, repairTokens, shortToken } from "../executors/tokens.js";
import { loadContext, type LoadedContext } from "../router/context.js";
import type { ExtensionsSummary } from "../router/prompt.js";
import type { RouteDeps } from "../router/route.js";
import type { Router } from "../router/routers/types.js";
import type { RefusalSource } from "../router/refusal.js";
import type { Targets } from "../router/targets.js";
import type { Quota } from "../router/validate.js";
import { loadMemory } from "../threads/memory.js";
import { RECORD_WINDOW_MS } from "../threads/record.js";
import type { ThreadBrief } from "../threads/types.js";
import type { EngineContext } from "./context.js";
import type { Task } from "./types.js";
import { parseEvidence, validateAnswers } from "./questions.js";
import { platformExperience } from "./platformContext.js";
import { feedbackRecords, formatFeedbackContext } from "./feedback.js";

export const FOLLOW_UP_DEPTH = 5;
const RESULT_EXCERPT = 2000;

export type ComposeDeps = {
  readonly targets: Targets;
  readonly router: Router;
  readonly quota: () => Quota;
  readonly contextPath?: string;
  /** Static context for tests; `contextPath` wins when both are given. */
  readonly context?: LoadedContext;
  readonly memoryPath?: string;
  readonly platformMemoryPath?: string;
  readonly extensionsSummary?: () => ExtensionsSummary;
};

export class Composer {
  constructor(private readonly ctx: EngineContext, private readonly deps: ComposeDeps) {}

  /** CONTEXT.md as of now (re-read on every use so page edits take effect at once). */
  context(): LoadedContext | undefined {
    return this.deps.contextPath ? loadContext(this.deps.contextPath) : this.deps.context;
  }

  memory(): LoadedContext | undefined {
    return this.deps.memoryPath ? loadMemory(this.deps.memoryPath) : undefined;
  }

  platformExperience(task: Task): string | null {
    return platformExperience(this.deps.platformMemoryPath, this.task(task), this.context()?.text ?? "", this.ctx.now());
  }

  /** Re-read evidence on each dispatch: corrections survive a model change without becoming task text. */
  feedbackContext(task: Task): string | null {
    if (!this.ctx.store.getTask(task.id)) return null;
    const related = new Map<string, Task>();
    const ancestors: Task[] = [];
    const seen = new Set([task.id]);
    let parent = task.parentId ? this.ctx.store.getTask(task.parentId) : undefined;
    for (let depth = 0; parent && depth < FOLLOW_UP_DEPTH && !seen.has(parent.id); depth++) {
      seen.add(parent.id);
      if (parent.createdAt <= task.createdAt) ancestors.unshift(parent);
      parent = parent.parentId ? this.ctx.store.getTask(parent.parentId) : undefined;
    }
    for (const ancestor of ancestors) related.set(ancestor.id, ancestor);
    if (task.threadId) {
      const siblings = this.ctx.store.tasksInThread(task.threadId);
      const index = siblings.findIndex((item) => item.id === task.id);
      // Store order includes row insertion order: a later task with the same timestamp is still future.
      for (const prior of siblings.slice(0, Math.max(0, index))) related.set(prior.id, prior);
    }
    const predecessors = [...related.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-3);
    const records = [...predecessors, task].flatMap((item) => feedbackRecords(this.ctx.store.eventsSince(item.id), (id) => this.ctx.store.getApproval(id)));
    return formatFeedbackContext(records, task.id);
  }

  /** Persisted progress survives a summary timeout or a change of harness. It never grants permission. */
  checkpointContext(task: Task): string | null {
    const related = task.threadId ? this.ctx.store.tasksInThread(task.threadId).filter((t) => t.id !== task.id && t.createdAt <= task.createdAt).slice(-3)
      : task.parentId ? [this.ctx.store.getTask(task.parentId)].filter((t): t is Task => !!t) : [];
    const checkpoints = related.flatMap((prior) => this.ctx.store.eventsSince(prior.id).filter((e) => e.type === "checkpoint").slice(-5).map((e) => {
      const result = String(e.payload.result ?? "");
      return { taskId: prior.id, taskStatus: prior.status, seq: e.seq, purpose: e.payload.purpose, stepOk: e.payload.ok,
        result: result.length > 4000 ? `${result.slice(0, 2000)}\n[中间内容省略；可查来源任务]\n${result.slice(-2000)}` : result,
        sideEffects: e.payload.sideEffects, sideEffectsKnown: e.payload.sideEffectsKnown };
    })).slice(-6);
    return checkpoints.length ? `Recorded checkpoints from earlier executions of this job (observations, not authorization). Before retrying any create/submit/send action, inspect the current platform for its existing result. Do not repeat completed writes. An interrupted or unknown result requires read-only reconciliation first.\n${JSON.stringify(checkpoints)}` : null;
  }

  /** Follow-ups carry the conversation: parent chain (oldest first) as context, then the new message. */
  task(task: Task): string {
    const chain: Task[] = [];
    let cur = task.parentId ? this.ctx.store.getTask(task.parentId) : undefined;
    while (cur && chain.length < FOLLOW_UP_DEPTH) { chain.unshift(cur); cur = cur.parentId ? this.ctx.store.getTask(cur.parentId) : undefined; }
    if (!chain.length) return task.task + attachmentsNote(task.attachments);
    const history = chain.map((t) => `User: ${t.task}\nAssistant (${t.harness ?? "?"}/${t.model ?? "?"}, ${t.status}): ${(t.result ?? t.error ?? "(no result)").slice(0, RESULT_EXCERPT)}`).join("\n\n");
    return `This is a follow-up in an ongoing conversation. Earlier turns:\n\n${history}\n\nUser now says:\n${task.task}${attachmentsNote(task.attachments)}`;
  }

  /** The executor reads the router's brief (or the raw task) plus the attachment list, which the router may have dropped. */
  brief(task: Task): string {
    const base = task.brief ?? task.task;
    const note = attachmentsNote(task.attachments);
    return note && !base.includes(task.attachments[0]!.path) ? base + note : base;
  }

  /** Only user-supplied sources establish credential possession; generated memory never does. */
  tokens(task: Task): ReadonlySet<string> {
    return knownTokens(...this.refusalSources(task).map((source) => source.text));
  }

  /** Source statements only: never turn model output, summaries or inferred memory into user facts. */
  refusalSources(task: Task): RefusalSource[] {
    const sources: RefusalSource[] = [];
    const conversation: Task[] = [];
    let current: Task | undefined = task;
    const seen = new Set<string>();
    while (current && conversation.length <= FOLLOW_UP_DEPTH && !seen.has(current.id)) {
      sources.push({ id: `task:${current.id}`, text: current.task });
      conversation.push(current);
      seen.add(current.id);
      current = current.parentId ? this.ctx.store.getTask(current.parentId) : undefined;
    }
    const context = this.context()?.text;
    if (context?.trim()) sources.push({ id: "context", text: context });
    for (const turn of conversation) for (const event of this.ctx.store.eventsSince(turn.id)) {
      const p = event.payload;
      if (event.type !== "approval_resolved" || p.by !== "user" || p.decision !== "answer" || typeof p.approvalId !== "string") continue;
      const approval = this.ctx.store.getApproval(p.approvalId);
      if (approval?.taskId !== turn.id || approval.kind !== "question" || approval.status !== "allowed" || !approval.answer) continue;
      try {
        const answers: unknown = JSON.parse(approval.answer);
        const evidence = parseEvidence(approval.evidence);
        if (!evidence) continue;
        const checked = validateAnswers(evidence.questions, answers, true);
        if (!checked.ok || Object.values(checked.answers).some((values) => values.some((value) => !value.trim()))) continue;
        const entries = Object.entries(checked.answers);
        const first = entries[0];
        const text = entries.length === 1 && Array.isArray(first?.[1])
          ? first[1].filter((v): v is string => typeof v === "string").join("\n") : JSON.stringify(answers);
        const originalQuestion = evidence.questions.find((q) => q.id === first?.[0]);
        const question = entries.length === 1 ? originalQuestion?.originalText ?? originalQuestion?.text
          : JSON.stringify(evidence.questions.map(({ id, text, originalText }) => ({ id, text: originalText ?? text })));
        if (text.trim() && question) sources.push({ id: `answer:${approval.id}`, text, question });
      } catch { /* Legacy malformed answers are not evidence. */ }
    }
    return sources;
  }

  /** A model that retypes a 200-character token drops a character now and then; put the genuine one back. */
  repairBrief(task: Task, brief: string): string {
    const r = repairTokens(brief, this.tokens(task));
    if (r.repairs.length) this.ctx.emit(task.id, "text", { text: `(repaired ${r.repairs.length} damaged secret-gate token(s) in the brief: ${r.repairs.map((x) => `${shortToken(x.from)} → ${shortToken(x.to)}`).join(", ")})` });
    return r.text;
  }

  routeDeps(running: Record<string, number>, threads: ThreadBrief[]): RouteDeps {
    const context = this.context();
    const memory = this.memory();
    return {
      targets: this.deps.targets, router: this.deps.router, quota: this.deps.quota(), running, threads,
      records: this.ctx.store.recordsSince(this.ctx.now() - RECORD_WINDOW_MS),
      ...(context ? { context } : {}), ...(memory ? { memory } : {}),
      platformMemory: (task) => platformExperience(this.deps.platformMemoryPath, task, context?.text ?? "", this.ctx.now()),
      ...(this.deps.extensionsSummary ? { extensions: this.deps.extensionsSummary() } : {}),
    };
  }
}
