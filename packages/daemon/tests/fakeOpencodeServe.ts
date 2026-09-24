/** A fake OpenCode v2 server for the executor's serve path: the endpoints opencodeServeRun.ts uses, with the behaviour
 *  verified against 2.0.8 (runtime MCP per location, env/permissions/instruction entries per session, desc message
 *  pages with an idle marker, pending permissions and forms answered through reply endpoints). A per-test `script`
 *  plays the model after each prompt. No model, no process. */

import { createServer, type Server } from "node:http";

type Json = Record<string, unknown>;
type Rule = { action: string; resource: string; effect: string };

export type FakeSession = {
  readonly id: string;
  readonly directory: string;
  readonly parentID: string | null;
  permissions: Rule[];
  env: Record<string, string> | null;
  envHistory: Record<string, string>[];
  instructions: Record<string, unknown>;
  model: { providerID: string; id: string } | null;
  agent: string | null;
  messages: Json[];
  active: boolean;
  prompts: string[];
};

type Pending<T> = { id: string; sessionID: string; resolve: (v: T) => void; body: Json };

export type Turn = {
  readonly session: FakeSession;
  readonly text: string;
  /** Adds an assistant message (completed unless `open`) with text and/or tool parts. */
  assistant(parts: Json[], extra?: Json): Json;
  /** A pending permission request; resolves with the reply's decision. */
  ask(action: string, resources: string[]): Promise<string>;
  /** A pending form; resolves with the answer, or "cancelled". */
  form(fields: Json[], kind?: string): Promise<Json | "cancelled">;
  /** A running sub-agent session under this one. */
  child(): FakeSession;
  interrupted: Promise<void>;
};

export type Script = (turn: Turn) => Promise<void>;

export type Failure = { readonly method: string; readonly path: RegExp; readonly status: number; times: number; readonly body?: string };

export class FakeOpenCode {
  readonly password = "fake-password";
  readonly sessions = new Map<string, FakeSession>();
  /** location → live runtime MCP servers. */
  readonly mcp = new Map<string, Map<string, Json>>();
  readonly requests: { method: string; path: string; body: string }[] = [];
  readonly failures: Failure[] = [];
  readonly permissions: Pending<string>[] = [];
  readonly forms: Pending<Json | "cancelled">[] = [];
  readonly replies: { id: string; body: Json }[] = [];
  agentsReady = true;
  /** Probe evaluation override (default: last matching rule, then allow). */
  evaluate: ((s: FakeSession, action: string, resource: string) => string) | null = null;
  script: Script = async (t) => { t.assistant([{ type: "text", text: "done" }]); };
  private server: Server | null = null;
  private clock = 0;
  private n = 0;
  private interrupts = new Map<string, () => void>();

  get url(): string { return `http://127.0.0.1:${(this.server!.address() as { port: number }).port}`; }

  start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        this.requests.push({ method: req.method ?? "", path: req.url ?? "", body });
        const send = (code: number, v?: unknown) => { res.statusCode = code; if (v === undefined) return res.end(); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };
        const auth = req.headers.authorization ?? "";
        if (auth !== `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`) return send(401, { _tag: "UnauthorizedError" });
        const fail = this.failures.find((f) => f.times > 0 && f.method === req.method && f.path.test(req.url ?? ""));
        if (fail) { fail.times--; res.statusCode = fail.status; return res.end(fail.body ?? JSON.stringify({ _tag: "InjectedError" })); }
        try { this.route(req.method ?? "", req.url ?? "", body ? JSON.parse(body) as Json : {}, send); }
        catch (e) { send(500, { _tag: "FakeError", message: (e as Error).message }); }
      });
    });
    return new Promise((r) => this.server!.listen(0, "127.0.0.1", r));
  }

  stop(): Promise<void> { return new Promise((r) => (this.server ? this.server.close(() => r()) : r())); }

  now(): number { this.clock = Math.max(Date.now(), this.clock + 1); return this.clock; }

  newSession(directory: string, extra: Partial<FakeSession> = {}): FakeSession {
    const s: FakeSession = { id: `ses_${++this.n}`, directory, parentID: null, permissions: [], env: null, envHistory: [], instructions: {}, model: null, agent: null, messages: [], active: false, prompts: [], ...extra };
    this.sessions.set(s.id, s);
    return s;
  }

  liveMcp(directory: string): Record<string, Json> { return Object.fromEntries(this.mcp.get(directory) ?? []); }

  bodies(method: string, path: RegExp): Json[] { return this.requests.filter((r) => r.method === method && path.test(r.path)).map((r) => (r.body ? JSON.parse(r.body) as Json : {})); }

  private route(method: string, raw: string, body: Json, send: (code: number, v?: unknown) => void): void {
    const url = new URL(raw, "http://x");
    const path = url.pathname;
    const location = url.searchParams.get("location[directory]") ?? "";
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/api/agent") return send(200, { location: { directory: location }, data: this.agentsReady ? [{ id: "build" }, { id: "plan" }] : [] });
    if (method === "GET" && path === "/api/mcp") return send(200, { location: { directory: location }, data: Object.keys(this.liveMcp(location)).map((name) => ({ name, status: { status: "connected" } })) });
    if ((m = /^\/api\/experimental\/mcp\/([^/]+)$/.exec(path))) {
      const name = decodeURIComponent(m[1]!);
      const at = this.mcp.get(location) ?? new Map<string, Json>();
      this.mcp.set(location, at);
      if (method === "PUT") { at.set(name, body.config as Json); return send(204); }
      if (method === "DELETE") return at.delete(name) ? send(204) : send(404, { _tag: "McpServerNotFoundError" });
    }
    if (method === "POST" && path === "/api/session") {
      const s = this.newSession(String((body.location as Json).directory), { permissions: (body.permissions as Rule[]) ?? [], model: body.model as FakeSession["model"], agent: String(body.agent ?? "") });
      return send(200, { data: this.info(s) });
    }
    if (method === "GET" && path === "/api/session/active") return send(200, { data: Object.fromEntries([...this.sessions.values()].filter((s) => s.active).map((s) => [s.id, { type: "running" }])) });
    if ((m = /^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/([^/]+)$/.exec(path)) && method === "PUT") {
      const s = this.sessions.get(m[1]!); if (!s) return send(404, { _tag: "SessionNotFoundError" });
      s.instructions[m[2]!] = body.value; return send(204);
    }
    if (!(m = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(path))) return send(404, { _tag: "RouteNotFound" });
    const s = this.sessions.get(decodeURIComponent(m[1]!));
    if (!s) return send(404, { _tag: "SessionNotFoundError" });
    const rest = m[2] ?? "";
    if (rest === "" && method === "GET") return send(200, { data: this.info(s) });
    if (rest === "" && method === "PATCH") { if (body.permissions) s.permissions = body.permissions as Rule[]; return send(200, { data: this.info(s) }); }
    if (rest === "" && method === "DELETE") { this.sessions.delete(s.id); return send(204); }
    if (rest === "/model" && method === "POST") { s.model = body.model as FakeSession["model"]; return send(204); }
    if (rest === "/agent" && method === "POST") { s.agent = String(body.agent); return send(204); }
    if (rest === "/environment" && method === "PUT") { s.env = body.variables as Record<string, string>; s.envHistory.push(s.env); return send(204); }
    if (rest === "/permission" && method === "POST") {
      const action = String(body.action); const resource = String((body.resources as string[])[0]);
      const effect = this.evaluate ? this.evaluate(s, action, resource) : evaluate(s.permissions, action, resource);
      const id = `per_probe_${++this.n}`;
      if (effect === "ask") this.permissions.push({ id, sessionID: s.id, resolve: () => undefined, body: { id, sessionID: s.id, action, resources: [resource] } });
      return send(200, { data: { id, effect } });
    }
    if (rest === "/permission" && method === "GET") return send(200, { data: this.permissions.filter((p) => p.sessionID === s.id).map((p) => p.body) });
    if ((m = /^\/permission\/([^/]+)\/reply$/.exec(rest)) && method === "POST") return this.settle(this.permissions, m[1]!, String(body.decision), body, send);
    if (rest === "/form" && method === "GET") return send(200, { data: this.forms.filter((f) => f.sessionID === s.id).map((f) => f.body) });
    if ((m = /^\/form\/([^/]+)\/reply$/.exec(rest)) && method === "POST") return this.settle(this.forms, m[1]!, body.answer as Json, body, send);
    if ((m = /^\/form\/([^/]+)$/.exec(rest)) && method === "DELETE") return this.settle(this.forms, m[1]!, "cancelled", {}, send);
    if (rest === "/interrupt" && method === "POST") {
      const wake = this.interrupts.get(s.id);
      if (s.active && wake) { wake(); this.finish(s, "interrupted"); }
      return send(200, { interrupted: !!wake });
    }
    if (rest === "/prompt" && method === "POST") return send(200, { data: this.prompt(s, String(body.text)) });
    if (rest === "/message" && method === "GET") {
      const all = [...s.messages].sort((a, b) => Number((b.time as Json).created) - Number((a.time as Json).created));
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const page = all.slice(offset, offset + limit);
      return send(200, { data: page, cursor: { previous: null, next: offset + limit < all.length ? String(offset + limit) : null } });
    }
    return send(404, { _tag: "RouteNotFound" });
  }

  private settle<T>(list: Pending<T>[], id: string, value: T, body: Json, send: (code: number, v?: unknown) => void): void {
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) return send(404, { _tag: "NotFound" });
    const [p] = list.splice(i, 1);
    this.replies.push({ id, body });
    p!.resolve(value);
    send(204);
  }

  private info(s: FakeSession): Json {
    return { id: s.id, location: { directory: s.directory }, ...(s.parentID ? { parentID: s.parentID } : {}), ...(s.model ? { model: s.model } : {}), ...(s.agent ? { agent: s.agent } : {}), permissions: s.permissions };
  }

  private finish(s: FakeSession, outcome: string): void {
    if (!s.active) return;
    s.active = false;
    s.messages.push({ id: `msg_${++this.n}`, type: "idle", time: { created: this.now() }, outcome });
  }

  private prompt(s: FakeSession, text: string): Json {
    const created = this.now();
    s.prompts.push(text);
    s.active = true;
    s.messages.push({ id: `msg_${++this.n}`, type: "user", time: { created: this.now() }, text });
    let wake: () => void = () => undefined;
    const interrupted = new Promise<void>((r) => (wake = r));
    this.interrupts.set(s.id, wake);
    const turn: Turn = {
      session: s, text, interrupted,
      assistant: (parts, extra = {}) => {
        const t = this.now();
        const msg = { id: `msg_${++this.n}`, type: "assistant", agent: "build", time: { created: t, completed: t }, content: parts, ...extra };
        s.messages.push(msg);
        return msg;
      },
      ask: (action, resources) => new Promise((resolve) => { const id = `per_${++this.n}`; this.permissions.push({ id, sessionID: s.id, resolve, body: { id, sessionID: s.id, action, resources, save: ["x *"] } }); }),
      form: (fields, kind = "question") => new Promise((resolve) => { const id = `frm_${++this.n}`; this.forms.push({ id, sessionID: s.id, resolve, body: { id, sessionID: s.id, title: "Questions", metadata: { kind }, fields } }); }),
      child: () => { const c = this.newSession(s.directory, { parentID: s.id, permissions: s.permissions }); c.active = true; return c; },
    };
    void this.script(turn).then(() => this.finish(s, "succeeded"), () => this.finish(s, "failed"));
    return { id: `msg_in_${this.n}`, sessionID: s.id, type: "user", time: { created } };
  }
}

/** Last matching rule wins; `*` matches anything; no match = allow (the build agent's default). */
export function evaluate(rules: readonly Rule[], action: string, resource: string): string {
  const glob = (p: string) => new RegExp(`^${p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
  let effect = "allow";
  for (const r of rules) if ((r.action === "*" || r.action === action) && glob(r.resource).test(resource)) effect = r.effect;
  return effect;
}

export const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until `cond` holds (bounded by vitest's own timeout, not asserted on time). */
export async function until(cond: () => boolean): Promise<void> {
  while (!cond()) await tick();
}
