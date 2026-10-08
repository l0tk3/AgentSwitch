/** mihomo's controller over its unix socket (docs/clash-v0.md §1, §7.3): what is running — its mode, whether TUN is
 *  on, its groups, its node sets and rule sets — and what needs no reload: which member a group uses, one node set or
 *  one rule set read again, how long a node takes to answer. */

import { request } from "node:http";

export type ClashGroup = { readonly name: string; readonly type: string; readonly now: string | null; readonly members: readonly string[] };
export type ClashStatus = {
  readonly version: string; readonly mode: string; readonly tun: boolean;
  readonly groups: readonly ClashGroup[];
  /** Every node (not a group, not a built-in like DIRECT), by name: the subscription's own list, then its node sets'. */
  readonly nodes: readonly string[];
  /** Its node sets, each with its nodes in their order. A node of a set is reached through the set, not by
   *  `/proxies/<name>` (seen 2026-10-08: `Resource not found`). */
  readonly nodeSets: Readonly<Record<string, readonly string[]>>;
  /** The rule sets it has, each with how many rules it holds. */
  readonly ruleSets: Readonly<Record<string, number>>;
};

const BUILT_IN = new Set(["Direct", "Reject", "RejectDrop", "Pass", "PassRule", "Compatible", "Dns"]);
const TIMEOUT_MS = 5_000;

export class ClashController {
  constructor(private readonly socket: string) {}

  async status(): Promise<ClashStatus> {
    const [version, configs, proxies, sets, sources] = await Promise.all([this.get("/version"), this.get("/configs"), this.get("/proxies"), this.get("/providers/rules").catch(() => ({})), this.get("/providers/proxies").catch(() => ({}))]);
    const all = obj(obj(proxies).proxies);
    const groups: ClashGroup[] = [], nodes: string[] = [];
    for (const [name, value] of Object.entries(all)) {
      const p = obj(value);
      if (Array.isArray(p.all)) groups.push({ name, type: String(p.type ?? ""), now: typeof p.now === "string" && p.now ? p.now : null, members: p.all.filter((m): m is string => typeof m === "string") });
      else if (!BUILT_IN.has(String(p.type ?? ""))) nodes.push(name);
    }
    // A node that comes from a node set of the subscription is listed there, not among the proxies (seen on
    // 2026-10-08: 42 nodes, none of them in /proxies). `Compatible` sets are the groups over again.
    const seen = new Set(nodes);
    const nodeSets: Record<string, string[]> = {};
    for (const [set, provider] of Object.entries(obj(obj(sources).providers))) {
      const p = obj(provider);
      if (p.vehicleType === "Compatible" || !Array.isArray(p.proxies)) continue;
      const members: string[] = nodeSets[set] = [];
      for (const node of p.proxies) {
        const n = obj(node);
        if (typeof n.name !== "string" || Array.isArray(n.all) || BUILT_IN.has(String(n.type ?? ""))) continue;
        members.push(n.name);
        if (!seen.has(n.name)) { seen.add(n.name); nodes.push(n.name); }
      }
    }
    const ruleSets = Object.fromEntries(Object.entries(obj(obj(sets).providers)).map(([name, v]) => [name, Number(obj(v).ruleCount) || 0]));
    return { version: String(obj(version).version ?? ""), mode: String(obj(configs).mode ?? ""), tun: obj(obj(configs).tun).enable === true, groups, nodes, nodeSets, ruleSets };
  }

  /** `group` uses `node` from now on (a group one chooses in by hand). */
  async select(group: string, node: string): Promise<void> {
    await this.send("PUT", `/proxies/${encodeURIComponent(group)}`, { name: node });
  }

  /** One rule set read again from where it comes from; nothing else is reloaded and no connection is closed. */
  async refreshRuleSet(name: string): Promise<void> {
    await this.send("PUT", `/providers/rules/${encodeURIComponent(name)}`);
  }

  /** One node set read again from where it comes from: the groups that use it have its nodes, in its order, at once. */
  async refreshNodeSet(name: string): Promise<void> {
    await this.send("PUT", `/providers/proxies/${encodeURIComponent(name)}`);
  }

  /** How long `node` of the node set `set` takes to answer `url` through it, in ms; null: it did not in `timeoutMs`. */
  async delay(set: string, node: string, url: string, timeoutMs: number): Promise<number | null> {
    try {
      const got = obj(await this.send("GET", `/providers/proxies/${encodeURIComponent(set)}/${encodeURIComponent(node)}/healthcheck?url=${encodeURIComponent(url)}&timeout=${timeoutMs}`, undefined, timeoutMs + 2_000));
      return typeof got.delay === "number" && got.delay > 0 ? got.delay : null;
    } catch { return null; }
  }

  private get(path: string): Promise<unknown> { return this.send("GET", path); }

  private send(method: string, path: string, body?: unknown, timeout: number = TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = request({ socketPath: this.socket, method, path, headers: data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}, timeout }, (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => {
          const text = Buffer.concat(parts).toString("utf8");
          if ((res.statusCode ?? 0) >= 300) { reject(new Error(`clash: ${method} ${path} → ${res.statusCode} ${text.slice(0, 200)}`)); return; }
          try { resolve(text ? JSON.parse(text) : null); } catch { resolve(null); }
        });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("clash: no answer")));
      req.on("error", reject);
      req.end(data ?? undefined);
    });
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
