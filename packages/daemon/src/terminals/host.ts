/** Terminal sessions the service holds (docs/terminal-v0.md): each one an agent CLI in a pseudo-terminal of its own,
 *  mirrored into a headless terminal so a screen that connects gets the current picture first, then the output as it
 *  comes. Status comes from the agent's hooks where it has them (Claude Code, Codex, pi's extension) or from a
 *  companion beside it (OpenCode's own server), else from output activity. Permission requests from a hook wait here until a screen answers (or the wait runs out and the agent asks
 *  in the terminal). */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import * as pty from "node-pty";
import type { KeyContext } from "./keys.js";

export const TERMINAL_HARNESSES = ["claude-code", "codex", "opencode", "pi"] as const;
export type TerminalHarness = (typeof TERMINAL_HARNESSES)[number];
/** How the agent asks before acting: every time, its own automatic mode, or not at all (bypass). The protected paths
 *  stay closed in every mode (the PreToolUse floor). */
export const PERMISSION_MODES = ["manual", "auto", "bypass"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type TerminalStatus = "working" | "waiting" | "idle" | "exited";
export type PermissionDecision = "allow" | "deny";

/** A permission request as the screens show it: the tool, one line to read, and the input as the agent gave it. */
export type PermissionAsk = { readonly id: string; readonly tool: string; readonly summary: string; readonly input: unknown; readonly at: number };

export type TerminalInfo = {
  readonly id: string;
  readonly harness: TerminalHarness;
  readonly cwd: string;
  readonly model: string | null;
  readonly mode: PermissionMode;
  /** What the screens call it: the user's own name for it, else a meaningful title the agent set (its current task),
   *  else the folder's name. */
  readonly name: string;
  /** The name is the user's own (a rename), not derived. */
  readonly customName: boolean;
  /** The terminal title the agent set, status glyphs removed ("" when none). */
  readonly title: string;
  readonly status: TerminalStatus;
  readonly pid: number | null;
  readonly cols: number;
  readonly rows: number;
  readonly createdAt: number;
  readonly lastOutputAt: number;
  readonly exitCode: number | null;
  /** The agent's own session id (Claude Code tells it through SessionStart), for resuming and deleting its transcript. */
  readonly agentSessionId: string | null;
  /** The session this terminal was continued from, if any: the same session goes on, unless `forked`. */
  readonly resumedFrom: string | null;
  /** Continued as a fork: a new session with the history of `resumedFrom`. */
  readonly forked: boolean;
  /** Status and permissions come from the agent's hooks or its companion (else status is guessed from output). */
  readonly hooks: boolean;
  readonly permissions: readonly PermissionAsk[];
  readonly seq: number;
};

export type TerminalEvent =
  | { readonly type: "snapshot"; readonly seq: number; readonly cols: number; readonly rows: number; readonly data: string }
  | { readonly type: "output"; readonly seq: number; readonly data: string }
  | { readonly type: "status"; readonly status: TerminalStatus }
  | { readonly type: "name"; readonly name: string }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }
  | { readonly type: "permission"; readonly request: PermissionAsk }
  | { readonly type: "permission_resolved"; readonly id: string; readonly decision: PermissionDecision | null }
  | { readonly type: "exit"; readonly code: number | null }
  /** The terminal was deleted: screens close. */
  | { readonly type: "removed" };

/** What a launcher gets: the new terminal's id and hook token go into the agent's env. */
export type LaunchRequest = {
  readonly id: string; readonly harness: TerminalHarness; readonly cwd: string; readonly model?: string; readonly resume?: string;
  /** Continue `resume` as a new session with its history, instead of the same session. */
  readonly fork?: boolean;
  readonly mode: PermissionMode;
  /** Bypass may be switched on later from inside the terminal (Claude Code's ⇧Tab): started from the Mac only. */
  readonly allowBypass?: boolean;
  readonly hookToken: string;
};
export type LaunchPlan = { readonly file: string; readonly args: readonly string[]; readonly env: Record<string, string>; readonly hooks: boolean; readonly companion?: Companion };
export type Launcher = (req: LaunchRequest) => LaunchPlan;

/** Runs beside the program and reports for it, for an agent whose status and permission requests live in a server of
 *  its own (OpenCode, opencodeTerminal.ts). Started before the program; it may change how the program starts. */
export type Companion = {
  /** The command line and env to start the program with instead of the plan's, or null to start as planned (then
   *  nothing comes from the companion and the status is guessed). */
  start(): Promise<{ readonly args: readonly string[]; readonly env: Record<string, string> } | null>;
  /** The program runs: report through `link` until stopped. */
  attach(link: CompanionLink): void;
  /** The program has ended or the terminal is gone (called once or more). */
  stop(): void;
};
export type CompanionLink = {
  status(status: Exclude<TerminalStatus, "exited">): void;
  /** A permission request for the screens: the answer, or null when none came or `signal` withdrew it (it was
   *  answered in the terminal). */
  ask(tool: string, input: unknown, signal: AbortSignal): Promise<PermissionDecision | null>;
};

/** pi's built-in tools under the names and fields the protected-path floor reads (Claude Code's); anything else, an
 *  extension's own tool, goes as it is and the floor leaves it to the agent. */
const PI_TOOLS: Readonly<Record<string, string>> = { bash: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", find: "Glob", ls: "LS" };
export function piTool(name: string, input: unknown): { tool: string; input: Record<string, unknown> } {
  const args = input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {};
  const tool = PI_TOOLS[name] ?? name;
  if ((tool === "Edit" || tool === "Write") && typeof args.path === "string") args.file_path = args.path;
  return { tool, input: args };
}

/** A hook call from the agent (hookClient.ts): the event name and the payload the agent passed to its hook. */
export type HookCall = { readonly event: string; readonly payload: Record<string, unknown> };
/** What the hook prints back to the agent (JSON), or null for nothing. */
export type HookAnswer = Record<string, unknown> | null;

export type TerminalHostOptions = {
  readonly launcher: Launcher;
  /** Output kept per terminal for reconnecting screens (default 2 MB); older output is only in the snapshot. */
  readonly bufferBytes?: number;
  /** Lines of scrollback in the headless terminal (default 5000) and in a snapshot (default 1000). */
  readonly scrollback?: number;
  readonly snapshotScrollback?: number;
  /** Without hooks: silence after output that counts as idle (default 3 s). */
  readonly idleAfterMs?: number;
  /** How long a permission request waits for a screen before the agent asks in the terminal itself (default 30 min). */
  readonly permissionTimeoutMs?: number;
  /** After SIGHUP, how long before SIGKILL (default 3 s). */
  readonly killGraceMs?: number;
  /** The protected-path floor for a tool call (PreToolUse): the reason to refuse it, or null to let the agent's own
   *  permission mode decide. */
  readonly floor?: (tool: string, input: Record<string, unknown>, cwd: string) => string | null;
  readonly now?: () => number;
};

export class TerminalError extends Error {
  constructor(readonly code: "not_found" | "exited" | "unavailable" | "forbidden", message: string) { super(message); }
}

type Listener = (ev: TerminalEvent) => void;
type Pending = { readonly ask: PermissionAsk; readonly resolve: (d: PermissionDecision | null) => void; readonly timer: NodeJS.Timeout };
type Chunk = { readonly seq: number; readonly data: string };

const DEFAULT_BUFFER_BYTES = 2 * 1024 * 1024;
/** How long output counts as the program answering what was just sent (echo, a mouse move, a resize), not work. */
const ECHO_MS = 600;
const DEFAULTS = { scrollback: 5000, snapshotScrollback: 1000, idleAfterMs: 3000, permissionTimeoutMs: 30 * 60_000, killGraceMs: 3000 };
const MAX_TITLE = 200;
/** A split escape sequence is held this long at most, and never more than this much of it. */
const HOLD_MS = 50;
/** Between the two size changes of a redraw: long enough for the program to notice the first. */
const REDRAW_MS = 60;
const HOLD_LIMIT = 4096;
const MAX_NAME = 80;
/** Agents put status glyphs in front of the title (Claude Code: ✳ idle, ✶ ✻ ✽ ✢ · while working; braille spinners). */
const TITLE_GLYPHS = /^[\s✳✶✷✸✹✺✻✼✽✢✣✤✥*·•●○◐◑◒◓⏺⏵▶►⠀-⣿]+/u;
/** Codex puts this in front of its title while something waits for you (`!` and `.` alternating): left out of the name,
 *  which would otherwise blink. Status comes from its notifications instead (OSC 9, launch.ts CODEX_ATTENTION). */
const ACTION_REQUIRED = /^\[ [!.] \] Action Required(?:\s*\|\s*)?/;
const AGENT_LABELS: Record<TerminalHarness, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi" };

/** The title without the agent's status glyphs and markers. */
export function cleanTitle(raw: string): string {
  return raw.trim().replace(ACTION_REQUIRED, "").replace(TITLE_GLYPHS, "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}


/** A title worth showing: not the agent's own name, a bare program name or a shell's `user@host: dir`. */
export function meaningfulTitle(title: string, harness: TerminalHarness): string | null {
  const t = cleanTitle(title);
  if (!t) return null;
  const low = t.toLowerCase();
  if ([harness, AGENT_LABELS[harness].toLowerCase(), "claude", "node", "zsh", "bash"].includes(low)) return null;
  if (/^[\w.-]+@[\w.-]+:/.test(t) || /^[~/]/.test(t)) return null;
  return t;
}

/** The name the screens show (see TerminalInfo.name); `given` is the title of the session a terminal continues. */
export function terminalName(custom: string | null, title: string, harness: TerminalHarness, cwd: string, given: string | null = null): string {
  return custom ?? meaningfulTitle(title, harness) ?? given ?? (basename(cwd) || AGENT_LABELS[harness]);
}
const MAX_SUMMARY = 400;

/** node-pty ships its macOS spawn helper without the execute bit when npm skips install scripts (npm ≥ 11 does by
 *  default); without it every spawn fails with "posix_spawnp failed". Set it once, before the first spawn. */
export function ensureSpawnHelper(): void {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const dir of [join(root, "prebuilds", `${process.platform}-${process.arch}`), join(root, "build", "Release")]) {
    const helper = join(dir, "spawn-helper");
    if (!existsSync(helper)) continue;
    if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
  }
}

/** Where `data` can be cut so that no escape sequence is split: the length of the part to send now. A program's output
 *  arrives in pieces that may end inside a sequence; a screen that starts from a snapshot taken at such a cut would
 *  print the sequence's tail as text ("27;2H"). The rest waits for the next piece. */
export function safeCut(data: string): number {
  let from = 0;
  for (;;) {
    const esc = data.indexOf("\x1b", from);
    if (esc < 0) return data.length;
    const end = sequenceEnd(data, esc);
    if (end < 0) return esc;
    from = end;
  }
}

/** Index just past the escape sequence at `at`, or -1 when `data` ends inside it. */
function sequenceEnd(data: string, at: number): number {
  const kind = data[at + 1];
  if (kind === undefined) return -1;
  if (kind === "[") {                                   // CSI: parameter and intermediate bytes, then a final byte
    for (let j = at + 2; j < data.length; j++) {
      const c = data.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j + 1;
      if (c < 0x20 || c > 0x3f) return j;               // malformed: the terminal gives up here too
    }
    return -1;
  }
  if ("]P_^X".includes(kind)) {                         // OSC, DCS, APC, PM, SOS: up to BEL or ESC \
    for (let j = at + 2; j < data.length; j++) {
      if (data[j] === "\x07") return j + 1;
      if (data[j] === "\x1b") return j + 1 >= data.length ? -1 : data[j + 1] === "\\" ? j + 2 : j;
    }
    return -1;
  }
  if ("()*+#%-./ ".includes(kind)) return at + 2 < data.length ? at + 3 : -1;   // charset and similar: one more byte
  return at + 2;                                        // two-byte sequences (ESC =, ESC 7, …)
}

/** One line a person can read for a permission request. */
export function permissionSummary(tool: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : null);
  const text = tool === "Bash" ? pick("command") : pick("file_path") ?? pick("notebook_path") ?? pick("url") ?? pick("pattern") ?? pick("path") ?? JSON.stringify(input ?? {});
  const line = `${tool}: ${text ?? ""}`.replace(/\s+/g, " ").trim();
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1)}…` : line;
}

class Session {
  readonly term: InstanceType<typeof headless.Terminal>;
  readonly ser: InstanceType<typeof serialize.SerializeAddon>;
  readonly listeners = new Set<Listener>();
  readonly pending = new Map<string, Pending>();
  chunks: Chunk[] = [];
  bytes = 0;
  seq = 0;
  /** Output up to here is in the headless terminal (its writes are asynchronous). */
  parsedSeq = 0;
  proc: pty.IPty | null = null;
  status: TerminalStatus = "idle";
  title: string;
  lastOutputAt: number;
  /** The user's own name for it; null = derived. */
  customName: string | null = null;
  resumedFrom: string | null = null;
  forked = false;
  /** The continued session's title, the name until the agent sets a title of its own. */
  givenName: string | null = null;
  exitCode: number | null = null;
  agentSessionId: string | null = null;
  /** The session this terminal started (a new one, or a fork's): the only record closing it may delete. */
  ownSessionId: string | null = null;
  hooks = false;
  companion: Companion | null = null;
  /** The agent said something on its screen waits for you (Codex's notification: an approval, an app's form, a
   *  question); until it goes on (a hook event) or, without hooks, until you type. */
  attention = false;
  idleTimer: NodeJS.Timeout | null = null;
  /** Output until then answers what was just sent (an agent without hooks is not busy for it). */
  quietUntil = 0;
  killTimer: NodeJS.Timeout | null = null;
  /** The start of an escape sequence the last piece of output ended in, sent with the next piece. */
  held = "";
  /** The program asked for mouse reports in SGR form. */
  sgrMouse = false;
  heldTimer: NodeJS.Timeout | null = null;

  constructor(readonly id: string, readonly harness: TerminalHarness, readonly cwd: string, readonly model: string | null, readonly mode: PermissionMode, readonly hookToken: string,
    readonly createdAt: number, public cols: number, public rows: number, scrollback: number) {
    this.term = new headless.Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.ser = new serialize.SerializeAddon();
    this.term.loadAddon(this.ser);
    // xterm's modes do not say how mouse reports are encoded: watch the program set and reset SGR form (1006).
    const sgr = (on: boolean) => (params: (number | number[])[]) => {
      if (params.some((p) => p === 1006 || (Array.isArray(p) && p.includes(1006)))) this.sgrMouse = on;
      return false;   // the terminal still handles the sequence itself
    };
    this.term.parser.registerCsiHandler({ prefix: "?", final: "h" }, sgr(true));
    this.term.parser.registerCsiHandler({ prefix: "?", final: "l" }, sgr(false));
    this.title = "";
    this.lastOutputAt = createdAt;
  }

  emit(ev: TerminalEvent): void {
    for (const l of this.listeners) {
      try { l(ev); } catch { /* a broken screen never stops the others */ }
    }
  }
}

export class TerminalHost {
  private readonly sessions = new Map<string, Session>();
  private readonly o: Required<Omit<TerminalHostOptions, "launcher" | "now" | "floor">> & { now: () => number };
  private helperChecked = false;

  constructor(private readonly opts: TerminalHostOptions) {
    this.o = {
      bufferBytes: opts.bufferBytes ?? DEFAULT_BUFFER_BYTES,
      scrollback: opts.scrollback ?? DEFAULTS.scrollback,
      snapshotScrollback: opts.snapshotScrollback ?? DEFAULTS.snapshotScrollback,
      idleAfterMs: opts.idleAfterMs ?? DEFAULTS.idleAfterMs,
      permissionTimeoutMs: opts.permissionTimeoutMs ?? DEFAULTS.permissionTimeoutMs,
      killGraceMs: opts.killGraceMs ?? DEFAULTS.killGraceMs,
      now: opts.now ?? Date.now,
    };
  }

  /** Starts an agent. The terminal is listed from the moment it is made (a second resume of the same session finds it),
   *  while a companion starts; the program follows. */
  async spawn(req: { harness: TerminalHarness; cwd: string; model?: string; resume?: string; fork?: boolean; name?: string; mode?: PermissionMode; allowBypass?: boolean; cols?: number; rows?: number }): Promise<TerminalInfo> {
    if (!this.helperChecked) { ensureSpawnHelper(); this.helperChecked = true; }
    const id = randomUUID().slice(0, 8);
    const hookToken = randomBytes(24).toString("base64url");
    let plan: LaunchPlan;
    try {
      plan = this.opts.launcher({ id, harness: req.harness, cwd: req.cwd, hookToken, mode: req.mode ?? "manual", ...(req.allowBypass ? { allowBypass: true } : {}), ...(req.model ? { model: req.model } : {}), ...(req.resume ? { resume: req.resume, ...(req.fork ? { fork: true } : {}) } : {}) });
    } catch (err) {
      throw new TerminalError("unavailable", (err as Error).message);
    }
    const s = new Session(id, req.harness, req.cwd, req.model ?? null, req.mode ?? "manual", hookToken, this.o.now(), req.cols ?? 120, req.rows ?? 36, this.o.scrollback);
    s.hooks = plan.hooks;
    s.resumedFrom = req.resume ?? null;
    s.forked = Boolean(req.resume && req.fork && req.harness !== "opencode");
    // Continued in place, the agent writes the session it was given (its hooks say the same once they run).
    if (req.resume && !s.forked) s.agentSessionId = req.resume;
    s.givenName = req.name?.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) || null;
    // Codex's notifications (OSC 9) are only those for what waits for you (launch.ts CODEX_ATTENTION).
    if (req.harness === "codex") s.term.parser.registerOscHandler(9, () => { s.attention = true; this.setStatus(s, "waiting"); return true; });
    s.term.onTitleChange((t) => {
      const title = cleanTitle(t);
      if (title === s.title) return;
      const before = this.nameOf(s);
      s.title = title;
      const after = this.nameOf(s);
      if (after !== before) s.emit({ type: "name", name: after });
    });
    this.sessions.set(id, s);
    let { args, env } = plan;
    if (plan.companion) {
      const started = await plan.companion.start().catch(() => null);
      if (this.sessions.get(id) !== s) {   // deleted while it started
        plan.companion.stop();
        throw new TerminalError("not_found", `terminal ${id} was deleted while it started`);
      }
      if (started) { ({ args, env } = started); s.hooks = true; s.companion = plan.companion; }
      else plan.companion.stop();
    }
    let proc: pty.IPty;
    try {
      proc = pty.spawn(plan.file, [...args], { name: "xterm-256color", cols: s.cols, rows: s.rows, cwd: req.cwd, env });
    } catch (err) {
      this.sessions.delete(id);
      s.companion?.stop();
      s.term.dispose();
      throw new TerminalError("unavailable", `could not start ${req.harness}: ${(err as Error).message}`);
    }
    s.proc = proc;
    proc.onData((data) => this.receive(s, data));
    proc.onExit(({ exitCode }) => this.exited(s, exitCode));
    s.companion?.attach({ status: (status) => this.setStatus(s, status), ask: (tool, input, signal) => this.ask(s, tool, input, signal) });
    return this.info(s);
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt).map((s) => this.info(s));
  }

  get(id: string): TerminalInfo | null {
    const s = this.sessions.get(id);
    return s ? this.info(s) : null;
  }

  /** The user's own name for the terminal; empty or null goes back to the derived one. */
  rename(id: string, name: string | null): TerminalInfo {
    const s = this.need(id);
    const cleaned = name?.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) || null;
    s.customName = cleaned;
    s.emit({ type: "name", name: this.nameOf(s) });
    return this.info(s);
  }

  /** Bytes typed into the terminal, as they are. */
  write(id: string, data: string): void {
    const s = this.live(id);
    s.quietUntil = this.o.now() + ECHO_MS;
    // Without hooks nothing else says the answer came: typing is taken for it.
    if (s.attention && !s.hooks) { s.attention = false; this.busy(s); }
    s.proc!.write(data);
  }

  /** Whether the program in the terminal asked for bracketed paste (then a reply is pasted as one block). */
  bracketedPaste(id: string): boolean {
    return this.need(id).term.modes.bracketedPasteMode;
  }

  applicationCursor(id: string): boolean {
    return this.need(id).term.modes.applicationCursorKeysMode;
  }

  /** What the program asked for that named keys follow (keys.ts). */
  keyContext(id: string): KeyContext {
    const s = this.need(id);
    return { applicationCursor: s.term.modes.applicationCursorKeysMode, mouse: s.term.modes.mouseTrackingMode, sgrMouse: s.sgrMouse,
      alternate: s.term.buffer.active.type === "alternate", cols: s.cols, rows: s.rows };
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.live(id);
    if (cols === s.cols && rows === s.rows) return;
    s.cols = cols;
    s.rows = rows;
    s.quietUntil = this.o.now() + ECHO_MS;
    s.proc!.resize(cols, rows);
    s.term.resize(cols, rows);
    s.emit({ type: "resize", cols, rows });
  }

  /** Has the program draw its screen again: a size change it notices (one row less, then back), as tmux does when a
   *  client attaches. A snapshot keeps the text but not what the serializer drops (OSC 8 links in an agent's status
   *  line); the redraw brings them back. The headless mirror keeps its size, so nothing else moves. */
  redraw(id: string): void {
    const s = this.live(id);
    if (s.rows < 2) return;
    s.quietUntil = this.o.now() + REDRAW_MS + ECHO_MS;
    s.proc!.resize(s.cols, s.rows - 1);
    setTimeout(() => { if (s.proc && s.status !== "exited") try { s.proc.resize(s.cols, s.rows); } catch { /* ended meanwhile */ } }, REDRAW_MS).unref();
  }

  /** Every event from `after` on: the output a screen missed when the buffer still has it, else a snapshot first. */
  subscribe(id: string, after: number | null, listener: Listener): () => void {
    const s = this.need(id);
    const first = s.chunks[0]?.seq ?? s.seq + 1;
    if (after !== null && after >= first - 1 && after <= s.seq) {
      for (const c of s.chunks) if (c.seq > after) listener({ type: "output", seq: c.seq, data: c.data });
    } else {
      listener(this.snapshot(s));
      for (const c of s.chunks) if (c.seq > s.parsedSeq) listener({ type: "output", seq: c.seq, data: c.data });
    }
    listener({ type: "status", status: s.status });
    for (const p of s.pending.values()) listener({ type: "permission", request: p.ask });
    if (s.status === "exited") listener({ type: "exit", code: s.exitCode });
    s.listeners.add(listener);
    return () => { s.listeners.delete(listener); };
  }

  /** A hook call from the agent in terminal `id`, proven by its hook token. Permission requests wait for a screen, or
   *  until `signal` aborts: the hook command went away, which happens when the request was answered in the terminal. */
  async hook(id: string, token: string, call: HookCall, signal?: AbortSignal): Promise<HookAnswer> {
    const s = this.sessions.get(id);
    if (!s || !same(token, s.hookToken)) throw new TerminalError("forbidden", "unknown terminal or hook token");
    const p = call.payload;
    if (typeof p.session_id === "string" && p.session_id) this.reported(s, p.session_id);
    // The agent goes on: what waited for you on its screen was answered.
    if (call.event !== "SessionStart" && s.attention) { s.attention = false; if (s.status === "waiting" && !s.pending.size) this.setStatus(s, "working"); }
    switch (call.event) {
      // A request answered in the terminal itself leaves its hook waiting here (Claude Code does not end it): what the
      // agent does next tells us — the tool ran (PostToolUse), the turn ended (Stop), or the user typed on (UserPromptSubmit).
      case "SessionStart": this.setStatus(s, "idle"); return null;
      case "UserPromptSubmit": this.settleAll(s, "working"); this.setStatus(s, "working"); return null;
      case "Stop": this.settleAll(s, "idle"); this.setStatus(s, "idle"); return null;
      case "PreToolUse": {
        this.setStatus(s, "working");
        const input = (p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {}) as Record<string, unknown>;
        const refused = this.opts.floor?.(String(p.tool_name ?? ""), input, s.cwd) ?? null;
        return refused ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refused } } : null;
      }
      case "PostToolUse": {
        const tool = String(p.tool_name ?? "");
        const input = JSON.stringify(p.tool_input ?? null);
        const same = [...s.pending.values()].filter((x) => x.ask.tool === tool);
        const exact = same.find((x) => JSON.stringify(x.ask.input) === input) ?? (same.length === 1 ? same[0] : undefined);
        if (exact) this.settle(s, exact.ask.id, null, "working");
        return null;
      }
      case "Notification": {
        const kind = String(p.notification_type ?? "");
        if (kind === "permission_prompt" || s.pending.size) this.setStatus(s, "waiting");
        else if (kind === "idle_prompt") this.setStatus(s, "idle");
        return null;
      }
      // pi's extension (piExtension.ts): every tool call is checked here first; a refusal blocks it.
      case "PiToolCall": {
        this.setStatus(s, "working");
        const call = piTool(String(p.tool ?? ""), p.input);
        const refused = this.opts.floor?.(call.tool, call.input, s.cwd) ?? null;
        return refused ? { block: true, reason: refused } : null;
      }
      case "PiAgentStart": this.setStatus(s, "working"); return null;
      case "PiAgentEnd": this.setStatus(s, "idle"); return null;
      // pi blocks on a question of its own (a confirm or a choice in its screen): the terminal waits for you.
      case "PiWaiting": this.setStatus(s, "waiting"); return null;
      case "CodexNotify": {
        if (typeof p["thread-id"] === "string" && p["thread-id"]) this.reported(s, p["thread-id"]);
        if (p.type === "agent-turn-complete") this.setStatus(s, "idle");
        return null;
      }
      case "PermissionRequest": {
        const tool = String(p.tool_name ?? "tool");
        const decision = await this.ask(s, tool, p.tool_input ?? null, signal);
        if (!decision) return null;   // nobody answered: the agent asks in the terminal
        return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "在 AgentSwitch 上被拒绝。" } } };
      }
      default: return null;
    }
  }

  /** The agent says which session it writes. A new terminal's or a fork's first one is its own; a later one (`/resume`
   *  typed inside it) is followed, never owned, so closing the terminal cannot delete a record it did not start. */
  private reported(s: Session, sessionId: string): void {
    s.agentSessionId = sessionId;
    if (!s.ownSessionId && (!s.resumedFrom || s.forked) && sessionId !== s.resumedFrom) s.ownSessionId = sessionId;
  }

  /** The session terminal `id` started itself, if its agent has reported one. */
  ownSession(id: string): string | null {
    return this.need(id).ownSessionId;
  }

  /** A screen's answer to a permission request; false when there is no such request (answered already). */
  decide(id: string, permissionId: string, decision: PermissionDecision): boolean {
    const s = this.need(id);
    const p = s.pending.get(permissionId);
    if (!p) return false;
    this.settle(s, permissionId, decision);
    return true;
  }

  /** Ends the program (SIGHUP, then SIGKILL after a grace period); the terminal stays listed with its last screen. The
   *  pty made the agent a process group leader, so the signal reaches what it started too. */
  kill(id: string): void {
    const s = this.need(id);
    if (!s.proc || s.status === "exited") return;
    const signal = (proc: pty.IPty, sig: NodeJS.Signals) => {
      try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch { /* gone already */ } }
    };
    signal(s.proc, "SIGHUP");
    s.killTimer = setTimeout(() => { if (s.proc) signal(s.proc, "SIGKILL"); }, this.o.killGraceMs);
    s.killTimer.unref();
  }

  /** Ends the program and resolves once it has exited (at once if it had), or after the kill grace and a moment more. */
  stopped(id: string): Promise<void> {
    const s = this.need(id);
    if (!s.proc || s.status === "exited") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); s.listeners.delete(listener); resolve(); };
      const listener: Listener = (ev) => { if (ev.type === "exit") done(); };
      const timer = setTimeout(done, this.o.killGraceMs + 1000);
      s.listeners.add(listener);
      this.kill(id);
    });
  }

  /** Ends the program if it still runs and forgets the terminal. */
  remove(id: string): TerminalInfo {
    const s = this.need(id);
    const info = this.info(s);
    this.kill(id);
    s.companion?.stop();
    for (const pid of [...s.pending.keys()]) this.settle(s, pid, null);
    s.emit({ type: "removed" });
    s.listeners.clear();
    this.sessions.delete(id);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.term.dispose();
    return info;
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.remove(id);
  }

  /** Output from the program, cut only between escape sequences (safeCut); a held tail goes out with the next piece,
   *  or after a moment when none comes. */
  private receive(s: Session, data: string): void {
    const all = s.held + data;
    if (s.heldTimer) { clearTimeout(s.heldTimer); s.heldTimer = null; }
    const cut = all.length > HOLD_LIMIT ? all.length : safeCut(all);
    s.held = all.slice(cut);
    if (cut > 0) this.output(s, all.slice(0, cut));
    if (s.held) {
      s.heldTimer = setTimeout(() => { s.heldTimer = null; const rest = s.held; s.held = ""; if (rest) this.output(s, rest); }, HOLD_MS);
      s.heldTimer.unref();
    }
  }

  private output(s: Session, data: string): void {
    s.seq += 1;
    const seq = s.seq;
    s.chunks.push({ seq, data });
    s.bytes += data.length;
    while (s.bytes > this.o.bufferBytes && s.chunks.length > 1) s.bytes -= s.chunks.shift()!.data.length;
    s.term.write(data, () => { if (seq > s.parsedSeq) s.parsedSeq = seq; });
    s.lastOutputAt = this.o.now();
    s.emit({ type: "output", seq, data });
    // Waiting for you, it waits whatever it draws.
    if (!s.hooks && s.status !== "exited" && !s.attention) {
      // A full-screen agent redraws while it waits — for the typing it echoes, a mouse move over the screen, a focus
      // change, a resize or a redraw asked for — and none of that is work: output answering what was just sent does not
      // make an idle terminal busy (a busy one stays busy while anything comes).
      if (s.status !== "working" && this.o.now() < s.quietUntil) return;
      this.busy(s);
    }
  }

  /** Working; without hooks, until the output stops for a while. */
  private busy(s: Session): void {
    this.setStatus(s, "working");
    if (s.hooks) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => { if (s.status === "working") this.setStatus(s, "idle"); }, this.o.idleAfterMs);
    s.idleTimer.unref();
  }

  private exited(s: Session, code: number): void {
    if (s.heldTimer) { clearTimeout(s.heldTimer); s.heldTimer = null; }
    if (s.held) { const rest = s.held; s.held = ""; this.output(s, rest); }
    if (s.killTimer) clearTimeout(s.killTimer);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.exitCode = code;
    s.companion?.stop();
    for (const pid of [...s.pending.keys()]) this.settle(s, pid, null);
    this.setStatus(s, "exited");
    s.emit({ type: "exit", code });
  }

  private ask(s: Session, tool: string, input: unknown, signal?: AbortSignal): Promise<PermissionDecision | null> {
    if (s.status === "exited" || signal?.aborted) return Promise.resolve(null);
    const id = randomUUID().slice(0, 8);
    const ask: PermissionAsk = { id, tool, summary: permissionSummary(tool, input), input, at: this.o.now() };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(s, id, null), this.o.permissionTimeoutMs);
      timer.unref();
      const gone = () => { if (s.pending.has(id)) this.settle(s, id, null, "working"); };
      signal?.addEventListener("abort", gone, { once: true });
      s.pending.set(id, { ask, resolve: (d) => { signal?.removeEventListener("abort", gone); resolve(d); }, timer });
      this.setStatus(s, "waiting");
      s.emit({ type: "permission", request: ask });
    });
  }

  /** `after`: the status once no request is left (default: working after an answer, waiting when none came, since
   *  the agent then asks in the terminal). */
  private settle(s: Session, id: string, decision: PermissionDecision | null, after?: TerminalStatus): void {
    const p = s.pending.get(id);
    if (!p) return;
    s.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(decision);
    s.emit({ type: "permission_resolved", id, decision });
    if (decision) s.attention = false;   // answered from a screen: the agent's own prompt for it is gone too
    if (s.status === "waiting" && !s.pending.size && !s.attention) this.setStatus(s, after ?? (decision ? "working" : "waiting"));
  }

  private settleAll(s: Session, after: TerminalStatus): void {
    for (const id of [...s.pending.keys()]) this.settle(s, id, null, after);
  }

  private setStatus(s: Session, status: TerminalStatus): void {
    if (s.status === status || s.status === "exited") return;
    s.status = status;
    s.emit({ type: "status", status });
  }

  /** The screen as a newly attached one needs it. The serializer restores mouse tracking but not how it reports:
   *  SGR (1006, which Claude Code turns on) is added back, or a desktop screen would send the wheel and clicks in the
   *  old byte form, which the page does not forward and the program does not read. */
  private snapshot(s: Session): TerminalEvent {
    const data = s.ser.serialize({ scrollback: this.o.snapshotScrollback }) + (s.sgrMouse ? "\x1b[?1006h" : "");
    return { type: "snapshot", seq: s.parsedSeq, cols: s.cols, rows: s.rows, data };
  }

  private need(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new TerminalError("not_found", `no terminal ${id}`);
    return s;
  }

  private live(id: string): Session {
    const s = this.need(id);
    if (!s.proc || s.status === "exited") throw new TerminalError("exited", `terminal ${id} has ended`);
    return s;
  }

  private nameOf(s: Session): string {
    return terminalName(s.customName, s.title, s.harness, s.cwd, s.givenName);
  }

  private info(s: Session): TerminalInfo {
    return {
      id: s.id, harness: s.harness, cwd: s.cwd, model: s.model, mode: s.mode, name: this.nameOf(s), customName: s.customName !== null, title: s.title,
      status: s.status, pid: s.proc?.pid ?? null,
      cols: s.cols, rows: s.rows, createdAt: s.createdAt, lastOutputAt: s.lastOutputAt, exitCode: s.exitCode,
      agentSessionId: s.agentSessionId, resumedFrom: s.resumedFrom, forked: s.forked, hooks: s.hooks, permissions: [...s.pending.values()].map((p) => p.ask), seq: s.seq,
    };
  }
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
