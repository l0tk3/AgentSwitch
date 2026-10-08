/** Profiles over HTTP (docs/profiles-v0.md §3): every agent's list with its current one; a new one, one removed, a
 *  profile's own proxy — on this Mac only; which one is current, and a proxy's exit checked — from a paired device too. */

import type { Hono } from "hono";
import { z } from "zod";
import { checkedProxy, ExitError, ExitPool } from "../browser/exits.js";
import { proxyPlace } from "../browser/identity.js";
import { remoteCaller } from "../core/caller.js";
import { PROFILE_AGENTS, ProfileError, type ProfileAgent } from "../profiles/store.js";
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

  // A profile's own proxy (§4): set, changed or taken away. It is checked at once — where it lets traffic out is
  // kept with the profile, or that it does not is said; the proxy is kept either way (it may be down for now).
  app.put("/profiles/:agent/:id/proxy", async (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "a profile's proxy is set on the Mac" }, 403);
    const agent = Agent.safeParse(c.req.param("agent"));
    if (!agent.success) return c.json({ error: "no such agent" }, 404);
    const id = c.req.param("id"), key = exitKey(agent.data, id);
    const body = await parseBody(c, z.object({ server: z.string().max(300).nullable(), username: z.string().max(200).optional(), password: z.string().max(4000).optional(), keepPassword: z.boolean().optional() }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    if (!deps.exits) return c.json({ error: "this service cannot give a profile a proxy" }, 503);
    try {
      if (body.data.server === null || !body.data.server.trim()) {
        store.setProxy(agent.data, id, null);
        await deps.exits.drop(key);
        return c.json({ agents: store.all() });
      }
      // No password typed and the same user as before: the ciphertext kept stays (it is never sent back to the screens).
      const before = store.proxyOf(agent.data, id);
      const password = body.data.password?.trim() || (body.data.keepPassword && before?.username === body.data.username?.trim() ? before?.password : undefined);
      const proxy = checkedProxy({ server: body.data.server, username: body.data.username, password });
      store.setProxy(agent.data, id, proxy);   // refuses one that is not there before anything listens for it
      let problem: string | null = null;
      try { store.setExit(agent.data, id, { ...(await deps.exits.check(key, proxy)), checkedAt: Date.now() }); }
      catch (err) { problem = err instanceof ExitError ? err.message : "没有查到出口。"; }
      // With Clash's TUN on, the way to the proxy itself must not be through another node (docs/clash-v0.md §3).
      const place = proxyPlace(proxy.server);
      if (place) await deps.clash?.addDirect(place.host).catch(() => undefined);
      return c.json({ agents: store.all(), ...(problem ? { problem } : {}) });
    } catch (err) {
      if (err instanceof ExitError) return c.json({ error: err.message }, 400);
      const f = failed(err); return c.json({ error: f.error }, f.status);
    }
  });

  // Where a profile's proxy lets traffic out, asked now.
  app.post("/profiles/:agent/:id/check", async (c) => {
    const agent = Agent.safeParse(c.req.param("agent"));
    if (!agent.success) return c.json({ error: "no such agent" }, 404);
    const id = c.req.param("id"), proxy = store.proxyOf(agent.data, id);
    if (!proxy || !deps.exits) return c.json({ error: "这个配置没有自己的代理。" }, 404);
    try {
      store.setExit(agent.data, id, { ...(await deps.exits.check(exitKey(agent.data, id), proxy)), checkedAt: Date.now() });
      return c.json({ agents: store.all() });
    } catch (err) {
      store.setExit(agent.data, id, null);
      return c.json({ agents: store.all(), problem: err instanceof ExitError ? err.message : "没有查到出口。" });
    }
  });

  app.delete("/profiles/:agent/:id", (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "profiles are removed on the Mac" }, 403);
    const agent = Agent.safeParse(c.req.param("agent"));
    if (!agent.success) return c.json({ error: "no such agent" }, 404);
    const id = c.req.param("id");
    // A terminal still running under it keeps its folder in use.
    if (deps.terminals?.host.list().some((t) => t.harness === agent.data && t.profile?.id === id && t.status !== "exited")) return c.json({ error: "有终端还在用这个配置：先结束它们。" }, 409);
    try { store.remove(agent.data, id); } catch (err) { const f = failed(err); return c.json({ error: f.error }, f.status); }
    void deps.exits?.drop(exitKey(agent.data, id));
    return c.json({ agents: store.all() });
  });
}

/** A profile's exit in the pool. */
export function exitKey(agent: string, id: string): string { return `${agent}/${id}`; }

/** What something about to start under profile `id` is given of its way out: nothing for a profile without a proxy
 *  of its own; else — once the proxy has just said where it lets traffic out — the forwarder to send everything
 *  through and that place. A proxy that does not answer starts nothing: `refused` says why (docs/profiles-v0.md §4). */
export async function exitFor(deps: Pick<ApiDeps, "profiles" | "exits">, agent: ProfileAgent, id: string, name: string,
                              now: () => number = Date.now): Promise<{ proxy?: string; exit?: { ip: string; place: string | null } } | { refused: string; status: 502 | 503 }> {
  const proxy = deps.profiles?.proxyOf(agent, id) ?? null;
  if (!proxy) return {};
  if (!deps.exits) return { refused: `配置 ${name} 有自己的代理，这个服务用不了它。`, status: 503 };
  const key = exitKey(agent, id);
  try {
    const exit = await deps.exits.check(key, proxy);
    deps.profiles!.setExit(agent, id, { ...exit, checkedAt: now() });
    return { proxy: ExitPool.url(await deps.exits.address(key, proxy)), exit: { ip: exit.ip, place: exit.place } };
  } catch (err) {
    deps.profiles!.setExit(agent, id, null);
    return { refused: `配置 ${name} 的代理没有通，终端没有开：${err instanceof ExitError ? err.message : (err as Error).message}`, status: 502 };
  }
}
