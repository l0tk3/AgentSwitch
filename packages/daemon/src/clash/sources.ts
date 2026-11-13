/** The subscriptions AgentSwitch works from (docs/clash-v0.md §10): any number of them, each a link or a file kept in
 *  a folder of its own (source.ts), each with its name and how often it is fetched again. With one, and nothing of it
 *  switched off, everything is as it was with the only one there used to be. With several — or with a node switched
 *  off — what is handed over is theirs put together: each subscription a node set AgentSwitch serves itself, its
 *  nodes under their own names (one whose name an earlier subscription already has takes its subscription's name
 *  after it), the nodes switched off left out; the groups and the rules are then AgentSwitch's alone (§7.11).
 *
 *  Which subscriptions there are, in their order, and which nodes are off is kept in `clash/sources.json`. The first
 *  one there ever was stays in `clash/source`, where it has always been; the others are in `clash/sources/<id>`. */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { ClashSource, ClashSourceError, fetchText, providerSlug, type Fetcher, type SourceInfo, type SourceNode } from "./source.js";

export type Subscription = SourceInfo & { readonly id: string; /** Fetched again after this many hours; 0: only when asked. */ readonly hours: number };
/** A node as the table of them all shows it: its name as handed over, the subscription it is of, what kind it is. */
export type NodeRow = { readonly name: string; readonly sub: string; readonly type: string; readonly off: boolean };
export type SourceFrom = { readonly link: string; readonly name?: string | undefined } | { readonly yaml: string; readonly name: string };

type Index = { list: { id: string; hours: number }[]; /** By subscription: the nodes switched off, by the names it gives them. */ off: Record<string, string[]> };
type Named = { readonly sub: string; readonly original: string; readonly name: string; readonly node: SourceNode; readonly off: boolean };

const FIRST = "0", MAX_SOURCES = 16, MAX_OFF = 2000;
const HOURS = [0, 1, 6, 12, 24];
/** What a node set of a subscription is tried against, and how often: as `自动选择` tries every node (§7.11). */
const PROBE = "https://www.gstatic.com/generate_204", PROBE_SECONDS = 300;
/** The parts of a subscription that are its routing: with several put together, none of them is taken from one. */
const ROUTING = ["proxies", "proxy-providers", "rule-providers", "rules", "sub-rules"] as const;

/** The node set a subscription is handed over as. */
export const subscriptionSet = (id: string): string => `as-sub-${id}`;

export class ClashSources {
  private readonly dir: string;
  private readonly file: string;
  private readonly sources = new Map<string, ClashSource>();
  private kept: Index | undefined;
  private names: Named[] | undefined;

  constructor(private readonly home: string, private readonly fetcher: Fetcher = fetchText, private readonly now: () => number = Date.now,
              private readonly agent: () => string = () => "clash.meta/v1.19.0",
              /** How often the one subscription of before this was fetched again: what it starts with here. */ private readonly firstHours: () => number = () => 24) {
    this.dir = join(home, "clash");
    this.file = join(this.dir, "sources.json");
  }

  // ---- what there is

  list(): Subscription[] {
    return this.index().list.flatMap(({ id, hours }) => {
      const info = this.source(id).info();
      return info ? [{ ...info, id, hours }] : [];
    });
  }

  several(): boolean { return this.list().length > 1; }

  /** What is handed over is the subscriptions put together (so the groups and rules are AgentSwitch's): with several
   *  always; with one, when a node of it is off and only AgentSwitch's rules are asked for anyway. */
  together(ownRules: boolean): boolean {
    return this.several() || (ownRules && this.named().some((n) => n.off));
  }

  /** As one: the only subscription as it is; several as a line that counts them. Null: none. */
  info(): SourceInfo | null {
    const all = this.list();
    if (all.length <= 1) return all[0] ? strip(all[0]) : null;
    const userinfo = all.find((s) => s.userinfo)?.userinfo, error = all.find((s) => s.error)?.error;
    return { kind: "link", name: `${all.length} Subscriptions`, updatedAt: Math.max(...all.map((s) => s.updatedAt)), nodes: this.named().filter((n) => !n.off).length,
      ...(userinfo ? { userinfo } : {}), providers: [], ...(error ? { error } : {}) };
  }

  /** Every node of every subscription under the name it is handed over by, the ones switched off too. */
  rows(): NodeRow[] {
    return this.named().map((n) => ({ name: n.name, sub: n.sub, type: typeof n.node.definition.type === "string" ? n.node.definition.type : "", off: n.off }));
  }

  /** What changes when anything of this does: for whoever keeps something made of it. */
  stamp(): string {
    const index = this.index();
    return JSON.stringify([index, this.list().map((s) => [s.name, s.updatedAt, s.nodes, s.providers.map((p) => p.updatedAt)])]);
  }

  // ---- what the subscription handed over is made of

  /** The text to build on (a copy). Put together: the first subscription's without its routing — its groups stay,
   *  only so that what names them elsewhere can be found and let go (build.ts `unname`) — and a node set for each
   *  subscription that has a node left. */
  document(ownRules: boolean): Record<string, unknown> | null {
    const all = this.list();
    if (!all.length) return null;
    if (!this.together(ownRules)) return this.source(all[0]!.id).document();
    const base = this.source(all[0]!.id).document() ?? {};
    for (const key of ROUTING) delete base[key];
    const left = new Set(this.named().filter((n) => !n.off).map((n) => n.sub));
    const sets = Object.fromEntries(all.filter((s) => left.has(s.id)).map((s) => [subscriptionSet(s.id),
      { type: "http", url: "http://127.0.0.1/", path: `./proxy_providers/${subscriptionSet(s.id)}.yaml`, interval: 86400, "health-check": { enable: true, url: PROBE, interval: PROBE_SECONDS } }]));
    if (Object.keys(sets).length) base["proxy-providers"] = sets;
    return base;
  }

  /** Every node that can be used, by name. */
  nodes(ownRules: boolean): readonly SourceNode[] {
    const all = this.list();
    if (!all.length) return [];
    if (!this.together(ownRules)) return this.source(all[0]!.id).nodes();
    const live = this.named().filter((n) => !n.off);
    const known = new Map(live.map((n) => [`${n.sub}\u0000${n.original}`, n.name]));
    return live.map((n) => {
      const definition: Record<string, unknown> = { ...n.node.definition, name: n.name };
      // A node dialled through another of its subscription goes through it under its name here; through anything
      // else of that subscription (a group, a node that is off) it is dialled directly.
      const through = definition["dialer-proxy"];
      if (typeof through === "string") {
        const now = known.get(`${n.sub}\u0000${through}`);
        if (now) definition["dialer-proxy"] = now; else delete definition["dialer-proxy"];
      }
      return { name: n.name, from: subscriptionSet(n.sub), definition };
    });
  }

  /** The node sets the core is to fetch from AgentSwitch. */
  held(ownRules: boolean): readonly string[] {
    const all = this.list();
    if (!all.length) return [];
    if (!this.together(ownRules)) return this.source(all[0]!.id).held();
    return [...new Set(this.nodes(ownRules).map((n) => n.from!))];
  }

  /** A node set as the core fetches it, by its slug: a subscription's nodes put together, or a node set one
   *  subscription names, as its service gave it. */
  provider(slug: string): { readonly text: string; readonly userinfo?: string } | null {
    const all = this.list();
    const sub = all.find((s) => providerSlug(subscriptionSet(s.id)) === slug);
    if (sub) {
      const nodes = this.nodes(true).filter((n) => n.from === subscriptionSet(sub.id));
      return nodes.length ? { text: stringify({ proxies: nodes.map((n) => n.definition) }, { lineWidth: 0 }), ...(sub.userinfo ? { userinfo: sub.userinfo } : {}) } : null;
    }
    for (const s of all) { const kept = this.source(s.id).provider(slug); if (kept) return kept; }
    return null;
  }

  // ---- what the user does with them

  /** One more subscription, fetched now. What cannot be fetched or is not a subscription is not kept. */
  async add(from: SourceFrom): Promise<string> {
    const index = this.index();
    if (index.list.length >= MAX_SOURCES) throw new ClashSourceError(`最多 ${MAX_SOURCES} 份订阅`);
    const taken = new Set(index.list.map((s) => s.id));
    let id = taken.has(FIRST) || existsSync(join(this.dir, "source", "meta.json")) ? randomBytes(4).toString("hex") : FIRST;
    while (taken.has(id)) id = randomBytes(4).toString("hex");
    const source = this.source(id);
    try {
      if ("link" in from) await source.setLink(from.link, from.name); else await source.setFile(from.yaml, from.name);
    } catch (err) { source.remove(); this.sources.delete(id); throw err; }
    this.save({ ...index, list: [...index.list, { id, hours: "link" in from ? 24 : 0 }] });
    return id;
  }

  /** It is gone, with what was kept of it. The names its nodes went by: what was chosen among them is forgotten. */
  remove(id: string): string[] {
    const index = this.index();
    if (!index.list.some((s) => s.id === id)) return [];
    const names = this.named().filter((n) => n.sub === id).map((n) => n.name);
    this.source(id).remove();
    this.sources.delete(id);
    const off = { ...index.off };
    delete off[id];
    this.save({ list: index.list.filter((s) => s.id !== id), off });
    return names;
  }

  rename(id: string, name: string): void {
    if (!this.index().list.some((s) => s.id === id)) return;
    this.source(id).rename(name);
    this.names = undefined;
  }

  setHours(id: string, hours: number): void {
    const index = this.index();
    if (!HOURS.includes(hours)) return;
    this.save({ ...index, list: index.list.map((s) => (s.id === id ? { ...s, hours } : s)) });
  }

  /** Every subscription is fetched again after this many hours (an app that knows of one interval alone). */
  setAllHours(hours: number): void {
    const index = this.index();
    if (!HOURS.includes(hours) || index.list.every((s) => s.hours === hours)) return;
    this.save({ ...index, list: index.list.map((s) => ({ ...s, hours })) });
  }

  /** A node of a subscription, by the name it is handed over by, is left out from now on, or is back. */
  setOff(name: string, off: boolean): boolean {
    const node = this.named().find((n) => n.name === name);
    if (!node) return false;
    const index = this.index();
    const now = new Set(index.off[node.sub] ?? []);
    if (off) now.add(node.original); else now.delete(node.original);
    if (Object.values(index.off).reduce((n, l) => n + l.length, 0) > MAX_OFF) return false;
    const next = { ...index.off };
    if (now.size) next[node.sub] = [...now]; else delete next[node.sub];
    this.save({ ...index, off: next });
    return true;
  }

  /** One fetched again, or all of them. A fetch that fails leaves what was kept and says so (source.ts). */
  async refresh(id?: string): Promise<void> {
    await Promise.all(this.index().list.filter((s) => id === undefined || s.id === id).map((s) => this.source(s.id).refresh()));
    this.names = undefined;
  }

  /** The ones whose interval has passed fetched again; whether any was. */
  async refreshDue(): Promise<boolean> {
    const due = this.index().list.filter((s) => this.source(s.id).due(s.hours));
    await Promise.all(due.map((s) => this.source(s.id).refresh()));
    if (due.length) this.names = undefined;
    return due.length > 0;
  }

  // ---- inside

  private source(id: string): ClashSource {
    let source = this.sources.get(id);
    if (!source) this.sources.set(id, source = new ClashSource(this.home, this.fetcher, this.now, this.agent, id === FIRST ? undefined : join(this.dir, "sources", id)));
    return source;
  }

  /** Every node under the name it is handed over by: its own, unless a subscription before it has that name. */
  private named(): Named[] {
    if (this.names) return this.names;
    const index = this.index(), taken = new Set<string>(), out: Named[] = [];
    for (const sub of this.list()) {
      const off = new Set(index.off[sub.id] ?? []);
      for (const node of this.source(sub.id).nodes()) {
        let name = node.name;
        for (let n = 1; taken.has(name); n += 1) name = `${node.name} · ${sub.name}${n > 1 ? ` ${n}` : ""}`;
        taken.add(name);
        out.push({ sub: sub.id, original: node.name, name, node, off: off.has(node.name) });
      }
    }
    return (this.names = out);
  }

  private index(): Index {
    if (this.kept) return this.kept;
    try {
      const o = JSON.parse(readFileSync(this.file, "utf8")) as { list?: unknown; off?: unknown };
      const list = (Array.isArray(o.list) ? o.list : []).flatMap((s) => {
        const e = s as { id?: unknown; hours?: unknown };
        return typeof e.id === "string" && /^[0-9a-f]{1,16}$/.test(e.id) ? [{ id: e.id, hours: HOURS.includes(e.hours as number) ? e.hours as number : 24 }] : [];
      }).slice(0, MAX_SOURCES);
      const ids = new Set(list.map((s) => s.id));
      const off = Object.fromEntries(Object.entries(o.off && typeof o.off === "object" ? o.off as Record<string, unknown> : {})
        .filter(([id, names]) => ids.has(id) && Array.isArray(names)).map(([id, names]) => [id, (names as unknown[]).filter((n): n is string => typeof n === "string")]));
      return (this.kept = { list, off });
    } catch {
      // Nothing written yet: the one subscription of before this, if there is one.
      const first = existsSync(join(this.dir, "source", "meta.json"));
      return (this.kept = { list: first ? [{ id: FIRST, hours: HOURS.includes(this.firstHours()) ? this.firstHours() : 24 }] : [], off: {} });
    }
  }

  private save(index: Index): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.kept = index;
    this.names = undefined;
  }
}

/** A subscription without what only the list of them says. */
function strip(sub: Subscription): SourceInfo {
  const { id: _id, hours: _hours, ...info } = sub;
  return info;
}
