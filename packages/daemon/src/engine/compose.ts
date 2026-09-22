/** What the router and the executor are given for a task: the composed request (follow-up history, attachments),
 *  the brief with damaged tokens repaired, and the per-dispatch route dependencies (context, memory, records…). */

import { attachmentsNote } from "../files/notes.js";
import { knownTokens, repairTokens, shortToken } from "../executors/tokens.js";
import { loadContext, type LoadedContext } from "../router/context.js";
import type { ExtensionsSummary } from "../router/prompt.js";
import type { RouteDeps } from "../router/route.js";
import type { Router } from "../router/routers/types.js";
import type { Targets } from "../router/targets.js";
import type { Quota } from "../router/validate.js";
import { loadMemory } from "../threads/memory.js";
import { RECORD_WINDOW_MS } from "../threads/record.js";
import type { ThreadBrief } from "../threads/types.js";
import type { EngineContext } from "./context.js";
import type { Task } from "./types.js";

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

  /** Genuine enc:v1: tokens this task may legitimately use: context, memory and the user's own words. */
  tokens(task: Task): ReadonlySet<string> {
    return knownTokens(this.context()?.text, this.memory()?.text, task.task);
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
      ...(this.deps.extensionsSummary ? { extensions: this.deps.extensionsSummary() } : {}),
    };
  }
}
