/** OpenCode in an AgentSwitch terminal (docs/terminal-v0.md §3): OpenCode 2 has no hooks a terminal can pass (its
 *  plugins are Effect modules in package directories), but its TUI is a client of a server, and the server says what
 *  runs and what waits. So the service starts the terminal's own private server — `opencode serve --stdio`, as the
 *  TUI's `--standalone` would, with this terminal's environment — attaches the TUI to it (`--server <url>`, the password
 *  in OPENCODE_PASSWORD), and polls it: a running session is working; a pending question, or a permission request when
 *  the terminal asks (manual), is waiting; nothing is idle. A permission request also goes to the screens as a card and
 *  is answered on the server; answered in the TUI first, the card is withdrawn. With `--auto` the TUI approves what is
 *  not denied itself, so no cards. The server ends with the terminal, or when the service goes (its stdin closes).
 *
 *  The server also says which session the TUI is on and which sub-agents run (2026-10-11, user: opencode的子代理好像并没有
 *  有效的识别到 … 有的时候会出现两个同样名字的session): a sub-agent is a session of its own with a `parentID`, running
 *  beside the one that sent it. The terminal is told its session — without it the list showed a new OpenCode terminal
 *  and, a line below, the session it was writing, under one name — and its sub-agents by their sessions. Only what
 *  this server runs is read (`/api/session/active`, then each running session's own line): the list of every session
 *  of the folder is shared with other OpenCodes and is not asked for this. */

import type { PermissionRequest } from "../executors/opencodeServeMap.js";
import { randomBytes } from "node:crypto";
import { basicAuth, noteServePort, startStdioServe, stopStdioServe, type StdioServe, type StdioServeOptions } from "../harness/opencodeStdio.js";
import { attachHeldServer, startHeldServer, type HoldPlace, type Holding, type ServerProcess } from "./held.js";
import type { Companion, CompanionLink } from "./host.js";
import { WritingFeed, WritingText, type Writing } from "../core/writing.js";
import { followEventStream, openCodeWriting } from "../harness/opencodeEvents.js";

/** Between two looks at the server: the status a screen shows is at most this late. */
const POLL_MS = 500;
/** How long after its event stream ended it is opened again. */
const FOLLOW_AGAIN_MS = 2_000;
const CALL_TIMEOUT_MS = 5_000;
/** Failed looks in a row before the companion gives up (the server is gone). */
const MAX_FAILURES = 10;
/** Looks at a server that lists no models yet before the model a terminal was started on is tried all the same. */
const MODEL_LOOKS = 20;
const DENIED = "在 AgentSwitch 上被拒绝。";
/** Sessions asked about in one look, and how far up a sub-agent's senders are followed. */
const LEARN_A_LOOK = 8;
const MAX_DEPTH = 6;

type Json = Record<string, unknown>;

export type OpenCodeCompanionOptions = {
  readonly binary: string;
  readonly cwd: string;
  /** The terminal's environment: the server gets it (the commands it runs), the TUI gets it with the password. */
  readonly env: Record<string, string>;
  /** The TUI's arguments besides the server choice (--auto, --session). */
  readonly args: readonly string[];
  /** The model a session gone on with (`--session`) is to be on. A new session opens on the one the configuration
   *  names (launch.ts); one gone on with keeps its own, so it is set on the server, once that lists its models. */
  readonly model?: { readonly model: string; readonly variant: string | null };
  /** Permission requests go to the screens (the terminal asks: manual). */
  readonly asks: boolean;
  readonly pollMs?: number;
  /** Starts the server (tests pass a fake). */
  readonly serve?: (o: StdioServeOptions) => Promise<StdioServe>;
  /** The terminal is held (docs/terminal-v0.md §10): its server runs on a holder of its own too, at `socket`. */
  readonly held?: { readonly holding: Holding; readonly socket: string; readonly unit: string };
  /** A held terminal taken up again: its server still runs there (`keep`). */
  readonly restored?: { readonly url: string; readonly password: string; readonly place: HoldPlace };
  readonly log?: (line: string) => void;
};

/** The terminal's server as the companion uses it. */
type Serving = { readonly url: string; readonly password: string; stderrTail(): string; readonly proc: ServerProcess };
/** Its address line, as `serve --stdio` writes it (startStdioServe): on a pty, each line ends in CR LF. */
const URL_LINE = /^\s*(\{.*"url".*\})\s*$/m;
const HELD_START_MS = 15_000;
const STOP_GRACE = 1_500;

/** A process this one spawned, as a `ServerProcess`. */
function childServer(s: StdioServe): ServerProcess {
  return { onExit: (cb) => { s.child.once("exit", cb); }, stop: (g) => stopStdioServe(s.child, g), detach: () => undefined };
}

/** A held server reached once something needs it (stopping it, hearing it end). */
function laterServer(place: HoldPlace): ServerProcess {
  const later = attachHeldServer(place).catch(() => null);
  return { place, onExit: (cb) => { void later.then((p) => (p ? p.onExit(cb) : cb())); }, stop: async (g) => { await (await later)?.stop(g); }, detach: () => { void later.then((p) => p?.detach()); } };
}

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
  /** The session last seen running on this server that is not a sub-agent's: the one the TUI is on. */
  private lastActive: string | null = null;
  /** What each session seen running is: the session it was sent from (a sub-agent's has one), its title, its agent.
   *  Asked once a session; one the server would not describe is taken for the TUI's own, as before. */
  private readonly known = new Map<string, { readonly parent: string | null; readonly title: string; readonly agent: string }>();
  /** What the terminal was last told: its session, its sub-agents (their ids). */
  private told: string | null = null;
  private toldAgents = "";
  private server: Serving | null = null;
  /** The event stream followed for what it writes. */
  private watching: AbortController | null = null;
  private link: CompanionLink | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private failures = 0;
  /** Requests on the screens now, and those answered or given up on (not shown again while the server lists them). */
  private readonly open = new Map<string, AbortController>();
  private readonly handled = new Set<string>();
  private readonly loc: string;
  /** The model still to be set on the session gone on with, and the looks that found no models listed yet. */
  private wanted: { readonly model: string; readonly variant: string | null } | null;
  private modelLooks = 0;

  constructor(private readonly o: OpenCodeCompanionOptions) {
    this.loc = `directory=${encodeURIComponent(o.cwd)}`;
    this.wanted = o.model && o.args.includes("--session") ? o.model : null;
    if (o.restored) {
      const { url, password, place } = o.restored;
      this.server = { url, password, stderrTail: () => "", proc: laterServer(place) };
      this.notePort(url);
    }
  }

  /** A held terminal's companion again, from what it kept (`keep`); null for what is not one. */
  static restore(kept: Record<string, unknown>, log?: (line: string) => void): OpenCodeCompanion | null {
    const { url, password, place, cwd, asks } = kept as { url?: unknown; password?: unknown; place?: HoldPlace; cwd?: unknown; asks?: unknown };
    if (typeof url !== "string" || typeof password !== "string" || typeof cwd !== "string" || !place?.socket) return null;
    return new OpenCodeCompanion({ binary: "", cwd, env: {}, args: [], asks: asks === true, restored: { url, password, place }, ...(log ? { log } : {}) });
  }

  keep(): Record<string, unknown> | null {
    const s = this.server;
    return s?.proc.place ? { kind: "opencode", url: s.url, password: s.password, place: s.proc.place, cwd: this.o.cwd, asks: this.o.asks } : null;
  }

  /** The service stops; the terminal is held: no more looks, the server runs on. */
  detach(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.watching?.abort();
    for (const ctl of this.open.values()) ctl.abort();
    this.open.clear();
    this.server?.proc.detach();
  }

  private notePort(url: string): void {
    const port = Number(new URL(url).port);
    if (Number.isInteger(port) && port > 0) this.server?.proc.onExit(noteServePort(port));
  }

  /** `opencode serve --stdio` on a holder of its own: its stdin is the pty, which does not close when the service goes. */
  private async startHeld(h: NonNullable<OpenCodeCompanionOptions["held"]>): Promise<Serving> {
    const password = randomBytes(24).toString("base64url");
    const { OPENCODE_SERVER_PASSWORD: _server, OPENCODE_PASSWORD: _own, ...base } = this.o.env;
    let out = "";
    let found: (url: string) => void = () => undefined;
    const url = new Promise<string>((resolve) => { found = resolve; });
    const proc = await startHeldServer(h.holding, { socket: h.socket, token: randomBytes(24).toString("base64url") },
      { file: this.o.binary, args: ["serve", "--stdio", "--port", "0", "--hostname", "127.0.0.1"], cwd: this.o.cwd, env: { ...base, OPENCODE_PASSWORD: password } }, h.unit,
      (text) => {
        out = (out + text).slice(-8_000);
        const m = URL_LINE.exec(out);
        if (m) try { found(String((JSON.parse(m[1]!) as { url: unknown }).url)); } catch { /* not yet whole */ }
      });
    let timer: NodeJS.Timeout | undefined;
    const ended = new Promise<never>((_, reject) => proc.onExit(() => reject(new Error(`opencode serve exited before it was ready: ${out.trim().slice(-200)}`))));
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`opencode serve did not report its address within ${HELD_START_MS} ms: ${out.trim().slice(-200)}`)), HELD_START_MS); });
    try {
      const at = await Promise.race([url, ended, late]);
      return { url: at, password, stderrTail: () => out.trim().slice(-300), proc };
    } catch (err) {
      await proc.stop(500);
      throw err;
    } finally { clearTimeout(timer); }
  }

  async start(): Promise<{ args: string[]; env: Record<string, string> } | null> {
    const log = this.o.log ?? ((l: string) => console.error(l));
    try {
      if (this.o.held) this.server = await this.startHeld(this.o.held);
      else {
        const s = await (this.o.serve ?? startStdioServe)({ binary: this.o.binary, cwd: this.o.cwd, env: this.o.env, port: 0 });
        this.server = { url: s.url, password: s.password, stderrTail: s.stderrTail, proc: childServer(s) };
      }
    } catch (err) {
      log(`opencode terminal: its server did not start, the TUI starts its own: ${(err as Error).message}`);
      return null;
    }
    if (this.stopped) { void this.server.proc.stop(STOP_GRACE); return null; }
    if (this.o.held) this.notePort(this.server.url);
    this.server.proc.onExit(() => { if (!this.stopped) log(`opencode terminal: its server exited: ${this.server?.stderrTail() ?? ""}`); });
    const { OPENCODE_SERVER_PASSWORD: _server, OPENCODE_PASSWORD: _own, ...env } = this.o.env;
    return { args: ["--server", this.server.url, ...this.o.args], env: { ...env, OPENCODE_PASSWORD: this.server.password } };
  }

  attach(link: CompanionLink): void {
    this.link = link;
    this.schedule(0);
    if (link.writing) void this.followWriting(link.writing.bind(link));
  }

  /** What it is writing (docs/simple-view-v0.md §5.14): its server's event stream, whose pieces of an answer are there
   *  alone (its messages have a part once it is written). The TUI's own session's — a sub-agent's is not shown — at
   *  most every WRITING_MS. A stream that ends is opened again while the terminal runs. */
  private async followWriting(writing: (w: Writing | null) => void): Promise<void> {
    const feed = new WritingFeed(writing);
    const written = new WritingText();
    while (!this.stopped && this.server) {
      const ctl = new AbortController();
      this.watching = ctl;
      try {
        await followEventStream(`${this.server.url}/api/event`, basicAuth(this.server.password), (event) => {
          const sid = String(((event.data ?? {}) as Json).sessionID ?? "");
          if (!sid || this.known.get(sid)?.parent) return;
          const w = openCodeWriting(event, sid, written);
          if (w === null) feed.clear(); else if (w) feed.set(w);
          // A step ended: what it wrote is in its messages, and so in the record.
          if (event.type === "session.step.ended" || event.type === "session.execution.succeeded" || event.type === "session.execution.failed") { feed.clear(); written.reset(); }
        }, ctl.signal);
      } catch { /* the server went, or the stream broke: looked at again */ }
      feed.clear();
      if (!this.stopped) await new Promise((r) => setTimeout(r, FOLLOW_AGAIN_MS).unref());
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.watching?.abort();
    for (const ctl of this.open.values()) ctl.abort();
    this.open.clear();
    if (this.server) void this.server.proc.stop(STOP_GRACE);
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
    if (this.wanted) await this.settle();
    if (this.stopped) return;
    const running = Object.keys(active);
    await this.learn(running);
    if (this.stopped) return;
    // Only a session known to be nobody's sub-agent is the TUI's. One not asked about yet, or whose own line the
    // server did not give, is neither: taken for the TUI's, a sub-agent's session became the terminal's for a while —
    // its screens showed that session's record, or none, and came back (2026-10-13, user: opencode的简略主题有的时候
    // 对话框会抽搐，有的时候对话完成会白屏).
    const own = running.filter((id) => this.known.get(id)?.parent === null);
    // A sub-agent's session running alone (its sender waits on it) still says whose turn this is — once every
    // session up to its sender is known.
    const sender = running.map((id) => this.top(id)).find((id) => this.known.get(id)?.parent === null);
    const top = own[own.length - 1] ?? sender ?? null;
    if (top) this.lastActive = top;
    this.tell(running);
    const listed = new Set(requests.map((r) => r.id));
    for (const [id, ctl] of this.open) if (!listed.has(id)) { ctl.abort(); this.open.delete(id); }
    for (const id of this.handled) if (!listed.has(id)) this.handled.delete(id);
    if (this.o.asks) for (const req of requests) if (!this.open.has(req.id) && !this.handled.has(req.id)) this.surface(req);
    const waiting = forms.length > 0 || (this.o.asks && requests.length > 0);
    this.link.status(waiting ? "waiting" : Object.keys(active).length ? "working" : "idle");
  }

  /** What the sessions in `ids` are, for those not asked about yet (a few a look: a burst of sub-agents is learnt
   *  over the next looks). */
  private async learn(ids: readonly string[]): Promise<void> {
    const fresh = ids.filter((id) => !this.known.has(id)).slice(0, LEARN_A_LOOK);
    await Promise.all(fresh.map(async (id) => {
      try {
        const s = ((await this.call("GET", `/api/session/${encodeURIComponent(id)}?${this.loc}`))?.data ?? {}) as Json;
        if (!s.id && !s.time) return;   // an empty answer says nothing of it: asked again at the next look
        this.known.set(id, { parent: typeof s.parentID === "string" && s.parentID ? s.parentID : null, title: typeof s.title === "string" ? s.title : "", agent: typeof s.agent === "string" ? s.agent : "" });
      } catch { /* not known yet: asked again at the next look */ }
    }));
  }

  /** The session a sub-agent's session was sent from, however deep; a session that is nobody's sub-agent is itself. */
  private top(id: string): string {
    let at = id;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const parent = this.known.get(at)?.parent;
      if (!parent) break;
      at = parent;
    }
    return at;
  }

  /** The terminal is told the session the TUI is on (the one last seen running, else the one it was started on) when
   *  that is first known or changes, and the sub-agents that run when that list changes. */
  private tell(running: readonly string[]): void {
    const at = this.o.args.indexOf("--session");
    const session = this.lastActive ?? (at >= 0 ? this.o.args[at + 1] ?? null : null);
    if (session && session !== this.told) { this.told = session; this.link?.session?.(session); }
    const agents = running.filter((id) => this.known.get(id)?.parent).map((id) => { const k = this.known.get(id)!; return { id, type: k.agent || "agent", name: k.title || k.agent || "agent" }; });
    const ids = agents.map((a) => a.id).join(" ");
    if (ids !== this.toldAgents) { this.toldAgents = ids; this.link?.subagents?.(agents); }
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

  /** The model the terminal was started on, for the session it goes on with: once, when the server lists its models
   *  (it loads them after it starts), and only where the session is on another. What cannot be set is said in the log;
   *  the session stays on its own. */
  private async settle(): Promise<void> {
    const want = this.wanted;
    if (!want) return;
    const log = this.o.log ?? ((l: string) => console.error(l));
    try {
      const models = (await this.call("GET", `/api/model?${this.loc}`))?.data;
      if (!(Array.isArray(models) && models.length) && ++this.modelLooks < MODEL_LOOKS) return;
      this.wanted = null;
      const session = await this.session();
      const now = session ? ((await this.call("GET", `/api/session/${encodeURIComponent(session)}?${this.loc}`))?.data as Json | undefined)?.model as Json | undefined : undefined;
      if (now && `${String(now.providerID)}/${String(now.id)}` === want.model && (now.variant ?? null) === want.variant) return;
      await this.setModel(want);
    } catch (err) {
      this.wanted = null;
      log(`opencode terminal: the model it was started on was not set: ${(err as Error).message}`);
    }
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
