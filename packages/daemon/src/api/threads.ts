/** Threads (threads-v0 §1, §9): list with folded state, detail with tasks, rename, archive (7-day expiry), reopen, delete. */

import type { Hono } from "hono";
import { z } from "zod";
import { TERMINAL } from "../engine/types.js";
import { foldThread } from "../threads/fold.js";
import type { Thread, ThreadStatus } from "../threads/types.js";
import { issues, limitParam, type ApiDeps } from "./shared.js";

/** Status changes go through /archive and /reopen (they check for running tasks and set the expiry). */
const ThreadPatch = z.object({ title: z.string().max(200).nullable().optional(), expires_at: z.number().int().nullable().optional() });

export function mountThreads(app: Hono, deps: ApiDeps): void {
  const view = (t: Thread) => {
    const state = foldThread(deps.store.threadEvents(t.id));
    return { ...t, title: t.title ?? state.title, summary: state.summary, lastTarget: state.lastTarget, lastActivity: state.lastActivity, taskCount: state.tasks.length, handoffs: state.handoffs.length };
  };
  app.get("/threads", (c) => {
    const status = c.req.query("status");
    const limit = limitParam(c, 50);
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
    const { title, expires_at } = body.data;
    const t = deps.store.updateThread(c.req.param("id"), { ...(title !== undefined ? { title } : {}), ...(expires_at !== undefined ? { expiresAt: expires_at } : {}) });
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
    const result = deps.engine.deleteThread(c.req.param("id"));
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.code === "not_found" ? 404 : 409);
  });
}

/** MCP servers and skills: the registry is the source of truth, executors read it on every run. */
