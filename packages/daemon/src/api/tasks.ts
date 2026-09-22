/** Tasks: create, list, show, follow the event stream, approve / answer / cancel, hand off. */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ApprovalPolicy } from "../engine/approvalPolicy.js";
import { TERMINAL, type TaskEvent } from "../engine/types.js";
import { MAX_FILES_PER_UPLOAD } from "../files/names.js";
import type { Attachment } from "../files/uploads.js";
import { TargetRef } from "../router/targets.js";
import { checkCwd } from "./cwdPolicy.js";
import { issues, newWorkDir, limitParam, type ApiDeps } from "./shared.js";

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
const AnswerBody = z.object({ approval_id: z.string().min(1), text: z.string().min(1).max(4000) });
const HandoffBody = z.object({ to: TargetRef.optional() });
const ApproveBody = z.object({ approval_id: z.string().min(1), decision: z.enum(["allow", "deny"]) });
const RateBody = z.object({ rating: z.union([z.literal(1), z.literal(-1), z.null()]) });

export function mountTasks(app: Hono, deps: ApiDeps): void {
  app.post("/tasks", async (c) => {
    const body = NewTaskBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    const { pin, needs_browser, ephemeral, cwd, parent_id, attachments: uploadIds, thread_id, approval, ...rest } = body.data;
    const cwdProblem = cwd ? checkCwd(cwd, deps.cwdRules) : null;
    if (cwdProblem) return c.json({ error: cwdProblem }, 400);
    const parent = parent_id ? deps.store.getTask(parent_id) : undefined;
    if (parent_id && !parent) return c.json({ error: "parent task not found" }, 404);
    const thread = thread_id ? deps.store.getThread(thread_id) : undefined;
    if (thread_id && !thread) return c.json({ error: "thread not found" }, 404);
    if (thread?.status === "archived") return c.json({ error: "thread is archived; reopen it first" }, 409);
    const inherited = parent && !parent.ephemeral ? parent.cwd : undefined;
    const workDir = cwd ?? inherited ?? newWorkDir(deps.workRoot);
    const isEphemeral = ephemeral ?? (cwd === undefined && inherited === undefined);
    let attachments: Attachment[] = [];
    try { attachments = uploadIds?.length ? deps.uploads.moveInto(uploadIds, workDir) : []; }
    catch (err) { return c.json({ error: (err as Error).message }, 400); }
    const task = deps.engine.submit({ ...rest, cwd: workDir, ephemeral: isEphemeral, attachments, ...(parent ? { parentId: parent.id } : {}), ...(thread ? { threadId: thread.id } : {}), ...(pin ? { pin } : {}), ...(needs_browser !== undefined ? { needsBrowser: needs_browser } : {}), ...(approval ? { approval } : {}) });
    return c.json(task, 201);
  });

  // "Hand this to someone else": a follow-up in the same thread, excluding the current executor unless `to` pins one.
  app.post("/tasks/:id/handoff", async (c) => {
    const body = HandoffBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    const task = deps.store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const thread = task.threadId ? deps.store.getThread(task.threadId) : undefined;
    if (thread?.status === "archived") return c.json({ error: "thread is archived; reopen it first" }, 409);
    // An ephemeral work dir is wiped when its task ends, so the successor gets a fresh one (as follow-ups do).
    const next = deps.engine.handoff(task.id, { ...(body.data.to ? { to: body.data.to } : {}), ...(task.ephemeral ? { cwd: newWorkDir(deps.workRoot), ephemeral: true } : {}) });
    return next ? c.json(next, 201) : c.json({ error: "not found" }, 404);
  });

  app.get("/tasks", (c) => c.json(deps.store.listTasks(limitParam(c, 50))));

  app.get("/tasks/:id", (c) => {
    const task = deps.store.getTask(c.req.param("id"));
    return task ? c.json({ ...task, approvals: deps.store.pendingApprovals(task.id) }) : c.json({ error: "not found" }, 404);
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
      const ends = (type: string) => type === "done" || type === "failed" || type === "cancelled";
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
      if (ended || TERMINAL.has(deps.store.getTask(id)!.status)) { unsubscribe(); return; }
      stream.onAbort(() => { unsubscribe(); done(); });
      await finished;
      unsubscribe();
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
    if (!body.success) return c.json({ error: "approval_id and text required" }, 400);
    const ok = owned(c, body.data.approval_id) && deps.engine.answer(body.data.approval_id, body.data.text);
    return ok ? c.json({ ok: true }) : c.json({ error: "no pending question with that id" }, 404);
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
