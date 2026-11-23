/** Tasks: create, list, show, follow the event stream, approve / answer / cancel, hand off. */

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ApprovalPolicy } from "../engine/approvalPolicy.js";
import { answersFromText, MAX_ANSWER_LENGTH, parseEvidence, validateAnswers } from "../core/questions.js";
import { TERMINAL, type Task, type TaskEvent } from "../engine/types.js";
import { MAX_FILES_PER_UPLOAD, taskInDir } from "../files/names.js";
import { randomUUID } from "node:crypto";
import type { Attachment } from "../files/uploads.js";
import { remoteCaller } from "../core/caller.js";
import { TargetRef } from "../core/target.js";
import { zodIssues } from "../util/zod.js";
import { checkCwd, checkStoredCwd } from "./cwdPolicy.js";
import { issues, newWorkDir, limitParam, type ApiDeps } from "./shared.js";
import { DEFAULT_LIST_LIMIT, SSE_HEARTBEAT_MS } from "../core/limits.js";
import { mkdirSync } from "node:fs";
import { newTaskFolder } from "../files/workdir.js";
import { oldDispatchOff, oldDispatchOffBody, OLD_DISPATCH_OFF_ERROR } from "../core/oldDispatch.js";

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
});
export { NewTaskBody };

/** What a paired phone may not decide (app-v0 §2): the approval policy is the Mac's. Where a task runs it may choose
 *  since 2026-09-25 (user decision: the Mac's folders are open to tasks, like Claude Code): any folder the cwd rules
 *  allow. It may not mark a folder ephemeral, which deletes it when the task ends. */
function remoteRefusal(body: z.infer<typeof NewTaskBody>): string | null {
  if (body.approval !== undefined) return "approval cannot be set from a paired device; the Mac's approval policy applies";
  if (body.ephemeral !== undefined) return "ephemeral cannot be set from a paired device";
  return null;
}

const AnswerBody = z.object({ approval_id: z.string().min(1), text: z.string().max(MAX_ANSWER_LENGTH).optional(), answers: z.record(z.string(), z.array(z.string())).optional() })
  .refine((b) => b.text !== undefined || b.answers !== undefined, { message: "text or answers required" });
const HandoffBody = z.object({ to: TargetRef.optional() });
const ApproveBody = z.object({ approval_id: z.string().min(1), decision: z.enum(["allow", "deny"]) });
const RateBody = z.object({ rating: z.union([z.literal(1), z.literal(-1), z.null()]) });

/** Until 2026-11-23 a "sealing" stage came first (router-v0 §9, removed); only "creating" is sent now. */
type IntakeStage = "creating";
type IntakeResult = { ok: true; task: Task; elapsedMs: number }
  | { ok: false; status: 400 | 404 | 409 | 410 | 500; error: string; streamError: string; elapsedMs: number };

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
          if (result.ok) send({ type: "accepted", task: result.task, elapsedMs: result.elapsedMs });
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
export type Admitted = { ok: true; task: Task } | { ok: false; status: 400 | 404 | 409 | 410; error: string; streamError?: string };

/** A new folder for a task that names none: under the default work folder when it is on and allowed, else a
 *  throw-away one in the data directory. */
function defaultTaskFolder(deps: ApiDeps): { dir: string; kept: boolean } {
  const root = deps.taskFolderRoot?.();
  if (root) {
    try {
      mkdirSync(root, { recursive: true });
      if (!checkCwd(root, deps.cwdRules)) return { dir: newTaskFolder(root), kept: true };
    } catch { /* unusable: fall through to a throw-away folder */ }
  }
  return { dir: newWorkDir(deps.workRoot), kept: false };
}

const SEARCH_LIMIT = 30;

/** Taking a task (shared by POST /tasks and the assistant, assistant-v0 §1.1): the referenced parent and thread are
 *  looked up, the work dir chosen, attachments moved in, the task submitted. The text goes on as typed: the automatic
 *  sealing before this (router-v0 §9) was removed on 2026-11-23. */
export function admitTask(deps: ApiDeps, body: TaskBody): Admitted {
  if (oldDispatchOff(deps)) return { ok: false, status: 410, error: OLD_DISPATCH_OFF_ERROR };
  const { pin, needs_browser, ephemeral, cwd, parent_id, attachments: uploadIds, thread_id, approval, ...rest } = body;
  // The assistant's folder comes here unchecked: check it now.
  const cwdProblem = cwd ? checkCwd(cwd, deps.cwdRules) : null;
  if (cwdProblem) return { ok: false, status: 400, error: cwdProblem };
  const parent = parent_id ? deps.store.getTask(parent_id) : undefined;
  if (parent_id && !parent) return { ok: false, status: 404, error: "parent task not found" };
  const effectiveThreadId = thread_id ?? parent?.threadId;
  const thread = effectiveThreadId ? deps.store.getThread(effectiveThreadId) : undefined;
  if (effectiveThreadId && !thread) return { ok: false, status: 404, error: "thread not found" };
  if (thread?.status === "archived") return { ok: false, status: 409, error: "thread is archived; reopen it first" };
  const inherited = parent && !parent.ephemeral ? parent.cwd : undefined;
  // A named folder wins over the parent's directory: "now do it in the repo" continues the thread, somewhere else.
  // Neither: a kept, dated folder under the default work folder, or a throw-away one when that is off or unusable.
  const folder = cwd === undefined && inherited === undefined ? defaultTaskFolder(deps) : null;
  const workDir = cwd ?? inherited ?? folder!.dir;
  const isEphemeral = ephemeral ?? (folder ? !folder.kept : false);
  let attachments: Attachment[] = [];
  // Into AgentSwitch's own folder under the task's id, not the folder the task works in (files/names.ts).
  const id = randomUUID().slice(0, 8);
  try { attachments = uploadIds?.length ? deps.uploads.moveToDir(uploadIds, taskInDir(deps.artifactsDir, id), false) : []; }
  catch (err) { return { ok: false, status: 400, error: (err as Error).message, streamError: "附件无法保存，请重新检查附件后提交。" }; }
  const task = deps.engine.submit({ ...rest, id, cwd: workDir, ephemeral: isEphemeral, attachments, ...(parent ? { parentId: parent.id } : {}), ...(thread ? { threadId: thread.id } : {}), ...(pin ? { pin } : {}), ...(needs_browser !== undefined ? { needsBrowser: needs_browser } : {}), ...(approval ? { approval } : {}) });
  return { ok: true, task };
}

export function mountTasks(app: Hono, deps: ApiDeps): void {
  // The old dispatch is off (core/oldDispatch.ts): nothing new is started or answered; reading, cancelling, deleting stay.
  const off = (c: Context) => oldDispatchOff(deps) ? c.json(oldDispatchOffBody, 410) : null;

  app.post("/tasks", async (c) => {
    const refusedOff = off(c);
    if (refusedOff) return refusedOff;
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const body = NewTaskBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: zodIssues(body.error) }, 400);
    const refused = remoteCaller(c.env) ? remoteRefusal(body.data) : null;
    if (refused) return c.json({ error: refused }, 400);
    const { cwd, parent_id, thread_id } = body.data;
    const cwdProblem = cwd ? checkCwd(cwd, deps.cwdRules) : null;
    if (cwdProblem) return c.json({ error: cwdProblem }, 400);
    const parent = parent_id ? deps.store.getTask(parent_id) : undefined;
    if (parent_id && !parent) return c.json({ error: "parent task not found" }, 404);
    const initialThreadId = thread_id ?? parent?.threadId;
    const thread = initialThreadId ? deps.store.getThread(initialThreadId) : undefined;
    if (initialThreadId && !thread) return c.json({ error: "thread not found" }, 404);
    if (thread?.status === "archived") return c.json({ error: "thread is archived; reopen it first" }, 409);
    // A follow-up takes over its parent's cwd, which may predate the current rules.
    const inheritedProblem = cwd === undefined && parent && !parent.ephemeral ? checkStoredCwd(parent.cwd, deps.cwdRules, deps.workRoot) : null;
    if (inheritedProblem) return c.json({ error: `the parent task's ${inheritedProblem}` }, 400);
    const receive = async (progress: (stage: IntakeStage) => void = () => undefined): Promise<IntakeResult> => {
      progress("creating");
      const admitted = admitTask(deps, body.data);
      if (!admitted.ok) return { ok: false, status: admitted.status, error: admitted.error, streamError: admitted.streamError ?? admitted.error, elapsedMs: elapsed() };
      const task = admitted.task;
      const elapsedMs = elapsed();
      // A diagnostic failure after submit must not turn an accepted task into a retryable rejection.
      try { deps.bus.publish(deps.store.appendEvent(task.id, "step", { action: "intake", durationMs: elapsedMs })); } catch { /* The task receipt still takes precedence. */ }
      return { ok: true, task, elapsedMs };
    };
    const wantsStream = (c.req.header("accept") ?? "").split(",").some((part) => part.split(";")[0]?.trim().toLowerCase() === "application/x-ndjson" && !/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(part));
    if (wantsStream) {
      c.header("Content-Type", "application/x-ndjson; charset=utf-8");
      c.header("Cache-Control", "no-store");
      c.header("X-Accel-Buffering", "no");
      return c.newResponse(intakeStream(receive, elapsed));
    }
    const result = await receive();
    c.header("Server-Timing", `intake;dur=${result.elapsedMs}`);
    return result.ok ? c.json(result.task, 201) : c.json({ error: result.error }, result.status);
  });

  // "Hand this to someone else": a follow-up in the same thread, excluding the current executor unless `to` pins one.
  app.post("/tasks/:id/handoff", async (c) => {
    const refusedOff = off(c);
    if (refusedOff) return refusedOff;
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
      // What its run is writing (docs/simple-view-v0.md §5.14): no `id`, it is in no sequence and never replayed; what is
      // being written now first. `{done: true}`: nothing is (the part is in the events).
      const writing = (w: import("../core/writing.js").Writing | null) =>
        void stream.writeSSE({ event: "writing", data: JSON.stringify(w ? { taskId: id, ...w } : { taskId: id, done: true }) }).catch(() => undefined);
      const now = deps.bus.writingOf(id);
      if (now) writing(now);
      const unwrite = deps.bus.subscribeWriting(id, writing);
      stream.onAbort(() => { unsubscribe(); unwrite(); done(); });
      const heartbeat = setInterval(() => { void stream.write(": ping\n\n").catch(() => undefined); }, deps.sseHeartbeatMs ?? SSE_HEARTBEAT_MS);
      try {
        await finished;
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
        unwrite();
      }
    });
  });

  /** The approval must belong to the task in the path: a leaked id from another task answers nothing. */
  const owned = (c: { req: { param: (k: string) => string } }, approvalId: string): boolean => deps.store.getApproval(approvalId)?.taskId === c.req.param("id");

  app.post("/tasks/:id/approve", async (c) => {
    const body = ApproveBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "approval_id and decision (allow|deny) required" }, 400);
    // Denying lets an old task end; allowing would let it go on.
    if (body.data.decision === "allow") { const refusedOff = off(c); if (refusedOff) return refusedOff; }
    const ok = owned(c, body.data.approval_id) && deps.engine.resolveApproval(body.data.approval_id, body.data.decision);
    return ok ? c.json({ ok: true }) : c.json({ error: "no pending approval with that id" }, 404);
  });

  app.post("/tasks/:id/answer", async (c) => {
    const refusedOff = off(c);
    if (refusedOff) return refusedOff;
    const body = AnswerBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "approval_id plus text or answers (question id → strings) required" }, 400);
    if (!owned(c, body.data.approval_id)) return c.json({ error: "no pending question with that id" }, 404);
    const approval = deps.store.getApproval(body.data.approval_id)!;
    const evidence = approval.kind === "question" && approval.status === "pending" ? parseEvidence(approval.evidence) : null;
    const task = deps.store.getTask(approval.taskId);
    if (!evidence || !task || TERMINAL.has(task.status)) return c.json({ error: "no pending question with that id" }, 404);
    const checked = validateAnswers(evidence.questions, body.data.answers ?? answersFromText(evidence.questions, body.data.text?.trim() ?? ""));
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    // Answers are stored as typed (the automatic sealing of answers was removed on 2026-11-23, router-v0 §9).
    const r = deps.engine.answer(body.data.approval_id, { answers: checked.answers });
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.code === "not_found" ? 404 : 400);
  });

  // Opened on the phone (docs/control-v0.md §4): read, no longer unread.
  app.post("/tasks/:id/ack", (c) => {
    const task = deps.store.acknowledgeTask(c.req.param("id"));
    return task ? c.json({ acknowledgedAt: task.acknowledgedAt }) : c.json({ error: "task not found" }, 404);
  });

  app.get("/search", (c) => {
    const q = (c.req.query("q") ?? "").slice(0, 200);
    return c.json({ results: q.trim() ? deps.store.search(q, limitParam(c, SEARCH_LIMIT)) : [] });
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
