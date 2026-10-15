/** The key a profile pays by (docs/profiles-v0.md §3.6): kept as a ciphertext of the gate's, sealed for the address it
 *  is sent to, and handed to the agent of a terminal under that profile when it asks — Claude Code through its
 *  `apiKeyHelper`, Codex through its provider's `auth` command (terminals/launch.ts, terminals/hookClient.ts `key`). It
 *  is in no file and in no environment: the plaintext is in this process for the moment the gate hands it over, and in
 *  the agent that sends it.
 *
 *  A terminal is not behind the credential gate (§8): the agent holds this key as it would one typed into its own
 *  settings. What the gate adds is that the key at rest is a ciphertext, and that it opens for one address only. */

import { API_HOME, apiSite, type Profile, type ProfileAgent, type ProfileApi, type ProfileKind } from "./store.js";

/** The gate's answer for a ciphertext it may open for one of `sites` (browser/fill.ts `FillResolver`, as the service
 *  wires it). */
export type KeyResolver = (token: string, sites: readonly string[]) => Promise<{ readonly value: string }>;
/** A ciphertext of the gate's, as it is written. */
const CIPHERTEXT = /^enc:v1:[A-Za-z0-9_=-]{16,}$/;

/** The part of the profile store this needs. */
export type ApiKeyStore = {
  apiOf(agent: ProfileAgent, id: string): ProfileApi | null;
  setApi(agent: ProfileAgent, id: string, api: ProfileApi): void;
  create(agent: ProfileAgent, name: string, kind: ProfileKind, api?: ProfileApi): Profile;
};

export class ApiKeyError extends Error {}

/** What a key looks like at the least: one word, not a handful of characters. Vendors' and relays' keys differ. */
const KEY = /^\S{8,400}$/;

export type ApiKeysOptions = {
  readonly store: ApiKeyStore;
  /** The gate's answer for a ciphertext; absent without the gate: no key can be kept or handed over. */
  readonly resolve?: KeyResolver | undefined;
  /** The models the address offers for this key (`listModels` by default); null when it would not say. */
  readonly models?: (agent: ProfileAgent, baseUrl: string | undefined, key: string) => Promise<readonly string[] | null>;
};

const MODELS_TIMEOUT_MS = 8_000;

/** The models an address lists for a key — Anthropic's `GET /v1/models` (`x-api-key` and a bearer, as Claude Code sends
 *  the key), OpenAI's `GET <base>/models` — or null when it lists none (a relay without the route, an address that is
 *  down): then a model is not checked. */
export async function listModels(agent: ProfileAgent, baseUrl: string | undefined, key: string, fetchImpl: typeof fetch = fetch): Promise<readonly string[] | null> {
  const base = (baseUrl ?? API_HOME[agent] ?? "").replace(/\/+$/, "");
  if (!base) return null;
  const url = agent === "claude-code" ? `${base}/v1/models?limit=1000` : `${base}/models`;
  const headers: Record<string, string> = agent === "claude-code" ? { "x-api-key": key, authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` };
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = ((await res.json()) as { data?: unknown }).data;
    if (!Array.isArray(data)) return null;
    const ids = data.map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : null)).filter((id): id is string => typeof id === "string");
    return ids.length ? ids : null;
  } catch { return null; }
}

/** What to say of `model` when `offered` does not list it: the one it was likely meant to be, and some others. */
export function unknownModel(model: string, offered: readonly string[]): string {
  const norm = (m: string) => m.toLowerCase().replace(/[._\s]/g, "-");
  const near = offered.find((m) => norm(m) === norm(model))
    ?? [...offered].sort((a, b) => distance(norm(a), norm(model)) - distance(norm(b), norm(model))).find((m) => distance(norm(m), norm(model)) <= 3);
  const some = offered.slice(0, 8).join("、");
  return `这个地址没有模型 ${model}${near ? `，是不是 ${near}` : ""}？它列出的有：${some}${offered.length > 8 ? " 等" : ""}。`;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const was = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = was;
    }
  }
  return row[b.length]!;
}

export class ApiKeys {
  constructor(private readonly o: ApiKeysOptions) {}

  /** A new profile that pays by `api.key`, a ciphertext sealed for where the key is sent. Refused before anything is
   *  made when the gate will not open it for that address. */
  async create(agent: ProfileAgent, name: string, api: ProfileApi, force = false): Promise<Profile> {
    const key = await this.open(agent, api.key, api.baseUrl);
    if (!force) await this.offered(agent, api.baseUrl, key, api.model);
    return this.o.store.create(agent, name, "api", api);
  }

  /** A model the address does not list is refused, saying which it was likely meant to be (`force`: kept anyway — a
   *  relay that serves more than it lists). Not checked when the address lists none. */
  private async offered(agent: ProfileAgent, baseUrl: string | undefined, key: string, model: string | undefined): Promise<void> {
    if (!model) return;
    const list = await (this.o.models ?? listModels)(agent, baseUrl, key);
    if (list && !list.includes(model)) throw new ApiKeyError(unknownModel(model, list));
  }

  /** `id`'s address and model from now on, and its key when one is given (`key` null: the one it has — which opens
   *  only while the address is on the site it was sealed for). */
  async set(agent: ProfileAgent, id: string, next: { readonly key: string | null; readonly baseUrl?: string | undefined; readonly model?: string | undefined }, force = false): Promise<void> {
    const kept = this.o.store.apiOf(agent, id);
    const key = next.key ?? kept?.key;
    if (!key) throw new ApiKeyError("这个配置还没有 API key。");
    if (!next.key && apiSite(agent, next.baseUrl) !== apiSite(agent, kept?.baseUrl)) throw new ApiKeyError("地址换到了另一个站点，原来的 API key 是为原站点加密的，请一并填入新的。");
    const plain = await this.open(agent, key, next.baseUrl);
    if (!force) await this.offered(agent, next.baseUrl, plain, next.model);
    this.o.store.setApi(agent, id, { key, baseUrl: next.baseUrl, model: next.model });
  }

  /** The key itself, for the agent of a terminal under `id` to send. */
  async plain(agent: ProfileAgent, id: string): Promise<string> {
    const kept = this.o.store.apiOf(agent, id);
    if (!kept) throw new ApiKeyError("这个配置没有 API key。");
    return this.open(agent, kept.key, kept.baseUrl);
  }

  private async open(agent: ProfileAgent, sealed: string, baseUrl: string | undefined): Promise<string> {
    if (!CIPHERTEXT.test(sealed)) throw new ApiKeyError("API key 请以密文（enc:v1:）提供。");
    if (!this.o.resolve) throw new ApiKeyError("凭据网关不可用，无法使用 API key。");
    let site: string;
    try { site = apiSite(agent, baseUrl?.trim() || undefined); } catch { throw new ApiKeyError("地址不是一个 http(s) 地址。"); }
    let value: string;
    try { value = (await this.o.resolve(sealed, [site])).value.trim(); }
    catch { throw new ApiKeyError(`凭据网关没有给出这个 API key（它须是为 ${new URL(site).host} 加密的）。`); }
    if (!KEY.test(value)) throw new ApiKeyError("这不像一个 API key。");
    return value;
  }
}
