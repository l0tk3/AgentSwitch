/** Tasks: create, list, show, follow the event stream, approve / answer / cancel, hand off. */

import type { SealContext, SealedEntry } from "../secrets/sealer.js";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ApprovalPolicy } from "../engine/approvalPolicy.js";
import { answersFromText, MAX_ANSWER_LENGTH, parseEvidence, validateAnswers } from "../core/questions.js";
import { TERMINAL, type Task, type TaskEvent } from "../engine/types.js";
import { MAX_FILES_PER_UPLOAD } from "../files/names.js";
import type { Attachment } from "../files/uploads.js";
import { remoteCaller } from "../core/caller.js";
import { TargetRef } from "../core/target.js";
import { zodIssues } from "../util/zod.js";
import { checkCwd, checkStoredCwd } from "./cwdPolicy.js";
import { resolveProject } from "./projects.js";
import { issues, newWorkDir, limitParam, type ApiDeps } from "./shared.js";
import { DEFAULT_LIST_LIMIT, SSE_HEARTBEAT_MS } from "../core/limits.js";

const NewTaskBody = z.object({
  task: z.string().min(1),
  cwd: z.string().min(1).optional(),
  pin: TargetRef.optional(),
  needs_browser: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
  parent_id: z.string().min(1).optional(),
  /** Ids from POST /uploads; moved into <cwd>/in/ when the task is created. */
  attachments: z.array(z.string().min(1)).max(MAX_FILES_PER_UPLOAD).optional(),
  /** Run inside an existing thread (defaults to the parent's thread, else a new one). */
  thread_id: z.string().min(1).optional(),
  /** Per-task approval policy override. */
  approval: ApprovalPolicy.optional(),
  /** Run in a registered project directory (GET /projects), by name; the phone's way to reach a folder on the Mac. */
  project: z.string().trim().min(1).max(40).optional(),
});
export { NewTaskBody };

/** What a paired phone may not decide (app-v0 §2): the approval policy is the Mac's, and so is where a task runs on the
 *  Mac. A phone's task gets a fresh work dir, or its parent's cwd as a follow-up; it may not mark that ephemeral either,
 *  which deletes a work dir under the temp dir or the daemon's work root when the task ends. */
function remoteRefusal(body: z.infer<typeof NewTaskBody>): string | null {
  if (body.approval !== undefined) return "approval cannot be set from a paired device; the Mac's approval policy applies";
  if (body.cwd !== undefined) return "cwd cannot be set from a paired device; the task gets its own work directory (a follow-up continues in its parent's)";
  if (body.ephemeral !== undefined) return "ephemeral cannot be set from a paired device";
  return null;
}

type Sealed = { ok: true; text: string; sealed: readonly SealedEntry[] } | { ok: false; code: "unroutable" | "unavailable"; error: string };

/** Every submission passes the sealer (router-v0 §9) before anything is stored; a sealer failure refuses the
 *  submission rather than storing the text as is. Without a sealer (echo mode, no gate) the text goes as is. */
async function sealSubmission(deps: ApiDeps, text: string, ctx: SealContext): Promise<Sealed> {
  if (!deps.sealer) return { ok: true, text, sealed: [] };
  const r = await deps.sealer(text, ctx);
  if (!r.ok) return { ok: false, code: r.code, error: r.error };
  return { ok: true, text: r.text, sealed: r.sealed };
}
const AnswerBody = z.object({ approval_id: z.string().min(1), text: z.string().max(MAX_ANSWER_LENGTH).optional(), answers: z.record(z.string(), z.array(z.string())).optional() })
  .refine((b) => b.text !== undefined || b.answers !== undefined, { message: "text or answers required" });
const HandoffBody = z.object({ to: TargetRef.optional() });
const ApproveBody = z.object({ approval_id: z.string().min(1), decision: z.enum(["allow", "deny"]) });
const RateBody = z.object({ rating: z.union([z.literal(1), z.literal(-1), z.null()]) });

type IntakeStage = "sealing" | "creating";
type IntakeResult = { ok: true; task: Task; elapsedMs: number; sealingMs: number }
  | { ok: false; status: 400 | 404 | 409 | 500 | 503; error: string; streamError: string; elapsedMs: number; sealingMs: number };

/** A bounded receipt, not an execution stream. Slow readers and disconnects never repeat or hold up creation. */
function intakeStream(receive: (progress: (stage: IntakeStage) => void) => Promise<IntakeResult>, elapsed: () => number): ReadableStream<Uint8Array> {
  let connected = true;
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const send = (frame: object) => { if (connected) controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n")); };
      void (async () => {
        try {
          const result = await receive((stage) => send({ type: "progress", stage, elapsedMs: elapsed() }));
          if (result.ok) send({ type: "accepted", task: result.task, elapsedMs: result.elapsedMs, sealingMs: result.sealingMs });
          else send({ type: "error", status: result.status, error: result.streamError });
        } catch {
          // Provider errors can contain the original input; never echo them into the receipt.
          send({ type: "error", status: 500, error: "任务接收结果暂时无法确认，请检查任务列表，勿自动重发。" });
        } finally {
          if (connected) controller.close();
        }
      })();
    },
    cancel() { connected = false; },
  });
}

export type TaskBody = z.infer<typeof NewTaskBody>;
export type Admitted = { ok: true; task: Task } | { ok: false; status: 400 | 404 | 409; error: string; streamError?: string };

/** The second half of taking a task, after sealing (shared by POST /tasks and the assistant, assistant-v0 §1.1): the
 *  referenced parent and thread are looked up again (sealing takes seconds; they may be gone or archived meanwhile), the
 *  work dir chosen, attachments moved in, the task submitted. */
export function admitSealed(deps: ApiDeps, body: TaskBody, sealed: { readonly text: string; readonly sealed: readonly SealedEntry[] }): Admitted {
  const { pin, needs_browser, ephemeral, cwd, parent_id, attachments: uploadIds, thread_id, approval, project, task: _raw, ...rest } = body;
  if (project && cwd) return { ok: false, status: 400, error: "a task names a project or a cwd, not both" };
  // Checked here, after sealing, so a project removed or moved meanwhile is refused rather than run somewhere else.
  const chosen = project ? resolveProject(deps, project) : null;
  if (chosen && !chosen.ok) return { ok: false, status: 400, error: chosen.error };
  const projectDir = chosen?.ok ? chosen.path : undefined;
  const parent = parent_id ? deps.store.getTask(parent_id) : undefined;
  if (parent_id && !parent) return { ok: false, status: 404, error: "parent task not found" };
  const effectiveThreadId = thread_id ?? parent?.threadId;
  const thread = effectiveThreadId ? deps.store.getThread(effectiveThreadId) : undefined;
  if (effectiveThreadId && !thread) return { ok: false, status: 404, error: "thread not found" };
  if (thread?.status === "archived") return { ok: false, status: 409, error: "thread is archived; reopen it first" };
  const inherited = parent && !parent.ephemeral ? parent.cwd : undefined;
  // A named project wins over the parent's directory: "now do it in the repo" continues the thread, somewhere else.
  const workDir = projectDir ?? cwd ?? inherited ?? newWorkDir(deps.workRoot);
  const isEphemeral = projectDir === undefined && (ephemeral ?? (cwd === undefined && inherited === undefined));
  let attachments: Attachment[] = [];
  try { attachments = uploadIds?.length ? deps.uploads.moveInto(uploadIds, workDir) : []; }
  catch (err) { return { ok: false, status: 400, error: (err as Error).message, streamError: "附件无法移入任务目录，请重新检查附件后提交。" }; }
  const task = deps.engine.submit({ ...rest, task: sealed.text, ...(sealed.sealed.length ? { sealed: sealed.sealed } : {}), cwd: workDir, ephemeral: isEphemeral, attachments, ...(parent ? { parentId: parent.id } : {}), ...(thread ? { threadId: thread.id } : {}), ...(pin ? { pin } : {}), ...(needs_browser !== undefined ? { needsBrowser: needs_browser } : {}), ...(approval ? { approval } : {}) });
  return { ok: true, task };
}

export function mountTasks(app: Hono, deps: ApiDeps): void {
  app.post("/tasks", async (c) => {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const body = NewTaskBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: zodIssues(body.error) }, 400);
    const refused = remoteCaller(c.env) ? remoteRefusal(body.data) : null;
    if (refused) return c.json({ error: refused }, 400);
    const { pin, needs_browser, ephemeral, cwd, parent_id, attachments: uploadIds, thread_id, approval, project, ...rest } = body.data;
    if (project && cwd) return c.json({ error: "a task names a project or a cwd, not both" }, 400);
    const cwdProblem = cwd ? checkCwd(cwd, deps.cwdRules) : null;
    if (cwdProblem) return c.json({ error: cwdProblem }, 400);
    const chosen = project ? resolveProject(deps, project) : null;
    if (chosen && !chosen.ok) return c.json({ error: chosen.error }, 400);
    let parent = parent_id ? deps.store.getTask(parent_id) : undefined;
    if (parent_id && !parent) return c.json({ error: "parent task not found" }, 404);
    const initialThreadId = thread_id ?? parent?.threadId;
    let thread = initialThreadId ? deps.store.getThread(initialThreadId) : undefined;
    if (initialThreadId && !thread) return c.json({ error: "thread not found" }, 404);
    if (thread?.status === "archived") return c.json({ error: "thread is archived; reopen it first" }, 409);
    // A follow-up takes over its parent's cwd, which may predate the current rules.
    const inheritedProblem = cwd === undefined && parent && !parent.ephemeral ? checkStoredCwd(parent.cwd, deps.cwdRules, deps.workRoot) : null;
    if (inheritedProblem) return c.json({ error: `the parent task's ${inheritedProblem}` }, 400);
    const receive = async (progress: (stage: IntakeStage) => void = () => undefined): Promise<IntakeResult> => {
      let sealingMs = 0;
      const failure = (status: Extract<IntakeResult, { ok: false }>["status"], error: string, streamError = error): IntakeResult => ({ ok: false, status, error, streamError, elapsedMs: elapsed(), sealingMs });
      if (deps.sealer) progress("sealing");
      const sealStarted = Date.now();
      let sealed: Sealed;
      try { sealed = await sealSubmission(deps, rest.task, { ...(parent ? { parentTask: parent.task } : {}), ...(thread?.title ? { threadTitle: thread.title } : {}) }); }
      catch { sealed = { ok: false, code: "unavailable", error: "凭据保护服务暂时不可用，消息未创建任务，请稍后重试。" }; }
      finally { sealingMs = deps.sealer ? Date.now() - sealStarted : 0; }
      if (!sealed.ok) return failure(sealed.code === "unroutable" ? 400 : 503, sealed.error, sealed.code === "unroutable"
        ? "凭据缺少目标站点或原文用途授权，请补充后重试。" : "凭据保护服务暂时不可用，消息未创建任务，请稍后重试。");
      progress("creating");
      const admitted = admitSealed(deps, body.data, sealed);
      if (!admitted.ok) return failure(admitted.status, admitted.error, admitted.streamError ?? admitted.error);
      const task = admitted.task;
      const elapsedMs = elapsed();
      // A diagnostic failure after submit must not turn an accepted task into a retryable rejection.
      try { deps.bus.publish(deps.store.appendEvent(task.id, "step", { action: "intake", durationMs: elapsedMs, sealingMs })); } catch { /* The task receipt still takes precedence. */ }
      return { ok: true, task, elapsedMs, sealingMs };
    };
    const wantsStream = (c.req.header("accept") ?? "").split(",").some((part) => part.split(";")[0]?.trim().toLowerCase() === "application/x-ndjson" && !/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(part));
    if (wantsStream) {
      c.header("Content-Type", "application/x-ndjson; charset=utf-8");
      c.header("Cache-Control", "no-store");
      c.header("X-Accel-Buffering", "no");
      return c.newResponse(intakeStream(receive, elapsed));
    }
    const result = await receive();
    c.header("Server-Timing", `sealing;dur=${result.sealingMs}, intake;dur=${result.elapsedMs}`);
    return result.ok ? c.json(result.task, 201) : c.json({ error: result.error }, result.status);
  });

  // "Hand this to someone else": a follow-up in the same thread, excluding the current executor unless `to` pins one.
  app.post("/tasks/:id/handoff", async (c) => {
    const body = HandoffBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    const task = deps.store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const thread = task.threadId ? deps.store.getThread(task.threadId) : undefined;
    if (thread?.status === "archived") return c.json({ error: "thread is archived; reopen it first" }, 409);
    const cwdProblem = task.ephemeral ? null : checkStoredCwd(task.cwd, deps.cwdRules, deps.workRoot);
    if (cwdProblem) return c.json({ error: `the task's ${cwdProblem}` }, 400);
    // An ephemeral work dir is wiped when its task ends, so the successor gets a fresh one (as follow-ups do).
    const next = deps.engine.handoff(task.id, { ...(body.data.to ? { to: body.data.to } : {}), ...(task.ephemeral ? { cwd: newWorkDir(deps.workRoot), ephemeral: true } : {}) });
    return next ? c.json(next, 201) : c.json({ error: "not found" }, 404);
  });

  app.get("/tasks", (c) => c.json(deps.store.listTasks(limitParam(c, DEFAULT_LIST_LIMIT))));

  app.get("/tasks/:id", (c) => {
    const task = deps.store.getTask(c.req.param("id"));
    return task ? c.json({ ...task, approvals: deps.store.pendingApprovals(task.id) }) : c.json({ error: "not found" }, 404);
  });

  app.delete("/tasks/:id", (c) => {
    const result = deps.engine.deleteTask(c.req.param("id"));
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.code === "not_found" ? 404 : 409);
  });

  // Files: uploads are staged, then moved into <cwd>/in/ by POST /tasks; downloads come from the
  // artifacts store once an ephemeral cwd is gone, otherwise from the cwd itself.
  app.get("/tasks/:id/events", (c) => {
    const id = c.req.param("id");
    const task = deps.store.getTask(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const after = Number(c.req.query("after") ?? 0);
    return streamSSE(c, async (stream) => {
      let last = after;
      const ends = (type: string) => TERMINAL.has(type as import("../engine/types.js").TaskStatus);
      const send = async (ev: { seq: number; type: string; payload: unknown; ts: number }) => {
        if (ev.seq <= last) return;
        last = ev.seq;
        await stream.writeSSE({ id: String(ev.seq), event: ev.type, data: JSON.stringify({ ...ev, taskId: id }) });
      };
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      // Subscribe before replaying so nothing emitted during the replay's awaits is lost; the seq check dedups.
      const queue: TaskEvent[] = [];
      let replaying = true;
      const unsubscribe = deps.bus.subscribe(id, (ev) => {
        if (replaying) { queue.push(ev); return; }
        void send(ev).then(() => { if (ends(ev.type)) done(); });
      });
      let ended = false;
      for (const ev of deps.store.eventsSince(id, after)) { await send(ev); ended ||= ends(ev.type); }
      while (queue.length) { const ev = queue.shift()!; await send(ev); ended ||= ends(ev.type); }
      replaying = false;
      const current = deps.store.getTask(id);
      if (ended || !current || TERMINAL.has(current.status)) { unsubscribe(); return; }
      stream.onAbort(() => { unsubscribe(); done(); });
      const heartbeat = setInterval(() => { void stream.write(": ping\n\n").catch(() => undefined); }, deps.sseHeartbeatMs ?? SSE_HEARTBEAT_MS);
      try {
        await finished;
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });

  /** The approval must belong to the task in the path: a leaked id from another task answers nothing. */
  const owned = (c: { req: { param: (k: string) => string } }, approvalId: string): boolean => deps.store.getApproval(approvalId)?.taskId === c.req.param("id");

  app.post("/tasks/:id/approve", async (c) => {
    const body = ApproveBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "approval_id and decision (allow|deny) required" }, 400);
    const ok = owned(c, body.data.approval_id) && deps.engine.resolveApproval(body.data.approval_id, body.data.decision);
    return ok ? c.json({ ok: true }) : c.json({ error: "no pending approval with that id" }, 404);
  });

  app.post("/tasks/:id/answer", async (c) => {
    const body = AnswerBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "approval_id plus text or answers (question id → strings) required" }, 400);
    if (!owned(c, body.data.approval_id)) return c.json({ error: "no pending question with that id" }, 404);
    const approval = deps.store.getApproval(body.data.approval_id)!;
    const evidence = approval.kind === "question" && approval.status === "pending" ? parseEvidence(approval.evidence) : null;
    const task = deps.store.getTask(approval.taskId);
    if (!evidence || !task || TERMINAL.has(task.status)) return c.json({ error: "no pending question with that id" }, 404);
    const checked = validateAnswers(evidence.questions, body.data.answers ?? answersFromText(evidence.questions, body.data.text?.trim() ?? ""));
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    // Answers are another plaintext entrance. Seal before ApprovalDesk stores the answer or emits it.
    const answers: Record<string, string[]> = {};
    const entries: SealedEntry[] = [];
    // Only the sealer sees this plaintext bundle. A host named in another answer can supply
    // the destination for a credential without ever copying that plaintext into stored evidence.
    const answerContext = `${task.task}\n\nQuestions and user answers:\n${JSON.stringify({ questions: evidence.questions, answers: checked.answers })}`;
    for (const [id, values] of Object.entries(checked.answers)) {
      answers[id] = [];
      for (const value of values) {
        const sealed = await sealSubmission(deps, value, { parentTask: answerContext });
        if (!sealed.ok) return c.json({ error: "could not seal the answer; it was not stored" }, sealed.code === "unroutable" ? 400 : 503);
        answers[id].push(sealed.text);
        entries.push(...sealed.sealed);
      }
    }
    const r = deps.engine.answer(body.data.approval_id, { answers, sealed: !!deps.sealer });
    if (r.ok && entries.length) deps.bus.publish(deps.store.appendEvent(task.id, "sealed", { entries, source: "answer", approvalId: approval.id }));
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.code === "not_found" ? 404 : 400);
  });

  app.post("/tasks/:id/rate", async (c) => {
    const body = RateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "rating must be 1, -1 or null" }, 400);
    return deps.engine.rate(c.req.param("id"), body.data.rating) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  app.post("/tasks/:id/cancel", (c) => {
    const task = deps.engine.cancel(c.req.param("id"));
    return task ? c.json(task) : c.json({ error: "not found" }, 404);
  });

  app.get("/approvals", (c) => c.json(deps.store.pendingApprovals()));

}
