/** What AgentSwitch keeps of its Clash Integration's settings (docs/clash-v0.md §7): the nodes for Claude and for
 *  OpenAI in their order, the addresses that go direct, how often the subscription is fetched again, and the token
 *  the addresses it serves carry. The subscription itself is kept beside it (source.ts). */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMPTY_SETTINGS, UPDATE_HOURS, type ClashSettings } from "./build.js";

const MAX_NODES = 32, MAX_DIRECT = 64;
type State = { settings: ClashSettings; token?: string };

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
    const settings = cleanSettings(next);
    this.write({ ...this.read(), settings });
    return settings;
  }

  private read(): State {
    try {
      const o = JSON.parse(readFileSync(this.file, "utf8")) as { settings?: unknown; token?: unknown };
      return { settings: cleanSettings(o.settings), ...(typeof o.token === "string" && /^[\w-]{16,64}$/.test(o.token) ? { token: o.token } : {}) };
    } catch { return { settings: EMPTY_SETTINGS }; }
  }

  private write(state: State): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export function cleanSettings(raw: unknown): ClashSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // A node's name is kept to the letter (it is matched against the subscription's); an address is trimmed.
  const strings = (v: unknown, max: number, trim: boolean): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim() && x.length <= 200).map((x) => (trim ? x.trim() : x)))].slice(0, max) : []);
  const service = (v: unknown): { nodes: string[] } => ({ nodes: strings((v && typeof v === "object" ? v as { nodes?: unknown } : {}).nodes, MAX_NODES, false) });
  const hours = (UPDATE_HOURS as readonly number[]).includes(o.autoUpdateHours as number) ? o.autoUpdateHours as number : EMPTY_SETTINGS.autoUpdateHours;
  return { claude: service(o.claude), openai: service(o.openai), direct: strings(o.direct, MAX_DIRECT, true), autoUpdateHours: hours };
}
