/** Codex in an AgentSwitch terminal, through an app-server of the terminal's own (docs/terminal-v0.md §3,
 *  docs/simple-view-v0.md §5.4). Codex has no command that sets its model or its reasoning effort (`/model` opens two
 *  lists), but its app-server has `thread/settings/update`, and its TUI attaches to an app-server it is given
 *  (`--remote`). So the service starts the terminal's private server — `codex <config flags> app-server --listen
 *  ws://127.0.0.1:<port>`, behind a capability token only this terminal's TUI and the service hold — attaches the TUI,
 *  and changes the model and effort of the thread the TUI is on as a second client; the TUI follows.
 *
 *  What a Codex terminal is started with is split (tried against 0.162, scripts/codex_remote_settings_probe.ts and the
 *  notes in docs): configuration goes to the server — the hooks above all, which only the server runs — and the TUI
 *  keeps its own (`tui.*`, the model and effort it starts at, how it asks, `resume` / `fork`). Its status and its
 *  permission cards come from the hooks as before: the companion reports none. */

import { type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { WritingFeed, WritingText } from "../core/writing.js";
import { AppServerClient, type Json } from "../harness/appserver.js";
import { spawnOwned, terminateProcess } from "../harness/processes.js";
import { connectWsLines, type WsLines } from "../harness/wsLines.js";
import type { Companion, CompanionLink } from "./host.js";
import { attachHeldServer, startHeldServer, type HoldPlace, type Holding, type ServerProcess } from "./held.js";

/** The TUI's token is in its environment under this name (`--remote-auth-token-env`), never on a command line. */
export const CODEX_REMOTE_TOKEN_ENV = "AGENTSWITCH_CODEX_REMOTE_TOKEN";
const START_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 1_500;
/** How long a change waits for the TUI to have made its thread. */
const THREAD_WAIT_MS = 8_000;
/** How often the companion looks which thread the TUI is on, to follow what it writes. */
const FOLLOW_MS = 1_500;

/** A Codex terminal's command line, split for a server and a TUI attached to it. Configuration (`-c key=value`) goes
 *  to the server; the hooks to the server alone (a TUI attached to a server runs none); `tui.*` and the reasoning
 *  effort the terminal starts at to the TUI alone; everything else — a subcommand and its arguments, `-m`, how it asks
 *  — is the TUI's.
 *
 *  Resuming or forking is the exception for how it asks: a TUI attached to a server refuses any permission override
 *  there ("Permission overrides are not supported when resuming a remote task", 0.162), so those — `-a`, the sandbox,
 *  skipping both, the permissions profile — go to the server alone, as its configuration. */
export function splitCodexArgs(args: readonly string[]): { server: string[]; tui: string[] } {
  const server: string[] = [], tui: string[] = [];
  const again = args[0] === "resume" || args[0] === "fork";
  const asks = (key: string) => key === "default_permissions" || key.startsWith("permissions.") || key === "approval_policy" || key === "sandbox_mode" || key.startsWith("sandbox_workspace_write.");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-c" && i + 1 < args.length) {
      const pair = args[++i]!;
      const key = pair.split("=")[0]!;
      if (key.startsWith("hooks.") || (again && asks(key))) server.push(a, pair);
      else if (key.startsWith("tui.") || key === "model_reasoning_effort") tui.push(a, pair);
      else { server.push(a, pair); tui.push(a, pair); }
      continue;
    }
    if (again && (a === "-a" || a === "--ask-for-approval") && i + 1 < args.length) { server.push("-c", `approval_policy=${JSON.stringify(args[++i])}`); continue; }
    if (again && (a === "-s" || a === "--sandbox") && i + 1 < args.length) { server.push("-c", `sandbox_mode=${JSON.stringify(args[++i])}`); continue; }
    if (again && a === "--dangerously-bypass-approvals-and-sandbox") { server.push("-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"'); continue; }
    tui.push(a);
  }
  return { server, tui };
}

/** The terminal's server: a child of this process (`child`), or one on a holder of its own (`proc`, a held terminal's). */
export type CodexServer = { readonly child?: ChildProcess; readonly proc?: ServerProcess; readonly url: string; readonly token: string };
/** Where a held terminal's server runs on: its holder's socket and the unit it is started in. */
export type CodexHeld = { readonly holding: Holding; readonly socket: string; readonly unit: string };

/** A process this one spawned, as a `ServerProcess`. */
function childServer(child: ChildProcess): ServerProcess {
  return { onExit: (cb) => { child.once("exit", cb); }, stop: (g) => terminateProcess(child, g), detach: () => undefined };
}
export type CodexCompanionOptions = {
  readonly binary: string;
  readonly cwd: string;
  /** The terminal's environment: the server gets it (the commands and hooks it runs), the TUI with the token added. */
  readonly env: Record<string, string>;
  /** The terminal's whole command line as it would start on its own (`splitCodexArgs` divides it). */
  readonly args: readonly string[];
  /** The terminal's own folder of the service: the token file goes there. */
  readonly dir: string;
  /** Starts the server (tests pass a fake). */
  readonly serve?: (o: { binary: string; flags: readonly string[]; cwd: string; env: Record<string, string>; dir: string; held?: CodexHeld }) => Promise<CodexServer>;
  /** The terminal is held (docs/terminal-v0.md §10): its server runs on a holder of its own too. */
  readonly held?: CodexHeld;
  /** A held terminal taken up again: its server still runs there (`keep`). */
  readonly restored?: { readonly url: string; readonly token: string; readonly place: HoldPlace };
  /** How long a change waits for the TUI's thread (tests: none). */
  readonly threadWaitMs?: number;
  /** This terminal was started with Codex's Daybreak switch on offer (its feature enabled, docs/simple-view-v0.md
   *  §5.8): the companion says how the switch stands. */
  readonly daybreak?: boolean;
  readonly log?: (line: string) => void;
};

const freePort = () => new Promise<number>((ok, fail) => {
  const probe = createServer();
  probe.once("error", fail);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => ok(port)); });
});

/** Spawns the server and waits until it answers its readiness check. Rejects, and reaps it, when it exits first or
 *  does not get ready in time. */
export async function startCodexServer(o: { binary: string; flags: readonly string[]; cwd: string; env: Record<string, string>; dir: string; held?: CodexHeld; startTimeoutMs?: number }): Promise<CodexServer> {
  const port = await freePort();
  const token = randomBytes(32).toString("base64url");
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const tokenFile = join(o.dir, "codex-server-token");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const url = `ws://127.0.0.1:${port}`;
  const args = [...o.flags, "app-server", "--listen", url, "--ws-auth", "capability-token", "--ws-token-file", tokenFile];
  let stderr = "";
  let gone = false;
  let proc: ServerProcess;
  if (o.held) {
    // On a holder of its own: it outlives the service with the TUI that is its client. Its token file stays with it.
    proc = await startHeldServer(o.held.holding, { socket: o.held.socket, token: randomBytes(24).toString("base64url") }, { file: o.binary, args, cwd: o.cwd, env: o.env }, o.held.unit,
      (text) => { stderr = (stderr + text).slice(-2_000); });
  } else {
    const child = spawnOwned(o.binary, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2_000); });
    proc = childServer(child);
  }
  proc.onExit(() => { gone = true; });
  const end = Date.now() + (o.startTimeoutMs ?? START_TIMEOUT_MS);
  try {
    for (;;) {
      if (gone) throw new Error(`codex app-server exited before it was ready: ${stderr.trim().slice(-200)}`);
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok, () => false);
      if (ready) break;
      if (Date.now() > end) throw new Error(`codex app-server was not ready within ${o.startTimeoutMs ?? START_TIMEOUT_MS} ms: ${stderr.trim().slice(-200)}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch (err) {
    await proc.stop(500);
    rmSync(tokenFile, { force: true });
    throw err;
  }
  proc.onExit(() => rmSync(tokenFile, { force: true }));
  return { proc, url, token };
}

export class CodexCompanion implements Companion {
  /** Its status and its cards come from the hooks, as for a Codex that runs on its own. */
  readonly reportsStatus = false;
  /** Present only where the switch is on offer: `Companion.daybreak` is how the host knows there is one. */
  readonly daybreak?: (session?: string | null) => Promise<boolean>;
  private server: CodexServer | null = null;
  private proc: ServerProcess | null = null;
  private stopped = false;
  private client: { rpc: AppServerClient; ws: WsLines } | null = null;
  /** The thread this client follows for what is written, and what it does with what it is told. */
  private followed: string | null = null;
  private onNote: ((method: string, params: Json) => void) | null = null;
  private following: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: CodexCompanionOptions) {
    if (o.daybreak) this.daybreak = (session) => this.daybreakNow(session ?? null);
    if (o.restored) {
      const { url, token, place } = o.restored;
      this.server = { url, token };
      const later = attachHeldServer(place).catch(() => null);
      this.proc = { place, onExit: (cb) => { void later.then((p) => (p ? p.onExit(cb) : cb())); }, stop: async (g) => { await (await later)?.stop(g); }, detach: () => { void later.then((p) => p?.detach()); } };
    }
  }

  /** A held terminal's companion again, from what it kept (`keep`); null for what is not one. */
  static restore(kept: Record<string, unknown>, log?: (line: string) => void): CodexCompanion | null {
    const { url, token, place, cwd, dir, daybreak } = kept as { url?: unknown; token?: unknown; place?: HoldPlace; cwd?: unknown; dir?: unknown; daybreak?: unknown };
    if (typeof url !== "string" || typeof token !== "string" || typeof cwd !== "string" || typeof dir !== "string" || !place?.socket) return null;
    return new CodexCompanion({ binary: "", cwd, env: {}, args: [], dir, restored: { url, token, place }, daybreak: daybreak === true, ...(log ? { log } : {}) });
  }

  keep(): Record<string, unknown> | null {
    const place = this.proc?.place;
    return place && this.server ? { kind: "codex", url: this.server.url, token: this.server.token, place, cwd: this.o.cwd, dir: this.o.dir, daybreak: this.o.daybreak === true } : null;
  }

  /** The service stops; the terminal is held: its server runs on, with the TUI its client. */
  detach(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.client?.ws.close();
    this.client = null;
    this.proc?.detach();
  }

  /** Which thread the TUI is on, and what the server says of it: the one the terminal follows (its hooks named it),
   *  when the server holds it; else the one the server holds that keeps a record — beside it Codex runs helpers of its
   *  own that keep none (seen on 0.162 with a real login: an ephemeral thread). The TUI makes its thread a moment
   *  after it shows its prompt: waited for, up to `waitMs`. */
  private async thread(rpc: AppServerClient, session: string | null, waitMs: number): Promise<{ thread?: string; now: Json }> {
    for (const end = Date.now() + waitMs; ; ) {
      const loaded = ((await rpc.request("thread/loaded/list", {}, CALL_TIMEOUT_MS)).data as unknown[] | undefined ?? []).map(String);
      for (const id of session && loaded.includes(session) ? [session] : loaded) {
        const read = ((await rpc.request("thread/read", { threadId: id, includeTurns: false }, CALL_TIMEOUT_MS)).thread ?? {}) as Json;
        if (read.ephemeral === true) continue;
        return { thread: id, now: read };
      }
      if (Date.now() > end || this.stopped) return { now: {} };
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /** How Codex's Daybreak switch stands for the thread the TUI is on: what is saved there (`thread/read`'s
   *  `daybreakEnabled` — the TUI holds the switch and saves each turn of it; a thread with none saved is off, as the
   *  TUI reads it: one begun with the switch on is given `true` at its start). Before it has a thread, how its new
   *  sessions start (`config/read`'s `daybreak`), which is what it will begin with. */
  private async daybreakNow(session: string | null): Promise<boolean> {
    const rpc = await this.rpc();
    const { thread, now } = await this.thread(rpc, session, 0);
    if (thread) return now.daybreakEnabled === true;
    const config = ((await rpc.request("config/read", { includeLayers: false, cwd: this.o.cwd }, CALL_TIMEOUT_MS)).config ?? {}) as Json;
    return (config.daybreak ?? (config.additional as Json | undefined)?.daybreak) === true;
  }

  async start(): Promise<{ args: string[]; env: Record<string, string> } | null> {
    const log = this.o.log ?? ((l: string) => console.error(l));
    const { server: flags, tui } = splitCodexArgs(this.o.args);
    try {
      this.server = await (this.o.serve ?? startCodexServer)({ binary: this.o.binary, flags, cwd: this.o.cwd, env: this.o.env, dir: this.o.dir, ...(this.o.held ? { held: this.o.held } : {}) });
      this.proc = this.server.proc ?? (this.server.child ? childServer(this.server.child) : null);
    } catch (err) {
      log(`codex terminal: its server did not start, the TUI runs on its own: ${(err as Error).message}`);
      return null;
    }
    if (this.stopped) { void this.proc?.stop(STOP_GRACE_MS); return null; }
    this.proc?.onExit(() => { if (!this.stopped) log("codex terminal: its server exited"); });
    return { args: [...tui, "--remote", this.server.url, "--remote-auth-token-env", CODEX_REMOTE_TOKEN_ENV], env: { ...this.o.env, [CODEX_REMOTE_TOKEN_ENV]: this.server.token } };
  }

  /** The hooks report its status and its cards; what it is writing comes from here (docs/simple-view-v0.md §5.14):
   *  this client follows the thread the TUI is on (`thread/resume` — which a thread refuses until its first turn has
   *  begun, so it is tried again) and is sent the pieces of its answer. The TUI made another thread (`/new`, a resume):
   *  that one is followed instead. */
  attach(link: CompanionLink): void {
    if (!link.writing) return;
    const feed = new WritingFeed((w) => link.writing!(w));
    const written = new WritingText();
    this.onNote = (method, params) => {
      if (params.threadId !== undefined && params.threadId !== this.followed) return;
      const piece = typeof params.delta === "string" ? params.delta : "";
      if (method === "item/agentMessage/delta" && piece) feed.set(written.add(String(params.itemId ?? ""), piece));
      else if (method === "item/reasoning/summaryTextDelta" && piece) feed.set(written.add(`reasoning:${String(params.itemId ?? "")}`, piece, true));
      // The part is written (its record has it), or the turn is over.
      else if ((method === "item/completed" && ["agentMessage", "reasoning"].includes(String((params.item as Json | undefined)?.type))) || method === "turn/completed") { feed.clear(); written.reset(); }
    };
    const look = async () => {
      if (this.stopped) return;
      try {
        const rpc = await this.rpc();
        const { thread } = await this.thread(rpc, null, 0);
        if (thread && thread !== this.followed) {
          await rpc.request("thread/resume", { threadId: thread }, CALL_TIMEOUT_MS);
          this.followed = thread;
          feed.clear(); written.reset();
        }
      } catch { /* no thread yet, or one not begun: looked at again */ }
      if (!this.stopped) this.following = setTimeout(() => void look(), FOLLOW_MS);
    };
    void look();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.following) clearTimeout(this.following);
    this.client?.ws.close();
    this.client = null;
    if (this.proc) void this.proc.stop(STOP_GRACE_MS);
  }

  /** A second client on the terminal's server, kept while it answers. */
  private async rpc(): Promise<AppServerClient> {
    if (this.client) return this.client.rpc;
    if (!this.server || this.stopped) throw new Error("its server is not running");
    const ws = await connectWsLines(this.server.url, { token: this.server.token, timeoutMs: CALL_TIMEOUT_MS });
    const rpc = new AppServerClient(ws.input, ws.output, async () => ({}), (method, params) => this.onNote?.(method, (params ?? {}) as Json));
    // A new connection follows no thread yet.
    ws.output.once("end", () => { if (this.client?.ws === ws) { this.client = null; this.followed = null; } });
    await rpc.request("initialize", { clientInfo: { name: "agentswitch", version: "0.1.0" }, capabilities: { experimentalApi: true } }, CALL_TIMEOUT_MS);
    rpc.notify("initialized");
    this.client = { rpc, ws };
    return rpc;
  }

  /** Another model, or another reasoning effort, for the thread the TUI is on: `thread/settings/update`, after which
   *  the TUI shows them (seen on 0.162: its footer goes from "GPT-6.1-Sol default" to "GPT-6-Astra high"). The model
   *  and the effort are checked against the server's own list first. Throws with a sentence a screen can show. */
  async setModel(want: { model?: string | null; variant?: string | null; session?: string | null }): Promise<{ model: string; variant: string | null }> {
    const rpc = await this.rpc();
    const { thread, now } = await this.thread(rpc, want.session ?? null, this.o.threadWaitMs ?? THREAD_WAIT_MS);
    if (!thread) throw new Error("no session yet: it starts with the TUI");
    const model = want.model ?? (typeof now.model === "string" ? now.model : null);
    if (!model) throw new Error("it has not said which model it is on");
    const models = ((await rpc.request("model/list", { includeHidden: true }, CALL_TIMEOUT_MS)).data as Json[] | undefined) ?? [];
    const known = models.find((m) => m.model === model || m.id === model);
    if (!known) throw new Error(`not a model of its: ${model}`);
    const efforts = (Array.isArray(known.supportedReasoningEfforts) ? known.supportedReasoningEfforts as Json[] : []).map((e) => String(e.reasoningEffort ?? "")).filter(Boolean);
    // Another model starts at its own default effort; an effort asked for must be one of that model's.
    const kept = !want.model && typeof now.reasoningEffort === "string" ? now.reasoningEffort : null;
    const effort = want.variant ?? kept ?? (typeof known.defaultReasoningEffort === "string" ? known.defaultReasoningEffort : null);
    if (want.variant && !efforts.includes(want.variant)) throw new Error(efforts.length ? `not a level of that model: one of ${efforts.join(", ")}` : "that model takes no level");
    await rpc.request("thread/settings/update", { threadId: thread, model: String(known.model ?? known.id), ...(effort ? { effort } : {}) }, CALL_TIMEOUT_MS);
    return { model: String(known.model ?? known.id), variant: effort };
  }
}
