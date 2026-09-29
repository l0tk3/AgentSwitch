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

export class OpenCodeCompanion implements Companion {
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
    const listed = new Set(requests.map((r) => r.id));
    for (const [id, ctl] of this.open) if (!listed.has(id)) { ctl.abort(); this.open.delete(id); }
    for (const id of this.handled) if (!listed.has(id)) this.handled.delete(id);
    if (this.o.asks) for (const req of requests) if (!this.open.has(req.id) && !this.handled.has(req.id)) this.surface(req);
    const waiting = forms.length > 0 || (this.o.asks && requests.length > 0);
    this.link.status(waiting ? "waiting" : Object.keys(active).length ? "working" : "idle");
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
