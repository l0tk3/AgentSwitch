/** Agents in the shared browser (docs/browser-v0.md §2 给 agent, §5 step 3). An agent session (a terminal's agent; a
 *  dispatched task later) gets a token the daemon mints for it alone, revoked when the session ends. Its browser tool is
 *  `secret-gate browser -- <bridge>`: the bridge (bridgeClient.ts) carries MCP between the gate and the daemon, one
 *  connection per bridge process. Behind each connection runs Playwright MCP, in this process, against the host's Chrome
 *  (agentMcp.ts), seeing only the session's own tabs. Between the two, this module adds what the screens need and what
 *  the gate does not see:
 *  - one call at a time per session, in order; a call on a tab a person holds waits for the hand-back (up to two
 *    minutes), then fails with words for the model; the hold is looked at again right before the call is handed over;
 *  - the tab's status (busy while a call runs) and the agent's last action for the screens' overlay, with the box of the
 *    element it acts on;
 *  - refusals of its own, whatever the gate does: no file read or written for an agent (`filename`, `paths`), only
 *    http(s) and about:blank, no resizing of a tab the screens size, `browser_close` closing the agent's own tabs only
 *    (each once handed back), no code but the gate's own probes (probes.ts: `browser_run_code_unsafe` runs in this
 *    process), and no network or console log of a tab whose hold could not be kept out of them (heldTraffic.ts);
 *  - Playwright MCP's files (unredacted snapshots, console logs) in a private folder per connection under
 *    `$AGENTSWITCH_HOME/browser` (read-denied to the executors), emptied after every call, removed with the connection.
 *  Tool arguments are never logged or audited: after the gate, a fill's text is the plaintext. */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserAudit } from "./audit.js";
import type { BrowserHost } from "./host.js";
import { codeRefusal } from "./probes.js";
import { auditUrl } from "./rules.js";
import { BrowserError, type Box, type TabOwner } from "./types.js";

/** The bridge script next to this module: bridgeClient.js in dist/, bridgeClient.ts under tsx (node strips its types). */
const EXT = import.meta.url.endsWith(".ts") ? "ts" : "js";
export const BRIDGE_SCRIPT = fileURLToPath(new URL(`./bridgeClient.${EXT}`, import.meta.url));

/** A call on a tab a person holds waits this long for the hand-back (browser-v0 §1 接手). */
export const HOLD_WAIT_MS = 120_000;
/** Bridge processes of one session kept at once (an agent restarting its tool leaves the old one to time out). */
const MAX_CONNECTIONS = 8;
/** The box of the element a call acts on is given this long; the call does not wait longer for it. */
const BOX_MS = 1_000;
const DESCRIPTION_CHARS = 60;

export const USER_HOLDS_TAB = "The user is using this tab in AgentSwitch (they took it over) and did not hand it back within 2 minutes, so this call was not run. Try again later, or ask the user to hand the tab back.";
export const FILES_REFUSED = "AgentSwitch's shared browser reads and writes no files for agents (filename, paths).";
export const RESIZE_REFUSED = "In AgentSwitch's shared browser a tab's size belongs to the screens showing it; browser_resize is not available.";
export const HELD_LOGS_REFUSED = "The user used this tab in AgentSwitch; its network requests and console messages are not available to agents.";
/** Tools that read a tab's network and console records (heldTraffic.ts keeps a hold's out of them). */
const LOG_TOOLS = new Set(["browser_network_requests", "browser_network_request", "browser_console_messages"]);
const NOT_OPENED = "Not opened in AgentSwitch's shared browser:";

export type JsonRpcId = string | number;
export type JsonRpcMessage = {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

/** One connection's MCP engine (Playwright MCP, agentMcp.ts; a fake in the tests). */
export interface EngineConnection {
  /** A message from the agent, after this module's checks. */
  receive(message: JsonRpcMessage): void;
  /** The tab the agent's next call acts on (Playwright MCP's current tab); null before it has one. */
  currentTab(): string | null;
  /** The tab at `index` of the agent's own list (`browser_tabs` select and close). */
  tabAt(index: number): string | null;
  /** Where `target` (a snapshot ref or a selector) is on the current tab, in the page's CSS pixels; null when unknown. */
  box(target: string): Promise<Box | null>;
  /** Before a call is handed over: waits out the grace after a hand-back (heldTraffic.ts) and returns the tabs, held
   *  before, whose logs could not be kept clear of the hold (their log tools are then refused). */
  settle?(): Promise<readonly string[]>;
  close(): Promise<void>;
}

export type EngineOptions = {
  readonly owner: TabOwner;
  /** The connection's private folder: Playwright MCP's output and its workspace root. */
  readonly outputDir: string;
  /** A message for the agent. */
  readonly send: (message: JsonRpcMessage) => void;
};
export type AgentEngine = (opts: EngineOptions) => Promise<EngineConnection>;

/** What this module needs of the host. */
export type AgentHost = Pick<BrowserHost, "get" | "tabsOf" | "watch" | "setStatus" | "setAction" | "close" | "allowed">;

export type BrowserAgentsOptions = {
  readonly host: AgentHost;
  readonly engine: AgentEngine;
  /** `$AGENTSWITCH_HOME/browser`: token files under `sessions/`, the connections' folders under `agents/`. */
  readonly dir: string;
  readonly audit?: BrowserAudit;
  readonly holdWaitMs?: number;
  readonly log?: (line: string) => void;
};

/** A session as its launcher gets it: the id and token for the bridge, and the 0600 file holding the token (the bridge
 *  reads it there, so it is in no command line, environment or model context). */
export type MintedSession = { readonly id: string; readonly token: string; readonly tokenFile: string };

/** One bridge process's connection, as the API serves it. */
export type AgentConnection = {
  readonly id: string;
  readonly session: string;
  receive(message: JsonRpcMessage): void;
  close(): Promise<void>;
};

/** What `secret-gate browser --` runs for one session: the bridge under the service's own node, pointed at the daemon's
 *  local address, with the token's file (never the token) on its command line. */
export function bridgeCommand(session: Pick<MintedSession, "id" | "tokenFile">, url: string, node: string = process.execPath, script: string = BRIDGE_SCRIPT): string[] {
  return [node, script, "--url", url, "--session", session.id, "--token-file", session.tokenFile];
}

/** The owner of a terminal's agent's tabs, named as the screens list it: `codex · AgentSwitch` (agent · folder). */
export function terminalOwner(id: string, agent: string, cwd: string): TabOwner {
  const short = agent === "claude-code" ? "claude" : agent;
  return { kind: "terminal", id, label: `${short} · ${basename(cwd) || cwd}` };
}

type Session = {
  readonly id: string;
  readonly owner: TabOwner;
  readonly digest: Buffer;
  readonly tokenFile: string;
  readonly connections: Map<string, Connection>;
  queue: Promise<void>;
};

type Connection = {
  readonly id: string;
  readonly session: Session;
  readonly outputDir: string;
  readonly out: (message: JsonRpcMessage) => void;
  readonly onEnd: () => void;
  engine: EngineConnection | null;
  /** Calls handed to the engine, by id: their answers come back here instead of going straight to the agent. */
  readonly pending: Map<JsonRpcId, (answer: JsonRpcMessage | null) => void>;
  /** Calls in the session's queue, not started yet. */
  readonly queued: Set<JsonRpcId>;
  /** Calls the agent cancelled before they ran (queued, or waiting for a hand-back). */
  readonly cancelled: Set<JsonRpcId>;
  /** Calls waiting for a hand-back, by id: calling one ends the wait. */
  readonly waits: Map<JsonRpcId, () => void>;
  closed: boolean;
};

type Args = Record<string, unknown>;

const digest = (token: string): Buffer => createHash("sha256").update(token).digest();
const isRequest = (m: JsonRpcMessage): boolean => typeof m.method === "string" && m.id !== undefined;
const isAnswer = (m: JsonRpcMessage): boolean => m.method === undefined && m.id !== undefined;
const sameOwner = (a: Pick<TabOwner, "kind" | "id">, b: Pick<TabOwner, "kind" | "id">): boolean => a.kind === b.kind && a.id === b.id;

/** A tool result the model reads as a failure. */
const failure = (id: JsonRpcId, text: string): JsonRpcMessage => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `### Error\n${text}` }], isError: true } });
const success = (id: JsonRpcId, text: string): JsonRpcMessage => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });

/** Text from the model shown on the screens: one line, short, ciphertexts left out. */
function clean(value: unknown, max = DESCRIPTION_CHARS): string {
  const text = String(value ?? "").replace(/enc:(?:v1|ref):[A-Za-z0-9_=-]+/g, "[ciphertext]").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
const quoted = (value: unknown): string => (typeof value === "string" && value.trim() ? ` "${clean(value)}"` : "");

function siteOf(raw: unknown): string {
  try { return new URL(String(raw)).host.replace(/^www\./, "") || String(raw); } catch { return clean(raw, 40); }
}

/** What the screens' overlay says the agent does (`click "Merge"`), or null for calls that leave it as it is (reading
 *  logs, the gate's own checks). Never the text typed: after the gate, it is the plaintext. */
export function describeCall(tool: string, args: Args): string | null {
  switch (tool) {
    case "browser_click": return `${args.doubleClick ? "double-click" : args.button === "right" ? "right-click" : "click"}${quoted(args.element)}`;
    case "browser_type": return `type into${quoted(args.element) || " a field"}`;
    case "browser_fill_form": {
      const fields = Array.isArray(args.fields) ? args.fields as Args[] : [];
      return fields.length === 1 ? `fill${quoted(fields[0]?.name) || " a field"}` : `fill ${fields.length} fields`;
    }
    case "browser_select_option": return `select in${quoted(args.element) || " a list"}`;
    case "browser_hover": return `hover${quoted(args.element)}`;
    case "browser_drag": return `drag${quoted(args.startElement)} to${quoted(args.endElement) || " a place"}`;
    case "browser_press_key": return `press ${clean(args.key, 20)}`;
    case "browser_navigate": return `open ${siteOf(args.url)}`;
    case "browser_navigate_back": return "back";
    case "browser_snapshot": return "read the page";
    case "browser_take_screenshot": return "screenshot";
    case "browser_wait_for": return "wait";
    case "browser_handle_dialog": return args.accept ? "accept the dialog" : "dismiss the dialog";
    case "browser_file_upload": return "upload";
    case "browser_tabs": return args.action === "new" ? "new tab" : null;
    default: return null;
  }
}

/** The element a call acts on, for its box. */
function targetArg(tool: string, args: Args): string | null {
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  if (tool === "browser_drag") return pick(args.startTarget);
  if (tool === "browser_fill_form") return Array.isArray(args.fields) ? pick((args.fields[0] as Args | undefined)?.target) : null;
  return ["browser_click", "browser_type", "browser_hover", "browser_select_option"].includes(tool) ? pick(args.target) : null;
}

/** An address as Playwright MCP completes it before navigating (`localhost…` → http, anything else bare → https). */
function completed(raw: string): string {
  try { new URL(raw); return raw; } catch { return raw.startsWith("localhost") ? `http://${raw}` : `https://${raw}`; }
}

/** Every file Playwright MCP left (snapshots, console logs, a download it tried), the folder itself kept. */
function sweep(dir: string): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) rmSync(join(dir, entry), { recursive: true, force: true });
}

export class BrowserAgents {
  private readonly sessions = new Map<string, Session>();
  private readonly log: (line: string) => void;
  private readonly sessionsDir: string;
  private readonly agentsDir: string;
  private readonly stopWatching: () => void;

  constructor(private readonly opts: BrowserAgentsOptions) {
    this.log = opts.log ?? console.error;
    this.sessionsDir = join(opts.dir, "sessions");
    this.agentsDir = join(opts.dir, "agents");
    // Nothing of an earlier run is valid now: its tokens died with it.
    for (const dir of [this.sessionsDir, this.agentsDir]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.stopWatching = opts.host.watch((ev) => {
      if (ev.type === "opened" && ev.owner.kind !== "you") opts.audit?.record({ tab: ev.id, action: "open", via: "agent", detail: { owner: `${ev.owner.kind}:${ev.owner.id}` } });
    });
  }

  /** A new session for `owner`'s agent: its id, its token and the token's file. */
  mint(owner: TabOwner): MintedSession {
    let id = randomBytes(6).toString("hex");
    while (this.sessions.has(id)) id = randomBytes(6).toString("hex");
    const token = randomBytes(32).toString("base64url");
    const tokenFile = join(this.sessionsDir, `${id}.token`);
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    this.sessions.set(id, { id, owner, digest: digest(token), tokenFile, connections: new Map(), queue: Promise.resolve() });
    return { id, token, tokenFile };
  }

  /** True when `token` is session `id`'s own and the session is live. */
  verify(id: string, token: string): boolean {
    return this.session(id, token) !== null;
  }

  /** The owner a live session acts for. */
  ownerOf(id: string): TabOwner | null {
    return this.sessions.get(id)?.owner ?? null;
  }

  /** A bridge process connects: its own Playwright MCP over the session's tabs. `send` gets every message for the agent;
   *  `onEnd` is called when the connection ends from this side (the session was revoked). */
  async connect(id: string, token: string, send: (message: JsonRpcMessage) => void, onEnd: () => void = () => undefined): Promise<AgentConnection> {
    const session = this.session(id, token);
    if (!session) throw new BrowserError("forbidden", "unknown or revoked browser session");
    if (session.connections.size >= MAX_CONNECTIONS) await this.closeConnection([...session.connections.values()][0]!);
    let connId = randomBytes(4).toString("hex");
    while (session.connections.has(connId)) connId = randomBytes(4).toString("hex");
    const outputDir = join(this.agentsDir, `${session.id}-${connId}`);
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const conn: Connection = { id: connId, session, outputDir, out: send, onEnd, engine: null, pending: new Map(), queued: new Set(), cancelled: new Set(), waits: new Map(), closed: false };
    session.connections.set(connId, conn);
    try {
      conn.engine = await this.opts.engine({ owner: session.owner, outputDir, send: (m) => this.fromEngine(conn, m) });
    } catch (err) {
      session.connections.delete(connId);
      rmSync(outputDir, { recursive: true, force: true });
      this.log(`browser: agent connection did not start: ${(err as Error).message?.split("\n")[0]}`);
      throw new BrowserError("unavailable", "the shared browser's agent tools did not start");
    }
    if (conn.closed || !this.sessions.has(session.id)) {
      await conn.engine.close().catch(() => undefined);
      throw new BrowserError("forbidden", "unknown or revoked browser session");
    }
    return { id: connId, session: session.id, receive: (m) => this.fromAgent(conn, m), close: () => this.closeConnection(conn) };
  }

  /** A live connection of the session, for the bridge's next message. */
  connection(id: string, token: string, connId: string): AgentConnection | null {
    const conn = this.session(id, token)?.connections.get(connId);
    if (!conn || conn.closed) return null;
    return { id: conn.id, session: id, receive: (m) => this.fromAgent(conn, m), close: () => this.closeConnection(conn) };
  }

  /** The session ends: its token stops working, its connections close, its token file goes. */
  revoke(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    rmSync(session.tokenFile, { force: true });
    for (const conn of [...session.connections.values()]) void this.closeConnection(conn);
  }

  /** `owner`'s agent is gone (its terminal exited or was deleted): every session of it is revoked and its tabs go idle,
   *  or close with `closeTabs`. */
  end(owner: Pick<TabOwner, "kind" | "id">, closeTabs = false): void {
    for (const session of [...this.sessions.values()]) if (sameOwner(session.owner, owner)) this.revoke(session.id);
    for (const tab of this.opts.host.tabsOf(owner)) {
      if (closeTabs) void this.opts.host.close(tab.id).catch(() => undefined);
      else this.quietly(() => this.opts.host.setStatus(tab.id, "idle"));
    }
  }

  async shutdown(): Promise<void> {
    this.stopWatching();
    for (const id of [...this.sessions.keys()]) this.revoke(id);
  }

  // ---- messages

  private session(id: string, token: string): Session | null {
    const session = this.sessions.get(id);
    if (!session || typeof token !== "string" || !token) return null;
    return timingSafeEqual(session.digest, digest(token)) ? session : null;
  }

  private fromAgent(conn: Connection, message: JsonRpcMessage): void {
    if (conn.closed || !conn.engine) return;
    if (message.method === "tools/call" && isRequest(message)) { this.enqueue(conn, message); return; }
    if (message.method === "initialize" && isRequest(message)) { conn.engine.receive(withRoots(message)); return; }
    if (message.method === "notifications/cancelled") {
      const id = (message.params as { requestId?: JsonRpcId } | undefined)?.requestId;
      if (id !== undefined && (conn.queued.has(id) || conn.waits.has(id))) { conn.cancelled.add(id); conn.waits.get(id)?.(); }
    }
    conn.engine.receive(message);
  }

  private fromEngine(conn: Connection, message: JsonRpcMessage): void {
    if (conn.closed) return;
    // Playwright MCP asks the client for its roots (its workspace): the connection's private folder, answered here.
    if (message.method === "roots/list" && isRequest(message)) {
      conn.engine?.receive({ jsonrpc: "2.0", id: message.id!, result: { roots: [{ uri: pathToFileURL(conn.outputDir).href, name: "agentswitch-browser" }] } });
      return;
    }
    if (isAnswer(message)) {
      const waiting = conn.pending.get(message.id!);
      if (waiting) { conn.pending.delete(message.id!); waiting(message); return; }
    }
    this.send(conn, message);
  }

  private send(conn: Connection, message: JsonRpcMessage): void {
    if (conn.closed) return;
    try { conn.out(message); } catch (err) { this.log(`browser: agent message not sent: ${(err as Error).message}`); }
  }

  /** One call after another, per session: the agent's order is the order they run in. */
  private enqueue(conn: Connection, request: JsonRpcMessage): void {
    const session = conn.session;
    const run = () => this.call(conn, request).catch((err: unknown) => {
      this.log(`browser: agent call failed: ${(err as Error)?.message?.split("\n")[0]}`);
      this.send(conn, failure(request.id!, "AgentSwitch's shared browser could not run this call."));
    });
    conn.queued.add(request.id!);
    session.queue = session.queue.then(run, run);
  }

  private async call(conn: Connection, request: JsonRpcMessage): Promise<void> {
    const id = request.id!;
    conn.queued.delete(id);
    if (conn.cancelled.delete(id) || conn.closed) return;
    const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
    const tool = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Args;
    const owner = conn.session.owner;
    const refused = this.refusal(owner, tool, args);
    if (refused) { this.send(conn, failure(id, refused)); return; }
    const engine = conn.engine!;
    const shown = describeCall(tool, args);
    const element = targetArg(tool, args);
    // Nobody may hold what the call acts on when it is handed over: wait for the hand-back, and look again after
    // anything that took a moment (the element's box, the grace after a hold), since a screen may take it meanwhile.
    let box: Box | null = null;
    let exposed: readonly string[] = [];
    for (;;) {
      if (!(await this.free(conn, id, this.reachOf(engine, owner, tool, args)))) {
        if (!conn.cancelled.delete(id)) this.send(conn, failure(id, USER_HOLDS_TAB));
        return;
      }
      if (conn.closed) return;
      if (tool === "browser_close") break;
      const reached = this.targetOf(engine, tool, args);
      box = reached && element ? await this.boxOf(engine, element) : null;
      exposed = (await engine.settle?.().catch(() => null)) ?? [];
      if (conn.closed) return;
      if (!this.reachOf(engine, owner, tool, args).some((tab) => this.heldNow(tab))) break;
    }
    if (tool === "browser_close") { await this.closeAll(conn, id, owner); return; }
    const target = this.targetOf(engine, tool, args);
    if (LOG_TOOLS.has(tool) && target && exposed.includes(target)) { this.send(conn, failure(id, HELD_LOGS_REFUSED)); return; }
    const before = engine.currentTab();
    if (target) {
      this.quietly(() => this.opts.host.setStatus(target, "busy"));
      if (shown) this.quietly(() => this.opts.host.setAction(target, { tool, description: shown, ...(box ? { box } : {}) }));
    }
    const answer = await this.forward(conn, request);
    const after = conn.closed ? null : engine.currentTab();
    for (const tab of new Set([target, after])) if (tab && this.opts.host.get(tab)) this.quietly(() => this.opts.host.setStatus(tab, "idle"));
    if (!target && after && shown) this.quietly(() => this.opts.host.setAction(after, { tool, description: shown }));
    sweep(conn.outputDir);
    if (!answer) return;
    if (tool === "browser_navigate" && after && !failed(answer)) {
      this.opts.audit?.record({ tab: after, action: "navigate", via: "agent", detail: { owner: `${owner.kind}:${owner.id}`, target: auditUrl(completed(String(args.url ?? ""))) } });
    }
    this.send(conn, !before && after && !failed(answer) ? withNote(answer, `Opened in tab "${owner.label}" of AgentSwitch's shared browser: the user sees it in AgentSwitch and can take it over.`) : answer);
  }

  /** The bridge's own refusals (the gate refuses most of them too; these hold whoever calls). */
  private refusal(owner: TabOwner, tool: string, args: Args): string | null {
    if ("filename" in args || "paths" in args) return FILES_REFUSED;
    if (tool === "browser_resize") return RESIZE_REFUSED;
    const code = codeRefusal(tool, args);
    if (code) return code;
    const url = tool === "browser_navigate" ? args.url : tool === "browser_tabs" && args.action === "new" ? args.url : undefined;
    if (url === undefined || url === null) return null;
    if (typeof url !== "string") return `${NOT_OPENED} the address must be text.`;
    try { this.opts.host.allowed(owner, completed(url)); return null; }
    catch (err) { return `${NOT_OPENED} ${err instanceof BrowserError ? err.message : "the address was refused."}`; }
  }

  /** `browser_close`: the agent's own tabs, each once nobody holds it (a screen may take one while others close). */
  private async closeAll(conn: Connection, id: JsonRpcId, owner: TabOwner): Promise<void> {
    let closed = 0;
    for (const tab of this.opts.host.tabsOf(owner)) {
      if (!(await this.free(conn, id, [tab.id]))) {
        if (!conn.cancelled.delete(id)) this.send(conn, failure(id, closed ? `Closed ${closed} tab(s); ${USER_HOLDS_TAB}` : USER_HOLDS_TAB));
        return;
      }
      if (conn.closed) return;
      if (!this.opts.host.get(tab.id)) continue;
      await this.opts.host.close(tab.id).catch(() => undefined);
      closed += 1;
    }
    this.send(conn, success(id, `Closed ${closed} tab(s) of this agent in AgentSwitch's shared browser.`));
  }

  /** The tab the call acts on (for its status and overlay): Playwright MCP's current tab, or the one `browser_tabs`
   *  selects or closes; null for one it opens or lists. */
  private targetOf(engine: EngineConnection, tool: string, args: Args): string | null {
    if (tool !== "browser_tabs") return engine.currentTab();
    if (args.action !== "select" && args.action !== "close") return null;
    return typeof args.index === "number" ? engine.tabAt(args.index) : engine.currentTab();
  }

  /** Every tab the call may act on, which nobody may hold when it starts: the target; when the engine cannot tell it
   *  (no current tab known, an index it does not have), every tab of the agent's; for `browser_close`, all of them. */
  private reachOf(engine: EngineConnection, owner: TabOwner, tool: string, args: Args): string[] {
    const all = () => this.opts.host.tabsOf(owner).map((t) => t.id);
    if (tool === "browser_close") return all();
    if (tool === "browser_tabs" && args.action !== "select" && args.action !== "close") return [];
    return [this.targetOf(engine, tool, args) ?? all()].flat();
  }

  private heldNow(tab: string): boolean {
    return (this.opts.host.get(tab)?.heldBy ?? null) !== null;
  }

  /** True once nobody holds any of `tabs` (at once when nobody does, or they are gone); false after the wait, or when
   *  the call was cancelled or the connection closed meanwhile. */
  private free(conn: Connection, id: JsonRpcId, tabs: readonly string[]): Promise<boolean> {
    if (!tabs.some((tab) => this.heldNow(tab))) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (free: boolean) => { clearTimeout(timer); stop(); conn.waits.delete(id); resolve(free); };
      const stop = this.opts.host.watch((ev) => {
        if (!tabs.includes(ev.id) || ev.type === "opened") return;
        if (!tabs.some((tab) => this.heldNow(tab))) done(true);
      });
      const timer = setTimeout(() => done(false), this.opts.holdWaitMs ?? HOLD_WAIT_MS);
      timer.unref?.();
      conn.waits.set(id, () => done(false));
    });
  }

  private async boxOf(engine: EngineConnection, element: string): Promise<Box | null> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), BOX_MS); timer.unref?.(); });
    const box = await Promise.race([engine.box(element).catch(() => null), late]);
    clearTimeout(timer);
    return box;
  }

  private forward(conn: Connection, request: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    return new Promise((resolve) => {
      if (conn.closed || !conn.engine) { resolve(null); return; }
      conn.pending.set(request.id!, resolve);
      conn.engine.receive(request);
    });
  }

  private async closeConnection(conn: Connection): Promise<void> {
    if (conn.closed) return;
    conn.closed = true;
    conn.session.connections.delete(conn.id);
    for (const [, answer] of conn.pending) answer(null);
    conn.pending.clear();
    for (const [, stop] of conn.waits) stop();
    try { conn.onEnd(); } catch { /* the stream is gone already */ }
    await conn.engine?.close().catch((err: unknown) => this.log(`browser: agent connection did not close cleanly: ${(err as Error)?.message?.split("\n")[0]}`));
    rmSync(conn.outputDir, { recursive: true, force: true });
  }

  private quietly(fn: () => void): void {
    try { fn(); } catch { /* the tab closed meanwhile */ }
  }
}

/** Playwright MCP's `initialize`, with the roots capability declared: it then asks for the workspace, answered with the
 *  connection's private folder (rather than the daemon's working directory). */
function withRoots(message: JsonRpcMessage): JsonRpcMessage {
  const params = (message.params && typeof message.params === "object" ? message.params : {}) as Args;
  const capabilities = (params.capabilities && typeof params.capabilities === "object" ? params.capabilities : {}) as Args;
  return { ...message, params: { ...params, capabilities: { ...capabilities, roots: {} } } };
}

function failed(answer: JsonRpcMessage): boolean {
  return answer.error !== undefined || (answer.result as { isError?: unknown } | undefined)?.isError === true;
}

function withNote(answer: JsonRpcMessage, note: string): JsonRpcMessage {
  const result = (answer.result ?? {}) as { content?: unknown[] };
  return { ...answer, result: { ...result, content: [...(Array.isArray(result.content) ? result.content : []), { type: "text", text: note }] } };
}
