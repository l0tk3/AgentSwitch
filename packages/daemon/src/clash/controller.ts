/** mihomo's controller over its unix socket (docs/clash-v0.md §1): what is running — its mode, whether TUN is on, its
 *  groups and nodes, its rule sets — and the two changes that need no reload: which node a group uses, and one rule
 *  set read again. */

import { request } from "node:http";

export type ClashGroup = { readonly name: string; readonly type: string; readonly now: string | null; readonly members: readonly string[] };
export type ClashStatus = {
  readonly version: string; readonly mode: string; readonly tun: boolean;
  readonly groups: readonly ClashGroup[];
  /** Every node (not a group, not a built-in like DIRECT), by name. */
  readonly nodes: readonly string[];
  /** The rule sets it has, each with how many rules it holds. */
  readonly ruleSets: Readonly<Record<string, number>>;
};

const BUILT_IN = new Set(["Direct", "Reject", "RejectDrop", "Pass", "PassRule", "Compatible", "Dns"]);
const TIMEOUT_MS = 5_000;

export class ClashController {
  constructor(private readonly socket: string) {}

  async status(): Promise<ClashStatus> {
    const [version, configs, proxies, sets] = await Promise.all([this.get("/version"), this.get("/configs"), this.get("/proxies"), this.get("/providers/rules").catch(() => ({}))]);
    const all = obj(obj(proxies).proxies);
    const groups: ClashGroup[] = [], nodes: string[] = [];
    for (const [name, value] of Object.entries(all)) {
      const p = obj(value);
      if (Array.isArray(p.all)) groups.push({ name, type: String(p.type ?? ""), now: typeof p.now === "string" && p.now ? p.now : null, members: p.all.filter((m): m is string => typeof m === "string") });
      else if (!BUILT_IN.has(String(p.type ?? ""))) nodes.push(name);
    }
    const ruleSets = Object.fromEntries(Object.entries(obj(obj(sets).providers)).map(([name, v]) => [name, Number(obj(v).ruleCount) || 0]));
    return { version: String(obj(version).version ?? ""), mode: String(obj(configs).mode ?? ""), tun: obj(obj(configs).tun).enable === true, groups, nodes, ruleSets };
  }

  /** `group` uses `node` from now on (a group one chooses in by hand). */
  async select(group: string, node: string): Promise<void> {
    await this.send("PUT", `/proxies/${encodeURIComponent(group)}`, { name: node });
  }

  /** One rule set read again from where it comes from; nothing else is reloaded and no connection is closed. */
  async refreshRuleSet(name: string): Promise<void> {
    await this.send("PUT", `/providers/rules/${encodeURIComponent(name)}`);
  }

  private get(path: string): Promise<unknown> { return this.send("GET", path); }

  private send(method: string, path: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = request({ socketPath: this.socket, method, path, headers: data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}, timeout: TIMEOUT_MS }, (res) => {
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
