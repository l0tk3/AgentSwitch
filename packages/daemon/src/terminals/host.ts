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
import { replyBytes, type KeyContext } from "./keys.js";
import { screenView } from "./screenView.js";

export const TERMINAL_HARNESSES = ["claude-code", "codex", "opencode", "pi"] as const;
export type TerminalHarness = (typeof TERMINAL_HARNESSES)[number];
/** How the agent asks before acting: every time, its own automatic mode, or not at all (bypass). The protected paths
 *  stay closed in every mode (the PreToolUse floor). */
export const PERMISSION_MODES = ["manual", "auto", "bypass"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type TerminalStatus = "working" | "waiting" | "idle" | "exited";
export type PermissionDecision = "allow" | "deny";

/** One question of a Claude Code `AskUserQuestion` call, as the screens draw it (docs/terminal-v0.md §3 "选择题"): its
 *  chip, the question, its options; one to pick or several. A question without options takes only words. */
export type AskQuestion = {
  readonly question: string; readonly header: string; readonly multiSelect: boolean;
  readonly options: readonly { readonly label: string; readonly description: string }[];
};
/** What a screen picked for one question: options by their label, and the words written in Other. */
export type QuestionPick = { readonly labels?: readonly string[] | undefined; readonly other?: string | undefined };

/** A permission request as the screens show it: the tool, one line to read, and the input as the agent gave it.
 *  `questions`: the request is the agent asking (AskUserQuestion), answered with picks instead of allow / deny. */
export type PermissionAsk = {
  readonly id: string; readonly tool: string; readonly summary: string; readonly input: unknown; readonly at: number;
  readonly questions?: readonly AskQuestion[];
};
/** A screen's answer to a request: allow or deny, and a question's answers as Claude Code takes them (question text →
 *  the answer), which go with allow. */
export type PermissionReply = { readonly decision: PermissionDecision; readonly answers?: Readonly<Record<string, string>> };

export type TerminalInfo = {
  readonly id: string;
  readonly harness: TerminalHarness;
  readonly cwd: string;
  /** Where the agent works now: the `cwd` its hook calls carry (it changes as the agent `cd`s), else `cwd`. */
  readonly workdir: string;
  readonly model: string | null;
  /** The model the agent says it is on now (Claude Code, each time it changes: a `/model` in the terminal, one a
   *  screen asked for, a fallback of its own); null until it has said. `model` is what the terminal was started with. */
  readonly modelNow: string | null;
  /** The thinking level it was started at, in the agent's own word; null: the agent's default. What it is at now is
   *  in its session's record (Claude Code and Codex write it with every turn). */
  readonly effort: string | null;
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
  /** The tool it is using now (the last one it reported before use, PreToolUse / pi's tool_call) and what on, until
   *  it is idle again; null when it has reported none (the Live Activity's step, assistant-v0 §4). */
  readonly activity: { readonly tool: string; readonly target: string; readonly note?: string } | null;
  /** Its sub-agents at work (Claude Code's SubagentStart … SubagentStop), in the order they started: the tree shows
   *  them under the terminal (docs/terminal-v0.md §1). */
  readonly subagents: readonly Subagent[];
  /** When the status last changed (the Live Activity's clock: working since, waiting since). */
  readonly statusSince: number;
  readonly seq: number;
};

export type Subagent = {
  readonly id: string;
  /** Its kind: Claude Code's `subagent_type` (Explore, code-reviewer, general-purpose…). */
  readonly type: string;
  /** What it was sent to do (the Agent tool's `description`), else its kind. */
  readonly name: string;
  /** The tool it uses now and what on, as the terminal's own `activity`; null before its first. */
  readonly activity: { readonly tool: string; readonly target: string; readonly note?: string } | null;
  readonly since: number;
};

export type TerminalEvent =
  | { readonly type: "snapshot"; readonly seq: number; readonly cols: number; readonly rows: number; readonly data: string }
  | { readonly type: "output"; readonly seq: number; readonly data: string }
  | { readonly type: "status"; readonly status: TerminalStatus }
  | { readonly type: "name"; readonly name: string }
  /** `by`: the screen that owns the size now (docs/terminal-v0.md §1 "尺寸有主"); null when none said who it is. */
  | { readonly type: "resize"; readonly cols: number; readonly rows: number; readonly by: string | null }
  | { readonly type: "permission"; readonly request: PermissionAsk }
  | { readonly type: "permission_resolved"; readonly id: string; readonly decision: PermissionDecision | null }
  /** Every request waiting now, sent on each (re)connect: a screen replaces what it holds (one answered elsewhere
   *  while it was away goes). */
  | { readonly type: "permissions"; readonly requests: readonly PermissionAsk[] }
  | { readonly type: "exit"; readonly code: number | null }
  /** The terminal was deleted: screens close. */
  | { readonly type: "removed" }
  /** The agent is on another model now (Claude Code's PostModelSwitch). */
  | { readonly type: "model"; readonly model: string }
  /** What it is doing now changed (the tool, its sub-agents): for a screen that shows the record, not the terminal
   *  (docs/simple-view-v0.md §4). */
  | { readonly type: "activity"; readonly activity: TerminalInfo["activity"]; readonly subagents: readonly Subagent[] }
  /** Its session's record changed (the stream's own, not the host's: it watches the agent's file). */
  | { readonly type: "record"; readonly rev: string };

/** What a launcher gets: the new terminal's id and hook token go into the agent's env. */
export type LaunchRequest = {
  readonly id: string; readonly harness: TerminalHarness; readonly cwd: string; readonly model?: string; readonly resume?: string;
  /** How hard it thinks, in the agent's own word for the level (harness/efforts.ts); absent: the agent's default. */
  readonly effort?: string;
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
  /** How long the size stays with a screen whose stream ended, for it to come back (a reconnect; default 3 s). */
  readonly sizeReleaseMs?: number;
  /** The protected-path floor for a tool call (PreToolUse): the reason to refuse it, or null to let the agent's own
   *  permission mode decide. */
  readonly floor?: (tool: string, input: Record<string, unknown>, cwd: string) => string | null;
  /** The program ended (or never started): what was made for this terminal's agent ends too (its browser session). */
  readonly onExit?: (id: string) => void;
  /** The terminal is forgotten (deleted, or its start failed): what it left goes too (its browser tabs). */
  readonly onRemove?: (id: string) => void;
  readonly now?: () => number;
};

export class TerminalError extends Error {
  constructor(readonly code: "not_found" | "exited" | "unavailable" | "forbidden" | "invalid" | "busy", message: string) { super(message); }
}

type Listener = (ev: TerminalEvent) => void;
/** How a terminal's turn ended: `line` is the agent's last answer (its start), the error, or the exit. */
export type TurnEnd = { readonly at: number; readonly ok: boolean; readonly line: string };
type Pending = { readonly ask: PermissionAsk; readonly resolve: (r: PermissionReply | null) => void; readonly timer: NodeJS.Timeout };
type Chunk = { readonly seq: number; readonly data: string };

const DEFAULT_BUFFER_BYTES = 2 * 1024 * 1024;
/** How long output counts as the program answering what was just sent (echo, a mouse move, a resize), not work. */
const ECHO_MS = 600;
const DEFAULTS = { scrollback: 5000, snapshotScrollback: 1000, idleAfterMs: 3000, permissionTimeoutMs: 30 * 60_000, killGraceMs: 3000, sizeReleaseMs: 3000 };
const MAX_TITLE = 200;
/** A split escape sequence is held this long at most, and never more than this much of it. */
const HOLD_MS = 50;
/** Between the two size changes of a redraw: long enough for the program to notice the first. */
const REDRAW_MS = 60;
const HOLD_LIMIT = 4096;
const MAX_NAME = 80;
/** What the agent says a step is for: a sentence. */
const MAX_NOTE = 200;
/** An Agent tool call starts its sub-agent at once; one not started by then was refused. */
const LAUNCH_MS = 60_000;
const MAX_LAUNCHES = 8;
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
/** How long after a screen asked for a model its change goes through without Claude Code's own question. */
const MODEL_ASK_MS = 20_000;

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

/** The one thing a request works on: the command, else the file, page, pattern or path, else the input as JSON. */
/** What the agent says a tool call is for, in its own words (Claude Code's `description` of a command), on one line:
 *  the screens say that where they say what it is doing, as its own app does, with the command under it. */
function said(input: unknown): { note?: string } {
  const description = input && typeof input === "object" ? (input as Record<string, unknown>).description : undefined;
  const note = typeof description === "string" ? description.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE) : "";
  return note ? { note } : {};
}

export function permissionTarget(tool: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : null);
  if (tool === "Bash") return pick("command") ?? "";
  return pick("file_path") ?? pick("notebook_path") ?? pick("url") ?? pick("pattern") ?? pick("path") ?? JSON.stringify(input ?? {});
}

/** One line a person can read for a permission request; for a question, the question itself (several joined by " · "). */
export function permissionSummary(tool: string, input: unknown): string {
  const questions = askQuestions(tool, input);
  const said = questions ? questions.map((q) => q.question).join(" · ") : `${tool}: ${permissionTarget(tool, input)}`;
  const line = said.replace(/\s+/g, " ").trim();
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1)}…` : line;
}

/** The tool by which Claude Code asks the user: its own dialog in the terminal, and a PermissionRequest (2.1.286). */
export const ASK_TOOL = "AskUserQuestion";
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 16;
/** Other's words, at most (Claude Code takes 8192 characters an answer). */
export const MAX_OTHER = 8000;

/** The questions of an AskUserQuestion call, or null when `tool` is another or its input is not one we can draw (then
 *  it is shown as any permission request). Each needs its text, unique in the call, and options with unique labels. */
export function askQuestions(tool: string, input: unknown): AskQuestion[] | null {
  if (tool !== ASK_TOOL || !input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) return null;
  const questions: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") return null;
    const { question, header, multiSelect, options = [] } = q as Record<string, unknown>;
    if (typeof question !== "string" || !question.trim() || !Array.isArray(options) || options.length > MAX_OPTIONS) return null;
    const opts: { label: string; description: string }[] = [];
    for (const o of options) {
      const { label, description } = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
      if (typeof label !== "string" || !label) return null;
      opts.push({ label, description: typeof description === "string" ? description : "" });
    }
    if (new Set(opts.map((o) => o.label)).size !== opts.length) return null;
    questions.push({ question, header: typeof header === "string" ? header : "", multiSelect: multiSelect === true, options: opts });
  }
  return new Set(questions.map((q) => q.question)).size === questions.length ? questions : null;
}

/** What is wrong with `picks` as answers to `questions`, or null: each must be one of the questions; its labels among
 *  its options, each once; one answer (an option or Other's words) when it takes one, at least one when several; a
 *  question without options takes words only. Questions left out go unanswered, as in Claude Code's own dialog. */
export function checkPicks(questions: readonly AskQuestion[], picks: Readonly<Record<string, QuestionPick>>): string | null {
  const keys = Object.keys(picks);
  if (!keys.length) return "no answers";
  for (const key of keys) {
    const q = questions.find((x) => x.question === key);
    const short = key.slice(0, 80);
    if (!q) return `not a question of this request: ${short}`;
    const labels = picks[key]!.labels ?? [];
    const other = picks[key]!.other?.trim() ?? "";
    if (new Set(labels).size !== labels.length) return `an option picked twice for "${short}"`;
    const unknown = labels.find((l) => !q.options.some((o) => o.label === l));
    if (unknown !== undefined) return `not an option of "${short}": ${unknown.slice(0, 80)}`;
    const count = labels.length + (other ? 1 : 0);
    if (count === 0) return `no answer for "${short}"`;
    if (!q.multiSelect && count > 1) return `one answer only for "${short}"`;
    if (other.length > MAX_OTHER) return `the answer to "${short}" is too long`;
  }
  return null;
}

/** An answer as Claude Code's own dialog gives it (2.1.286): the option's label; several joined by ", ", a label that
 *  holds ", " or a quote written as a JSON string (its `Brt`); Other's words as they are, after the options picked. */
export function answerText(pick: QuestionPick): string {
  const other = pick.other?.trim() ?? "";
  const parts = [...(pick.labels ?? []), ...(other ? [other] : [])];
  if (parts.length === 1) return parts[0]!;
  return parts.map((p) => (p.includes(", ") || p.includes('"') ? JSON.stringify(p) : p)).join(", ");
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
  statusSince: number;
  activity: { tool: string; target: string; note?: string } | null = null;
  /** The folder the agent last said it works in (a hook call's `cwd`); null before it says. */
  agentCwd: string | null = null;
  /** The model the agent says it is on now (PostModelSwitch); and one a screen asked for a moment ago. */
  modelNow: string | null = null;
  /** The level it was started at; null: the agent's own default. */
  effort: string | null = null;
  modelAsked: { readonly model: string; readonly at: number } | null = null;
  /** Sub-agents at work, by their id; and the Agent tool calls not yet started as one (what each was sent to do). */
  readonly subagents = new Map<string, { id: string; type: string; name: string; activity: { tool: string; target: string; note?: string } | null; since: number }>();
  launches: { type: string; name: string; at: number }[] = [];
  /** How the last turn ended (assistant-v0 §4 "结果要提示"): the agent said it ended, or it failed (an API error the
   *  agent reported, the program exiting with an error). `line`: what to read — kept in memory only. */
  lastTurn: TurnEnd | null = null;
  /** The screen whose size the terminal has (the last one a user acted on); null: none said, or it left. */
  sizedBy: string | null = null;
  /** Screens following the stream, by their id: the size goes back when its owner's last stream ends. */
  readonly screens = new Map<string, number>();
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
  /** The kitty keyboard protocol's flags, the current ones last. */
  kitty: number[] = [];
  heldTimer: NodeJS.Timeout | null = null;

  constructor(readonly id: string, readonly harness: TerminalHarness, readonly cwd: string, readonly model: string | null, readonly mode: PermissionMode, readonly hookToken: string,
    readonly createdAt: number, public cols: number, public rows: number, scrollback: number) {
    this.term = new headless.Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.ser = new serialize.SerializeAddon();
    // It reads the screen as shown: lines cut at the screen's width (screenView.ts: a narrowed screen keeps wider lines).
    this.ser.activate(screenView(this.term) as unknown as Parameters<typeof this.ser.activate>[0]);
    // xterm's modes do not say how mouse reports are encoded: watch the program set and reset SGR form (1006).
    const sgr = (on: boolean) => (params: (number | number[])[]) => {
      if (params.some((p) => p === 1006 || (Array.isArray(p) && p.includes(1006)))) this.sgrMouse = on;
      return false;   // the terminal still handles the sequence itself
    };
    this.term.parser.registerCsiHandler({ prefix: "?", final: "h" }, sgr(true));
    this.term.parser.registerCsiHandler({ prefix: "?", final: "l" }, sgr(false));
    // The kitty keyboard protocol's flags, a stack the program pushes (`CSI > f u`), pops (`CSI < n u`) and sets
    // (`CSI = f ; m u`). Its query (`CSI ? u`) goes unanswered: xterm encodes no other key that way, so Claude Code,
    // which asks first, keeps the legacy keys.
    const num = (p: number | number[] | undefined, d: number): number => (typeof p === "number" ? p : d);
    this.term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => { this.kitty.push(num(params[0], 0)); return true; });
    this.term.parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => { this.kitty.splice(-Math.max(1, num(params[0], 1))); return true; });
    this.term.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      const flags = num(params[0], 0), mode = num(params[1], 1), top = this.kitty.pop() ?? 0;
      this.kitty.push(mode === 1 ? flags : mode === 2 ? top | flags : top & ~flags);
      return true;
    });
    this.title = "";
    this.lastOutputAt = createdAt;
    this.statusSince = createdAt;
  }

  emit(ev: TerminalEvent): void {
    for (const l of this.listeners) {
      try { l(ev); } catch { /* a broken screen never stops the others */ }
    }
  }
}

export class TerminalHost {
  private readonly sessions = new Map<string, Session>();
  private readonly workListeners = new Set<(cwd: string) => void>();
  private readonly o: Required<Omit<TerminalHostOptions, "launcher" | "now" | "floor" | "onExit" | "onRemove">> & { now: () => number };
  private helperChecked = false;

  constructor(private readonly opts: TerminalHostOptions) {
    this.o = {
      bufferBytes: opts.bufferBytes ?? DEFAULT_BUFFER_BYTES,
      scrollback: opts.scrollback ?? DEFAULTS.scrollback,
      snapshotScrollback: opts.snapshotScrollback ?? DEFAULTS.snapshotScrollback,
      idleAfterMs: opts.idleAfterMs ?? DEFAULTS.idleAfterMs,
      permissionTimeoutMs: opts.permissionTimeoutMs ?? DEFAULTS.permissionTimeoutMs,
      sizeReleaseMs: opts.sizeReleaseMs ?? DEFAULTS.sizeReleaseMs,
      killGraceMs: opts.killGraceMs ?? DEFAULTS.killGraceMs,
      now: opts.now ?? Date.now,
    };
  }

  /** Starts an agent. The terminal is listed from the moment it is made (a second resume of the same session finds it),
   *  while a companion starts; the program follows. */
  async spawn(req: { harness: TerminalHarness; cwd: string; model?: string; effort?: string; resume?: string; fork?: boolean; name?: string; mode?: PermissionMode; allowBypass?: boolean; cols?: number; rows?: number }): Promise<TerminalInfo> {
    if (!this.helperChecked) { ensureSpawnHelper(); this.helperChecked = true; }
    const id = randomUUID().slice(0, 8);
    const hookToken = randomBytes(24).toString("base64url");
    let plan: LaunchPlan;
    try {
      plan = this.opts.launcher({ id, harness: req.harness, cwd: req.cwd, hookToken, mode: req.mode ?? "manual", ...(req.allowBypass ? { allowBypass: true } : {}), ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}), ...(req.resume ? { resume: req.resume, ...(req.fork ? { fork: true } : {}) } : {}) });
    } catch (err) {
      this.ended(id, true);
      throw new TerminalError("unavailable", (err as Error).message);
    }
    const s = new Session(id, req.harness, req.cwd, req.model ?? null, req.mode ?? "manual", hookToken, this.o.now(), req.cols ?? 120, req.rows ?? 36, this.o.scrollback);
    s.hooks = plan.hooks;
    s.effort = req.effort ?? null;
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
        this.ended(id, true);
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
      this.ended(id, true);
      throw new TerminalError("unavailable", `could not start ${req.harness}: ${(err as Error).message}`);
    }
    s.proc = proc;
    proc.onData((data) => this.receive(s, data));
    proc.onExit(({ exitCode }) => this.exited(s, exitCode));
    s.companion?.attach({
      status: (status) => { if (status === "idle") this.turnEnded(s, true, null); this.setStatus(s, status); },
      ask: async (tool, input, signal) => (await this.ask(s, tool, input, signal))?.decision ?? null,
    });
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
      alternate: s.term.buffer.active.type === "alternate", cols: s.cols, rows: s.rows, kittyKeys: (s.kitty.at(-1) ?? 0) > 0 };
  }

  /** `by`: the screen asking, which owns the size from now on (a claim at the same size still changes the owner). */
  resize(id: string, cols: number, rows: number, by: string | null = null): void {
    const s = this.live(id);
    const same = cols === s.cols && rows === s.rows;
    if (same && by === s.sizedBy) return;
    s.sizedBy = by;
    if (!same) {
      s.cols = cols;
      s.rows = rows;
      s.quietUntil = this.o.now() + ECHO_MS;
      s.proc!.resize(cols, rows);
      s.term.resize(cols, rows);
    }
    s.emit({ type: "resize", cols, rows, by });
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

  /** Every event from `after` on: the output a screen missed when the buffer still has it, else a snapshot first.
   *  `screen`: the drawing screen's id; when the owner of the size stops following (the phone went to the background,
   *  the window closed), nobody owns it and the screens still there take it back (terminal-v0 §1 "离开就交还"). */
  subscribe(id: string, after: number | null, listener: Listener, screen: string | null = null): () => void {
    const s = this.need(id);
    const first = s.chunks[0]?.seq ?? s.seq + 1;
    if (after !== null && after >= first - 1 && after <= s.seq) {
      for (const c of s.chunks) if (c.seq > after) listener({ type: "output", seq: c.seq, data: c.data });
    } else {
      listener(this.snapshot(s));
      for (const c of s.chunks) if (c.seq > s.parsedSeq) listener({ type: "output", seq: c.seq, data: c.data });
    }
    listener({ type: "resize", cols: s.cols, rows: s.rows, by: s.sizedBy });
    listener({ type: "status", status: s.status });
    for (const p of s.pending.values()) listener({ type: "permission", request: p.ask });
    listener({ type: "permissions", requests: [...s.pending.values()].map((p) => p.ask) });
    if (s.status === "exited") listener({ type: "exit", code: s.exitCode });
    s.listeners.add(listener);
    if (screen) s.screens.set(screen, (s.screens.get(screen) ?? 0) + 1);
    return () => {
      s.listeners.delete(listener);
      if (!screen) return;
      const left = (s.screens.get(screen) ?? 1) - 1;
      if (left > 0) { s.screens.set(screen, left); return; }
      s.screens.delete(screen);
      // A little while first: the same screen reconnecting (a network blip, the phone fetching a fresh screen) keeps it.
      const release = () => {
        if (s.screens.has(screen) || s.sizedBy !== screen || s.status === "exited") return;
        s.sizedBy = null;
        s.emit({ type: "resize", cols: s.cols, rows: s.rows, by: null });
      };
      if (this.o.sizeReleaseMs > 0) setTimeout(release, this.o.sizeReleaseMs).unref();
      else release();
    };
  }

  /** A screen asks the agent in terminal `id` to change its model: typed as the agent's own command (`/model <id>`,
   *  which Claude Code takes without opening its picker). Claude Code alone: the other agents choose a model in a
   *  picker of their own. Not while it works (the command would wait in its queue as a message), nor while something
   *  waits for an answer. Claude Code keeps the choice as its default for new sessions, as its picker's Enter does. */
  askModel(id: string, model: string): void {
    const s = this.need(id);
    if (s.harness !== "claude-code") throw new TerminalError("invalid", "this agent chooses its model in its own picker");
    if (s.status === "exited") throw new TerminalError("exited", `terminal ${id} has ended`);
    if (s.status !== "idle" || s.pending.size) throw new TerminalError("busy", "the agent is at work or waits for an answer");
    s.modelAsked = { model, at: this.o.now() };
    this.write(id, replyBytes(`/model ${model}`, this.bracketedPaste(id), true));
  }

  /** A screen asks the agent in terminal `id` to think at another level: Claude Code's own command (`/effort <level>`),
   *  which it also takes while it works (the next request of the turn runs at it). Claude Code alone: Codex chooses in
   *  its `/model` picker, OpenCode in `/variants`, pi by a key. Not while something waits for an answer (the keys
   *  would go to that prompt). Claude Code keeps the level as that model's default for later sessions, `max` excepted. */
  askEffort(id: string, effort: string): void {
    const s = this.need(id);
    if (s.harness !== "claude-code") throw new TerminalError("invalid", "this agent chooses its level in its own picker");
    if (s.status === "exited") throw new TerminalError("exited", `terminal ${id} has ended`);
    if (s.status === "waiting" || s.pending.size) throw new TerminalError("busy", "the agent waits for an answer");
    this.write(id, replyBytes(`/effort ${effort}`, this.bracketedPaste(id), true));
  }

  /** A hook call from the agent in terminal `id`, proven by its hook token. Permission requests wait for a screen, or
   *  until `signal` aborts: the hook command went away, which happens when the request was answered in the terminal. */
  async hook(id: string, token: string, call: HookCall, signal?: AbortSignal): Promise<HookAnswer> {
    const s = this.sessions.get(id);
    if (!s || !same(token, s.hookToken)) throw new TerminalError("forbidden", "unknown terminal or hook token");
    const p = call.payload;
    if (typeof p.session_id === "string" && p.session_id) this.reported(s, p.session_id);
    // Where it works now (the window's title says it): Claude Code and Codex send it with every call.
    if (typeof p.cwd === "string" && p.cwd.startsWith("/") && p.cwd.length < 4096) s.agentCwd = p.cwd;
    // Claude Code says in every hook call made inside a sub-agent which one it is.
    const agentId = typeof p.agent_id === "string" && p.agent_id ? p.agent_id : null;
    // A change of model is not the agent going on: it says nothing of what waits on its screen.
    if (call.event === "PreModelSwitch") {
      const asked = s.modelAsked;
      s.modelAsked = null;
      // One a screen of ours asked for a moment ago: the user chose it there, so Claude Code does not ask again. Any
      // other (typed in the terminal) is Claude Code's to ask about or not.
      return asked && this.o.now() - asked.at < MODEL_ASK_MS ? { hookSpecificOutput: { hookEventName: "PreModelSwitch", permissionDecision: "allow" } } : null;
    }
    if (call.event === "PostModelSwitch") {
      const to = typeof p.to_model === "string" ? p.to_model.trim() : "";
      if (to && to.length <= 200 && to !== s.modelNow) { s.modelNow = to; s.emit({ type: "model", model: to }); }
      return null;
    }
    // The agent goes on: what waited for you on its screen was answered.
    if (call.event !== "SessionStart" && s.attention) { s.attention = false; if (s.status === "waiting" && !s.pending.size) this.setStatus(s, "working"); }
    switch (call.event) {
      // A request answered in the terminal itself leaves its hook waiting here (Claude Code does not end it): what the
      // agent does next tells us — the tool ran (PostToolUse), the turn ended (Stop), or the user typed on (UserPromptSubmit).
      case "SessionStart": this.noSubagents(s); this.setStatus(s, "idle"); return null;
      case "UserPromptSubmit": this.settleAll(s, "working"); this.setStatus(s, "working"); return null;
      case "Stop": this.settleAll(s, "idle"); this.noSubagents(s); this.turnEnded(s, true, p.last_assistant_message); this.setStatus(s, "idle"); return null;
      case "SubagentStart": if (agentId) this.subagentStarted(s, agentId, String(p.agent_type ?? "")); return null;
      case "SubagentStop": if (agentId && s.subagents.delete(agentId)) this.doing(s); return null;
      // Claude Code: the turn ended on an API error (a rate limit, overload, authentication…), which Stop does not say.
      case "StopFailure": {
        const error = [p.error, p.error_details].filter((x) => typeof x === "string" && x.trim()).join(": ");
        this.settleAll(s, "idle");
        this.noSubagents(s);
        this.turnEnded(s, false, error || "这一轮出错结束", true);
        this.setStatus(s, "idle");
        return null;
      }
      case "PreToolUse": {
        const input = (p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {}) as Record<string, unknown>;
        this.using(s, String(p.tool_name ?? ""), input);
        this.subagentUsing(s, agentId, String(p.agent_type ?? ""), String(p.tool_name ?? ""), input);
        this.setStatus(s, "working");
        const refused = this.opts.floor?.(String(p.tool_name ?? ""), input, s.cwd) ?? null;
        return refused ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refused } } : null;
      }
      case "PostToolUse": {
        this.workDone(s);
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
        const call = piTool(String(p.tool ?? ""), p.input);
        this.using(s, call.tool, call.input);
        this.setStatus(s, "working");
        const refused = this.opts.floor?.(call.tool, call.input, s.cwd) ?? null;
        return refused ? { block: true, reason: refused } : null;
      }
      case "PiAgentStart": this.setStatus(s, "working"); return null;
      case "PiAgentEnd": this.turnEnded(s, true, null); this.setStatus(s, "idle"); return null;
      // pi blocks on a question of its own (a confirm or a choice in its screen): the terminal waits for you.
      case "PiWaiting": this.setStatus(s, "waiting"); return null;
      case "CodexNotify": {
        if (typeof p["thread-id"] === "string" && p["thread-id"]) this.reported(s, p["thread-id"]);
        if (p.type === "agent-turn-complete") { this.turnEnded(s, true, p["last-assistant-message"]); this.setStatus(s, "idle"); }
        return null;
      }
      case "PermissionRequest": {
        const tool = String(p.tool_name ?? "tool");
        const input = p.tool_input ?? null;
        const reply = await this.ask(s, tool, input, signal);
        if (!reply) return null;   // nobody answered: the agent asks in the terminal
        if (reply.decision === "deny") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "在 AgentSwitch 上被拒绝。" } } };
        // A question's answers go back in the call's own input, as Claude Code's dialog puts them: an allow without
        // `updatedInput` it drops for a tool that asks the user itself, and its dialog would wait on (terminal-v0 §3).
        const updatedInput = reply.answers ? { ...(input as Record<string, unknown>), answers: reply.answers } : undefined;
        return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: updatedInput ? { behavior: "allow", updatedInput } : { behavior: "allow" } } };
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

  /** A screen's answer to a permission request; false when there is no such request (answered already). A question
   *  (AskUserQuestion) is allowed only with `picks`, its answers (checkPicks), and only a question takes them: else
   *  TerminalError "invalid". Deny stays open to a question, as esc in the terminal. */
  decide(id: string, permissionId: string, decision: PermissionDecision, picks?: Readonly<Record<string, QuestionPick>>): boolean {
    const s = this.need(id);
    const p = s.pending.get(permissionId);
    if (!p) return false;
    const { questions } = p.ask;
    if (picks && (decision !== "allow" || !questions)) throw new TerminalError("invalid", questions ? "answers go with allow" : "this request is not a question");
    if (!questions || decision === "deny") { this.settle(s, permissionId, { decision }); return true; }
    // An allow alone answers nothing (Claude Code drops it, its dialog waits): an older screen's [ allow ] says so.
    if (!picks) throw new TerminalError("invalid", "这个请求是 agent 的提问，需要选好答案再提交；请在终端里作答，或更新 AgentSwitch 应用。");
    const wrong = checkPicks(questions, picks);
    if (wrong) throw new TerminalError("invalid", wrong);
    const answers = Object.fromEntries(Object.entries(picks).map(([q, pick]) => [q, answerText(pick)]));
    this.settle(s, permissionId, { decision, answers });
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
    this.ended(id, true);
    return info;
  }

  /** Tells the owner of what was made for terminal `id` that its program ended, or (`removed`) that it is gone too. */
  private ended(id: string, removed: boolean): void {
    try {
      this.opts.onExit?.(id);
      if (removed) this.opts.onRemove?.(id);
    } catch (err) { console.error(`terminals: ending ${id}: ${(err as Error).message}`); }
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
    // Ending on an error by itself is a failed turn; one the service ended (close, quit) is not.
    if (code !== 0 && !s.killTimer) this.turnEnded(s, false, `进程退出（代码 ${code}）`, true);
    s.companion?.stop();
    for (const pid of [...s.pending.keys()]) this.settle(s, pid, null);
    this.noSubagents(s);
    this.setStatus(s, "exited");
    s.emit({ type: "exit", code });
    this.ended(s.id, false);
  }

  /** A turn ended: from work (a repeated Stop, a start-up idle is none), or `always` (the program exited on an error). */
  private turnEnded(s: Session, ok: boolean, said: unknown, always = false): void {
    this.workDone(s);
    if (!always && s.status !== "working" && s.status !== "waiting") return;
    const text = typeof said === "string" ? said.replace(/\s+/g, " ").trim() : "";
    s.lastTurn = { at: this.o.now(), ok, line: text.slice(0, 400) };
  }

  /** `listener` hears a terminal's folder when its agent finished a tool call or a turn there: something in it may have
   *  changed (the tree's git status looks again). Returns the way to stop listening. */
  onWorkDone(listener: (cwd: string) => void): () => void {
    this.workListeners.add(listener);
    return () => this.workListeners.delete(listener);
  }

  private workDone(s: Session): void {
    for (const listener of this.workListeners) listener(s.cwd);
  }

  /** How terminal `id`'s last turn ended (local only: the Mac's Live Activity). */
  lastTurn(id: string): TurnEnd | null {
    return this.sessions.get(id)?.lastTurn ?? null;
  }

  private ask(s: Session, tool: string, input: unknown, signal?: AbortSignal): Promise<PermissionReply | null> {
    if (s.status === "exited" || signal?.aborted) return Promise.resolve(null);
    const id = randomUUID().slice(0, 8);
    const questions = askQuestions(tool, input);
    const ask: PermissionAsk = { id, tool, summary: permissionSummary(tool, input), input, at: this.o.now(), ...(questions ? { questions } : {}) };
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
  private settle(s: Session, id: string, reply: PermissionReply | null, after?: TerminalStatus): void {
    const p = s.pending.get(id);
    if (!p) return;
    s.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(reply);
    const decision = reply?.decision ?? null;
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
    s.statusSince = this.o.now();
    if (status === "idle" || status === "exited") s.activity = null;
    s.emit({ type: "status", status });
    this.doing(s);
  }

  /** Tells the screens what it is doing now. */
  private doing(s: Session): void {
    s.emit({ type: "activity", activity: s.activity, subagents: [...s.subagents.values()] });
  }

  /** The tool the agent reports it is about to use, and what on (a command, a file, a page). */
  private using(s: Session, tool: string, input: unknown): void {
    if (!tool) return;
    const target = permissionTarget(tool, input).replace(/\s+/g, " ").trim();
    s.activity = { tool, target: target.length > MAX_SUMMARY ? `${target.slice(0, MAX_SUMMARY - 1)}…` : target, ...said(input) };
    this.doing(s);
  }

  /** A sub-agent at work: named by what the Agent tool call that started it was sent to do (the oldest waiting one of
   *  its kind, else the oldest), else by its kind. */
  private subagentStarted(s: Session, id: string, type: string): void {
    const now = this.o.now();
    s.launches = s.launches.filter((l) => now - l.at < LAUNCH_MS);
    const i = Math.max(s.launches.findIndex((l) => l.type === type), s.launches.length ? 0 : -1);
    const [launch] = i >= 0 ? s.launches.splice(i, 1) : [];
    s.subagents.set(id, { id, type: type || launch?.type || "agent", name: launch?.name || type || "agent", activity: null, since: now });
    this.doing(s);
  }

  /** A tool call: a sub-agent's own (what it is doing now; one not seen starting is taken in by its kind), or the
   *  agent sending one off (what it is to do, for its name). */
  private subagentUsing(s: Session, agentId: string | null, agentType: string, tool: string, input: Record<string, unknown>): void {
    if (agentId) {
      if (!s.subagents.has(agentId)) this.subagentStarted(s, agentId, agentType);
      const target = permissionTarget(tool, input).replace(/\s+/g, " ").trim();
      s.subagents.get(agentId)!.activity = { tool, target: target.length > MAX_SUMMARY ? `${target.slice(0, MAX_SUMMARY - 1)}…` : target, ...said(input) };
      this.doing(s);
      return;
    }
    if (tool !== "Agent" && tool !== "Task") return;
    const name = typeof input.description === "string" ? input.description.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "";
    const type = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general-purpose";
    s.launches = [...s.launches, { type, name, at: this.o.now() }].slice(-MAX_LAUNCHES);
  }

  /** The turn ended (or a new session began): its sub-agents with it. One still at work in the background comes back
   *  with its next tool call. */
  private noSubagents(s: Session): void {
    s.subagents.clear();
    s.launches = [];
  }

  /** The screen as a newly attached one needs it. The serializer restores mouse tracking but not how it reports:
   *  SGR (1006, which Claude Code turns on) is added back, or a desktop screen would send the wheel and clicks in the
   *  old byte form, which the page does not forward and the program does not read. */
  private snapshot(s: Session): TerminalEvent {
    // With the kitty keyboard protocol's flags too (a native screen encodes its keys by them; others ignore it).
    const kitty = s.kitty.at(-1) ?? 0;
    const data = s.ser.serialize({ scrollback: this.o.snapshotScrollback }) + (s.sgrMouse ? "\x1b[?1006h" : "") + (kitty ? `\x1b[>${kitty}u` : "");
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
      id: s.id, harness: s.harness, cwd: s.cwd, workdir: s.agentCwd ?? s.cwd, model: s.model, modelNow: s.modelNow, effort: s.effort, mode: s.mode, name: this.nameOf(s), customName: s.customName !== null, title: s.title,
      status: s.status, pid: s.proc?.pid ?? null,
      cols: s.cols, rows: s.rows, createdAt: s.createdAt, lastOutputAt: s.lastOutputAt, exitCode: s.exitCode,
      agentSessionId: s.agentSessionId, resumedFrom: s.resumedFrom, forked: s.forked, hooks: s.hooks, permissions: [...s.pending.values()].map((p) => p.ask),
      activity: s.activity, subagents: [...s.subagents.values()].map((a) => ({ ...a })), statusSince: s.statusSince, seq: s.seq,
    };
  }
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
