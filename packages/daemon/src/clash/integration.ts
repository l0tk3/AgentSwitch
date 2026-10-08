/** Clash Integration as one thing (docs/clash-v0.md §7): the subscription AgentSwitch works from, what it is set to
 *  add, the Clash Verge found on this Mac and the core it runs. What the user changes here reaches the core at once
 *  through its controller — a node set or a rule set read again, a group's member picked — and nothing of Clash
 *  Verge's is written; only when a group appears or goes does Clash Verge have to fetch the subscription again. */

import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { buildConfig, chosen, CLASH_SERVICES, CLASH_TEMPLATES, defaultGroup, DIRECT_SET, dnsSection, dnsText, groupNames, groupsIn, nodeSet, RULE_SETS, ruleSet, running, SERVICE, templateRules, VERGE_UPDATE_HOURS, type ClashService, type ClashSettings, type ClashTemplate } from "./build.js";
import { rulesFrom } from "./rules.js";
import { observe, type CheckDeps, type Observed } from "./check.js";
import { ClashController, type ClashStatus } from "./controller.js";
import { ClashSourceError, type ClashSource, type SourceInfo } from "./source.js";
import { cleanSettings, type ClashStore } from "./store.js";
import { vergeOwnDns, vergeProfileLink, vergeProfileText, vergeProfiles, vergeSocket, type VergeProfile } from "./verge.js";

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
  /** The DNS template: on or off, whether its text is the user's own; and whether Clash Verge has its own DNS
   *  settings on, which the core then takes instead. */
  readonly dns: { readonly on: boolean; readonly custom: boolean; readonly overridden: boolean };
  /** The core runs the subscription AgentSwitch makes; it is the one made now (else Clash Verge fetches it again). */
  readonly active: boolean; readonly upToDate: boolean;
  /** The link Clash Verge takes the subscription by. */
  readonly install: string;
  /** When Clash Verge last fetched it; null: never. */
  readonly fetchedAt: number | null;
};

/** One line of the routing check (§7.9): a kind of traffic, the name tried for it, what it should do and what the
 *  core did with it. `expect` null: nothing is asked of it here (a template that is off), it is shown for what it is;
 *  `ok` null likewise. */
export type ClashCheckRow = {
  readonly id: string; readonly title: string; readonly host: string;
  readonly expect: { readonly kind: "group"; readonly group: string } | { readonly kind: "direct" } | { readonly kind: "reject" } | null;
  readonly observed: Observed;
  readonly ok: boolean | null;
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
  /** The routing check's ways of looking (tests give their own). */
  readonly check?: Partial<CheckDeps>;
};

const DELAY_MS = 5_000;

export class ClashIntegration {
  private updating: Promise<void> | null = null;
  /** What would be handed over now, kept until something it is made of changes. */
  private made: { readonly key: string; readonly config: Record<string, unknown>; readonly text: string; readonly hash: string } | null = null;

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
    const dns = (next && typeof next === "object" ? (next as { dns?: { text?: unknown } }).dns?.text : null);
    if (typeof dns === "string" && dns.trim()) {
      const read = dnsSection(dns);
      if ("error" in read) throw new ClashRefused(read.error);
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

  /** The DNS template's text as it is in use, for editing. */
  dns(): { readonly text: string; readonly custom: boolean } {
    const settings = this.o.store.settings();
    return { text: dnsText(settings), custom: settings.dns.text !== null };
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
    this.forgetNodes();
    await this.push(await this.status(), true);
    return this.shown(await this.status());
  }

  async removeSource(): Promise<ClashView> {
    this.o.source.remove();
    this.forgetNodes();
    return this.view();
  }

  /** The nodes chosen were chosen in the subscription that was there: with another in its place, or none, they are
   *  forgotten — a node of the same name in another subscription is not the same node (user, 2026-10-08: 还是别记住
   *  节点了，不然会一直堆积，而且其他订阅链接里如果有重名的不就弄错了). One that goes missing from the same
   *  subscription when it is fetched again stays, marked. */
  private forgetNodes(): void {
    const settings = this.o.store.settings();
    if (settings.claude.nodes.length || settings.openai.nodes.length) this.o.store.save({ ...settings, claude: { nodes: [] }, openai: { nodes: [] } });
  }

  /** The routing check: a connection of each kind sent through the core, and what the core did with it. */
  async check(): Promise<{ readonly rows: readonly ClashCheckRow[] }> {
    const controller = this.controller(), status = await this.status();
    if (!controller || !status) throw new ClashRefused("Clash Verge 没有在运行");
    const port = this.o.check?.port ?? status.proxyPort;
    if (!port) throw new ClashRefused("Clash 没有开代理端口，没法从这里发连接去试");
    const settings = this.o.store.settings(), enabled = this.enabled(), document = this.o.source.document() ?? {};
    const deps: CheckDeps = { port, connections: () => controller.connections(), ...this.o.check };
    const has = (template: ClashTemplate, rule: string): boolean => settings.templates[template].on && templateRules(template, settings).includes(rule);
    const service = (s: ClashService, host: string) => ({ id: s, title: s === "claude" ? "Claude" : "OpenAI", host, far: true,
      expect: enabled[s] ? { kind: "group" as const, group: groupNames(document, s).group } : null });
    const wanted: { id: string; title: string; host: string; far?: boolean; expect: ClashCheckRow["expect"] }[] = [
      service("claude", "claude.ai"), service("openai", "chatgpt.com"),
      { id: "domestic", title: "Domestic", host: "www.baidu.com", expect: has("domestic", "DOMAIN-KEYWORD,baidu") ? { kind: "direct" } : null },
      { id: "china", title: "China by Address", host: "www.163.com", expect: has("domestic", "GEOIP,CN") ? { kind: "direct" } : null },
      { id: "block", title: "Ads", host: "ad.doubleclick.net", expect: has("block", "DOMAIN-SUFFIX,doubleclick.net") ? { kind: "reject" } : null },
      ...settings.direct.slice(0, 8).map((address) => ({ id: `direct:${address}`, title: address, host: address, expect: { kind: "direct" as const } })),
      { id: "other", title: "Everything Else", host: "www.google.com", expect: null },
    ];
    const rows = await Promise.all(wanted.map(async ({ far, ...row }): Promise<ClashCheckRow> => {
      const observed = await observe(deps, row.host, 443, far === true);
      const ok = row.expect === null ? null
        : row.expect.kind === "group" ? observed.outcome === "proxied" && observed.path[0] === row.expect.group
        : row.expect.kind === "direct" ? observed.outcome === "direct" : observed.outcome === "rejected";
      return { ...row, observed, ok };
    }));
    return { rows };
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

  /** The subscription, fetched: what was handed over is remembered by its fingerprint, to tell later whether Clash
   *  Verge has the one made now. */
  subscription(): { readonly text: string; readonly headers: Record<string, string> } | null {
    const made = this.build();
    if (!made) return null;
    this.o.store.setServed(made.hash, (this.o.now ?? Date.now)());
    const info = this.o.source.info();
    return { text: made.text, headers: { "profile-update-interval": String(VERGE_UPDATE_HOURS), ...(info?.userinfo ? { "subscription-userinfo": info.userinfo } : {}) } };
  }

  ruleSet(name: string): string | null { return ruleSet(name, this.o.store.settings(), this.o.source.nodes()); }

  nodeSet(name: string): string | null {
    const service = CLASH_SERVICES.find((s) => SERVICE[s].set === name);
    return service ? nodeSet(service, this.o.store.settings(), this.o.source.nodes()) : null;
  }

  provider(slug: string): { readonly text: string; readonly userinfo?: string } | null { return this.o.source.provider(slug); }

  // ---- inside

  /** What would be handed over now; null without a subscription to work from. */
  private build(): { readonly config: Record<string, unknown>; readonly text: string; readonly hash: string } | null {
    const info = this.o.source.info(), settings = this.o.store.settings(), base = `${this.o.base()}/clash`, token = this.token();
    if (!info) return null;
    const key = JSON.stringify([info.updatedAt, info.providers.map((p) => p.updatedAt), info.nodes, settings, base, token]);
    if (this.made?.key !== key) {
      const config = buildConfig(this.o.source.document()!, this.o.source.nodes(), this.o.source.held(), settings, base, token);
      const text = stringify(config, { lineWidth: 0 });
      this.made = { key, config, text, hash: createHash("sha256").update(text).digest("hex").slice(0, 16) };
    }
    return this.made;
  }

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
    // The groups of what would be handed over now: the core has to have each by its name. And what Clash Verge
    // last fetched has to be that very text — a part the core does not show (DNS) is told only so.
    const made = this.build(), served = this.o.store.served();
    const seen = status ? running({ enabled, groups: made ? groupsIn(made.config) : [] }, status) : { active: false, current: false };
    const state = { active: seen.active, current: seen.current && (!made || !served || served.hash === made.hash) };
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
      dns: { on: settings.dns.on, custom: settings.dns.text !== null, overridden: vergeOwnDns(this.o.dir) },
      active: state.active, upToDate: state.current, install, fetchedAt: served?.at ?? null,
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
