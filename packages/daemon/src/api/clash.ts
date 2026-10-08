/** Clash Integration over HTTP (docs/clash-v0.md §7). For the screens, on this Mac only: what was found and what
 *  runs, the subscription to work from, the settings, a node picked, delays, an update. For Clash Verge and its core,
 *  by the token their addresses carry and nothing else: the subscription AgentSwitch makes, its rule sets and node
 *  sets, and its copy of the node sets the subscription names. */

import type { Context, Hono } from "hono";
import { z } from "zod";
import { remoteCaller } from "../core/caller.js";
import { CLASH_SERVICES, CLASH_TEMPLATES, UPDATE_HOURS } from "../clash/build.js";
import { MAX_RULES } from "../clash/rules.js";
import { ClashRefused, ClashSourceError, type ClashIntegration } from "../clash/integration.js";
import { parseBody, type ApiDeps } from "./shared.js";

/** The addresses Clash Verge and its core fetch: open to whoever has the token, on this Mac's loopback alone. */
export const CLASH_FETCHED = /^\/clash\/(?:sub\.yaml|(?:rules|nodes|providers)\/[\w-]{1,200}\.yaml)$/;

const Service = z.object({ nodes: z.array(z.string().min(1).max(200)).max(32) });
/** A template: on or off, and its rules if they are the user's own (lines as written; which of them is not a rule
 *  is said by the service). */
const Template = z.object({ on: z.boolean(), rules: z.array(z.string().max(1000)).max(MAX_RULES * 2).nullable() });
const Settings = z.object({ claude: Service, openai: Service, direct: z.array(z.string().min(1).max(200)).max(64),
  autoUpdateHours: z.number().refine((n) => (UPDATE_HOURS as readonly number[]).includes(n)),
  templates: z.object({ domestic: Template, block: Template }), renameDefault: z.boolean(),
  dns: z.object({ on: z.boolean(), text: z.string().max(64 * 1024).nullable() }) });
const Source = z.union([
  z.object({ link: z.string().min(8).max(4000) }).strict(),
  z.object({ yaml: z.string().min(1).max(8_000_000), name: z.string().max(200) }).strict(),
  z.object({ verge: z.string().regex(/^[A-Za-z0-9]{6,32}$/) }).strict(),
]);
const Select = z.object({ service: z.enum(CLASH_SERVICES), node: z.string().min(1).max(200).nullable() });
const Delays = z.object({ service: z.enum(CLASH_SERVICES), scope: z.enum(["chosen", "all"]) });
/** A YAML answer's headers, made anew each time: the listener writes into the object it is given (a length), and a
 *  shared one answered the second request with `v is not iterable` (seen with the real listener, 2026-10-08). */
const yaml = (more: Record<string, string> = {}): Record<string, string> => ({ "content-type": "text/yaml; charset=utf-8", ...more });

export function mountClash(app: Hono<any>, deps: ApiDeps): void {
  const clash: ClashIntegration | undefined = deps.clash;
  if (!clash) return;
  const mac = (c: Context): Response | null => (remoteCaller(c.env) ? c.json({ error: "Clash is set up on the Mac" }, 403) : null);
  /** What the subscription service or Clash said no to is the answer; anything else is this service's fault. */
  const said = async <T>(c: Context, work: () => Promise<T>): Promise<Response> => {
    try { return c.json(await work() as object); }
    catch (err) { if (err instanceof ClashRefused || err instanceof ClashSourceError) return c.json({ error: err.message }, 400); throw err; }
  };

  app.get("/clash", async (c) => mac(c) ?? c.json(await clash.view()));

  app.put("/clash/settings", async (c) => {
    const no = mac(c); if (no) return no;
    const body = await parseBody(c, Settings);
    return body.ok ? said(c, () => clash.saveSettings(body.data)) : c.json({ error: body.error }, 400);
  });

  // A template's rules as they are in use, to edit them.
  app.get("/clash/templates/:name", (c) => {
    const no = mac(c); if (no) return no;
    const name = CLASH_TEMPLATES.find((t) => t === c.req.param("name"));
    return name ? c.json(clash.template(name)) : c.notFound();
  });

  // The routing check: a connection of each kind through the core, and what the core did with it.
  app.post("/clash/check", async (c) => mac(c) ?? said(c, () => clash.check()));

  // The DNS template's text as it is in use, to edit it.
  app.get("/clash/dns", (c) => mac(c) ?? c.json(clash.dns()));

  app.post("/clash/source", async (c) => {
    const no = mac(c); if (no) return no;
    const body = await parseBody(c, Source);
    return body.ok ? said(c, () => clash.setSource(body.data)) : c.json({ error: body.error }, 400);
  });

  app.delete("/clash/source", async (c) => mac(c) ?? c.json(await clash.removeSource()));

  app.post("/clash/update", async (c) => mac(c) ?? said(c, () => clash.update()));

  app.post("/clash/select", async (c) => {
    const no = mac(c); if (no) return no;
    const body = await parseBody(c, Select);
    return body.ok ? said(c, () => clash.select(body.data.service, body.data.node)) : c.json({ error: body.error }, 400);
  });

  app.post("/clash/delays", async (c) => {
    const no = mac(c); if (no) return no;
    const body = await parseBody(c, Delays);
    return body.ok ? said(c, async () => ({ delays: await clash.delays(body.data.service, body.data.scope) })) : c.json({ error: body.error }, 400);
  });

  // ---- what Clash Verge and its core fetch

  const held = (c: Context): boolean => !remoteCaller(c.env) && c.req.query("k") === clash.token();
  const name = (c: Context): string => (c.req.param("file") ?? "").replace(/\.yaml$/, "");

  app.get("/clash/sub.yaml", (c) => {
    if (!held(c)) return c.notFound();
    const made = clash.subscription();
    return made ? c.body(made.text, 200, yaml(made.headers)) : c.text("# AgentSwitch: no subscription to work from yet (Clash, in the AgentSwitch window)\n", 503);
  });

  app.get("/clash/rules/:file", (c) => {
    if (!held(c)) return c.notFound();
    const text = clash.ruleSet(name(c));
    return text === null ? c.notFound() : c.body(text, 200, yaml());
  });

  // No node chosen: nothing to hand over. The core keeps the set it had (it takes no empty one).
  app.get("/clash/nodes/:file", (c) => {
    if (!held(c)) return c.notFound();
    const text = clash.nodeSet(name(c));
    return text === null ? c.text("# AgentSwitch: no node chosen\n", 503) : c.body(text, 200, yaml());
  });

  app.get("/clash/providers/:file", (c) => {
    if (!held(c)) return c.notFound();
    const kept = clash.provider(name(c));
    return kept ? c.body(kept.text, 200, yaml(kept.userinfo ? { "subscription-userinfo": kept.userinfo } : {})) : c.notFound();
  });
}
