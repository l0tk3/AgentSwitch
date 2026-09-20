/** HTTP API. The phone is just another client of these routes; the CLI uses the same ones. */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Bus } from "../engine/bus.js";
import type { Engine } from "../engine/engine.js";
import type { Store } from "../engine/store.js";
import { TERMINAL } from "../engine/types.js";
import type { QuotaService } from "../quota/index.js";
import { lintContext, loadContext } from "../router/context.js";
import type { RoutingLog } from "../router/log.js";
import { route, type RouteDeps } from "../router/route.js";
import { TargetRef, type Targets } from "../router/targets.js";
import { writeFileSync } from "node:fs";

export type ApiDeps = {
  readonly store: Store;
  readonly bus: Bus;
  readonly engine: Engine;
  readonly targets: Targets;
  readonly quota: QuotaService;
  readonly routingLog: RoutingLog;
  readonly routeDeps: () => RouteDeps;
  readonly contextPath: string;
  readonly version: string;
};

const NewTaskBody = z.object({
  task: z.string().min(1),
  cwd: z.string().min(1),
  pin: TargetRef.optional(),
  needs_browser: z.boolean().optional(),
});
const ApproveBody = z.object({ approval_id: z.string().min(1), decision: z.enum(["allow", "deny"]) });
const ContextBody = z.object({ text: z.string() });

export function createApp(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, version: deps.version, pendingApprovals: deps.store.pendingApprovals().length }));

  app.post("/tasks", async (c) => {
    const body = NewTaskBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    const { pin, needs_browser, ...rest } = body.data;
    const task = deps.engine.submit({ ...rest, ...(pin ? { pin } : {}), ...(needs_browser !== undefined ? { needsBrowser: needs_browser } : {}) });
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
    const { pin, needs_browser, ...rest } = body.data;
    const result = await route({ ...rest, ...(pin ? { pin } : {}), ...(needs_browser !== undefined ? { needsBrowser: needs_browser } : {}) }, deps.routeDeps());
    deps.routingLog.record(rest.task, rest.cwd, result);
    return c.json(result);
  });

  app.get("/quota", async (c) => c.json(await deps.quota.refresh(c.req.query("refresh") === "1")));
  app.post("/quota/refresh", async (c) => c.json(await deps.quota.refresh(true)));

  app.get("/targets", (c) => c.json({ ...deps.targets, quota: deps.quota.map() }));
  app.get("/routing/log", (c) => c.json(deps.routingLog.recent(Number(c.req.query("limit") ?? 50))));

  app.get("/context", (c) => {
    const ctx = loadContext(deps.contextPath);
    return c.json({ path: deps.contextPath, text: ctx.text, warnings: ctx.warnings });
  });
  app.put("/context", async (c) => {
    const body = ContextBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "text required" }, 400);
    const lint = lintContext(body.data.text);
    writeFileSync(deps.contextPath, body.data.text);
    return c.json({ path: deps.contextPath, warnings: lint.warnings });
  });

  return app;
}
