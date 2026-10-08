/** What AgentSwitch keeps of its Clash Integration (docs/clash-v0.md §6): which of Clash Verge's subscriptions it works
 *  from, the nodes for Claude and for OpenAI in their order, the addresses that go direct, and the token the addresses
 *  it serves carry. No node's address or password is kept: the subscription is read from Clash Verge's own file each
 *  time it is asked for. */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMPTY_SETTINGS, type ClashSettings, type ServiceProxy } from "./build.js";

const MAX_NODES = 32, MAX_DIRECT = 64;

export class ClashStore {
  private readonly dir: string;
  private readonly file: string;

  constructor(home: string) { this.dir = join(home, "clash"); this.file = join(this.dir, "settings.json"); }

  settings(): ClashSettings { return this.read().settings; }

  /** The token the served addresses carry; made on first use. */
  token(): string {
    const now = this.read();
    if (now.token) return now.token;
    const token = randomBytes(18).toString("base64url");
    this.write({ ...now, token });
    return token;
  }

  save(next: ClashSettings): ClashSettings {
    const settings = clean(next);
    this.write({ ...this.read(), settings });
    return settings;
  }

  private read(): { settings: ClashSettings; token?: string } {
    try {
      const o = JSON.parse(readFileSync(this.file, "utf8")) as { settings?: unknown; token?: unknown };
      return { settings: clean(o.settings), ...(typeof o.token === "string" && /^[\w-]{16,64}$/.test(o.token) ? { token: o.token } : {}) };
    } catch { return { settings: EMPTY_SETTINGS }; }
  }

  private write(state: { settings: ClashSettings; token?: string }): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function clean(raw: unknown): ClashSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim() && x.length <= 200).map((x) => x.trim()))].slice(0, max) : []);
  const service = (v: unknown): ServiceProxy => {
    const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const nodes = strings(s.nodes, MAX_NODES);
    const picked = typeof s.picked === "string" && nodes.includes(s.picked) ? s.picked : undefined;
    return { nodes, mode: s.mode === "manual" && picked ? "manual" : "auto", ...(picked ? { picked } : {}) };
  };
  return { source: typeof o.source === "string" && /^[A-Za-z0-9]{6,32}$/.test(o.source) ? o.source : null, claude: service(o.claude), openai: service(o.openai), direct: strings(o.direct, MAX_DIRECT) };
}
