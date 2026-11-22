/** `Settings › Add-Ons` (profiles/addons.ts): what each profile of an agent has installed, and changing it. On this
 *  node only: installing an MCP server is naming a program this Mac will run. */

import type { Hono } from "hono";
import { z } from "zod";
import { remoteCaller } from "../core/caller.js";
import { ADDON_KINDS, AddonError, FILE_KINDS, type Addon, type AddonPlace } from "../profiles/addons.js";
import { DEFAULT_PROFILE } from "../profiles/store.js";
import { parseBody, type ApiDeps } from "./shared.js";

const Agent = z.enum(["claude-code", "codex"]);
const Profiles = z.array(z.string().min(1).max(40)).min(1).max(500);

export function mountAddons(app: Hono<any>, deps: ApiDeps): void {
  const store = deps.profiles, addons = deps.addons;
  if (!store || !addons) return;
  const local = (c: { env: unknown }) => !remoteCaller(c.env as never);
  /** The places of the profiles named; a name that is no profile's is refused whole. */
  const places = (agent: "claude-code" | "codex", ids: readonly string[]): AddonPlace[] | null => {
    const found = ids.map((id) => store.addonPlace(agent, id));
    return found.every((p): p is AddonPlace => p !== null) ? found : null;
  };
  const refused = (c: any, err: unknown) => c.json({ error: err instanceof AddonError ? err.message : (err as Error).message }, 400);

  app.get("/profiles/addons", async (c) => {
    const agent = Agent.safeParse(c.req.query("agent"));
    if (!agent.success) return c.json({ error: "agent: claude-code or codex" }, 400);
    const all = store.all()[agent.data].profiles;
    const own = await addons.list(store.addonPlace(agent.data, DEFAULT_PROFILE)!).catch((): Addon[] => []);
    const profiles = await Promise.all(all.map(async (p) => {
      if (p.id === DEFAULT_PROFILE) return { id: p.id, items: own };
      const place = store.addonPlace(agent.data, p.id);
      // No folder of its own (a Codex profile that pays by a key): the Mac's own, all of it.
      if (!place || !place.own) return { id: p.id, items: own.map((i) => ({ ...i, shared: true })) };
      return { id: p.id, items: await addons.list(place).catch((): Addon[] => []) };
    }));
    return c.json({ agent: agent.data, kinds: ADDON_KINDS[agent.data], profiles });
  });

  app.post("/profiles/addons/mcp/install", async (c) => {
    if (!local(c)) return c.json({ error: "on the Mac only" }, 403);
    const body = await parseBody(c, z.object({ agent: Agent, command: z.string().min(1).max(4000), profiles: Profiles }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    const at = places(body.data.agent, body.data.profiles);
    if (!at) return c.json({ error: "no such profile" }, 404);
    try { return c.json({ results: await addons.install(body.data.command, at) }); } catch (err) { return refused(c, err); }
  });

  app.post("/profiles/addons/mcp/remove", async (c) => {
    if (!local(c)) return c.json({ error: "on the Mac only" }, 403);
    const body = await parseBody(c, z.object({ agent: Agent, name: z.string().min(1).max(64), profiles: Profiles }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    const at = places(body.data.agent, body.data.profiles);
    if (!at) return c.json({ error: "no such profile" }, 404);
    try { return c.json({ results: await addons.removeMcp(body.data.name, at) }); } catch (err) { return refused(c, err); }
  });

  app.post("/profiles/addons/mcp/switch", async (c) => {
    if (!local(c)) return c.json({ error: "on the Mac only" }, 403);
    const body = await parseBody(c, z.object({ agent: Agent, name: z.string().min(1).max(64), on: z.boolean(), profiles: Profiles }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    const at = places(body.data.agent, body.data.profiles);
    if (!at) return c.json({ error: "no such profile" }, 404);
    try { return c.json({ results: await addons.switchMcp(body.data.name, body.data.on, at) }); } catch (err) { return refused(c, err); }
  });

  const Kind = z.enum(["skills", "agents", "commands", "prompts", "rules"]);
  app.post("/profiles/addons/copy", async (c) => {
    if (!local(c)) return c.json({ error: "on the Mac only" }, 403);
    const body = await parseBody(c, z.object({ agent: Agent, kind: Kind, name: z.string().min(1).max(80), from: z.string().min(1).max(40), profiles: Profiles }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    if (!ADDON_KINDS[body.data.agent].includes(body.data.kind) || !FILE_KINDS.has(body.data.kind)) return c.json({ error: "not a kind this agent keeps as files" }, 400);
    const from = store.addonPlace(body.data.agent, body.data.from), at = places(body.data.agent, body.data.profiles);
    if (!from || !at) return c.json({ error: "no such profile" }, 404);
    try { return c.json({ results: addons.copyFile(body.data.kind, body.data.name, from, at) }); } catch (err) { return refused(c, err); }
  });

  app.post("/profiles/addons/remove", async (c) => {
    if (!local(c)) return c.json({ error: "on the Mac only" }, 403);
    const body = await parseBody(c, z.object({ agent: Agent, kind: Kind, name: z.string().min(1).max(80), profiles: Profiles }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    if (!ADDON_KINDS[body.data.agent].includes(body.data.kind)) return c.json({ error: "not a kind this agent keeps as files" }, 400);
    const at = places(body.data.agent, body.data.profiles);
    if (!at) return c.json({ error: "no such profile" }, 404);
    try { return c.json({ results: addons.removeFile(body.data.kind, body.data.name, at) }); } catch (err) { return refused(c, err); }
  });
}
