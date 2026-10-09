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
import { keySequence, replyBytes, type KeyContext } from "./keys.js";
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
  /** How it asks now, in its own word (`acceptEdits`, `plan` …), once anything says: a hook call's `permission_mode`,
   *  or its screen read after a change asked for here. Null before; `mode` is what it was started with. */
  readonly modeNow: string | null;
  /** What Claude Code offers as your next message (its prompt suggestion: dim words in its empty input), while it
   *  rests and shows one; null otherwise. It is on its screen and nowhere else (docs/simple-view-v0.md §5.6). */
  readonly suggestion: string | null;
  /** A screen can set its model and its level (`POST …/model`, `…/effort`): its agent takes a command for them, or a
   *  companion of this terminal sets them on the agent's own server. False for one that can only say what it is on (a
   *  Codex or an OpenCode started without its server). */
  readonly sets: boolean;
  /** Codex's Daybreak switch for the session it is on (docs/simple-view-v0.md §5.8): on, off; null where there is no
   *  such switch (another agent, a Codex without it, one that runs without its own server) or it has not been read. */
  readonly daybreak: boolean | null;
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
  /** The turn so far, as the agent's own screen counts it (`workingOnScreen`); null when it says nothing. */
  readonly progress: TurnProgress | null;
  /** Its sub-agents at work (Claude Code's SubagentStart … SubagentStop), in the order they started: the tree shows
   *  them under the terminal (docs/terminal-v0.md §1). */
  readonly subagents: readonly Subagent[];
  /** When the status last changed (the Live Activity's clock: working since, waiting since). */
  readonly statusSince: number;
  /** The profile it runs under (docs/profiles-v0.md): its id and its name as it was at the start; null: the
   *  Mac's own (`Default`). */
  readonly profile: { readonly id: string; readonly name: string; /** Where its own proxy let traffic out when this terminal was about to start (§4); absent: it has none, this Mac's way out. */ readonly exit?: { readonly ip: string; readonly place: string | null };
    /** The profile's colour, by its name in the palette (§3.2): the dot the screens mark this terminal with. */ readonly color?: string } | null;
  /** What the agent's own screen said to commands sent from a screen (`commanded`), the latest last. */
  readonly notices: readonly ScreenNotice[];
  /** A list to choose from that the agent's own screen shows now (`choicesOnScreen`); null when it shows none. */
  readonly choices: ScreenChoices | null;
  /** Replies a screen sent that the agent's record does not hold yet (`replied`): shown at once, as said. */
  readonly sent: readonly SentReply[];
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
  /** Codex's Daybreak switch stands otherwise now. */
  | { readonly type: "daybreak"; readonly on: boolean }
  /** It asks in another way now (its permission mode). */
  | { readonly type: "mode"; readonly mode: string }
  | { readonly type: "suggestion"; readonly text: string | null }
  /** What it is doing now changed (the tool, its sub-agents): for a screen that shows the record, not the terminal
   *  (docs/simple-view-v0.md §4). */
  | { readonly type: "activity"; readonly activity: TerminalInfo["activity"]; readonly subagents: readonly Subagent[] }
  /** Its screen answered a command sent from a screen: all that it has said to such commands, the latest last. */
  | { readonly type: "notices"; readonly notices: readonly ScreenNotice[] }
  /** The list its own screen shows to choose from changed (null: it shows none now). */
  | { readonly type: "choices"; readonly choices: ScreenChoices | null }
  /** The replies sent and not yet in the agent's record changed (one sent, one found there, one given up). */
  | { readonly type: "sent"; readonly replies: readonly SentReply[] }
  /** How far the turn has come changed (the count on the agent's own screen), or there is none now: for a screen that
   *  shows the record, beside what it is doing. */
  | { readonly type: "progress"; readonly progress: TurnProgress | null }
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
  /** The folder the agent keeps its sign-in in, for a profile other than the Mac's own (docs/profiles-v0.md §2);
   *  absent: the agent's default. */
  readonly configHome?: string;
  /** The proxy what the agent sends is to leave through: a forwarder of this service on this Mac (docs/profiles-v0.md
   *  §4), as an address with its name and password; absent: this Mac's own way out. */
  readonly proxy?: string;
  /** The profile's own browser, by its key, for the agent's browser tool and for the pages it asks the system to
   *  open (docs/profiles-v0.md §5.1); absent: the shared browser, and the system's own for those pages. */
  readonly browserKey?: string;
  /** What the agent is given as its first input, as if typed (Claude Code: `/login` for a profile nobody is signed
   *  in to, docs/profiles-v0.md §3.1); absent: it starts at its prompt. */
  readonly firstInput?: string;
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
  /** False: the companion reports no status (Codex's hooks do, as when it runs on its own), so whether the terminal
   *  has hooks stays as its plan said. Absent: it reports (OpenCode's server). */
  readonly reportsStatus?: boolean;
  /** Another model, or another level, for the session the program is on, where the companion can set them (OpenCode's
   *  server). What it is on afterwards; throws with a sentence a screen can show. */
  setModel?(want: { model?: string | null; variant?: string | null; session?: string | null }): Promise<{ model: string; variant: string | null }>;
  /** How a switch of the agent's own stands for the session the program is on, where the terminal has it (Codex's
   *  Daybreak, read from its server). The switch itself is turned in the program, by its own command. */
  daybreak?(session?: string | null): Promise<boolean>;
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
  /** Claude Code's screen is read for its compacting line this long after it drew (default 400 ms;
   *  docs/simple-view-v0.md §5.7). */
  readonly compactLookMs?: number;
  /** How often at most a working Claude Code's screen is read for its token count. */
  readonly progressLookMs?: number;
  /** How long after its screen drew it is read for a list to choose from. */
  readonly choiceLookMs?: number;
  /** How long a reply its record never took is still shown once the terminal is at rest. */
  readonly sentRestMs?: number;
  /** How long Codex is given to turn its Daybreak switch after its command was typed (default 5 s). */
  readonly daybreakWaitMs?: number;
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
/** `call`: the agent's own id of the tool call the request is for, where its hooks gave one (`Session.calls`). */
type Pending = { readonly ask: PermissionAsk; readonly resolve: (r: PermissionReply | null) => void; readonly timer: NodeJS.Timeout; readonly call?: string };
type Chunk = { readonly seq: number; readonly data: string };

const DEFAULT_BUFFER_BYTES = 2 * 1024 * 1024;
/** How long output counts as the program answering what was just sent (echo, a mouse move, a resize), not work. */
const ECHO_MS = 600;
/** The agents whose own prompt takes a command that sets the model or the level at once — Claude Code's `/model <id>`
 *  and `/effort <level>`, pi's `/model <provider/id>` and `/thinking <level>` — so a screen can change them. Codex and
 *  OpenCode choose in pickers of their own (docs/simple-view-v0.md §5.4). */
const DIRECT: ReadonlySet<string> = new Set(["claude-code", "pi"]);   // OpenCode: through its companion's server (`Companion.setModel`)
/** The screen is read for a suggestion once nothing has been drawn for this long. */
const SUGGEST_MS = 200;
/** What a terminal is doing while its agent compacts its context: the tool its `activity` names. */
const COMPACT_TOOL = "Compact";
/** Codex's server is asked how its Daybreak switch stands this long after its screen named it, and after the
 *  command that turns it was typed: this often, for this long. */
const DAYBREAK_LOOK_MS = 400;
/** A terminal's start waits this long at most for the first answer, and asks again after these. */
const DAYBREAK_FIRST_MS = 2000;
const DAYBREAK_AGAIN_MS = [2000, 6000];
const DAYBREAK_POLL_MS = 250;
const DAYBREAK_WAIT_MS = 5000;
/** After a hook said a compaction is over, a compacting line still on the screen is not believed for this long. */
const COMPACT_GRACE_MS = 1500;
const DEFAULTS = { scrollback: 5000, snapshotScrollback: 1000, idleAfterMs: 3000, compactLookMs: 400, progressLookMs: 1000, choiceLookMs: 250, sentRestMs: 5000, permissionTimeoutMs: 30 * 60_000, killGraceMs: 3000, sizeReleaseMs: 3000 };
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

/** Claude Code's permission modes, in its own words, and the one the line under its input names (2.1.292 says
 *  `accept edits on`, `plan mode on`, `auto mode on`, `bypass permissions on`; none of them: it asks each time). Read
 *  from the screen's last lines, the newest first: an older line that scrolled up does not count over a newer one. */
export const CLAUDE_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;
export type ClaudeMode = (typeof CLAUDE_MODES)[number];
export function modeOnScreen(lines: readonly string[]): ClaudeMode {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.toLowerCase();
    if (line.includes("bypass permissions on")) return "bypassPermissions";
    if (line.includes("accept edits on")) return "acceptEdits";
    if (line.includes("plan mode on")) return "plan";
    if (line.includes("auto mode on")) return "auto";
    // Asking each time: "manual mode on" where its footer names the mode (seen on 2.1.292 with a status line set),
    // its hint for the shortcuts where it names none.
    if (line.includes("manual mode on") || line.includes("? for shortcuts")) return "default";
  }
  return "default";
}

/** One row of a screen for `suggestionOnScreen`: its text, and for each character whether it is drawn dim. */
export type ScreenRow = { readonly text: string; readonly dim: readonly boolean[] };

/** Claude Code's own line while it compacts its context, as its screen draws it: at the row's start one of the
 *  glyphs its spinner turns through, the words, and soon a clock — `✻ Compacting conversation… (1m 5s · ↓ 3.3k tokens)`
 *  (seen on 2.1.292, scripts/claude_compact_probe.ts; the glyphs are its program's). The words anywhere else are not
 *  it: an answer's lines begin with its bullet or are indented, as what you typed begins with `❯` — a terminal whose
 *  record quotes this line must not look as if it compacted for as long as the quote is on its screen. */
export function compactingOnScreen(lines: readonly string[]): boolean {
  return lines.some((line) => /^[·✢✳✶✻✽*]\s+Compacting conversation(?:…|\.{3})?(?:\s+\([^)]*\)?)?\s*$/u.test(line));
}

/** One of an agent's own commands, as its own list of them names and describes it. */
export type ListedCommand = { readonly name: string; readonly description: string };

/** The rows of the list an agent pops up when `/` is typed into its empty input: `/model   choose what model…`, the
 *  selected one with its mark (Codex) or not (Claude Code). The input's own row (`› /`) has no words after the name. */
export function commandRows(lines: readonly string[]): ListedCommand[] {
  const out: ListedCommand[] = [];
  for (const line of lines) {
    const m = /^\s*(?:[│|]\s*)?(?:[›❯>]\s+)?\/([A-Za-z0-9][\w:.-]{0,60})\s{2,}(\S.*?)\s*(?:[│|]\s*)?$/u.exec(line);
    if (m) out.push({ name: m[1]!, description: m[2]!.replace(/\s+/g, " ").slice(0, 300) });
  }
  return out;
}

/** The agent's input line is on the screen and holds nothing typed: its mark, then nothing or only its dim words (a
 *  placeholder, what it suggests). Rows from `screenRows`. */
export function inputEmpty(rows: readonly ScreenRow[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const m = /^\s*(?:[│|]\s*)?[›❯](?:\s|$)/u.exec(row.text);
    if (!m) continue;
    for (let x = m[0].length; x < row.text.length; x++) if (row.text[x]!.trim() && !row.dim[x] && !/[│|]/.test(row.text[x]!)) return false;
    return true;
  }
  return false;
}
const COMMAND_STEP_MS = 90;
const COMMAND_STEPS = 60;
const COMMAND_STILL = 5;

/** What an agent's screen said to one of its own commands (`/daybreak` → `Daybreak off. Applies to new turns.`,
 *  `/model` → `Model changed to gpt-6-sol high`). The agent writes such lines on its screen and not into its record,
 *  so a screen that shows the record had nothing to show for the command (2026-10-08, user: 我输入/daybreak都没反应
 *  然后cli有回应 简略界面没反应). */
export type ScreenNotice = { readonly id: string; readonly text: string; readonly at: number };
const MAX_NOTICES = 8;
const NOTICE_LOOKS_MS = [500, 1500];

/** The lines `after` has that `before` had not, above the agent's input line: what a command printed. Each without
 *  its bullet; rules, the echo of what was typed and blank lines left out. */
export function printedSince(before: readonly string[], after: readonly string[]): string {
  const had = new Set(before.map((l) => l.trim()));
  let end = after.length;
  for (let i = after.length - 1; i >= 0; i--) if (/^\s*(?:[│|]\s*)?[›❯>](?:\s|$)/u.test(after[i]!)) { end = i; break; }
  return after.slice(0, end)
    .filter((l) => l.trim() && !had.has(l.trim()) && !/^[\s─━╭╮╰╯│|]+$/u.test(l) && !/^\s*[›❯>]\s/u.test(l))
    .map((l) => l.replace(/^\s*(?:[•⏺●]|⎿)\s*/u, "").trim())
    .filter(Boolean).slice(-6).join("\n").slice(0, 600);
}

/** A list the agent draws on its own screen and waits on — Codex's `/model` (its models, then how hard each thinks),
 *  Claude Code's or Codex's question whether to trust a folder, any menu of theirs: numbered rows, one of them marked
 *  as where the selection stands. A screen that shows the record offers the same rows; taking one moves the selection
 *  there with the arrow keys and enters it, as in the terminal (2026-10-08, user: /model直接在简略视图里出一个列表让我
 *  可以点就行了，逻辑和和在cli一致). */
export type ScreenChoices = { readonly title: string; readonly options: readonly { readonly label: string; readonly detail?: string }[]; readonly selected: number };

const CHOICE_ROW = /^\s*(?:[│|]\s*)?(?:([›❯>▶])\s+)?(\d{1,2})[.)]\s+(\S.*?)\s*(?:[│|]\s*)?$/u;
const MAX_CHOICES = 40;

/** The list on the screen's last rows, if it shows one: rows numbered 1, 2, 3… in order (a row between two of them
 *  that has no number continues the one above), exactly one with the selection's mark before its number, and the
 *  nearest line above them as what is asked. Numbered lines in an answer have no such mark: not a list to choose from. */
export function choicesOnScreen(lines: readonly string[]): ScreenChoices | null {
  let end = -1;
  for (let i = lines.length - 1; i >= 0 && end < 0; i--) if (CHOICE_ROW.test(lines[i]!)) end = i;
  if (end < 0) return null;
  const rows: { at: number; n: number; marked: boolean; text: string }[] = [];
  for (let i = end; i >= 0 && end - i < 4 * MAX_CHOICES; i--) {
    const m = CHOICE_ROW.exec(lines[i]!);
    if (!m) { if (!lines[i]!.trim()) break; continue; }
    rows.unshift({ at: i, n: Number(m[2]), marked: !!m[1], text: m[3]! });
    if (Number(m[2]) === 1) break;
  }
  if (!rows.length || rows.length > MAX_CHOICES || rows.some((r, i) => r.n !== i + 1) || rows.filter((r) => r.marked).length !== 1) return null;
  // A single row is a list only where the screen says under it how to take it (Codex: `enter select · esc back`);
  // by itself it may be what you typed after your own prompt mark.
  if (rows.length === 1 && !lines.slice(end + 1, end + 5).some((l) => /\benter\b.*\b(select|confirm)|\besc\b.*\b(back|cancel)/i.test(l))) return null;
  let title = "";
  for (let i = rows[0]!.at - 1; i >= 0 && i >= rows[0]!.at - 4 && !title; i--) title = lines[i]!.replace(/^[\s│|╭╰─]+|[\s│|╮╯─]+$/gu, "").trim();
  const options = rows.map((r) => {
    const [label, ...rest] = r.text.split(/\s{2,}/);
    const detail = rest.join(" ").trim();
    return { label: label!.trim().slice(0, 200), ...(detail ? { detail: detail.slice(0, 300) } : {}) };
  });
  return { title: title.slice(0, 300), options, selected: rows.findIndex((r) => r.marked) };
}

/** A reply a screen sent, kept until the agent's own record holds it. The record is what the screens show, and a
 *  message reaches it late: the agent writes it down only as its turn begins — seconds after, for a session's first —
 *  and one sent while it works is not written down until it is taken (Codex). Meanwhile it is at work with nothing
 *  on the screens of what it was told (2026-10-08, user: 有的时候简略视图我发送一个消息对方开始working了我的消息还没渲染出来).
 *  `files`: how many files went with it (their places in its text read otherwise in the record). */
export type SentReply = { readonly id: string; readonly text: string; readonly at: number; readonly files: number };
/** Kept at most this many, each for at most this long, and not past this long at rest: what never became a message
 *  (an answer typed into a question on the agent's own screen) leaves with the turn. */
const MAX_SENT = 6;
/** Tool calls remembered as begun, at most (each turn's end forgets them all). */
const MAX_OPEN_CALLS = 200;
const SENT_KEEP_MS = 15 * 60_000;
const MAX_SENT_CHARS = 4_000;

/** How far a turn has come, as the agent's own screen counts it: the tokens that have come from the model (`down`) or
 *  gone to it (`up`). The screens show it beside "Working": a number that moves says it is not stuck (2026-10-08, user:
 *  working 建议加上token数量，不然都不知道是不是卡死了). */
export type TurnProgress = { readonly tokens: number; readonly way: "down" | "up" };

/** Claude Code's line while it works, as its screen draws it: one of its spinner's glyphs at the row's start, a word
 *  of its own, and in brackets how long and how many tokens — `✻ Pondering… (1m 5s · ↓ 3.3k tokens · esc to interrupt)`
 *  (seen on 2.1.292, scripts/claude_working_probe.ts). Read for the tokens alone: the count and its arrow. Null when
 *  no such line is on screen or it names no tokens yet (the first seconds of a turn). As with `compactingOnScreen`,
 *  only a row that begins with the glyph: an answer that quotes such a line is indented or begins with its bullet. */
export function workingOnScreen(lines: readonly string[]): TurnProgress | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = /^[·✢✳✶✻✽*]\s+\S[^()]*\((.*)\)\s*$/u.exec(lines[i]!);
    if (!row) continue;
    const said = /(?:^|[\s·])([↑↓])\s*(\d+(?:\.\d+)?)\s*([kKmM])?\s+tokens?\b/u.exec(row[1]!);
    if (!said) return null;
    const scale = said[3] ? (said[3].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
    return { tokens: Math.round(Number(said[2]) * scale), way: said[1] === "↑" ? "up" : "down" };
  }
  return null;
}

/** Claude Code's prompt suggestion, read off the last rows of its screen (docs/simple-view-v0.md §5.6). Its input is
 *  the line that begins `❯ `; empty, it shows what it offers as your next message in dim letters (seen on 2.1.292,
 *  scripts/claude_suggestion_probe.ts: `❯ ⟦add both⟧`). What you typed there is not dim, so it is never taken for one;
 *  nor are the examples it shows before the first message (`Try "…"`). Null: no input line in these rows, an empty
 *  one, or one with typing in it. */
export function suggestionOnScreen(rows: readonly ScreenRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (!/^❯[ \u00a0]/.test(row.text)) continue;
    const said = row.text.slice(2);
    if (!said.trim()) return null;
    for (let x = 2; x < row.text.length; x++) if (row.text[x]!.trim() && !row.dim[x]) return null;
    const text = said.trim().replace(/\s+/g, " ");
    return /^Try "|^Press /.test(text) || text.length > 300 ? null : text;
  }
  return null;
}

/** The last `count` rows of a screen with anything on them, each with which of its characters are dim. */
export function screenRows(term: { readonly rows: number; readonly cols: number; readonly buffer: { readonly active: import("@xterm/headless").IBuffer } }, count = 10): ScreenRow[] {
  const buffer = term.buffer.active;
  const out: ScreenRow[] = [];
  for (let y = buffer.baseY + term.rows - 1; y >= buffer.baseY && out.length < count; y--) {
    const line = buffer.getLine(y);
    if (!line) continue;
    let text = "";
    const dim: boolean[] = [];
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      const chars = cell.getChars();
      if (!chars && cell.getWidth() === 0) continue;   // the second half of a wide character
      for (const ch of chars || " ") { text += ch; dim.push(!!cell.isDim()); }
    }
    if (text.trim()) out.unshift({ text: text.replace(/\s+$/, ""), dim });
  }
  return out;
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
  /** Tool calls begun and not yet done, by the agent's own id for each (Claude Code's `tool_use_id`, in PreToolUse
   *  and PostToolUse but not in PermissionRequest — seen on 2.1.293, scripts/claude_working_probe.ts): which call a
   *  request is for, so that another call of the same tool ending does not answer it. */
  readonly calls = new Map<string, { tool: string; input: string }>();
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
  modeNow: string | null = null;
  suggestion: string | null = null;
  suggestTimer: NodeJS.Timeout | null = null;
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
  /** A hook call of the agent's has named its session (Codex's turn-end notice names a thread, which may be a helper's). */
  sessionByHook = false;
  /** The session this terminal started (a new one, or a fork's): the only record closing it may delete. */
  ownSessionId: string | null = null;
  hooks = false;
  companion: Companion | null = null;
  /** The agent said something on its screen waits for you (Codex's notification: an approval, an app's form, a
   *  question); until it goes on (a hook event) or, without hooks, until you type. */
  attention = false;
  idleTimer: NodeJS.Timeout | null = null;
  /** It compacts its context (its screen says so): what it was before — at rest (you asked for it) or at work (its
   *  context filled up in the middle of a turn) — and goes back to after; null when it does not. */
  compactFrom: "idle" | "working" | null = null;
  /** When a hook last said a compaction was over. */
  compactEndedAt = 0;
  compactTimer: NodeJS.Timeout | null = null;
  profile: { id: string; name: string; exit?: { ip: string; place: string | null }; color?: string } | null = null;
  /** Its profile's own browser, by its key (docs/profiles-v0.md §5.1); null: the shared one. */
  browserKey: string | null = null;
  /** What its screen said to commands sent from a screen (`commanded`). */
  notices: ScreenNotice[] = [];
  /** The program it runs (the launcher's), for what is learned of that program (`learnCommands`). */
  program = "";
  learning = false;
  /** The list its screen shows to choose from (`choiceLooks`). */
  choices: ScreenChoices | null = null;
  choiceTimer: NodeJS.Timeout | null = null;
  /** Replies sent and not yet in its record (`replied`), the oldest first; the timer that gives them up at rest. */
  sent: SentReply[] = [];
  sentTimer: NodeJS.Timeout | null = null;
  /** The turn so far, off its screen (`progressLooks`). */
  progress: TurnProgress | null = null;
  progressTimer: NodeJS.Timeout | null = null;
  /** Codex's Daybreak switch as last read from its server; null: no switch, or not read yet. */
  daybreak: boolean | null = null;
  daybreakTimer: NodeJS.Timeout | null = null;
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
  /** Each program's own commands, by its kind and path, as read off a terminal running it. */
  private readonly learned = new Map<string, readonly ListedCommand[]>();
  private readonly o: Required<Omit<TerminalHostOptions, "launcher" | "now" | "floor" | "onExit" | "onRemove">> & { now: () => number };
  private helperChecked = false;

  constructor(private readonly opts: TerminalHostOptions) {
    this.o = {
      bufferBytes: opts.bufferBytes ?? DEFAULT_BUFFER_BYTES,
      scrollback: opts.scrollback ?? DEFAULTS.scrollback,
      snapshotScrollback: opts.snapshotScrollback ?? DEFAULTS.snapshotScrollback,
      idleAfterMs: opts.idleAfterMs ?? DEFAULTS.idleAfterMs,
      compactLookMs: opts.compactLookMs ?? DEFAULTS.compactLookMs,
      progressLookMs: opts.progressLookMs ?? DEFAULTS.progressLookMs,
      sentRestMs: opts.sentRestMs ?? DEFAULTS.sentRestMs,
      choiceLookMs: opts.choiceLookMs ?? DEFAULTS.choiceLookMs,
      daybreakWaitMs: opts.daybreakWaitMs ?? DAYBREAK_WAIT_MS,
      permissionTimeoutMs: opts.permissionTimeoutMs ?? DEFAULTS.permissionTimeoutMs,
      sizeReleaseMs: opts.sizeReleaseMs ?? DEFAULTS.sizeReleaseMs,
      killGraceMs: opts.killGraceMs ?? DEFAULTS.killGraceMs,
      now: opts.now ?? Date.now,
    };
  }

  /** Starts an agent. The terminal is listed from the moment it is made (a second resume of the same session finds it),
   *  while a companion starts; the program follows. */
  async spawn(req: { harness: TerminalHarness; cwd: string; model?: string; effort?: string; resume?: string; fork?: boolean; name?: string; mode?: PermissionMode; allowBypass?: boolean; cols?: number; rows?: number; profile?: { id: string; name: string; home: string; proxy?: string; exit?: { ip: string; place: string | null }; browserKey?: string; color?: string }; firstInput?: string }): Promise<TerminalInfo> {
    if (!this.helperChecked) { ensureSpawnHelper(); this.helperChecked = true; }
    const id = randomUUID().slice(0, 8);
    const hookToken = randomBytes(24).toString("base64url");
    let plan: LaunchPlan;
    try {
      plan = this.opts.launcher({ id, harness: req.harness, cwd: req.cwd, hookToken, mode: req.mode ?? "manual", ...(req.profile ? { configHome: req.profile.home, ...(req.profile.proxy ? { proxy: req.profile.proxy } : {}), ...(req.profile.browserKey ? { browserKey: req.profile.browserKey } : {}) } : {}), ...(req.firstInput ? { firstInput: req.firstInput } : {}), ...(req.allowBypass ? { allowBypass: true } : {}), ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}), ...(req.resume ? { resume: req.resume, ...(req.fork ? { fork: true } : {}) } : {}) });
    } catch (err) {
      this.ended(id, true);
      throw new TerminalError("unavailable", (err as Error).message);
    }
    const s = new Session(id, req.harness, req.cwd, req.model ?? null, req.mode ?? "manual", hookToken, this.o.now(), req.cols ?? 120, req.rows ?? 36, this.o.scrollback);
    s.hooks = plan.hooks;
    s.profile = req.profile ? { id: req.profile.id, name: req.profile.name, ...(req.profile.exit ? { exit: req.profile.exit } : {}), ...(req.profile.color ? { color: req.profile.color } : {}) } : null;
    s.browserKey = req.profile?.browserKey ?? null;
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
      if (started) { ({ args, env } = started); if (plan.companion.reportsStatus !== false) s.hooks = true; s.companion = plan.companion; }
      else plan.companion.stop();
    }
    let proc: pty.IPty;
    try {
      s.program = plan.file;
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
    const daybreak = s.companion?.daybreak?.bind(s.companion);
    if (daybreak) {
      // How its switch stands as it starts: how its new sessions start, until its TUI has made its thread or loaded
      // the one it goes on with — asked again once that has had time (a session resumed keeps its own choice, and
      // says nothing on its screen when that is off).
      s.daybreak = await Promise.race([daybreak(null).catch(() => null), new Promise<null>((r) => { setTimeout(() => r(null), DAYBREAK_FIRST_MS).unref(); })]);
      for (const ms of DAYBREAK_AGAIN_MS) setTimeout(() => this.daybreakLooks(s, 0), ms).unref();
    }
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
  /** A profile's colour was changed: the terminals open under it carry the new one (docs/profiles-v0.md §3.2). */
  recolor(harness: TerminalHarness, profile: string, color: string): void {
    for (const s of this.sessions.values()) if (s.harness === harness && s.profile?.id === profile) s.profile = { ...s.profile, color };
  }

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
  async askModel(id: string, model: string): Promise<void> {
    const s = this.need(id);
    if (s.companion?.setModel) { await this.switched(s, { model }); return; }
    if (!DIRECT.has(s.harness)) throw new TerminalError("invalid", "this agent chooses its model in its own picker");
    if (s.status === "exited") throw new TerminalError("exited", `terminal ${id} has ended`);
    if (s.status !== "idle" || s.pending.size) throw new TerminalError("busy", "the agent is at work or waits for an answer");
    if (s.harness === "claude-code") s.modelAsked = { model, at: this.o.now() };
    this.write(id, replyBytes(`/model ${model}`, this.bracketedPaste(id), true));
    // pi says nothing of its model to the service: the one asked for is taken as the one it is on (its own line
    // says "Model: …"; an id it does not know leaves it where it was, and the screens list only its own ids).
    if (s.harness === "pi" && s.modelNow !== model) { s.modelNow = model; s.emit({ type: "model", model }); }
  }

  /** A screen asks the agent in terminal `id` to think at another level: Claude Code's own command (`/effort <level>`),
   *  which it also takes while it works (the next request of the turn runs at it). Claude Code alone: Codex chooses in
   *  its `/model` picker, OpenCode in `/variants`, pi by a key. Not while something waits for an answer (the keys
   *  would go to that prompt). Claude Code keeps the level as that model's default for later sessions, `max` excepted. */
  async askEffort(id: string, effort: string): Promise<void> {
    const s = this.need(id);
    if (s.companion?.setModel) { await this.switched(s, { variant: effort }); return; }
    if (!DIRECT.has(s.harness)) throw new TerminalError("invalid", "this agent chooses its level in its own picker");
    if (s.status === "exited") throw new TerminalError("exited", `terminal ${id} has ended`);
    if (s.status === "waiting" || s.pending.size) throw new TerminalError("busy", "the agent waits for an answer");
    if (s.harness === "pi") {
      // pi's command is `/thinking <level>` (seen on 0.87.1: "Thinking level: xhigh"); typed while it works it would
      // be a message to it, so only while it rests. The level it is at now is what a screen reads as its level.
      if (s.status !== "idle") throw new TerminalError("busy", "the agent is at work");
      this.write(id, replyBytes(`/thinking ${effort}`, this.bracketedPaste(id), true));
      s.effort = effort;
      return;
    }
    this.write(id, replyBytes(`/effort ${effort}`, this.bracketedPaste(id), true));
  }

  /** A screen turns Codex's Daybreak switch (docs/simple-view-v0.md §5.8). Its TUI holds the switch — a change made
   *  on its server alone it does not follow — so its own command is typed, `/daybreak`, which only flips: typed when
   *  the switch stands otherwise than asked, and then its server is asked until it says so. Codex takes the command
   *  while it works too (it holds from the next turn); not while something waits for an answer, where the keys
   *  would go. Codex itself keeps the choice as how its new sessions start. Returns how it stands. */
  async askDaybreak(id: string, on: boolean): Promise<boolean> {
    const s = this.need(id);
    const read = s.companion?.daybreak?.bind(s.companion);
    if (!read) throw new TerminalError("invalid", "this terminal has no Daybreak switch");
    if (s.status === "exited") throw new TerminalError("exited", `terminal ${id} has ended`);
    if (s.status === "waiting" || s.pending.size) throw new TerminalError("busy", "the agent waits for an answer");
    const ask = async (): Promise<boolean> => { try { return await read(s.agentSessionId); } catch (err) { throw new TerminalError("invalid", (err as Error).message); } };
    let now = await ask();
    if (now !== on) {
      this.write(id, replyBytes("/daybreak", this.bracketedPaste(id), true));
      for (const end = this.o.now() + this.o.daybreakWaitMs; now !== on && this.o.now() < end; ) {
        await new Promise((r) => setTimeout(r, DAYBREAK_POLL_MS));
        if (!this.sessions.has(id) || (s.status as TerminalStatus) === "exited") throw new TerminalError("exited", `terminal ${id} has ended`);
        now = await ask();
      }
    }
    this.daybreakIs(s, now);
    if (now !== on) throw new TerminalError("busy", "Codex did not turn it: its screen says why");
    return now;
  }

  private daybreakIs(s: Session, on: boolean): void {
    if (s.daybreak === on) return;
    s.daybreak = on;
    s.emit({ type: "daybreak", on });
  }

  /** Asks the terminal's companion how the switch stands, a moment from now (once, however often it is asked for):
   *  when the terminal starts, when its screen names the switch (it was turned there, or says how it begins), when a
   *  turn ends. What cannot be read leaves what was read before. */
  private daybreakLooks(s: Session, inMs = DAYBREAK_LOOK_MS): void {
    const read = s.companion?.daybreak?.bind(s.companion);
    if (!read || s.daybreakTimer || s.status === "exited") return;
    s.daybreakTimer = setTimeout(() => {
      s.daybreakTimer = null;
      if (!this.sessions.has(s.id) || s.status === "exited") return;
      read(s.agentSessionId).then((on) => { if (this.sessions.has(s.id)) this.daybreakIs(s, on); }, () => undefined);
    }, inMs);
    s.daybreakTimer.unref();
  }

  /** A model or a level set through the terminal's companion (OpenCode: on its own server, which its TUI follows):
   *  while it rests, as the others; what it is on afterwards is what the screens are told. */
  private async switched(s: Session, want: { model?: string; variant?: string }): Promise<void> {
    if (s.status === "exited") throw new TerminalError("exited", `terminal ${s.id} has ended`);
    if (s.status !== "idle" || s.pending.size) throw new TerminalError("busy", "the agent is at work or waits for an answer");
    let now: { model: string; variant: string | null };
    try { now = await s.companion!.setModel!({ ...want, session: s.agentSessionId }); } catch (err) { throw new TerminalError("invalid", (err as Error).message); }
    if (now.model !== s.modelNow) { s.modelNow = now.model; s.emit({ type: "model", model: now.model }); }
    s.effort = now.variant;
  }

  /** What Claude Code offers as the next message, looked for once its screen has been still a moment: only while
   *  it rests (at work its input shows other things), and gone the moment it works again. */
  private suggests(s: Session): void {
    if (s.harness !== "claude-code") return;
    if (s.status !== "idle") { this.suggestionIs(s, null); return; }
    if (s.suggestTimer) clearTimeout(s.suggestTimer);
    s.suggestTimer = setTimeout(() => {
      s.suggestTimer = null;
      if (s.status === "idle" && this.sessions.has(s.id)) this.suggestionIs(s, suggestionOnScreen(screenRows(s.term)));
    }, SUGGEST_MS);
    s.suggestTimer.unref();
  }

  private suggestionIs(s: Session, text: string | null): void {
    if (s.suggestTimer && text === null) { clearTimeout(s.suggestTimer); s.suggestTimer = null; }
    if (text === s.suggestion) return;
    s.suggestion = text;
    s.emit({ type: "suggestion", text });
  }

  private modeIs(s: Session, mode: string): void {
    if (mode === s.modeNow) return;
    s.modeNow = mode;
    s.emit({ type: "mode", mode });
  }

  /** The last `rows` lines of the terminal's screen that have anything on them, as text (top to bottom). */
  screenTail(id: string, rows = 10): string[] {
    const s = this.need(id);
    const buffer = s.term.buffer.active;
    const out: string[] = [];
    for (let y = buffer.baseY + s.term.rows - 1; y >= buffer.baseY && out.length < rows; y--) {
      const text = buffer.getLine(y)?.translateToString(true).trimEnd() ?? "";
      if (text.trim()) out.unshift(text);
    }
    return out;
  }

  /** A screen asks the Claude Code in terminal `id` to ask in another way (docs/simple-view-v0.md §5.4 “换模式”). It
   *  has no command for a mode: ⇧Tab steps through the ones this session offers, and the line under its input names
   *  the one it is in. So the key is pressed and that line read, until it names `mode` — or it is back where it began
   *  (the session does not offer that mode: one started without skipping permissions never reaches it). While it
   *  rests only: the key would go to whatever else has the screen. Resolves to the mode it is in afterwards. */
  async askMode(id: string, mode: ClaudeMode, o: { stepMs?: number; waitMs?: number } = {}): Promise<ClaudeMode> {
    const s = this.need(id);
    if (s.harness !== "claude-code") throw new TerminalError("invalid", "this agent chooses how it asks on its own screen");
    if (s.status === "exited") throw new TerminalError("exited", `terminal ${id} has ended`);
    if (s.status !== "idle" || s.pending.size) throw new TerminalError("busy", "the agent is at work or waits for an answer");
    const step = o.stepMs ?? 80, wait = o.waitMs ?? 1500;
    const read = (): ClaudeMode => modeOnScreen(this.screenTail(id));
    const began = read();
    let now = began;
    for (let press = 0; now !== mode && press < CLAUDE_MODES.length + 1; press++) {
      this.write(id, "\x1b[Z");
      const was = now;
      for (let waited = 0; waited < wait && now === was; waited += step) {
        await new Promise((r) => setTimeout(r, step));
        if (!this.sessions.has(id) || (s.status as TerminalStatus) === "exited") throw new TerminalError("exited", `terminal ${id} has ended`);
        now = read();
      }
      // The key did nothing its screen shows: something else has the keyboard there.
      if (now === was) throw new TerminalError("busy", "its screen did not take the key");
      if (now === began) break;
    }
    this.modeIs(s, now);
    if (now !== mode) throw new TerminalError("invalid", `this session does not offer ${mode}`);
    return now;
  }

  /** The browser of its own that terminal `id` runs with (its key), for a call proven by the terminal's hook token;
   *  null: it has none. Throws for a terminal or a token that is not there. */
  browserOf(id: string, token: string): string | null {
    const s = this.sessions.get(id);
    if (!s || !same(token, s.hookToken)) throw new TerminalError("forbidden", "unknown terminal or hook token");
    return s.browserKey;
  }

  /** A hook call from the agent in terminal `id`, proven by its hook token. Permission requests wait for a screen, or
   *  until `signal` aborts: the hook command went away, which happens when the request was answered in the terminal. */
  async hook(id: string, token: string, call: HookCall, signal?: AbortSignal): Promise<HookAnswer> {
    const s = this.sessions.get(id);
    if (!s || !same(token, s.hookToken)) throw new TerminalError("forbidden", "unknown terminal or hook token");
    const p = call.payload;
    if (typeof p.session_id === "string" && p.session_id) { this.reported(s, p.session_id); s.sessionByHook = true; }
    // How it asks now: Claude Code says it with every call.
    if (typeof p.permission_mode === "string" && /^[A-Za-z]{2,40}$/.test(p.permission_mode)) this.modeIs(s, p.permission_mode);
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
    // It was compacting its context (docs/simple-view-v0.md §5.7): anything the main agent says means that is over —
    // the SessionStart that follows a compaction, or it going on with its turn. (Sub-agents stop meanwhile: not that.)
    if (s.compactFrom && !agentId) { this.compacts(s, false); s.compactEndedAt = this.o.now(); }
    // The agent goes on: what waited for you on its screen was answered.
    if (call.event !== "SessionStart" && s.attention) { s.attention = false; if (s.status === "waiting" && !s.pending.size) this.setStatus(s, "working"); }
    switch (call.event) {
      // A request answered in the terminal itself leaves its hook waiting here (Claude Code does not end it): what the
      // agent does next tells us — the tool ran (PostToolUse), the turn ended (Stop), or the user typed on (UserPromptSubmit).
      case "SessionStart":
        // The one after a compaction is the same session going on: in the middle of a turn it is still at work, and
        // its sub-agents with it.
        if (p.source === "compact") return null;
        this.noSubagents(s); this.setStatus(s, "idle"); return null;
      case "UserPromptSubmit": this.settleAll(s, "working"); s.calls.clear(); this.progressed(s, null); this.setStatus(s, "working"); return null;
      case "Stop": this.settleAll(s, "idle"); s.calls.clear(); this.noSubagents(s); this.turnEnded(s, true, p.last_assistant_message); this.setStatus(s, "idle"); this.daybreakLooks(s); return null;
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
        if (typeof p.tool_use_id === "string" && p.tool_use_id) {
          if (s.calls.size >= MAX_OPEN_CALLS) s.calls.clear();
          s.calls.set(p.tool_use_id, { tool: String(p.tool_name ?? ""), input: JSON.stringify(p.tool_input ?? null) });
        }
        this.using(s, String(p.tool_name ?? ""), input);
        this.subagentUsing(s, agentId, String(p.agent_type ?? ""), String(p.tool_name ?? ""), input);
        // A sub-agent going on beside a request that waits for you leaves the terminal waiting for you.
        if (!(agentId && s.pending.size)) this.setStatus(s, "working");
        const refused = this.opts.floor?.(String(p.tool_name ?? ""), input, s.cwd) ?? null;
        return refused ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refused } } : null;
      }
      case "PostToolUse": {
        this.workDone(s);
        const tool = String(p.tool_name ?? "");
        const input = JSON.stringify(p.tool_input ?? null);
        const call = typeof p.tool_use_id === "string" ? p.tool_use_id : "";
        if (call) s.calls.delete(call);
        const same = [...s.pending.values()].filter((x) => x.ask.tool === tool);
        // The call that ended says which it was: only the request for that call was answered. Several calls of one
        // tool run at once (two commands, a sub-agent's beside the main agent's), and one of them ending is not the
        // answer to another's request — its card stayed on the agent's own screen and left ours (2026-10-08). A
        // request tied to no call is known by what it was for; without ids at all, as before: by that, else by being
        // the only one of its tool.
        const exact = call
          ? same.find((x) => x.call === call) ?? same.find((x) => !x.call && JSON.stringify(x.ask.input) === input)
          : same.find((x) => JSON.stringify(x.ask.input) === input) ?? (same.length === 1 ? same[0] : undefined);
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
        const thread = typeof p["thread-id"] === "string" ? p["thread-id"] : "";
        // Codex starts helper threads of its own beside the one its TUI shows (seen 2026-10-07 on 0.162 with a real
        // login: an ephemeral thread with no record), and each says when its turn ends. Where the hooks have named
        // the terminal's session, a notice of another thread is not this terminal's: taken for it, the terminal would
        // follow a session that has no record and be at rest while it works. Without the hooks the notice is all
        // there is, and it is followed as before.
        if (s.hooks && s.sessionByHook && thread && thread !== s.agentSessionId) return null;
        if (thread) this.reported(s, thread);
        if (p.type === "agent-turn-complete") { this.turnEnded(s, true, p["last-assistant-message"]); this.setStatus(s, "idle"); }
        return null;
      }
      case "PermissionRequest": {
        const tool = String(p.tool_name ?? "tool");
        const input = p.tool_input ?? null;
        // The call it is for: the latest begun with this tool and this input that no request is tied to yet.
        const tied = new Set([...s.pending.values()].map((x) => x.call));
        const wanted = JSON.stringify(input);
        const call = [...s.calls].reverse().find(([id, c]) => c.tool === tool && c.input === wanted && !tied.has(id))?.[0];
        const reply = await this.ask(s, tool, input, signal, call);
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
    s.term.write(data, () => { if (seq > s.parsedSeq) s.parsedSeq = seq; this.suggests(s); this.compactLooks(s); this.progressLooks(s); this.choiceLooks(s); });
    // Codex names its Daybreak switch on its screen when it is turned there and when a session begins with it on:
    // the word is only the cue, its server says how it stands.
    if (s.companion?.daybreak && data.includes("Daybreak")) this.daybreakLooks(s);
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

  private ask(s: Session, tool: string, input: unknown, signal?: AbortSignal, call?: string): Promise<PermissionReply | null> {
    if (s.status === "exited" || signal?.aborted) return Promise.resolve(null);
    const id = randomUUID().slice(0, 8);
    const questions = askQuestions(tool, input);
    const ask: PermissionAsk = { id, tool, summary: permissionSummary(tool, input), input, at: this.o.now(), ...(questions ? { questions } : {}) };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(s, id, null), this.o.permissionTimeoutMs);
      timer.unref();
      const gone = () => { if (s.pending.has(id)) this.settle(s, id, null, "working"); };
      signal?.addEventListener("abort", gone, { once: true });
      s.pending.set(id, { ask, resolve: (d) => { signal?.removeEventListener("abort", gone); resolve(d); }, timer, ...(call ? { call } : {}) });
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

  /** It begins compacting its context, or that is over. While it lasts the terminal is at work on `Compact`; after,
   *  it is what it was before. Not a turn: no result is kept. */
  private compacts(s: Session, on: boolean): void {
    if (on) {
      if (s.status === "exited" || s.status === "waiting") return;
      s.compactFrom ??= s.status === "working" ? "working" : "idle";
      s.activity = { tool: COMPACT_TOOL, target: "" };
      if (s.status === "working") this.doing(s); else this.setStatus(s, "working");
      return;
    }
    const from = s.compactFrom;
    s.compactFrom = null;
    if (!from) return;
    const doing = s.activity?.tool === COMPACT_TOOL;
    if (doing) s.activity = null;
    if (from === "idle" && s.status === "working") this.setStatus(s, "idle");
    else if (doing) this.doing(s);
  }

  /** Claude Code's screen drew: a moment later it is read for its compacting line. No hook says a compaction began
   *  without Claude Code printing the hook's command into the terminal afterwards, and none says one was cancelled
   *  or failed; the line on its screen says both (docs/simple-view-v0.md §5.7). */
  private compactLooks(s: Session): void {
    if (s.harness !== "claude-code" || !s.hooks || s.compactTimer || s.status === "exited") return;
    s.compactTimer = setTimeout(() => {
      s.compactTimer = null;
      if (!this.sessions.has(s.id) || s.status === "exited") return;
      const on = compactingOnScreen(this.screenTail(s.id, s.rows));
      if (on === (s.compactFrom !== null)) return;
      // A hook has just said it is over: the line may stay a moment longer.
      if (on && this.o.now() - s.compactEndedAt < COMPACT_GRACE_MS) return;
      this.compacts(s, on);
    }, this.o.compactLookMs);
    s.compactTimer.unref();
  }

  /** Claude Code's screen drew while it works: at most once a second it is read for how far the turn has come (the
   *  tokens on its working line), and the screens are told when the count moved. Its spinner redraws many times a
   *  second; the count is what says the model is still answering. */
  private progressLooks(s: Session): void {
    if (s.harness !== "claude-code" || s.progressTimer || s.status !== "working") return;
    s.progressTimer = setTimeout(() => {
      s.progressTimer = null;
      if (!this.sessions.has(s.id) || s.status !== "working") return;
      const now = workingOnScreen(this.screenTail(s.id, s.rows));
      // A row without a count (a turn's first seconds, a tool running) leaves the last one standing: it only grows.
      if (!now || (now.tokens === s.progress?.tokens && now.way === s.progress?.way)) return;
      this.progressed(s, now);
    }, this.o.progressLookMs);
    s.progressTimer.unref();
  }

  /** A screen sent `text` to terminal `id` as a message (typed and entered): it is shown on the record's screens at
   *  once, until the record holds it (`confirmSent`) or it turns out not to have been a message. A command of the
   *  agent's own (`/…`, `!…`) is not one. */
  replied(id: string, text: string, files = 0): void {
    const s = this.need(id);
    const said = text.trim();
    if (!said || /^[/!]/.test(said) || s.status === "exited") return;
    const now = this.o.now();
    s.sent = [...s.sent.filter((r) => now - r.at < SENT_KEEP_MS), { id: randomUUID().slice(0, 8), text: said.slice(0, MAX_SENT_CHARS), at: now, files }].slice(-MAX_SENT);
    s.emit({ type: "sent", replies: [...s.sent] });
    this.sentRests(s);
  }

  /** The agent's record holds these now. */
  confirmSent(id: string, replies: readonly string[]): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const left = s.sent.filter((r) => !replies.includes(r.id));
    if (left.length === s.sent.length) return;
    s.sent = left;
    s.emit({ type: "sent", replies: [...s.sent] });
  }

  /** At rest for a while with replies its record never took: they were not messages (or it ended first). A turn that
   *  begins meanwhile keeps them — one sent while it worked is taken as the next turn starts. */
  private sentRests(s: Session): void {
    if (s.sentTimer) { clearTimeout(s.sentTimer); s.sentTimer = null; }
    if (!s.sent.length || s.status === "working" || s.status === "waiting") return;
    s.sentTimer = setTimeout(() => {
      s.sentTimer = null;
      if (!this.sessions.has(s.id) || s.status === "working" || s.status === "waiting") return;
      const now = this.o.now();
      const left = s.status === "exited" ? [] : s.sent.filter((r) => now - r.at < this.o.sentRestMs);
      if (left.length !== s.sent.length) { s.sent = left; s.emit({ type: "sent", replies: [...left] }); }
      if (left.length) this.sentRests(s);
    }, this.o.sentRestMs);
    s.sentTimer.unref();
  }

  /** The agent's own commands as its own list gives them, learned from a terminal running the same program
   *  (`learnCommands`); null when not learned yet. */
  commandsOf(id: string): readonly ListedCommand[] | null {
    const s = this.sessions.get(id);
    return (s && this.learned.get(`${s.harness}\n${s.program}`)) ?? null;
  }

  /** Reads the agent's own list of commands off terminal `id`, once per program: while it rests with an empty input
   *  and nothing to choose on its screen, `/` is typed into it, the list it pops up is read row by row as the selection
   *  is walked down it, and the `/` is taken out again. A list of names kept by hand goes stale with every release
   *  (2026-10-08, user: 命令列表改成动态维护的不就行了，看当前运行的对应的agent是哪个，直接去里面取). Nothing is typed
   *  when its input is not positively empty; whatever goes wrong, the input is left as it was found. */
  async learnCommands(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || s.learning || !s.program || this.learned.has(`${s.harness}\n${s.program}`)) return;
    const ready = () => s.status === "idle" && !s.pending.size && !s.attention && !choicesOnScreen(this.screenTail(id, s.rows)) && inputEmpty(screenRows(s.term, s.rows));
    if (!ready()) return;
    s.learning = true;
    const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const found = new Map<string, string>();
    const read = () => { let fresh = 0; for (const c of commandRows(this.screenTail(id, s.rows))) if (!found.has(c.name)) { found.set(c.name, c.description); fresh += 1; } return fresh; };
    try {
      this.write(id, "/");
      await pause(350);
      if (!read()) return;
      const down = keySequence("down", this.keyContext(id)).repeat(3);
      for (let step = 0, still = 0; step < COMMAND_STEPS && still < COMMAND_STILL; step++) {
        if (s.status !== "idle") return;
        this.write(id, down);
        await pause(COMMAND_STEP_MS);
        still = read() ? 0 : still + 1;
      }
      if (found.size >= 5) this.learned.set(`${s.harness}\n${s.program}`, [...found].map(([name, description]) => ({ name, description })));
    } catch { /* the terminal went away */ } finally {
      // The `/` out again; once more if its list is still up.
      try {
        for (let i = 0; i < 2 && this.sessions.has(id) && s.status !== "exited"; i++) {
          if (i > 0 && inputEmpty(screenRows(s.term, s.rows))) break;
          this.write(id, "\x7f");
          await pause(200);
        }
      } catch { /* gone */ }
      s.learning = false;
    }
  }

  /** A screen is about to send terminal `id` one of the agent's own commands: what its screen says to it in the next
   *  moments is told to the record's screens as a notice. Call before the command is typed. */
  commanded(id: string): void {
    const s = this.need(id);
    if (s.status === "exited") return;
    const before = this.screenTail(id, s.rows);
    let told = "";
    for (const ms of NOTICE_LOOKS_MS) {
      setTimeout(() => {
        if (!this.sessions.has(id) || s.status === "exited") return;
        const after = this.screenTail(id, s.rows);
        // A list it opened is offered as one (`choices`), not said as a notice.
        const text = choicesOnScreen(after) ? "" : printedSince(before, after);
        if (!text || text === told) return;
        const again = told !== "";
        told = text;
        const notice = { id: randomUUID().slice(0, 8), text, at: this.o.now() };
        s.notices = [...(again ? s.notices.slice(0, -1) : s.notices), notice].slice(-MAX_NOTICES);
        s.emit({ type: "notices", notices: [...s.notices] });
      }, ms).unref();
    }
  }

  /** Its screen drew: a moment later it is read for a list to choose from, and the screens are told when that changed. */
  private choiceLooks(s: Session): void {
    if (s.choiceTimer || s.status === "exited") return;
    s.choiceTimer = setTimeout(() => {
      s.choiceTimer = null;
      if (!this.sessions.has(s.id)) return;
      const now = s.status === "exited" ? null : choicesOnScreen(this.screenTail(s.id, s.rows));
      if (JSON.stringify(now) === JSON.stringify(s.choices)) return;
      s.choices = now;
      s.emit({ type: "choices", choices: now });
    }, this.o.choiceLookMs);
    s.choiceTimer.unref();
  }

  /** A screen takes row `pick` (from 0) of the list on the agent's screen, which must still read `label` there: the
   *  selection is moved to it with the arrow keys and entered. TerminalError "busy" when the list is gone or changed. */
  choose(id: string, pick: number, label: string): void {
    const s = this.need(id);
    const now = s.status === "exited" ? null : choicesOnScreen(this.screenTail(id, s.rows));
    if (!now || now.options[pick]?.label !== label) throw new TerminalError("busy", "its screen no longer shows that choice");
    const ctx = this.keyContext(id);
    const step = keySequence(pick > now.selected ? "down" : "up", ctx);
    this.write(id, step.repeat(Math.abs(pick - now.selected)) + "\r");
  }

  private progressed(s: Session, now: TurnProgress | null): void {
    if (now?.tokens === s.progress?.tokens && now?.way === s.progress?.way) return;
    s.progress = now;
    s.emit({ type: "progress", progress: now });
  }

  private setStatus(s: Session, status: TerminalStatus): void {
    if (s.status === status || s.status === "exited") return;
    s.status = status;
    s.statusSince = this.o.now();
    if (status === "idle" || status === "exited") { s.activity = null; s.compactFrom = null; this.progressed(s, null); }
    s.emit({ type: "status", status });
    this.sentRests(s);
    this.suggests(s);
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
      id: s.id, harness: s.harness, cwd: s.cwd, workdir: s.agentCwd ?? s.cwd, model: s.model, modelNow: s.modelNow, modeNow: s.modeNow, suggestion: s.suggestion, sets: DIRECT.has(s.harness) || !!s.companion?.setModel, daybreak: s.daybreak, effort: s.effort, mode: s.mode, name: this.nameOf(s), customName: s.customName !== null, title: s.title,
      status: s.status, pid: s.proc?.pid ?? null,
      cols: s.cols, rows: s.rows, createdAt: s.createdAt, lastOutputAt: s.lastOutputAt, exitCode: s.exitCode,
      agentSessionId: s.agentSessionId, resumedFrom: s.resumedFrom, forked: s.forked, hooks: s.hooks, permissions: [...s.pending.values()].map((p) => p.ask),
      activity: s.activity, progress: s.progress, subagents: [...s.subagents.values()].map((a) => ({ ...a })), statusSince: s.statusSince, sent: [...s.sent], choices: s.choices, notices: [...s.notices], profile: s.profile, seq: s.seq,
    };
  }
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
