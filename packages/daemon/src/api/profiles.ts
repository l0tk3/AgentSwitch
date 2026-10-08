/** Profiles over HTTP (docs/profiles-v0.md §3): every agent's list with its current one; a new one, one removed —
 *  on this Mac only; which one is current — from a paired device too. */

import type { Hono } from "hono";
import { z } from "zod";
import { remoteCaller } from "../core/caller.js";
import { PROFILE_AGENTS, ProfileError } from "../profiles/store.js";
import { parseBody, type ApiDeps } from "./shared.js";

const Agent = z.enum(PROFILE_AGENTS);
const failed = (err: unknown): { status: 400 | 404 | 409; error: string } =>
  err instanceof ProfileError ? { status: err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400, error: err.message } : { status: 400, error: (err as Error).message };

export function mountProfiles(app: Hono<any>, deps: ApiDeps): void {
  const store = deps.profiles;
  if (!store) return;

  app.get("/profiles", (c) => c.json({ agents: store.all() }));

  app.post("/profiles/current", async (c) => {
    const body = await parseBody(c, z.object({ agent: Agent, id: z.string().min(1).max(40) }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    try { store.setCurrent(body.data.agent, body.data.id); } catch (err) { const f = failed(err); return c.json({ error: f.error }, f.status); }
    return c.json({ agents: store.all() });
  });

  app.post("/profiles", async (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "profiles are made on the Mac" }, 403);
    const body = await parseBody(c, z.object({ agent: Agent, name: z.string().min(1).max(80), kind: z.enum(["subscription", "api"]).default("subscription") }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const profile = store.create(body.data.agent, body.data.name, body.data.kind);
      return c.json({ profile, agents: store.all() }, 201);
    } catch (err) { const f = failed(err); return c.json({ error: f.error }, f.status); }
  });

  app.delete("/profiles/:agent/:id", (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "profiles are removed on the Mac" }, 403);
    const agent = Agent.safeParse(c.req.param("agent"));
    if (!agent.success) return c.json({ error: "no such agent" }, 404);
    const id = c.req.param("id");
    // A terminal still running under it keeps its folder in use.
    if (deps.terminals?.host.list().some((t) => t.harness === agent.data && t.profile?.id === id && t.status !== "exited")) return c.json({ error: "有终端还在用这个配置：先结束它们。" }, 409);
    try { store.remove(agent.data, id); } catch (err) { const f = failed(err); return c.json({ error: f.error }, f.status); }
    return c.json({ agents: store.all() });
  });
}
