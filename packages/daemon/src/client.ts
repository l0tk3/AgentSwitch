/** Thin HTTP client used by the CLI and `agentswitch config`. */

import type { EngineStatus, EngineUpdateRequest } from "./browser/engine/kit.js";
import type { AgentProfiles, Profile, ProfileAgent, ProfileKind } from "./profiles/store.js";
import type { Leftover } from "./terminals/leftovers.js";
import type { ModelProbe } from "./profiles/apiKeys.js";
export type NodeSelf = { name: string; kind: string; fingerprint: string | null; port: number | null; listening: boolean };
export type NodeRow = { id: string; name: string; kind: string | null; fingerprint: string; state?: "online" | "offline" | "revoked"; address?: string | null; waiting?: number | null; inbound: string | null };

export class Client {
  /** `token`: the local API's (`$AGENTSWITCH_HOME/local-token`, api/localAuth.ts). `extra`: headers every request
   *  carries, the nodes key among them (nodes/book.ts). */
  constructor(private readonly base: string, private readonly fetchImpl: typeof fetch = fetch, private readonly token: string | null = null, private readonly extra: Readonly<Record<string, string>> = {}) {}

  private auth(): Record<string, string> {
    return { ...this.extra, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) };
  }

  /** The same calls made to another node this one is paired with, by its id or name (docs/mesh-v0.md §5.2): this
   *  node's service passes them on. */
  on(node: string): Client {
    return new Client(`${this.base}/nodes/${encodeURIComponent(node)}`, this.fetchImpl, this.token, this.extra);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers: { "content-type": "application/json", ...this.auth() }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    // A service older than the call answers a route it does not have in plain text (`404 Not Found`).
    let data: T & { error?: string };
    try { data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string }); }
    catch { throw new Error(res.ok ? `${method} ${path}: not JSON` : `HTTP ${res.status}${text.trim() ? `: ${text.trim().slice(0, 200)}` : ""}`); }
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  health() { return this.call<{ ok: boolean; version: string }>("GET", "/healthz"); }
  /** docs/mesh-v0.md: this node, the nodes it uses, and the devices (phones, other nodes) that use it. */
  node() { return this.call<{ name: string; kind: string; version: string; home: string; has: string[] }>("GET", "/node"); }
  nodes() { return this.call<{ self: NodeSelf; nodes: NodeRow[] }>("GET", "/nodes"); }
  addNode(link: string, back: boolean) { return this.call<{ ok: true; node: NodeRow; back: string }>("POST", "/nodes", { link, back }); }
  removeNode(node: string, both: boolean) { return this.call<{ ok: true; told: boolean; inboundRevoked: boolean; node: NodeRow }>("DELETE", `/nodes/${encodeURIComponent(node)}${both ? "?both=1" : ""}`); }
  pairing(back: boolean) { return this.call<{ code: string; expiresAt: number; link: string }>("POST", "/pairing", { back }); }
  /** This node's remote listener: name, port, fingerprint and the addresses a pairing offers (local only). */
  remoteInfo() { return this.call<{ enabled: boolean; port: number | null; fingerprint: string | null; name: string | null; lan: string[]; tailnet: string[]; onlineDevices: number }>("GET", "/remote/info"); }
  /** A one-time path that signs a browser on this machine into the web console (api/localAuth.ts; 60 s). */
  consoleLink() { return this.call<{ path: string }>("POST", "/local/console-link", {}); }
  devices() { return this.call<{ id: string; name: string; platform: string; lastSeenAt: number | null; revokedAt: number | null; online: boolean }[]>("GET", "/devices"); }
  revokeDevice(id: string) { return this.call<{ ok: true }>("DELETE", `/devices/${encodeURIComponent(id)}`); }
  /** docs/profiles-v0.md: every agent's profiles; one made (an API key a ciphertext, §3.6), changed, removed. */
  profiles() { return this.call<{ agents: Record<ProfileAgent, AgentProfiles> }>("GET", "/profiles"); }
  /** What the terminals left running (docs/terminal-v0.md §11); `on` false: this service does not clean them. */
  leftovers() { return this.call<{ on: boolean; graceMs?: number; leftovers: Leftover[] }>("GET", "/terminals/leftovers"); }
  endLeftovers(what: { terminal?: string; pids?: number[] } = {}) { return this.call<{ ended: number[] }>("POST", "/terminals/leftovers/end", what); }
  /** The models an address offers for a key (a ciphertext just sealed for it, or the one `profile` keeps), or what it said instead. */
  profileModels(agent: ProfileAgent, ask: { baseUrl?: string; key?: string; profile?: string }) { return this.call<ModelProbe>("POST", "/profiles/models", { agent, ...ask }); }
  createProfile(agent: ProfileAgent, name: string, kind: ProfileKind, api?: { key: string; baseUrl?: string; model?: string; force?: boolean }) {
    return this.call<{ profile: Profile; agents: Record<ProfileAgent, AgentProfiles> }>("POST", "/profiles", { agent, name, kind, ...(api ? { api } : {}) });
  }
  setProfileApi(agent: ProfileAgent, id: string, api: { key: string | null; baseUrl: string | null; model: string | null; force?: boolean }) {
    return this.call<{ agents: Record<ProfileAgent, AgentProfiles> }>("PUT", `/profiles/${agent}/${encodeURIComponent(id)}/api`, api);
  }
  setProfileColor(agent: ProfileAgent, id: string, color: string) { return this.call<{ agents: Record<ProfileAgent, AgentProfiles> }>("PUT", `/profiles/${agent}/${encodeURIComponent(id)}/color`, { color }); }
  /** A profile's own proxy (§4: its password a ciphertext sealed for the proxy's host:port; `keepPassword` keeps the one
   *  kept) set or, with `server` null, taken away; checked at once, `problem` saying when it let nothing out. */
  setProfileProxy(agent: ProfileAgent, id: string, proxy: { server: string | null; username?: string; password?: string; keepPassword?: boolean }) {
    return this.call<{ agents: Record<ProfileAgent, AgentProfiles>; problem?: string }>("PUT", `/profiles/${agent}/${encodeURIComponent(id)}/proxy`, proxy);
  }
  checkProfile(agent: ProfileAgent, id: string) { return this.call<{ agents: Record<ProfileAgent, AgentProfiles>; problem?: string }>("POST", `/profiles/${agent}/${encodeURIComponent(id)}/check`, {}); }
  /** A claude.ai session key (§3.4), a ciphertext sealed for claude.ai; null forgets it. */
  setProfileSessionKey(agent: ProfileAgent, id: string, key: string | null) { return this.call<{ agents: Record<ProfileAgent, AgentProfiles> }>("PUT", `/profiles/${agent}/${encodeURIComponent(id)}/session-key`, { key }); }
  setProfileTelemetry(agent: ProfileAgent, id: string, on: boolean) { return this.call<{ agents: Record<ProfileAgent, AgentProfiles> }>("PUT", `/profiles/${agent}/${encodeURIComponent(id)}/telemetry`, { on }); }
  removeProfile(agent: ProfileAgent, id: string) { return this.call<{ agents: Record<ProfileAgent, AgentProfiles> }>("DELETE", `/profiles/${agent}/${encodeURIComponent(id)}`); }
  /** docs/browser-v0.md §7: the browser engine as installed; `check` asks what could be. */
  browserEngine(opts: { check?: boolean; prerelease?: boolean } = {}) {
    return this.call<EngineStatus>("GET", `/browser/engine${opts.check ? `?check=1${opts.prerelease ? "&prerelease=1" : ""}` : ""}`);
  }
  updateBrowserEngine(req: EngineUpdateRequest) { return this.call<EngineStatus & { ok: true }>("POST", "/browser/engine/update", req); }
  cancelBrowserEngine() { return this.call<{ ok: true }>("POST", "/browser/engine/cancel", {}); }
  workdir() { return this.call<{ path: string; default: string; problem: string | null }>("GET", "/settings/workdir"); }
  setWorkdir(path: string) { return this.call<{ path: string; default: string; problem: string | null }>("PUT", "/settings/workdir", { path }); }
  /** What paired nodes may do here (docs/mesh-v0.md): type into this node's terminals. */
  mesh() { return this.call<{ keyboard: boolean }>("GET", "/settings/mesh"); }
  setMesh(mesh: { keyboard: boolean }) { return this.call<{ keyboard: boolean }>("PUT", "/settings/mesh", mesh); }
}
