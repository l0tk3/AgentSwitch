/** The subscription AgentSwitch works from (docs/clash-v0.md §7.1): a link it fetches, or a file given to it, kept in
 *  its own folder — with the node sets that file names by link, which it fetches too, because the nodes chosen for
 *  Claude and for OpenAI are served with all they need to connect. What is kept holds the nodes' addresses and
 *  passwords and the links: files only the user can read, never the database, a log or an agent's context. */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export type Fetched = { readonly status: number; readonly body: string; readonly headers: Readonly<Record<string, string>> };
/** One GET, saying who asks (`agent`: subscription services answer in Clash's format to Clash). */
export type Fetcher = (url: string, agent: string) => Promise<Fetched>;

export type SourceNode = { readonly name: string; /** The node set it came in; null: the subscription's own list. */ readonly from: string | null; readonly definition: Readonly<Record<string, unknown>> };
export type SourceProvider = { readonly name: string; readonly host: string; readonly updatedAt: number | null; readonly nodes: number; readonly error?: string };
export type SourceInfo = {
  readonly kind: "link" | "file";
  readonly name: string;
  /** Where a link goes (its host; the rest of it is never shown). */
  readonly host?: string;
  readonly updatedAt: number;
  readonly nodes: number;
  /** `upload=…; download=…; total=…; expire=…` as the subscription service said it. */
  readonly userinfo?: string;
  readonly providers: readonly SourceProvider[];
  /** The last fetch of the link did not work; what is kept is the one before. */
  readonly error?: string;
};

export class ClashSourceError extends Error {}

type ProviderMeta = { url: string; updatedAt: number | null; userinfo?: string; error?: string };
type Meta = { kind: "link" | "file"; name: string; url?: string; updatedAt: number; userinfo?: string; error?: string; providers: Record<string, ProviderMeta> };
type Loaded = { meta: Meta; main: string; document: Record<string, unknown>; nodes: SourceNode[]; counts: Record<string, number> };

const MAX_BYTES = 16 * 1024 * 1024;
const FETCH_MS = 30_000;

export const fetchText: Fetcher = async (url, agent) => {
  const res = await fetch(url, { headers: { "user-agent": agent, accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(FETCH_MS) });
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error("too large");
  return { status: res.status, body, headers: Object.fromEntries(res.headers) };
};

/** A node set's address in what AgentSwitch serves: its name, in letters an address takes. */
export function providerSlug(name: string): string { return Buffer.from(name, "utf8").toString("base64url"); }

export class ClashSource {
  private readonly dir: string;
  private loaded: Loaded | null | undefined;

  constructor(home: string, private readonly fetcher: Fetcher = fetchText, private readonly now: () => number = Date.now,
              /** Who the fetches say they are. */ private readonly agent: () => string = () => "clash.meta/v1.19.0") {
    this.dir = join(home, "clash", "source");
  }

  info(): SourceInfo | null {
    const l = this.load();
    if (!l) return null;
    const { meta } = l;
    return {
      kind: meta.kind, name: meta.name, ...(meta.url ? { host: host(meta.url) } : {}), updatedAt: meta.updatedAt, nodes: l.nodes.length,
      ...(meta.userinfo ?? Object.values(meta.providers).find((p) => p.userinfo)?.userinfo ? { userinfo: (meta.userinfo ?? Object.values(meta.providers).find((p) => p.userinfo)?.userinfo)! } : {}),
      providers: Object.entries(meta.providers).map(([name, p]) => ({ name, host: host(p.url), updatedAt: p.updatedAt, nodes: l.counts[name] ?? 0, ...(p.error ? { error: p.error } : {}) })),
      ...(meta.error ? { error: meta.error } : {}),
    };
  }

  /** The subscription as it was read (a copy: the caller builds on it). */
  document(): Record<string, unknown> | null {
    const l = this.load();
    return l ? structuredClone(l.document) : null;
  }

  /** Every node it has, by name: the subscription's own list first, then each node set's. */
  nodes(): readonly SourceNode[] { return this.load()?.nodes ?? []; }

  /** The node sets AgentSwitch holds a copy of (so serves itself), by name. */
  held(): readonly string[] {
    const l = this.load();
    return l ? Object.entries(l.meta.providers).filter(([, p]) => p.updatedAt !== null).map(([name]) => name) : [];
  }

  /** A held node set as its service gave it, by its slug. */
  provider(slug: string): { readonly text: string; readonly userinfo?: string } | null {
    const l = this.load();
    const entry = l && Object.entries(l.meta.providers).find(([name, p]) => providerSlug(name) === slug && p.updatedAt !== null);
    if (!entry) return null;
    try { return { text: readFileSync(this.providerFile(entry[0]), "utf8"), ...(entry[1].userinfo ? { userinfo: entry[1].userinfo } : {}) }; } catch { return null; }
  }

  /** Work from this link from now on: fetched now, and its node sets with it. */
  async setLink(url: string, name?: string): Promise<SourceInfo> {
    const target = web(url);
    if (!target) throw new ClashSourceError("这不是一条 http(s) 链接");
    const got = await this.get(target);
    const document = clashConfig(got.body);
    const meta: Meta = { kind: "link", name: (name ?? "").trim() || host(target), url: target, updatedAt: this.now(), ...userinfo(got), providers: {} };
    return this.keep(meta, got.body, document);
  }

  /** Work from this file's text from now on (its node sets are fetched now). */
  async setFile(text: string, name: string): Promise<SourceInfo> {
    const document = clashConfig(text);
    return this.keep({ kind: "file", name: name.trim() || "subscription.yaml", updatedAt: this.now(), providers: {} }, text, document);
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
    this.loaded = null;
  }

  /** The link fetched again, and every node set. A fetch that fails leaves what was kept and says so. */
  async refresh(): Promise<SourceInfo | null> {
    const l = this.load();
    if (!l) return null;
    let { main, document } = l;
    const meta: Meta = { ...l.meta, providers: { ...l.meta.providers } };
    delete meta.error;
    if (meta.kind === "link" && meta.url) {
      try {
        const got = await this.get(meta.url);
        document = clashConfig(got.body);
        main = got.body;
        const info = userinfo(got);
        if (info.userinfo) meta.userinfo = info.userinfo; else delete meta.userinfo;
      } catch (err) { meta.error = reason(err); }
    }
    meta.updatedAt = this.now();
    return this.keep(meta, main, document);
  }

  /** It was last fetched `hours` or more ago. */
  due(hours: number): boolean {
    const l = this.load();
    return !!l && hours > 0 && this.now() - l.meta.updatedAt >= hours * 3_600_000;
  }

  // ---- inside

  /** The node sets the subscription names by link are fetched, and everything is written. */
  private async keep(meta: Meta, main: string, document: Record<string, unknown>): Promise<SourceInfo> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const named = linkedProviders(document);
    const providers: Record<string, ProviderMeta> = {};
    await Promise.all(Object.entries(named).map(async ([name, url]) => {
      const before = meta.providers[name]?.url === url ? meta.providers[name]! : { url, updatedAt: null };
      try {
        const got = await this.get(url);
        providerNodes(got.body);   // it has to be a list of nodes before it replaces the one kept
        this.write(this.providerFile(name), got.body);
        providers[name] = { url, updatedAt: this.now(), ...userinfo(got) };
      } catch (err) { providers[name] = { ...before, error: reason(err) }; }
    }));
    // In the subscription's own order, whatever order the fetches ended in.
    meta.providers = Object.fromEntries(Object.keys(named).map((name) => [name, providers[name]!]));
    this.write(join(this.dir, "main.yaml"), main);
    this.write(join(this.dir, "meta.json"), JSON.stringify(meta, null, 2));
    this.loaded = undefined;
    return this.info()!;
  }

  private async get(url: string): Promise<Fetched> {
    let got: Fetched;
    try { got = await this.fetcher(url, this.agent()); } catch { throw new ClashSourceError(`连不上 ${host(url)}`); }
    if (got.status < 200 || got.status >= 300) throw new ClashSourceError(`${host(url)} 回了 ${got.status}`);
    return got;
  }

  private load(): Loaded | null {
    if (this.loaded !== undefined) return this.loaded;
    try {
      const meta = JSON.parse(readFileSync(join(this.dir, "meta.json"), "utf8")) as Meta;
      const main = readFileSync(join(this.dir, "main.yaml"), "utf8");
      const document = clashConfig(main);
      const nodes: SourceNode[] = [], seen = new Set<string>(), counts: Record<string, number> = {};
      const add = (list: unknown, from: string | null): number => {
        let n = 0;
        for (const item of Array.isArray(list) ? list : []) {
          const name = item && typeof item === "object" ? (item as { name?: unknown }).name : undefined;
          if (typeof name !== "string" || !name) continue;
          n += 1;
          if (seen.has(name)) continue;
          seen.add(name);
          nodes.push({ name, from, definition: item as Record<string, unknown> });
        }
        return n;
      };
      add(document.proxies, null);
      for (const [name, p] of Object.entries(meta.providers ?? {})) {
        if (p.updatedAt === null) continue;
        try { counts[name] = add(providerNodes(readFileSync(this.providerFile(name), "utf8")), name); } catch { counts[name] = 0; }
      }
      this.loaded = { meta: { ...meta, providers: meta.providers ?? {} }, main, document, nodes, counts };
    } catch { this.loaded = null; }
    return this.loaded;
  }

  private providerFile(name: string): string { return join(this.dir, `provider-${providerSlug(name)}.yaml`); }

  private write(file: string, text: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  }
}

/** A Clash configuration: something with nodes of its own or node sets. Anything else is refused, not guessed at. */
function clashConfig(text: string): Record<string, unknown> {
  let doc: unknown;
  try { doc = parse(text); } catch { throw new ClashSourceError("这不是 Clash 格式的订阅（不是合法的 YAML）"); }
  const o = doc && typeof doc === "object" && !Array.isArray(doc) ? doc as Record<string, unknown> : null;
  const sets = o && o["proxy-providers"] && typeof o["proxy-providers"] === "object" ? Object.keys(o["proxy-providers"] as object).length : 0;
  if (!o || (!(Array.isArray(o.proxies) && o.proxies.length) && !sets)) throw new ClashSourceError("这不是 Clash 格式的订阅（里面没有节点，也没有节点集）");
  return o;
}

/** The nodes of a node set as its service gave it: a Clash file with `proxies`. */
function providerNodes(text: string): unknown[] {
  let doc: unknown;
  try { doc = parse(text); } catch { throw new ClashSourceError("节点集回来的不是 Clash 格式"); }
  const list = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as { proxies?: unknown }).proxies : null;
  if (!Array.isArray(list) || !list.length) throw new ClashSourceError("节点集回来的不是 Clash 格式");
  return list;
}

/** The node sets a subscription fetches by link: name → link. */
export function linkedProviders(document: Record<string, unknown>): Record<string, string> {
  const sets = document["proxy-providers"];
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(sets && typeof sets === "object" ? sets as Record<string, unknown> : {})) {
    const p = (value && typeof value === "object" ? value : {}) as { type?: unknown; url?: unknown };
    const url = p.type === "http" && typeof p.url === "string" ? web(p.url) : null;
    if (url) out[name] = url;
  }
  return out;
}

function userinfo(got: Fetched): { userinfo?: string } {
  const value = Object.entries(got.headers).find(([k]) => k.toLowerCase() === "subscription-userinfo")?.[1];
  return value && value.length <= 300 ? { userinfo: value } : {};
}

function web(url: string): string | null {
  try { const u = new URL(url.trim()); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null; } catch { return null; }
}

function host(url: string): string {
  try { return new URL(url).host; } catch { return "?"; }
}

function reason(err: unknown): string {
  return err instanceof ClashSourceError ? err.message : "没有取到";
}
