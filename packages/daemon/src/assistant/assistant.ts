/** The router as the user's assistant (assistant-v0 §1.1). Every phone message: sealed first (the conversation never
 *  holds plaintext), stored, answered by one router-model call with one action — reply, create_task, status, cancel —
 *  and stored again. A message with files or a pinned executor is a task without asking. When the assistant cannot
 *  answer usefully the message becomes a task as before, so nothing the user says is lost. A resend with the same
 *  client id gets the first answer. */

import { tmpdir } from "node:os";
import { z } from "zod";
import type { Router } from "../core/modelCall.js";
import type { TargetRef } from "../core/target.js";
import type { Engine } from "../engine/engine.js";
import type { Store } from "../engine/store.js";
import type { Task } from "../engine/types.js";
import { askJson } from "../router/ask.js";
import type { SealedEntry, Sealer } from "../secrets/sealer.js";
import { COMMUNICATION_GUIDANCE } from "../util/communication.js";
import { extractJsonObject } from "../util/json.js";
import { findProject, type Project } from "../files/projects.js";
import type { AssistantKind, AssistantLog, AssistantMessage } from "./log.js";
import { buildRegister, withoutLegend, type Register } from "./register.js";

export const HISTORY_MESSAGES = 20;
const TOKEN = /enc:v1:[A-Za-z0-9_=-]{16,}/g;

export const ASSISTANT_SYSTEM = `${COMMUNICATION_GUIDANCE}

You are the dispatcher of AgentSwitch, the user's task system on their Mac, talking with the user on their phone.
Every message the user sends comes to you first. You keep track of their tasks (the register below) and choose one
action for this message:
- "create_task": the user wants something done on the Mac — code, browsing, research, files, anything an agent carries
  out. "task": the request as one self-contained instruction, in the user's language, only when the message leans on
  the conversation ("try that again", "same for the other site"); otherwise leave it out and the user's own words are
  used. Copy every enc:v1: token of the user's message into "task" unchanged. "parent_id": the id of a register task
  this continues (same work, a retry, a correction, the next step on the same site); otherwise leave it out. "project":
  the name of a registered project (listed below) when the work is on it — the user names it or plainly means it ("修一下
  AgentSwitch 的 bug", "在那个仓库里跑测试"); the task then runs in that folder. Otherwise leave it out: the task gets an
  empty scratch folder. Never guess a project for a task that does not need one. "text": one short sentence confirming
  you took it on — no promises about the result. "cwd": a folder on the Mac the user names for the work, when it is not
  a registered project ("在 ~/Desktop/报表 里整理一下", "/Users/x/code/site 的测试"): an absolute path or one starting with ~/.
  Leave it out otherwise.
- "status": the user asks how a task went or is going. "task_ids": the register tasks meant (find them by thread
  title, site, time or order — "刚才那个", "x.com 那个"). "text": answer from the register only — state, last step, what
  it waits for, the outcome — in one or two sentences. Never invent progress.
- "cancel": the user wants running work stopped. "task_ids": running register tasks. "text": confirm what stops.
- "watch": the user wants to hear how a running task gets on at intervals ("每 10 分钟告诉我一下", "盯着那个任务").
  "task_ids": running register tasks; "every_minutes": 1–240 (10 when the user names no interval), 0 stops watching.
  "text": confirm what you will do. You already report every end, failure and question for the user on your own: never
  set a watch just for those.
- "reply": anything else — what you can answer from the conversation and the register, small talk, or a question back
  when you cannot tell what the user wants (for example whether a message is a new task or about an existing one).
When the body says a new AgentSwitch version is waiting and the user wants it installed, "reply": they confirm it under
设置 › 新版本 on the phone or in the Mac's menu bar (you cannot install it); after the switch you report how it went.
Answer in the user's language, briefly: it may be read aloud. Never repeat enc:v1: tokens in "text".
Reply with one JSON object only:
{"action":"create_task|status|cancel|watch|reply","text":"...","task":"...","parent_id":"...","project":"...","cwd":"...","task_ids":["..."],"every_minutes":10}`;

export const DEFAULT_WATCH_MINUTES = 10;
export const MAX_WATCH_MINUTES = 240;
const MS_PER_MINUTE = 60_000;

const Decision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reply"), text: z.string().min(1) }),
  z.object({ action: z.literal("create_task"), text: z.string().default(""), task: z.string().optional(), parent_id: z.string().optional(), project: z.string().optional(), cwd: z.string().max(1024).optional() }),
  z.object({ action: z.literal("status"), text: z.string().min(1), task_ids: z.array(z.string()).default([]) }),
  z.object({ action: z.literal("cancel"), text: z.string().min(1), task_ids: z.array(z.string()).default([]) }),
  z.object({ action: z.literal("watch"), text: z.string().min(1), task_ids: z.array(z.string()).default([]), every_minutes: z.number().int().min(0).max(MAX_WATCH_MINUTES).default(DEFAULT_WATCH_MINUTES) }),
]);
type Decision = z.infer<typeof Decision>;

export type TaskRequest = { readonly task: string; readonly parent_id?: string; readonly project?: string; readonly cwd?: string; readonly attachments?: string[]; readonly pin?: TargetRef };
export type Admit = (body: TaskRequest, sealed: { readonly text: string; readonly sealed: readonly SealedEntry[] }) =>
  { ok: true; task: Task } | { ok: false; status: number; error: string };

export type AssistantDeps = {
  readonly log: AssistantLog;
  readonly store: Store;
  readonly engine: Pick<Engine, "cancel">;
  /** The router model as a text-only agent; absent (echo mode) = every message is a task. */
  readonly router?: Router;
  readonly sealer?: Sealer;
  readonly admit: Admit;
  /** The project folders a task may run in (assistant-v0 §5); absent = none. */
  readonly projects?: () => readonly Project[];
  /** When a newer AgentSwitch.app is staged: its build time (assistant-v0 §5). */
  readonly stagedUpdate?: () => string | null;
  readonly timeoutMs: number;
  readonly now?: () => number;
};

export type Incoming = { readonly text: string; readonly clientId: string; readonly attachments?: string[]; readonly pin?: TargetRef };
export type Answered = { ok: true; user: AssistantMessage; assistant: AssistantMessage; task?: Task } | { ok: false; status: number; error: string };

export class Assistant {
  /** Messages being answered, by client id: a resend while the first is in flight waits for it. */
  private readonly inFlight = new Map<string, Promise<Answered>>();

  constructor(private readonly deps: AssistantDeps) {}

  converse(input: Incoming): Promise<Answered> {
    const running = this.inFlight.get(input.clientId);
    if (running) return running;
    const done = this.deps.log.byClientId(input.clientId);
    if (done?.assistant) return Promise.resolve(this.replay(done.user, done.assistant));
    const work = this.answer(input).finally(() => this.inFlight.delete(input.clientId));
    this.inFlight.set(input.clientId, work);
    return work;
  }

  private projects(): readonly Project[] {
    return this.deps.projects?.() ?? [];
  }

  /** Messages after `seq`, oldest first. */
  messages(seq: number, limit: number): AssistantMessage[] {
    return this.deps.log.after(seq, limit);
  }

  /** The newest `limit` messages, oldest first. */
  latest(limit: number): AssistantMessage[] {
    return this.deps.log.recent(limit);
  }

  private replay(user: AssistantMessage, assistant: AssistantMessage): Answered {
    const task = assistant.kind === "task" || assistant.kind === "fallback" ? this.deps.store.getTask(assistant.taskIds[0] ?? "") : undefined;
    return { ok: true, user, assistant, ...(task ? { task } : {}) };
  }

  private async answer(input: Incoming): Promise<Answered> {
    const sealed = this.deps.sealer ? await this.deps.sealer(input.text) : { ok: true as const, text: input.text, sealed: [], ms: 0 };
    if (!sealed.ok) return { ok: false, status: sealed.code === "unroutable" ? 400 : 503, error: sealed.error };
    const history = this.deps.log.recent(HISTORY_MESSAGES);
    const user = this.deps.log.append({ role: "user", text: sealed.text, kind: "message", taskIds: [], clientId: input.clientId, replyTo: null });
    const reply = (kind: AssistantKind, text: string, taskIds: readonly string[] = []) =>
      this.deps.log.append({ role: "assistant", text, kind, taskIds, clientId: null, replyTo: user.seq });
    const create = (kind: "task" | "fallback", text: string, request: TaskRequest): Answered => {
      const admitted = this.deps.admit({ ...request, ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(input.pin ? { pin: input.pin } : {}) },
        { text: request.task, sealed: sealed.sealed });
      if (!admitted.ok) return { ok: true, user, assistant: reply("reply", `没能建成任务：${admitted.error}`) };
      return { ok: true, user, assistant: reply(kind, text, [admitted.task.id]), task: admitted.task };
    };

    // Files and a pinned executor only make sense for a task: no need to ask.
    if (input.attachments?.length || input.pin) return create("task", "收到，连同附件和指定交给路由器安排。", { task: sealed.text });
    const register = buildRegister(this.deps.store, (this.deps.now ?? Date.now)(), new Map(this.deps.log.watches().map((w) => [w.taskId, w.everyMs])));
    const decision = this.deps.router ? await this.decide(history, sealed.text, register) : null;
    if (!decision) return create("fallback", this.deps.router ? "助理暂时没回应，已直接建成任务。" : "已建成任务。", { task: sealed.text });

    switch (decision.action) {
      case "reply":
        return { ok: true, user, assistant: reply("reply", decision.text) };
      case "status":
        return { ok: true, user, assistant: reply("status", decision.text, decision.task_ids.filter((id) => register.allIds.has(id))) };
      case "cancel": {
        const ids = decision.task_ids.filter((id) => register.activeIds.has(id));
        for (const id of ids) this.deps.engine.cancel(id);
        return { ok: true, user, assistant: reply("cancel", ids.length ? decision.text : "没有找到正在运行的这个任务。", ids) };
      }
      case "watch": {
        const ids = decision.task_ids.filter((id) => register.activeIds.has(id));
        if (!ids.length) return { ok: true, user, assistant: reply("reply", "没有找到正在进行的这个任务。") };
        for (const id of ids) {
          if (decision.every_minutes === 0) this.deps.log.removeWatch(id);
          else this.deps.log.setWatch(id, decision.every_minutes * MS_PER_MINUTE);
        }
        return { ok: true, user, assistant: reply("watch", decision.text, ids) };
      }
      case "create_task": {
        const task = decision.task && keepsTokens(sealed.text, decision.task) ? decision.task : sealed.text;
        const parent = decision.parent_id && register.allIds.has(decision.parent_id) ? decision.parent_id : undefined;
        const project = decision.project ? findProject(this.projects(), decision.project)?.name : undefined;
        // A named folder (checked against the cwd rules when the task is admitted); a registered project wins.
        const cwd = !project && decision.cwd ? expandHome(decision.cwd.trim()) : undefined;
        return create("task", decision.text || "收到，正在安排。", { task, ...(parent ? { parent_id: parent } : {}), ...(project ? { project } : {}), ...(cwd ? { cwd } : {}) });
      }
    }
  }

  /** One router-model call (with the usual single retry on a malformed reply); null when it gives nothing usable. */
  private async decide(history: readonly AssistantMessage[], message: string, register: Register): Promise<Decision | null> {
    const conversation = history.map((m) => `${m.role === "user" ? "User" : "You"}: ${withoutLegend(m.text)}`).join("\n") || "(none)";
    const projects = this.projects();
    const listed = projects.length ? projects.map((p) => `- "${p.name}": ${p.path}`).join("\n") : "(none)";
    const staged = this.deps.stagedUpdate?.() ?? null;
    const update = staged ? `\n\nA new AgentSwitch version (built ${staged}) is waiting to be installed.` : "";
    const body = (previousError?: string) => `Task register:\n${register.text}\n\nRegistered projects:\n${listed}${update}\n\nConversation so far:\n${conversation}\n\nThe user's new message:\n${withoutLegend(message)}${previousError ? `\n\n(Your previous reply was rejected: ${previousError})` : ""}`;
    const r = await askJson(this.deps.router!, { system: ASSISTANT_SYSTEM, cwd: tmpdir(), body }, parseDecision, this.deps.timeoutMs);
    return r.value;
  }
}

function parseDecision(text: string): { ok: true; value: Decision } | { ok: false; error: string } {
  const raw = extractJsonObject(text);
  if (raw === undefined) return { ok: false, error: "no JSON object" };
  try {
    const parsed = Decision.safeParse(JSON.parse(raw));
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** A rewrite may only be used when every credential token of the user's message survived it, character for character. */
export function keepsTokens(original: string, rewrite: string): boolean {
  return [...original.matchAll(TOKEN)].every((m) => rewrite.includes(m[0]));
}

/** `~/x` → `$HOME/x`; anything not absolute after that is dropped (a relative folder means nothing on the phone). */
function expandHome(path: string): string | undefined {
  const home = process.env.HOME ?? "";
  const full = path === "~" ? home : path.startsWith("~/") ? home + path.slice(1) : path;
  return full.startsWith("/") ? full : undefined;
}
