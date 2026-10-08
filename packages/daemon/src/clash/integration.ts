/** Clash Integration as one thing (docs/clash-v0.md §7): the subscription AgentSwitch works from, what it is set to
 *  add, the Clash Verge found on this Mac and the core it runs. What the user changes here reaches the core at once
 *  through its controller — a node set or a rule set read again, a group's member picked — and nothing of Clash
 *  Verge's is written; only when a group appears or goes does Clash Verge have to fetch the subscription again. */

import { buildConfig, buildSubscription, chosen, CLASH_SERVICES, CLASH_TEMPLATES, defaultGroup, DIRECT_SET, groupNames, groupsIn, nodeSet, RULE_SETS, ruleSet, running, SERVICE, templateRules, VERGE_UPDATE_HOURS, type ClashService, type ClashSettings, type ClashTemplate } from "./build.js";
import { rulesFrom } from "./rules.js";
import { ClashController, type ClashStatus } from "./controller.js";
import { ClashSourceError, type ClashSource, type SourceInfo } from "./source.js";
import { cleanSettings, type ClashStore } from "./store.js";
import { vergeProfileLink, vergeProfileText, vergeProfiles, vergeSocket, type VergeProfile } from "./verge.js";

export type ClashServiceView = {
  /** Its two groups by the names they have in Clash. */
  readonly group: string; readonly auto: string;
  /** The core has this service's groups from AgentSwitch (so they can be picked in from here). */
  readonly live: boolean;
  /** What its group uses now — a node, or the automatic group (`auto`'s name) — and what the automatic one uses. */
  readonly now: string | null; readonly autoNow: string | null;
  /** Chosen nodes the subscription no longer has. */
  readonly missing: readonly string[];
};
export type ClashView = {
  /** Clash Verge is on this Mac; its core answers. */
  readonly found: boolean; readonly running: boolean;
  readonly version?: string; readonly mode?: string; readonly tun?: boolean;
  /** The subscription worked from; null: none given yet. */
  readonly source: (SourceInfo & { readonly traffic?: { readonly used: number; readonly total: number; readonly expire: number | null } }) | null;
  /** Every node of it, by name. */
  readonly nodes: readonly string[];
  /** Clash Verge's own subscriptions, to import one (AgentSwitch's own left out). */
  readonly profiles: readonly VergeProfile[];
  readonly settings: ClashSettings;
  readonly services: Readonly<Record<ClashService, ClashServiceView>>;
  /** Each rule template: on or off, whether its rules are the user's own, how many are in use. */
  readonly templates: Readonly<Record<ClashTemplate, { readonly on: boolean; readonly custom: boolean; readonly count: number }>>;
  /** The subscription's default group, which can be called `Manual` (null: it has none such, or has a `Manual`). */
  readonly defaultGroup: string | null;
  /** The core runs the subscription AgentSwitch makes; it is the one made now (else Clash Verge fetches it again). */
  readonly active: boolean; readonly upToDate: boolean;
  /** The link Clash Verge takes the subscription by. */
  readonly install: string;
  /** When Clash Verge last fetched it; null: not since this service started. */
  readonly fetchedAt: number | null;
};

export class ClashRefused extends Error {}

export type ClashOptions = {
  readonly store: ClashStore;
  readonly source: ClashSource;
  /** Where this service listens on this Mac (`http://127.0.0.1:<port>`). */
  readonly base: () => string;
  /** Clash Verge's folder, and the socket of its core (tests give their own). */
  readonly dir?: string;
  readonly socket?: () => string | null;
  readonly now?: () => number;
};

const DELAY_MS = 5_000;

export class ClashIntegration {
  private fetchedAt: number | null = null;
  private updating: Promise<void> | null = null;

  constructor(private readonly o: ClashOptions) {}

  // ---- for the screens

  async view(): Promise<ClashView> {
    const status = await this.status();
    return this.shown(status);
  }

  /** The nodes, the direct addresses, the update interval: kept, and what lives in sets is the core's at once. */
  async saveSettings(next: unknown): Promise<ClashView> {
    // A template's own rules are rules or nothing is kept: the line that is not one is said.
    const given = (next && typeof next === "object" ? (next as { templates?: unknown }).templates : null) as Record<string, { rules?: unknown } | undefined> | null;
    for (const template of CLASH_TEMPLATES) {
      const lines = given?.[template]?.rules;
      const read = Array.isArray(lines) ? rulesFrom(lines.map(String)) : null;
      if (read && "error" in read) throw new ClashRefused(read.error);
    }
    this.o.store.save(cleanSettings(next));
    const status = await this.status();
    await this.push(status, false);
    return this.shown(await this.status());
  }

  /** A template's rules as they are in use, for editing: the user's own if it was edited, else the built-in ones. */
  template(template: ClashTemplate): { readonly rules: readonly string[]; readonly custom: boolean } {
    const settings = this.o.store.settings();
    return { rules: templateRules(template, settings), custom: settings.templates[template].rules !== null };
  }

  /** Work from this from now on: a link, a file's text, or one of Clash Verge's subscriptions (copied in). */
  async setSource(from: { readonly link: string } | { readonly yaml: string; readonly name: string } | { readonly verge: string }): Promise<ClashView> {
    if ("link" in from) await this.o.source.setLink(from.link);
    else if ("yaml" in from) await this.o.source.setFile(from.yaml, from.name);
    else {
      const profile = vergeProfiles(this.o.dir)?.profiles.find((p) => p.uid === from.verge);
      const link = vergeProfileLink(from.verge, this.o.dir), text = vergeProfileText(from.verge, this.o.dir);
      if (!profile || (link === null && text === null)) throw new ClashRefused("Clash Verge 里没有这个订阅");
      if (link !== null) await this.o.source.setLink(link, profile.name); else await this.o.source.setFile(text!, profile.name);
    }
    await this.push(await this.status(), true);
    return this.shown(await this.status());
  }

  async removeSource(): Promise<ClashView> {
    this.o.source.remove();
    return this.view();
  }

  /** The subscription fetched again now, and the core told to take what came. */
  async update(): Promise<ClashView> {
    await this.refresh();
    return this.view();
  }

  /** A service's group uses `node` from now on; null: its automatic group. */
  async select(service: ClashService, node: string | null): Promise<ClashView> {
    const status = await this.status();
    const view = this.shown(status).services[service];
    const controller = this.controller();
    if (!controller || !view.live) throw new ClashRefused("Clash Verge 还没有用上 AgentSwitch 的这一组");
    await controller.select(view.group, node ?? view.auto).catch(() => { throw new ClashRefused("这一组里没有这个节点"); });
    return this.view();
  }

  /** How long each node takes to reach a service, in ms (null: no answer): the chosen ones, or every node of the
   *  subscription. Asked of the running core, through whichever of its node sets has the node. */
  async delays(service: ClashService, scope: "chosen" | "all"): Promise<Record<string, number | null>> {
    const controller = this.controller(), status = await this.status();
    if (!controller || !status) throw new ClashRefused("Clash Verge 没有在运行");
    const names = scope === "all" ? this.o.source.nodes().map((n) => n.name) : chosen(service, this.o.store.settings(), this.o.source.nodes()).map((n) => n.name);
    const own = SERVICE[service].set;
    const setOf = (node: string): string | null => (status.nodeSets[own]?.includes(node) ? own : Object.keys(status.nodeSets).find((set) => status.nodeSets[set]!.includes(node)) ?? null);
    const out: Record<string, number | null> = {};
    await Promise.all(names.map(async (node) => {
      const set = setOf(node);
      out[node] = set ? await controller.delay(set, node, SERVICE[service].probe, DELAY_MS) : null;
    }));
    return out;
  }

  /** Once a minute: the subscription fetched again when its interval has passed. */
  async tick(): Promise<void> {
    if (this.o.source.due(this.o.store.settings().autoUpdateHours)) await this.refresh().catch(() => undefined);
  }

  // ---- what Clash Verge and its core fetch

  token(): string { return this.o.store.token(); }

  subscription(): { readonly text: string; readonly headers: Record<string, string> } | null {
    const document = this.o.source.document();
    if (!document) return null;
    this.fetchedAt = (this.o.now ?? Date.now)();
    const info = this.o.source.info();
    return {
      text: buildSubscription(document, this.o.source.nodes(), this.o.source.held(), this.o.store.settings(), `${this.o.base()}/clash`, this.token()),
      headers: { "profile-update-interval": String(VERGE_UPDATE_HOURS), ...(info?.userinfo ? { "subscription-userinfo": info.userinfo } : {}) },
    };
  }

  ruleSet(name: string): string | null { return ruleSet(name, this.o.store.settings(), this.o.source.nodes()); }

  nodeSet(name: string): string | null {
    const service = CLASH_SERVICES.find((s) => SERVICE[s].set === name);
    return service ? nodeSet(service, this.o.store.settings(), this.o.source.nodes()) : null;
  }

  provider(slug: string): { readonly text: string; readonly userinfo?: string } | null { return this.o.source.provider(slug); }

  // ---- inside

  private controller(): ClashController | null {
    const socket = this.o.socket ? this.o.socket() : vergeSocket(this.o.dir);
    return socket ? new ClashController(socket) : null;
  }

  private async status(): Promise<ClashStatus | null> {
    try { return (await this.controller()?.status()) ?? null; } catch { return null; }
  }

  private enabled(): Record<ClashService, boolean> {
    const settings = this.o.store.settings(), nodes = this.o.source.nodes();
    return { claude: chosen("claude", settings, nodes).length > 0, openai: chosen("openai", settings, nodes).length > 0 };
  }

  private async refresh(): Promise<void> {
    // One fetch at a time: the timer and the button may ask together.
    this.updating ??= (async () => {
      try {
        await this.o.source.refresh();
        await this.push(await this.status(), true);
      } finally { this.updating = null; }
    })();
    await this.updating;
  }

  /** The core takes what is its to take without a reload: the rule sets and AgentSwitch's node sets, and — when the
   *  subscription itself was fetched again — the node sets it gets from AgentSwitch's copy. Only a core that runs
   *  AgentSwitch's subscription has them; one that does not is left alone. */
  private async push(status: ClashStatus | null, fetched: boolean): Promise<void> {
    const controller = this.controller();
    if (!controller || !status || !(DIRECT_SET in status.ruleSets)) return;
    const quiet = (p: Promise<void>): Promise<void> => p.catch(() => undefined);
    await Promise.all([
      ...RULE_SETS.filter((name) => name in status.ruleSets).map((name) => quiet(controller.refreshRuleSet(name))),
      // A service with no node left has nothing to hand over: the core keeps the set it had until its groups go.
      ...CLASH_SERVICES.filter((s) => SERVICE[s].set in status.nodeSets && this.nodeSet(SERVICE[s].set) !== null).map((s) => quiet(controller.refreshNodeSet(SERVICE[s].set))),
      ...(fetched ? this.o.source.held().filter((name) => name in status.nodeSets).map((name) => quiet(controller.refreshNodeSet(name))) : []),
    ]);
  }

  private shown(status: ClashStatus | null): ClashView {
    const profiles = vergeProfiles(this.o.dir);
    const settings = this.o.store.settings(), nodes = this.o.source.nodes(), info = this.o.source.info();
    const document = this.o.source.document() ?? {};
    const enabled = this.enabled();
    const base = this.o.base();
    // The groups of what would be handed over now: the core has to have each by its name.
    const built = info ? groupsIn(buildConfig(structuredClone(document), nodes, this.o.source.held(), settings, `${base}/clash`, "")) : [];
    const state = status ? running({ enabled, groups: built }, status) : { active: false, current: false };
    const service = (s: ClashService): ClashServiceView => {
      const names = groupNames(document, s);
      const live = !!status && state.active && SERVICE[s].set in status.nodeSets;
      const now = (group: string): string | null => (live ? status!.groups.find((g) => g.name === group)?.now ?? null : null);
      const have = new Set(nodes.map((n) => n.name));
      return { ...names, live, now: now(names.group), autoNow: now(names.auto), missing: info ? settings[s].nodes.filter((n) => !have.has(n)) : [] };
    };
    const install = `clash://install-config?url=${encodeURIComponent(`${base}/clash/sub.yaml?k=${this.token()}`)}&name=${encodeURIComponent("AgentSwitch")}`;
    const traffic = info?.userinfo ? parseTraffic(info.userinfo) : null;
    return {
      found: profiles !== null, running: status !== null,
      ...(status ? { version: status.version, mode: status.mode, tun: status.tun } : {}),
      source: info ? { ...info, ...(traffic ? { traffic } : {}) } : null,
      nodes: nodes.map((n) => n.name),
      profiles: (profiles?.profiles ?? []).filter((p) => p.from !== base),
      settings, services: { claude: service("claude"), openai: service("openai") },
      templates: Object.fromEntries(CLASH_TEMPLATES.map((t) => [t, { on: settings.templates[t].on, custom: settings.templates[t].rules !== null, count: templateRules(t, settings).length }])) as ClashView["templates"],
      defaultGroup: info ? defaultGroup(document) : null,
      active: state.active, upToDate: state.current, install, fetchedAt: this.fetchedAt,
    };
  }
}

/** `upload=1; download=2; total=3; expire=4` as numbers: what is used of what, and when it ends (ms). */
export function parseTraffic(userinfo: string): { used: number; total: number; expire: number | null } | null {
  const field = (name: string): number | null => {
    const m = new RegExp(`(?:^|;)\\s*${name}=(\\d+(?:\\.\\d+)?)`).exec(userinfo);
    return m ? Number(m[1]) : null;
  };
  const total = field("total");
  if (total === null) return null;
  const expire = field("expire");
  return { used: (field("upload") ?? 0) + (field("download") ?? 0), total, expire: expire ? expire * 1000 : null };
}

export { ClashSourceError };
