/** HTTP API. The phone is just another client of these routes; the CLI uses the same ones. */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Bus } from "../engine/bus.js";
import type { Extensions } from "../extensions/index.js";
import { HARNESSES, McpServer, SkillName } from "../extensions/types.js";
import { listTree, resolveInside } from "../files/artifacts.js";
import { contentType, isImage, MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD } from "../files/names.js";
import type { Attachment, Uploads } from "../files/uploads.js";
import type { Engine } from "../engine/engine.js";
import type { Store } from "../engine/store.js";
import { TERMINAL } from "../engine/types.js";
import type { QuotaService } from "../quota/index.js";
import { exampleContext, lintContext, loadContext } from "../router/context.js";
import type { RoutingLog } from "../router/log.js";
import { route, type RouteDeps } from "../router/route.js";
import { TargetRef, type Targets } from "../router/targets.js";
import { foldThread } from "../threads/fold.js";
import type { Thread, ThreadStatus } from "../threads/types.js";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";

const UI_DIR = resolve(new URL("../../ui/", import.meta.url).pathname);
const UI_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

/** A file under ui/ by its URL path, or null when it does not exist or escapes the directory. */
export function uiFile(urlPath: string): { body: string; type: string } | null {
  let rel: string;
  try { rel = decodeURIComponent(urlPath); } catch { return null; }
  const file = resolve(UI_DIR, "." + (rel === "" || rel === "/" ? "/index.html" : rel));
  if (file !== UI_DIR && !file.startsWith(UI_DIR + sep)) return null;
  const type = UI_TYPES[extname(file)];
  if (!type || !existsSync(file) || !statSync(file).isFile()) return null;
  return { body: readFileSync(file, "utf8"), type };
}

function newWorkDir(root: string): string {
  const dir = join(root, randomUUID().slice(0, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type ApiDeps = {
  readonly store: Store;
  readonly bus: Bus;
  readonly engine: Engine;
  readonly targets: Targets;
  readonly quota: QuotaService;
  readonly routingLog: RoutingLog;
  readonly routeDeps: () => RouteDeps;
  readonly contextPath: string;
  readonly workRoot: string;
  readonly uploads: Uploads;
  readonly artifactsDir: string;
  readonly extensions: Extensions;
  readonly version: string;
};

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
});
const HandoffBody = z.object({ to: TargetRef.optional() });
const ThreadPatch = z.object({ title: z.string().max(200).nullable().optional(), status: z.enum(["open", "archived"]).optional(), expires_at: z.number().int().nullable().optional() });
const ApproveBody = z.object({ approval_id: z.string().min(1), decision: z.enum(["allow", "deny"]) });
const ContextBody = z.object({ text: z.string() });
const SkillBody = z.object({ content: z.string().optional(), enabled: z.boolean().optional(), harnesses: z.array(z.enum(HARNESSES)).optional() });
const ImportBody = z.object({ path: z.string().min(1) });

const issues = (err: z.ZodError): string => err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

export function createApp(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, version: deps.version, pendingApprovals: deps.store.pendingApprovals().length }));

  // Development console / phone draft: one static page that only uses the API below.
  app.get("/", (c) => c.redirect("/ui"));
  app.get("/ui", (c) => c.html(uiFile("/index.html")!.body));
  app.get("/ui/*", (c) => {
    const f = uiFile(c.req.path.slice("/ui".length));
    return f ? c.body(f.body, 200, { "content-type": f.type, "cache-control": "no-cache" }) : c.notFound();
  });

  app.post("/tasks", async (c) => {
    const body = NewTaskBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    const { pin, needs_browser, ephemeral, cwd, parent_id, attachments: uploadIds, thread_id, ...rest } = body.data;
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
    const task = deps.engine.submit({ ...rest, cwd: workDir, ephemeral: isEphemeral, attachments, ...(parent ? { parentId: parent.id } : {}), ...(thread ? { threadId: thread.id } : {}), ...(pin ? { pin } : {}), ...(needs_browser !== undefined ? { needsBrowser: needs_browser } : {}) });
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

  mountThreads(app, deps);

  app.get("/tasks", (c) => c.json(deps.store.listTasks(Number(c.req.query("limit") ?? 50))));

  app.get("/tasks/:id", (c) => {
    const task = deps.store.getTask(c.req.param("id"));
    return task ? c.json({ ...task, approvals: deps.store.pendingApprovals(task.id) }) : c.json({ error: "not found" }, 404);
  });

  // Files: uploads are staged, then moved into <cwd>/in/ by POST /tasks; downloads come from the
  // artifacts store once an ephemeral cwd is gone, otherwise from the cwd itself.
  app.post("/uploads", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "multipart form expected" }, 400);
    const entries = [...form.values()].filter((v): v is File => v instanceof File);
    if (!entries.length) return c.json({ error: "no files" }, 400);
    if (entries.length > MAX_FILES_PER_UPLOAD) return c.json({ error: `at most ${MAX_FILES_PER_UPLOAD} files per upload` }, 400);
    const big = entries.find((f) => f.size > MAX_FILE_BYTES);
    if (big) return c.json({ error: `${big.name} exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB` }, 413);
    const files = [];
    for (const f of entries) files.push(deps.uploads.stage(f.name, Buffer.from(await f.arrayBuffer()), f.type));
    return c.json({ files });
  });

  const fileRoot = (id: string): { root: "artifacts" | "cwd"; dir: string } | null => {
    const task = deps.store.getTask(id);
    if (!task) return null;
    const art = join(deps.artifactsDir, task.id);
    if (existsSync(art)) return { root: "artifacts", dir: art };
    return existsSync(task.cwd) ? { root: "cwd", dir: task.cwd } : null;
  };

  app.get("/tasks/:id/files", (c) => {
    const task = deps.store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const r = fileRoot(task.id);
    return c.json({ root: r?.root ?? null, files: r ? listTree(r.dir) : [] });
  });

  app.get("/tasks/:id/files/*", (c) => {
    const r = fileRoot(c.req.param("id"));
    if (!r) return c.notFound();
    let rel: string;
    try { rel = decodeURIComponent(c.req.path.split("/files/")[1] ?? ""); } catch { return c.notFound(); }
    const file = resolveInside(r.dir, rel);
    if (!file) return c.notFound();
    const name = rel.split("/").pop() ?? "file";
    const disposition = `${isImage(name) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`;
    return c.body(readFileSync(file), 200, { "content-type": contentType(name), "content-disposition": disposition, "cache-control": "private, no-cache" });
  });

  app.get("/tasks/:id/events", (c) => {
    const id = c.req.param("id");
    const task = deps.store.getTask(id);
    if (!task) return c.json({ error: "not found" }, 404);
    const after = Number(c.req.query("after") ?? 0);
    return streamSSE(c, async (stream) => {
      let last = after;
      const send = async (ev: { seq: number; type: string; payload: unknown; ts: number }) => {
        if (ev.seq <= last) return;
        last = ev.seq;
        await stream.writeSSE({ id: String(ev.seq), event: ev.type, data: JSON.stringify({ ...ev, taskId: id }) });
      };
      for (const ev of deps.store.eventsSince(id, after)) await send(ev);
      if (TERMINAL.has(deps.store.getTask(id)!.status)) return;
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      const unsubscribe = deps.bus.subscribe(id, (ev) => {
        void send(ev).then(() => { if (ev.type === "done" || ev.type === "failed" || ev.type === "cancelled") done(); });
      });
      stream.onAbort(() => { unsubscribe(); done(); });
      await finished;
      unsubscribe();
    });
  });

  app.post("/tasks/:id/approve", async (c) => {
    const body = ApproveBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "approval_id and decision (allow|deny) required" }, 400);
    const ok = deps.engine.resolveApproval(body.data.approval_id, body.data.decision);
    return ok ? c.json({ ok: true }) : c.json({ error: "no pending approval with that id" }, 404);
  });

  app.post("/tasks/:id/cancel", (c) => {
    const task = deps.engine.cancel(c.req.param("id"));
    return task ? c.json(task) : c.json({ error: "not found" }, 404);
  });

  app.get("/approvals", (c) => c.json(deps.store.pendingApprovals()));

  app.post("/route/preview", async (c) => {
    const body = NewTaskBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "task and cwd required" }, 400);
    const { pin, needs_browser, ephemeral: _e, parent_id: _p, cwd, ...rest } = body.data;
    if (!cwd) return c.json({ error: "cwd required for preview" }, 400);
    const result = await route({ ...rest, cwd, ...(pin ? { pin } : {}), ...(needs_browser !== undefined ? { needsBrowser: needs_browser } : {}) }, deps.routeDeps());
    deps.routingLog.record(rest.task, cwd, result);
    return c.json(result);
  });

  app.get("/quota", async (c) => c.json(await deps.quota.refresh(c.req.query("refresh") === "1")));
  app.post("/quota/refresh", async (c) => c.json(await deps.quota.refresh(true)));

  app.get("/targets", (c) => c.json({ ...deps.targets, quota: deps.quota.map() }));
  app.get("/routing/log", (c) => c.json(deps.routingLog.recent(Number(c.req.query("limit") ?? 50))));

  app.get("/context/example", (c) => c.json({ text: exampleContext() }));
  app.get("/context", (c) => {
    const ctx = loadContext(deps.contextPath);
    return c.json({ path: deps.contextPath, text: ctx.text, warnings: ctx.warnings });
  });
  app.put("/context", async (c) => {
    const body = ContextBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "text required" }, 400);
    const lint = lintContext(body.data.text);
    writeFileSync(deps.contextPath, lint.text, { mode: 0o600 }); // the stripped lines never reach disk
    return c.json({ path: deps.contextPath, warnings: lint.warnings });
  });

  mountExtensions(app, deps.extensions);
  return app;
}

/** Threads (threads-v0 §1, §9): list with folded state, detail with tasks, rename, archive (7-day expiry), reopen, delete. */
function mountThreads(app: Hono, deps: ApiDeps): void {
  const view = (t: Thread) => {
    const state = foldThread(deps.store.threadEvents(t.id));
    return { ...t, title: t.title ?? state.title, summary: state.summary, lastTarget: state.lastTarget, lastActivity: state.lastActivity, taskCount: state.tasks.length, handoffs: state.handoffs.length };
  };
  app.get("/threads", (c) => {
    const status = c.req.query("status");
    const limit = Number(c.req.query("limit") ?? 50);
    const opts: { limit: number; status?: ThreadStatus } = status === "open" || status === "archived" ? { limit, status } : { limit };
    return c.json(deps.store.listThreads(opts).map(view));
  });
  app.get("/threads/:id", (c) => {
    const t = deps.store.getThread(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    return c.json({ ...view(t), state: foldThread(deps.store.threadEvents(t.id)), tasks: deps.store.tasksInThread(t.id), events: deps.store.threadEvents(t.id) });
  });
  app.patch("/threads/:id", async (c) => {
    const body = ThreadPatch.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    if (!deps.store.getThread(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    const { title, status, expires_at } = body.data;
    const t = deps.store.updateThread(c.req.param("id"), { ...(title !== undefined ? { title } : {}), ...(status !== undefined ? { status } : {}), ...(expires_at !== undefined ? { expiresAt: expires_at } : {}) });
    if (title !== undefined && title) deps.store.appendThreadEvent(t.id, "title", { title });
    return c.json(view(t));
  });
  app.post("/threads/:id/archive", (c) => {
    const id = c.req.param("id");
    if (!deps.store.getThread(id)) return c.json({ error: "not found" }, 404);
    const active = deps.store.tasksInThread(id).find((t) => !TERMINAL.has(t.status));
    if (active) return c.json({ error: `task ${active.id} is still ${active.status}; cancel it first` }, 409);
    return c.json(view(deps.store.archiveThread(id)));
  });
  app.post("/threads/:id/reopen", (c) => {
    const id = c.req.param("id");
    return deps.store.getThread(id) ? c.json(view(deps.store.reopenThread(id))) : c.json({ error: "not found" }, 404);
  });
  app.delete("/threads/:id", (c) => {
    const id = c.req.param("id");
    const active = deps.store.tasksInThread(id).find((t) => !TERMINAL.has(t.status));
    if (active) return c.json({ error: `task ${active.id} is still ${active.status}; cancel it first` }, 409);
    return deps.store.deleteThread(id) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });
}

/** MCP servers and skills: the registry is the source of truth, executors read it on every run. */
function mountExtensions(app: Hono, ext: Extensions): void {
  app.get("/mcp", (c) => c.json(ext.mcp.list()));
  app.put("/mcp/:name", async (c) => {
    const body = McpServer.safeParse({ ...(await c.req.json().catch(() => ({}))), name: c.req.param("name") });
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    return c.json(ext.mcp.upsert(body.data));
  });
  app.delete("/mcp/:name", (c) => (ext.mcp.remove(c.req.param("name")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));

  app.get("/skills", (c) => c.json(ext.skills.list()));
  app.get("/skills/discover", (c) => c.json(ext.skills.discover()));
  app.post("/skills/import", async (c) => {
    const body = ImportBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    try { return c.json(ext.skills.importFrom(body.data.path), 201); } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });
  app.get("/skills/:name", (c) => {
    const name = c.req.param("name");
    const skill = ext.skills.get(name);
    return skill ? c.json({ ...skill, content: ext.skills.content(name) }) : c.json({ error: "not found" }, 404);
  });
  app.put("/skills/:name", async (c) => {
    const name = SkillName.safeParse(c.req.param("name"));
    if (!name.success) return c.json({ error: issues(name.error) }, 400);
    const body = SkillBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    try { return c.json(ext.skills.write(name.data, body.data)); } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });
  app.delete("/skills/:name", (c) => (ext.skills.remove(c.req.param("name")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));
}
