/** Clash Integration over HTTP (docs/clash-v0.md §6). For the screens, on this Mac only: what was found of Clash Verge
 *  and what runs, the settings, a node picked. For Clash Verge and its core, by the token their addresses carry and
 *  nothing else: the subscription AgentSwitch makes of the user's own, and its rule sets. */

import type { Hono } from "hono";
import { z } from "zod";
import { remoteCaller } from "../core/caller.js";
import { AUTO_SUFFIX, buildSubscription, CLASH_SERVICES, ClashBuildError, GROUP, RULE_SETS, ruleSet, running, type ClashSettings } from "../clash/build.js";
import { ClashController, type ClashStatus } from "../clash/controller.js";
import type { ClashStore } from "../clash/store.js";
import { vergeProfileText, vergeProfiles, vergeSocket } from "../clash/verge.js";
import { parseBody, type ApiDeps } from "./shared.js";

export type ClashDeps = {
  readonly store: ClashStore;
  /** Clash Verge's folder, and the socket of its core (tests give their own). */
  readonly dir?: string;
  readonly socket?: () => string | null;
  /** Where this service listens on this Mac (`http://127.0.0.1:<port>`). */
  readonly base: () => string;
};

/** The addresses Clash Verge and its core fetch: open to whoever has the token, on this Mac's loopback alone. */
export const CLASH_FETCHED = /^\/clash\/(?:sub\.yaml|rules\/[a-z-]{1,40}\.yaml)$/;

const Service = z.object({ nodes: z.array(z.string().min(1).max(200)).max(32), mode: z.enum(["auto", "manual"]), picked: z.string().max(200).optional() });
const Settings = z.object({ source: z.string().regex(/^[A-Za-z0-9]{6,32}$/).nullable(), claude: Service, openai: Service, direct: z.array(z.string().min(1).max(200)).max(64) });

export function mountClash(app: Hono<any>, deps: ApiDeps): void {
  const clash = deps.clash;
  if (!clash) return;
  const controller = (): ClashController | null => { const s = clash.socket ? clash.socket() : vergeSocket(clash.dir); return s ? new ClashController(s) : null; };
  const held = (c: { req: { query(name: string): string | undefined } }): boolean => c.req.query("k") === clash.store.token();
  const subscriptionUrl = (): string => `${clash.base()}/clash/sub.yaml?k=${clash.store.token()}`;

  const view = async () => {
    const profiles = vergeProfiles(clash.dir);
    const settings = clash.store.settings();
    let status: ClashStatus | null = null;
    try { status = (await controller()?.status()) ?? null; } catch { status = null; }
    const state = status ? running(settings, status) : { active: false, current: false };
    // The link Clash Verge takes a new subscription by; ours is added once, by the user's own click.
    const install = `clash://install-config?url=${encodeURIComponent(subscriptionUrl())}&name=${encodeURIComponent("AgentSwitch")}`;
    return {
      found: profiles !== null, running: status !== null,
      ...(status ? { version: status.version, mode: status.mode, tun: status.tun, nodes: status.nodes, ruleSets: status.ruleSets } : {}),
      profiles: profiles?.profiles ?? [], currentProfile: profiles?.current ?? null,
      settings, active: state.active, upToDate: state.current, install,
    };
  };

  app.get("/clash", async (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "Clash is set up on the Mac" }, 403);
    return c.json(await view());
  });

  app.put("/clash/settings", async (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "Clash is set up on the Mac" }, 403);
    const body = await parseBody(c, Settings);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const next = body.data as ClashSettings;
    // It has to make a subscription before it is kept: a node the subscription does not have is said now.
    if (next.source) {
      const text = vergeProfileText(next.source, clash.dir);
      if (text === null) return c.json({ error: "Clash Verge 里没有这个订阅" }, 400);
      try { buildSubscription(text, next, `${clash.base()}/clash`, "x"); } catch (err) { return c.json({ error: (err as Error).message }, 400); }
    }
    const saved = clash.store.save(next);
    // What lives in the rule sets takes effect now; who is picked too. The groups' own order waits for Clash Verge
    // to fetch the subscription again (`upToDate` says so).
    const ctl = controller();
    if (ctl) {
      await Promise.all(Object.values(RULE_SETS).map((name) => ctl.refreshRuleSet(name).catch(() => undefined)));
      for (const service of CLASH_SERVICES) {
        if (!saved[service].nodes.length) continue;
        const want = saved[service].mode === "manual" && saved[service].picked ? saved[service].picked! : `${GROUP[service]}${AUTO_SUFFIX}`;
        const status = await ctl.status().catch(() => null);
        const member = status?.groups.find((g) => g.name === GROUP[service])?.members.find((m) => m === want || m === `AS · ${want}`);
        if (member) await ctl.select(GROUP[service], member).catch(() => undefined);
      }
    }
    return c.json(await view());
  });

  // ---- what Clash Verge and its core fetch

  app.get("/clash/sub.yaml", (c) => {
    if (remoteCaller(c.env) || !held(c)) return c.notFound();
    const settings = clash.store.settings();
    const text = settings.source ? vergeProfileText(settings.source, clash.dir) : null;
    if (text === null) return c.text("# AgentSwitch: choose the subscription to work from in Settings › Clash Integration\n", 503);
    try {
      return c.body(buildSubscription(text, settings, `${clash.base()}/clash`, clash.store.token()), 200, { "content-type": "text/yaml; charset=utf-8", "profile-update-interval": "24" });
    } catch (err) { return c.text(`# AgentSwitch: ${err instanceof ClashBuildError ? err.message : "the subscription could not be made"}\n`, 503); }
  });

  app.get("/clash/rules/:file", (c) => {
    if (remoteCaller(c.env) || !held(c)) return c.notFound();
    const text = ruleSet(c.req.param("file").replace(/\.yaml$/, ""), clash.store.settings());
    return text === null ? c.notFound() : c.body(text, 200, { "content-type": "text/yaml; charset=utf-8" });
  });
}
