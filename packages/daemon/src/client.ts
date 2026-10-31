/** Thin HTTP client used by the CLI; the phone app will do the same calls. */

import type { EngineStatus, EngineUpdateRequest } from "./browser/engine/kit.js";
import type { Approval, Task, TaskEvent } from "./engine/types.js";
import type { AgentProfiles, Profile, ProfileAgent, ProfileKind } from "./profiles/store.js";
import type { ModelProbe } from "./profiles/apiKeys.js";
import type { ModelSettings } from "./router/modelOverlay.js";
import type { DiscoveredSkill, McpServer, Skill } from "./extensions/types.js";
import type { PlatformMemory } from "./threads/platformMemory.js";

/** An MCP server as sent: what the service fills in when left out (args, env, headers, enabled, harnesses, approval, note) may be. */
export type McpServerInput = Pick<McpServer, "name" | "kind"> & Partial<Omit<McpServer, "name" | "kind">>;
import type { Thread, ThreadState } from "./threads/types.js";

/** Rows the CLI lists by default. */
const CLIENT_LIST_LIMIT = 20;
const SSE_DATA = "data:";

export type NodeSelf = { name: string; kind: string; fingerprint: string | null; port: number | null; listening: boolean };
export type NodeRow = { id: string; name: string; kind: string | null; fingerprint: string; state?: "online" | "offline" | "revoked"; address?: string | null; waiting?: number | null; inbound: string | null };

export type ThreadView = Thread & { summary: ThreadState["summary"]; lastTarget: ThreadState["lastTarget"]; lastActivity: number | null; taskCount: number; handoffs: number };

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
  submit(task: string, cwd: string | undefined, opts: { pin?: { harness: string; model: string }; needsBrowser?: boolean; ephemeral?: boolean; parentId?: string; threadId?: string } = {}) {
    return this.call<Task>("POST", "/tasks", { task, ...(cwd ? { cwd } : {}), ...(opts.pin ? { pin: opts.pin } : {}), ...(opts.needsBrowser ? { needs_browser: true } : {}), ...(opts.ephemeral ? { ephemeral: true } : {}), ...(opts.parentId ? { parent_id: opts.parentId } : {}), ...(opts.threadId ? { thread_id: opts.threadId } : {}) });
  }
  handoff(taskId: string, to?: { harness: string; model: string }) { return this.call<Task>("POST", `/tasks/${taskId}/handoff`, to ? { to } : {}); }
  threads(status?: "open" | "archived") { return this.call<ThreadView[]>("GET", `/threads${status ? `?status=${status}` : ""}`); }
  thread(id: string) { return this.call<ThreadView & { state: ThreadState; tasks: Task[] }>("GET", `/threads/${id}`); }
  patchThread(id: string, patch: { title?: string | null; status?: "open" | "archived"; expires_at?: number | null }) { return this.call<ThreadView>("PATCH", `/threads/${id}`, patch); }
  archiveThread(id: string) { return this.call<ThreadView>("POST", `/threads/${id}/archive`); }
  reopenThread(id: string) { return this.call<ThreadView>("POST", `/threads/${id}/reopen`); }
  deleteThread(id: string) { return this.call<{ ok: true }>("DELETE", `/threads/${id}`); }
  tasks(limit = CLIENT_LIST_LIMIT) { return this.call<Task[]>("GET", `/tasks?limit=${limit}`); }
  task(id: string) { return this.call<Task & { approvals: Approval[] }>("GET", `/tasks/${id}`); }
  answer(taskId: string, approvalId: string, text: string) { return this.call<{ ok: true }>("POST", `/tasks/${taskId}/answer`, { approval_id: approvalId, text }); }
  /** The dispatch model and the default executor and model as they will be after the next start (app-v0 §2). */
  modelSettings() { return this.call<ModelSettings & { restartRequired: boolean }>("GET", "/settings/models"); }
  saveModelSettings(update: { router?: { model: string }; default?: { harness: string; model: string } }) { return this.call<{ restartRequired: boolean }>("PUT", "/settings/models", update); }
  workdir() { return this.call<{ path: string; default: string; problem: string | null }>("GET", "/settings/workdir"); }
  setWorkdir(path: string) { return this.call<{ path: string; default: string; problem: string | null }>("PUT", "/settings/workdir", { path }); }
  /** What paired nodes may do here (docs/mesh-v0.md): type into this node's terminals. */
  mesh() { return this.call<{ keyboard: boolean }>("GET", "/settings/mesh"); }
  setMesh(mesh: { keyboard: boolean }) { return this.call<{ keyboard: boolean }>("PUT", "/settings/mesh", mesh); }
  policy() { return this.call<{ policy: { mode: string; human: string[] }; categories: { id: string; title: string }[] }>("GET", "/approvals/policy"); }
  setPolicy(policy: { mode: "manual" | "auto" | "scoped" | "skip"; human?: string[] }) { return this.call<{ policy: unknown }>("PUT", "/approvals/policy", policy); }
  approve(taskId: string, approvalId: string, decision: "allow" | "deny") { return this.call<{ ok: true }>("POST", `/tasks/${taskId}/approve`, { approval_id: approvalId, decision }); }
  cancel(id: string) { return this.call<Task>("POST", `/tasks/${id}/cancel`); }
  deleteTask(id: string) { return this.call<{ ok: true }>("DELETE", `/tasks/${id}`); }
  rate(id: string, rating: 1 | -1 | null) { return this.call<{ ok: true }>("POST", `/tasks/${id}/rate`, { rating }); }
  approvals() { return this.call<Approval[]>("GET", "/approvals"); }
  quota(refresh = false) { return this.call<unknown[]>("GET", `/quota${refresh ? "?refresh=1" : ""}`); }
  preview(task: string, cwd: string) { return this.call<unknown>("POST", "/route/preview", { task, cwd }); }
  routingLog(limit = CLIENT_LIST_LIMIT) { return this.call<unknown[]>("GET", `/routing/log?limit=${limit}`); }
  context() { return this.call<{ path: string; text: string; warnings: string[] }>("GET", "/context"); }
  memory() { return this.call<{ path: string; text: string; warnings: string[] }>("GET", "/memory"); }
  putMemory(text: string) { return this.call<{ path: string; warnings: string[] }>("PUT", "/memory", { text }); }
  /** CONTEXT.md saved: what looks like a credential is sealed first (`sealed`), lines that may not stay are said (`warnings`). */
  putContext(text: string) { return this.call<{ path: string; warnings: string[]; sealed: { label: string }[] }>("PUT", "/context", { text }); }
  /** What dispatch learned of platforms (docs/threads-v0.md), and one forgotten. */
  platformMemory() { return this.call<{ records: PlatformMemory[] }>("GET", "/platform-memory"); }
  forgetPlatformMemory(id: string) { return this.call<{ ok: true }>("DELETE", `/platform-memory/${encodeURIComponent(id)}`); }
  putMcp(server: McpServerInput) { return this.call<McpServer>("PUT", `/mcp/${encodeURIComponent(server.name)}`, server); }
  removeMcp(name: string) { return this.call<{ ok: true }>("DELETE", `/mcp/${encodeURIComponent(name)}`); }
  skill(name: string) { return this.call<Skill & { content: string }>("GET", `/skills/${encodeURIComponent(name)}`); }
  putSkill(name: string, body: { content?: string; enabled?: boolean; harnesses?: string[] }) { return this.call<Skill>("PUT", `/skills/${encodeURIComponent(name)}`, body); }
  removeSkill(name: string) { return this.call<{ ok: true }>("DELETE", `/skills/${encodeURIComponent(name)}`); }
  discoverSkills() { return this.call<DiscoveredSkill[]>("GET", "/skills/discover"); }
  importSkill(path: string) { return this.call<Skill>("POST", "/skills/import", { path }); }
  records() { return this.call<unknown[]>("GET", "/records"); }
  files(taskId: string) { return this.call<{ root: "artifacts" | "cwd" | null; files: { path: string; size: number; mtime: number }[] }>("GET", `/tasks/${taskId}/files`); }
  contextExample() { return this.call<{ text: string }>("GET", "/context/example"); }
  mcp() { return this.call<McpServer[]>("GET", "/mcp"); }
  skills() { return this.call<Skill[]>("GET", "/skills"); }

  /** Follow a task's SSE stream; calls onEvent for each event, resolves when the task ends. */
  async watch(id: string, onEvent: (ev: TaskEvent) => void | Promise<void>, after = 0): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/tasks/${id}/events?after=${after}`, { headers: this.auth() });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split("\n").find((l) => l.startsWith(SSE_DATA));
        if (data) await onEvent(JSON.parse(data.slice(SSE_DATA.length).trim()) as TaskEvent);
      }
    }
  }
}
