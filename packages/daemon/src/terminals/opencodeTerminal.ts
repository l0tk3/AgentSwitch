/** OpenCode in an AgentSwitch terminal (docs/terminal-v0.md §3): OpenCode 2 has no hooks a terminal can pass (its
 *  plugins are Effect modules in package directories), but its TUI is a client of a server, and the server says what
 *  runs and what waits. So the service starts the terminal's own private server — `opencode serve --stdio`, as the
 *  TUI's `--standalone` would, with this terminal's environment — attaches the TUI to it (`--server <url>`, the password
 *  in OPENCODE_PASSWORD), and polls it: a running session is working; a pending question, or a permission request when
 *  the terminal asks (manual), is waiting; nothing is idle. A permission request also goes to the screens as a card and
 *  is answered on the server; answered in the TUI first, the card is withdrawn. With `--auto` the TUI approves what is
 *  not denied itself, so no cards. The server ends with the terminal, or when the service goes (its stdin closes). */

import type { PermissionRequest } from "../executors/opencodeServeMap.js";
import { basicAuth, startStdioServe, stopStdioServe, type StdioServe, type StdioServeOptions } from "../harness/opencodeStdio.js";
import type { Companion, CompanionLink } from "./host.js";

/** Between two looks at the server: the status a screen shows is at most this late. */
const POLL_MS = 500;
const CALL_TIMEOUT_MS = 5_000;
/** Failed looks in a row before the companion gives up (the server is gone). */
const MAX_FAILURES = 10;
const DENIED = "在 AgentSwitch 上被拒绝。";

type Json = Record<string, unknown>;

export type OpenCodeCompanionOptions = {
  readonly binary: string;
  readonly cwd: string;
  /** The terminal's environment: the server gets it (the commands it runs), the TUI gets it with the password. */
  readonly env: Record<string, string>;
  /** The TUI's arguments besides the server choice (model, --auto, --session). */
  readonly args: readonly string[];
  /** Permission requests go to the screens (the terminal asks: manual). */
  readonly asks: boolean;
  readonly pollMs?: number;
  /** Starts the server (tests pass a fake). */
  readonly serve?: (o: StdioServeOptions) => Promise<StdioServe>;
  readonly log?: (line: string) => void;
};

/** A permission request as a card: the tool names the screens know where there is one. */
export function openCodeAsk(req: PermissionRequest): { tool: string; input: Json } {
  const what = (req.resources ?? []).join(" ; ");
  switch (req.action) {
    case "shell": case "bash": return { tool: "Bash", input: { command: what } };
    case "edit": case "write": return { tool: "Edit", input: { file_path: what } };
    case "read": return { tool: "Read", input: { file_path: what } };
    case "webfetch": return { tool: "WebFetch", input: { url: what } };
    default: return { tool: req.action, input: { path: what, ...(req.metadata ? { metadata: req.metadata } : {}) } };
  }
}

/** A model as the screens name it (`provider/model`) and as OpenCode's server takes it. */
const refOf = (model: string): { providerID: string; id: string } | null => {
  const cut = model.indexOf("/");
  return cut > 0 && cut < model.length - 1 ? { providerID: model.slice(0, cut), id: model.slice(cut + 1) } : null;
};

export class OpenCodeCompanion implements Companion {
  /** When the companion was made: a session of this folder made since is the TUI's own. */
  private readonly since = Date.now();
  /** The session last seen running on this server: the one the TUI is on. */
  private lastActive: string | null = null;
  private server: StdioServe | null = null;
  private link: CompanionLink | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private failures = 0;
  /** Requests on the screens now, and those answered or given up on (not shown again while the server lists them). */
  private readonly open = new Map<string, AbortController>();
  private readonly handled = new Set<string>();
  private readonly loc: string;

  constructor(private readonly o: OpenCodeCompanionOptions) {
    this.loc = `directory=${encodeURIComponent(o.cwd)}`;
  }

  async start(): Promise<{ args: string[]; env: Record<string, string> } | null> {
    const log = this.o.log ?? ((l: string) => console.error(l));
    try {
      this.server = await (this.o.serve ?? startStdioServe)({ binary: this.o.binary, cwd: this.o.cwd, env: this.o.env, port: 0 });
    } catch (err) {
      log(`opencode terminal: its server did not start, the TUI starts its own: ${(err as Error).message}`);
      return null;
    }
    if (this.stopped) { void stopStdioServe(this.server.child); return null; }
    this.server.child.once("exit", () => { if (!this.stopped) log(`opencode terminal: its server exited: ${this.server?.stderrTail() ?? ""}`); });
    const { OPENCODE_SERVER_PASSWORD: _server, OPENCODE_PASSWORD: _own, ...env } = this.o.env;
    return { args: ["--server", this.server.url, ...this.o.args], env: { ...env, OPENCODE_PASSWORD: this.server.password } };
  }

  attach(link: CompanionLink): void {
    this.link = link;
    this.schedule(0);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const ctl of this.open.values()) ctl.abort();
    this.open.clear();
    if (this.server) void stopStdioServe(this.server.child);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.look().finally(() => this.schedule(this.o.pollMs ?? POLL_MS)); }, ms);
    this.timer.unref();
  }

  /** One look: the sessions running, the permission requests and questions waiting. */
  private async look(): Promise<void> {
    if (this.stopped || !this.link) return;
    let active: Json, requests: PermissionRequest[], forms: Json[];
    try {
      [active, requests, forms] = await Promise.all([
        this.call("GET", "/api/session/active").then((r) => (r?.data ?? {}) as Json),
        this.call("GET", `/api/permission/request?${this.loc}`).then((r) => (Array.isArray(r?.data) ? r.data : []) as PermissionRequest[]),
        this.call("GET", `/api/form?${this.loc}`).then((r) => (Array.isArray(r?.data) ? r.data : []) as Json[]),
      ]);
      this.failures = 0;
    } catch (err) {
      if (++this.failures === MAX_FAILURES) {
        (this.o.log ?? console.error)(`opencode terminal: its server does not answer, status stops: ${(err as Error).message}`);
        this.stop();
      }
      return;
    }
    if (this.stopped) return;
    const running = Object.keys(active);
    if (running.length) this.lastActive = running[running.length - 1]!;
    const listed = new Set(requests.map((r) => r.id));
    for (const [id, ctl] of this.open) if (!listed.has(id)) { ctl.abort(); this.open.delete(id); }
    for (const id of this.handled) if (!listed.has(id)) this.handled.delete(id);
    if (this.o.asks) for (const req of requests) if (!this.open.has(req.id) && !this.handled.has(req.id)) this.surface(req);
    const waiting = forms.length > 0 || (this.o.asks && requests.length > 0);
    this.link.status(waiting ? "waiting" : Object.keys(active).length ? "working" : "idle");
  }

  /** The session the TUI is on, as far as its server shows: the one it was started on (`--session`), else the one
   *  last seen running, else the newest one of this folder made since the terminal started. Null before its first
   *  message (the TUI makes its session then). */
  private async session(): Promise<string | null> {
    const at = this.o.args.indexOf("--session");
    if (at >= 0 && this.o.args[at + 1]) return this.o.args[at + 1]!;
    if (this.lastActive) return this.lastActive;
    const all = (await this.call("GET", `/api/session?${this.loc}`))?.data;
    const mine = (Array.isArray(all) ? all as Json[] : [])
      .map((s) => ({ id: String(s.id ?? ""), made: Number((s.time as Json | undefined)?.created) || 0 }))
      .filter((s) => s.id && s.made >= this.since - 2_000)
      .sort((a, b) => b.made - a.made);
    return mine[0]?.id ?? null;
  }

  /** Another model, or another variant (how hard it thinks), for the session the TUI is on — OpenCode's own
   *  `POST /api/session/:id/model` on the terminal's private server (docs/simple-view-v0.md §5.4; seen on 2.0.24: the
   *  TUI writes "Switched model to …" and its footer follows). Its server takes any id without a word, so what is
   *  asked for is checked against its own list first. Throws with a sentence a screen can show. */
  async setModel(want: { model?: string | null; variant?: string | null }): Promise<{ model: string; variant: string | null }> {
    if (!this.server || this.stopped) throw new Error("its server is not running");
    const session = await this.session();
    if (!session) throw new Error("no session yet: it starts with the first message");
    const now = ((await this.call("GET", `/api/session/${encodeURIComponent(session)}?${this.loc}`))?.data as Json | undefined)?.model as Json | undefined;
    const target = want.model ? refOf(want.model) : now && typeof now.id === "string" && typeof now.providerID === "string" ? { providerID: now.providerID, id: now.id } : null;
    if (!target) throw new Error(want.model ? `not a model of its: ${want.model}` : "it has not said which model it is on");
    const models = (await this.call("GET", `/api/model?${this.loc}`))?.data;
    const known = (Array.isArray(models) ? models as Json[] : []).find((m) => m.providerID === target.providerID && m.id === target.id && m.enabled !== false);
    if (!known) throw new Error(`not a model of its: ${target.providerID}/${target.id}`);
    const variants = (Array.isArray(known.variants) ? known.variants as Json[] : []).map((v) => String(v.id ?? "")).filter(Boolean);
    // A variant asked for must be one of that model's; another model starts at its own default.
    const kept = !want.model && typeof now?.variant === "string" ? now.variant : null;
    const variant = want.variant ?? kept;
    if (variant && !variants.includes(variant)) throw new Error(variants.length ? `not a level of that model: one of ${variants.join(", ")}` : "that model takes no level");
    await this.call("POST", `/api/session/${encodeURIComponent(session)}/model?${this.loc}`, { model: { ...target, ...(variant ? { variant } : {}) } });
    return { model: `${target.providerID}/${target.id}`, variant: variant ?? null };
  }

  private surface(req: PermissionRequest): void {
    const ctl = new AbortController();
    this.open.set(req.id, ctl);
    const { tool, input } = openCodeAsk(req);
    void this.link!.ask(tool, input, ctl.signal).then(async (decision) => {
      this.open.delete(req.id);
      this.handled.add(req.id);
      if (!decision || this.stopped) return;   // withdrawn, or none came: the TUI still asks
      const path = `/api/session/${encodeURIComponent(req.sessionID)}/permission/${encodeURIComponent(req.id)}/reply`;
      await this.call("POST", path, decision === "allow" ? { decision: "once" } : { decision: "reject", message: DENIED })
        .catch((err: Error) => (this.o.log ?? console.error)(`opencode terminal: answering a ${req.action} request: ${err.message}`));
    });
  }

  private async call(method: string, path: string, body?: Json): Promise<Json | null> {
    const server = this.server;
    if (!server) throw new Error("no server");
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: { authorization: basicAuth(server.password), "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${method} ${path.split("?")[0]}: HTTP ${res.status}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as Json) : null;
  }
}
