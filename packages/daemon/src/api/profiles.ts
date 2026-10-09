/** Profiles over HTTP (docs/profiles-v0.md §3): every agent's list with its current one; a new one, one removed, a
 *  profile's colour — on this Mac only; which one is current, a profile's own proxy (§4.2: its password a ciphertext,
 *  as from the Mac) and that proxy's exit checked — from a paired device too. */

import type { Hono } from "hono";
import { z } from "zod";
import { checkedProxy, ExitError, ExitPool } from "../browser/exits.js";
import { proxyPlace } from "../browser/identity.js";
import { remoteCaller } from "../core/caller.js";
import { PROFILE_AGENTS, PROFILE_COLORS, ProfileError, type ProfileAgent, type ProfileProxy } from "../profiles/store.js";
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
    const agent = Agent.safeParse(c.req.param("agent"));
    if (!agent.success) return c.json({ error: "no such agent" }, 404);
    const id = c.req.param("id"), key = exitKey(agent.data, id);
    const body = await parseBody(c, z.object({ server: z.string().max(300).nullable(), username: z.string().max(200).optional(), password: z.string().max(4000).optional(), keepPassword: z.boolean().optional() }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    if (!deps.exits) return c.json({ error: "this service cannot give a profile a proxy" }, 503);
    try {
      if (body.data.server === null || !body.data.server.trim()) {
        store.setProxy(agent.data, id, null);
        await deps.profileBrowsers?.drop(key);
        await deps.exits.drop(key);
        return c.json({ agents: store.all() });
      }
      // No password typed and the same user as before: the ciphertext kept stays (it is never sent back to the screens).
      const before = store.proxyOf(agent.data, id);
      const password = body.data.password?.trim() || (body.data.keepPassword && before?.username === body.data.username?.trim() ? before?.password : undefined);
      const proxy = checkedProxy({ server: body.data.server, username: body.data.username, password });
      store.setProxy(agent.data, id, proxy);   // refuses one that is not there before anything listens for it
      const problem = await checked(store, deps.exits, agent.data, id, proxy);
      // With Clash's TUN on, the way to the proxy itself must not be through another node (docs/clash-v0.md §3).
      const place = proxyPlace(proxy.server);
      if (place) await deps.clash?.addDirect(place.host).catch(() => undefined);
      return c.json({ agents: store.all(), ...(problem ? { problem } : {}) });
    } catch (err) {
      if (err instanceof ExitError) return c.json({ error: err.message }, 400);
      const f = failed(err); return c.json({ error: f.error }, f.status);
    }
  });

  // A profile's colour (§3.2): the dot its terminals are marked with on every screen.
  app.put("/profiles/:agent/:id/color", async (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "a profile's colour is set on the Mac" }, 403);
    const agent = Agent.safeParse(c.req.param("agent"));
    if (!agent.success) return c.json({ error: "no such agent" }, 404);
    const body = await parseBody(c, z.object({ color: z.enum(PROFILE_COLORS) }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    try { store.setColor(agent.data, c.req.param("id"), body.data.color); } catch (err) { const f = failed(err); return c.json({ error: f.error }, f.status); }
    // The terminals already open under it change their dot with it.
    deps.terminals?.host.recolor(agent.data, c.req.param("id"), body.data.color);
    return c.json({ agents: store.all() });
  });

  // Where a profile's proxy lets traffic out, asked now.
  app.post("/profiles/:agent/:id/check", async (c) => {
    const agent = Agent.safeParse(c.req.param("agent"));
    if (!agent.success) return c.json({ error: "no such agent" }, 404);
    const id = c.req.param("id"), proxy = store.proxyOf(agent.data, id);
    if (!proxy || !deps.exits) return c.json({ error: "这个配置没有自己的代理。" }, 404);
    const problem = await checked(store, deps.exits, agent.data, id, proxy);
    return c.json({ agents: store.all(), ...(problem ? { problem } : {}) });
  });

  app.delete("/profiles/:agent/:id", (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "profiles are removed on the Mac" }, 403);
    const agent = Agent.safeParse(c.req.param("agent"));
    if (!agent.success) return c.json({ error: "no such agent" }, 404);
    const id = c.req.param("id");
    // A terminal still running under it keeps its folder in use.
    if (deps.terminals?.host.list().some((t) => t.harness === agent.data && t.profile?.id === id && t.status !== "exited")) return c.json({ error: "有终端还在用这个配置：先结束它们。" }, 409);
    try { store.remove(agent.data, id); } catch (err) { const f = failed(err); return c.json({ error: f.error }, f.status); }
    void deps.profileBrowsers?.drop(exitKey(agent.data, id));
    void deps.exits?.drop(exitKey(agent.data, id));
    return c.json({ agents: store.all() });
  });
}

/** A profile's proxy asked where it lets traffic out, and the answer kept with the profile. What to say when it is
 *  not known: that nothing got out, or that it did but no lookup would name the address; null when it is known. */
async function checked(store: NonNullable<ApiDeps["profiles"]>, exits: ExitPool, agent: ProfileAgent, id: string, proxy: ProfileProxy): Promise<string | null> {
  try {
    const exit = await exits.check(exitKey(agent, id), proxy);
    store.setExit(agent, id, exit.ip ? { ...exit, checkedAt: Date.now() } : null);
    return exit.ip ? null : "代理是通的，但几个出口查询都没有给出地址，所以不知道从哪里出去。";
  } catch (err) {
    store.setExit(agent, id, null);
    return err instanceof ExitError ? err.message : "没有查到出口。";
  }
}

/** A profile's exit in the pool. */
export function exitKey(agent: string, id: string): string { return `${agent}.${id}`; }

/** Before profile `key`'s own browser is started: its proxy asked where it lets traffic out, as before a terminal is
 *  (docs/profiles-v0.md §5.3). Null when it does (or the key has no proxy to ask); else why nothing was opened. */
export async function browserExitProblem(deps: Pick<ApiDeps, "profiles" | "exits">, key: string, now: () => number = Date.now): Promise<string | null> {
  const p = profileOfKey(key);
  const proxy = p ? deps.profiles?.proxyOf(p.agent, p.id) ?? null : null;
  if (!p || !proxy || !deps.exits) return null;
  try {
    const exit = await deps.exits.check(key, proxy);
    deps.profiles!.setExit(p.agent, p.id, exit.ip ? { ...exit, checkedAt: now() } : null);
    return null;
  } catch (err) {
    deps.profiles!.setExit(p.agent, p.id, null);
    return `配置 ${deps.profiles!.nameOf(p.agent, p.id) ?? p.id} 的代理没有通，浏览器没有开：${err instanceof ExitError ? err.message : (err as Error).message}`;
  }
}

/** The profile a key stands for; null for what is not a key. */
export function profileOfKey(key: string): { agent: ProfileAgent; id: string } | null {
  const at = key.lastIndexOf(".");
  const agent = PROFILE_AGENTS.find((a) => a === key.slice(0, at));
  return agent && at > 0 ? { agent, id: key.slice(at + 1) } : null;
}

/** What something about to start under profile `id` is given of its way out: for a profile without a proxy of its
 *  own, its own browser and nothing else; else — once the proxy has just said where it lets traffic out — the forwarder to send everything
 *  through and that place. A proxy that does not answer starts nothing: `refused` says why (docs/profiles-v0.md §4). */
export async function exitFor(deps: Pick<ApiDeps, "profiles" | "exits" | "profileBrowsers">, agent: ProfileAgent, id: string, name: string,
                              now: () => number = Date.now): Promise<{ proxy?: string; exit?: { ip: string; place: string | null }; browserKey?: string } | { refused: string; status: 502 | 503 }> {
  const proxy = deps.profiles?.proxyOf(agent, id) ?? null;
  const key = exitKey(agent, id);
  // No proxy of its own: it leaves as this Mac does. It has a browser of its own all the same (§5.5) — its sign-in
  // is not to land in a browser where somebody else is signed in — where that browser shows a window on this Mac
  // (one nobody can see is no place to sign in: then things stay as they were, the system's browser).
  if (!proxy) return deps.profileBrowsers?.of(key)?.visible() ? { browserKey: key } : {};
  if (!deps.exits) return { refused: `配置 ${name} 有自己的代理，这个服务用不了它。`, status: 503 };
  try {
    const exit = await deps.exits.check(key, proxy);
    // The proxy lets traffic out; where, when a lookup would say (none saying does not keep the terminal shut).
    deps.profiles!.setExit(agent, id, exit.ip ? { ...exit, checkedAt: now() } : null);
    // With a proxy of its own it has a browser of its own too, through the same forwarder (§5.1).
    return { proxy: ExitPool.url(await deps.exits.address(key, proxy)), ...(exit.ip ? { exit: { ip: exit.ip, place: exit.place } } : {}), browserKey: key };
  } catch (err) {
    deps.profiles!.setExit(agent, id, null);
    return { refused: `配置 ${name} 的代理没有通，终端没有开：${err instanceof ExitError ? err.message : (err as Error).message}`, status: 502 };
  }
}
