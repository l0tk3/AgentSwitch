/** HTTP API. The phone is just another client of these routes; the CLI uses the same ones. */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Bus } from "../engine/bus.js";
import type { Extensions } from "../extensions/index.js";
import { HARNESSES, McpServer, SkillName } from "../extensions/types.js";
import type { Engine } from "../engine/engine.js";
import type { Store } from "../engine/store.js";
import { TERMINAL } from "../engine/types.js";
import type { QuotaService } from "../quota/index.js";
import { exampleContext, lintContext, loadContext } from "../router/context.js";
import type { RoutingLog } from "../router/log.js";
import { route, type RouteDeps } from "../router/route.js";
import { TargetRef, type Targets } from "../router/targets.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const UI_PATH = new URL("../../ui/index.html", import.meta.url).pathname;

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
});
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
  app.get("/ui", (c) => c.html(readFileSync(UI_PATH, "utf8")));

  app.post("/tasks", async (c) => {
    const body = NewTaskBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    const { pin, needs_browser, ephemeral, cwd, parent_id, ...rest } = body.data;
    const parent = parent_id ? deps.store.getTask(parent_id) : undefined;
    if (parent_id && !parent) return c.json({ error: "parent task not found" }, 404);
    const inherited = parent && !parent.ephemeral ? parent.cwd : undefined;
    const workDir = cwd ?? inherited ?? newWorkDir(deps.workRoot);
    const isEphemeral = ephemeral ?? (cwd === undefined && inherited === undefined);
    const task = deps.engine.submit({ ...rest, cwd: workDir, ephemeral: isEphemeral, ...(parent ? { parentId: parent.id } : {}), ...(pin ? { pin } : {}), ...(needs_browser !== undefined ? { needsBrowser: needs_browser } : {}) });
    return c.json(task, 201);
  });

  app.get("/tasks", (c) => c.json(deps.store.listTasks(Number(c.req.query("limit") ?? 50))));

  app.get("/tasks/:id", (c) => {
    const task = deps.store.getTask(c.req.param("id"));
    return task ? c.json({ ...task, approvals: deps.store.pendingApprovals(task.id) }) : c.json({ error: "not found" }, 404);
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
