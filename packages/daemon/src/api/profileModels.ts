/** The models each profile really offers (user 2026-11-23: the `dpsk` profile listed Opus, Fable, Sonnet, Haiku,
 *  while it reaches DeepSeek, which serves none of them). An agent's own list (`GET /terminals`) is what the agent
 *  offers at its own vendor; a profile that pays by a key at another address offers what that address lists for the
 *  key (`POST /profiles/models`), and when it lists none, only the model the profile was given. Read for the room's
 *  model switches, the admin's `models` tool and the check before a session is started. */

import { API_HOME, type ProfileAgent } from "../profiles/store.js";

export type Ask = (method: string, path: string, body?: unknown) => Promise<{ readonly status: number; readonly body: unknown }>;
export type OfferedModel = { readonly id: string; readonly name: string; readonly description?: string; readonly older?: boolean };
export type ProfileModels = {
  readonly id: string; readonly name: string;
  /** The models of this profile: the agent's own list, or the other address's. */
  readonly models: readonly OfferedModel[];
  /** Where the list came from: the agent's own, the address (`vendor`), or the profile's one model (`profile`). */
  readonly source: "agent" | "vendor" | "profile";
  /** The model it starts on when none is chosen, when the profile says. */
  readonly model?: string;
  /** The address, for a profile at another vendor's. */
  readonly baseUrl?: string;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? v as Obj : {});
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A profile at an address that is not the agent's own vendor's. */
export function elsewhereAddress(agent: string, baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  const home = API_HOME[agent as ProfileAgent];
  if (!home) return true;
  try { return new URL(baseUrl).origin !== new URL(home).origin; } catch { return true; }
}

/** Claude Code names its aliases without the version ("Opus") and says it in the description ("Opus 5.5 · Most
 *  capable…"): the name with its version, when the description starts with the name. */
export function fullName(name: string, description: string): string {
  const head = description.split(" · ")[0]?.trim() ?? "";
  return head.length > name.length && head.length <= name.length + 12 && head.toLowerCase().startsWith(name.toLowerCase()) && /\d/.test(head.slice(name.length)) ? head : name;
}

const KEEP_MS = 10 * 60_000;

/** Asked of an address at most once in ten minutes per profile: the address is another vendor's, over the network. */
export class ProfileModelLists {
  private kept = new Map<string, { at: number; models: string[] | null }>();
  constructor(private readonly now: () => number = Date.now) {}

  private async vendor(ask: Ask, agent: string, profile: string, baseUrl: string): Promise<string[] | null> {
    const key = `${agent}.${profile}@${baseUrl}`;
    const was = this.kept.get(key);
    if (was && this.now() - was.at < KEEP_MS) return was.models;
    let models: string[] | null = null;
    try {
      const res = await ask("POST", "/profiles/models", { agent, profile, ...(baseUrl ? { baseUrl } : {}) });
      const said = obj(res.body).models;
      if (res.status === 200 && Array.isArray(said)) models = said.filter((m): m is string => typeof m === "string" && !!m).slice(0, 200);
    } catch { /* unreachable: the profile's own model */ }
    this.kept.set(key, { at: this.now(), models });
    return models;
  }

  /** Every profile of every agent with its models. `terminals` and `profiles` are the bodies of `GET /terminals` and
   *  `GET /profiles`, already asked. */
  async all(ask: Ask, terminals: unknown, profiles: unknown): Promise<Record<string, { current: string | null; profiles: ProfileModels[] }>> {
    const own = obj(obj(terminals).models);
    const agents = obj(obj(profiles).agents);
    const out: Record<string, { current: string | null; profiles: ProfileModels[] }> = {};
    for (const agent of new Set([...Object.keys(own), ...Object.keys(agents)])) {
      const agentModels = list(own[agent]).map((m): OfferedModel => ({ id: str(m.id), name: fullName(str(m.name) || str(m.id), str(m.description)), ...(str(m.description) ? { description: str(m.description) } : {}), ...(m.older === true ? { older: true } : {}) })).filter((m) => m.id);
      const of = obj(agents[agent]);
      const rows = await Promise.all(list(of.profiles).map(async (p): Promise<ProfileModels> => {
        const id = str(p.id), name = str(p.name) || id;
        const api = obj(p.api);
        const baseUrl = str(api.baseUrl) || undefined, model = str(api.model) || undefined;
        const base = { id, name, ...(model ? { model } : {}) };
        // Antigravity under a key has another list than signed in, at Google's own address too (`POST /profiles/models`
        // answers with the program's names for it).
        const keyed = agent === "agy" && str(p.kind) === "api";
        if (str(p.kind) !== "api" || (!keyed && !elsewhereAddress(agent, baseUrl))) return { ...base, models: agentModels, source: "agent" };
        const listed = await this.vendor(ask, agent, id, baseUrl ?? "");
        const at = baseUrl ? { baseUrl } : {};
        if (listed?.length) {
          const ids = model && !listed.includes(model) ? [model, ...listed] : listed;
          return { ...base, ...at, models: ids.map((m) => ({ id: m, name: m })), source: "vendor" };
        }
        return { ...base, ...at, models: model ? [{ id: model, name: model }] : [], source: "profile" };
      }));
      out[agent] = { current: str(of.current) || null, profiles: rows };
    }
    return out;
  }
}

/** The one kept list of this service: the room's screens and the Kit's tools ask the same addresses. */
export const profileModelLists = new ProfileModelLists();
