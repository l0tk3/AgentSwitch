/** Grok in AgentSwitch's terminals (docs/terminal-v0.md §3 Grok; 2026-11-11, user: 能否增加对Grok的支持？目前还没有Grok).
 *
 *  Grok Build (xAI's `grok`, 1.0.77) has Claude Code's hooks — the same events, the event as JSON on the hook's stdin,
 *  the same answers — and sends every field under Claude Code's name beside its own (`session_id` and `sessionId`,
 *  `tool_name` and `toolName`, …). So the terminals' hook command and the host's handler serve it as they are. What
 *  differs is here:
 *
 *  - **Where the hooks are written.** Grok takes hooks from files only: no flag names one for a single start, and the
 *    configuration a start can carry (`GROK_CONFIG`) is kept to a list that leaves hooks out. So AgentSwitch writes one
 *    file of its own into the user's Grok folder, `~/.grok/hooks/agentswitch.json` — the one thing it puts there, as
 *    other tools that follow agents do (Orca's `orca-status.json`, Vibe Island's `vibe-island.json`). The file
 *    never changes: its command runs the hook program a terminal of ours names in its environment, and where there is
 *    no such terminal — a `grok` started in iTerm — it reads the event and does nothing. Deleting the file is safe; it
 *    is written again when a Grok terminal starts here. `AGENTSWITCH_GROK_HOOKS=0` keeps AgentSwitch from writing it:
 *    Grok terminals then run without hooks and their status is read from the window title.
 *  - **A folder Grok does not trust yet.** It asks on its screen first, and until the answer no hook runs — the user's
 *    own are held back too. The terminal has no session until then (the screens show the question, screenChoices.ts).
 *  - **Nothing asks through a hook.** Grok has no PermissionRequest: it asks on its own screen and says so
 *    (`Notification`, `permission_prompt`), and its window title carries `⚠ Action Required` for as long as it waits.
 *    The title is what says the question was answered there (no hook does until the tool has run).
 *  - **Sub-agents are sessions of their own.** What a sub-agent does comes with ITS session's id and its kind
 *    (`subagentType`); only its start names the session that sent it. Such a call is the terminal's sub-agent at work,
 *    never the terminal moving to another session.
 *  - **Its tools have its own names** (`run_terminal_command`, `read_file`, …): given here under the names and fields
 *    the protected-path floor and the screens read (Claude Code's), as pi's are.
 *
 *  Measured 2026-11-11 with the user's Grok 1.0.77 (headless runs and its TUI in a pty; docs/terminal-v0.md §3). */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HookCall } from "./host.js";

export { grokHome } from "../sessions/grok.js";

/** The events AgentSwitch listens to. `SessionEnd` is left out: the program's exit says the same. */
export const GROK_HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied",
  "Stop", "StopFailure", "StopCancelled", "Notification", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
] as const;

/** The file's name in Grok's `hooks/` folder (Grok names each hook after it: `global/agentswitch:…`). */
export const GROK_HOOK_FILE = "agentswitch.json";
/** A terminal's environment names the hook program: the service's node and its hook client (launch.ts). */
export const GROK_HOOK_NODE = "AGENTSWITCH_TERMINAL_NODE";
export const GROK_HOOK_SCRIPT = "AGENTSWITCH_TERMINAL_HOOK_SCRIPT";

/** The one command of every hook: in a terminal of ours, the hook program that terminal names; anywhere else the event
 *  is read (Grok writes it whether or not anything reads) and nothing happens. Never a path of this installation: a
 *  developer's copy of the service and the installed one share the file. */
export const GROK_HOOK_COMMAND =
  `if [ -n "\${AGENTSWITCH_TERMINAL_ID-}" ] && [ -n "\${${GROK_HOOK_NODE}-}" ] && [ -n "\${${GROK_HOOK_SCRIPT}-}" ]; ` +
  `then exec "$${GROK_HOOK_NODE}" "$${GROK_HOOK_SCRIPT}"; else cat >/dev/null 2>&1 || :; fi`;

/** The hook file's content: every event to the one command, each given `timeoutS` (Grok's own default is 5 s). */
export function grokHookFile(timeoutS: number): string {
  const hooks = Object.fromEntries(GROK_HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command: GROK_HOOK_COMMAND, timeout: timeoutS }] }]]));
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

/** AgentSwitch's hook file is in Grok's folder `home`, written now when it was missing or read otherwise. False when
 *  it is not there and could not be written (no such folder: Grok has never run; a folder that cannot be written), or
 *  the user turned it off: the terminal then starts without hooks. */
export function ensureGrokHooks(home: string | null, timeoutS: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!home || env.AGENTSWITCH_GROK_HOOKS === "0") return false;
  const dir = join(home, "hooks"), file = join(dir, GROK_HOOK_FILE), want = grokHookFile(timeoutS);
  try {
    if (existsSync(file) && readFileSync(file, "utf8") === want) return true;
    // Grok's folder is made by Grok: none means it has never run here, and this service does not make one for it.
    if (!existsSync(home)) return false;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, want, { mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}

/** Grok's built-in tools under the names the protected-path floor and the screens read (Claude Code's). Anything else —
 *  an MCP server's tool (`server__tool`), its scheduler, its image tools — goes as it is. */
const GROK_TOOLS: Readonly<Record<string, string>> = {
  run_terminal_command: "Bash", monitor: "Bash", read_file: "Read", search_replace: "Edit", hashline_edit: "Edit", write: "Write",
  grep: "Grep", list_dir: "LS", web_search: "WebSearch", web_fetch: "WebFetch", spawn_subagent: "Task", todo_write: "TodoWrite",
  ask_user_question: "AskUserQuestion",
};

/** A Grok tool call as the floor and the screens read one: Claude Code's name for the tool, and the file it names
 *  under `file_path` (Grok's `read_file` says `target_file`, its `list_dir` `target_directory`). */
export function grokTool(name: string, input: unknown): { tool: string; input: Record<string, unknown> } {
  const args = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  const tool = GROK_TOOLS[name] ?? name;
  if (tool === "Read" && typeof args.file_path !== "string" && typeof args.target_file === "string") args.file_path = args.target_file;
  if (tool === "LS" && typeof args.path !== "string" && typeof args.target_directory === "string") args.path = args.target_directory;
  // What it sends a sub-agent to do is the sub-agent's name on the screens; Grok's are all of one kind unless it says.
  if (tool === "Task" && typeof args.subagent_type !== "string") args.subagent_type = "general-purpose";
  return { tool, input: args };
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** A hook call of Grok's as the host's handler reads one (Claude Code's terms), or null for one that says nothing the
 *  terminal follows: its last words as it shuts down, a sub-agent's own prompt.
 *
 *  - Tools by Claude Code's names (`grokTool`).
 *  - A call from a sub-agent's own session: `agent_id` (that session's id, which its start named) and `agent_type`
 *    instead of a session — the terminal stays on the session that sent it, in the folder it works in.
 *  - `PostToolUseFailure` is a tool call that ended; `StopCancelled`, `PermissionDenied`, `PreCompact` and
 *    `PostCompact` go on under their own names (host.ts). */
export function grokCall(call: HookCall): HookCall | null {
  const p: Record<string, unknown> = { ...call.payload };
  let event = call.event;
  const kind = text(p.subagentType);
  if (event === "SubagentStart") {
    // Said by the session that sent it: which one started, and of what kind.
    const id = text(p.subagentId);
    if (!id) return null;
    p.agent_id = id;
    p.agent_type = kind;
  } else if (kind) {
    // The sub-agent's own session speaks: its prompt and its end are not the terminal's.
    const id = text(p.subagentId) || text(p.session_id);
    if (!id || event === "UserPromptSubmit" || event === "SessionEnd" || event === "Stop" || event === "StopCancelled" || event === "StopFailure") return null;
    p.agent_id = id;
    p.agent_type = kind;
    delete p.session_id;
    delete p.transcript_path;
    delete p.cwd;
  }
  // Its goodbye: after a turn that ended long ago it says Stop once more as the program goes (`reason: "shutdown"`).
  if (event === "Stop" && p.reason === "shutdown") return null;
  if (event === "SessionEnd") return null;
  if (event === "PostToolUseFailure") event = "PostToolUse";
  if (typeof p.tool_name === "string") {
    const { tool, input } = grokTool(p.tool_name, p.tool_input);
    p.tool_name = tool;
    p.tool_input = input;
  }
  return { event, payload: p };
}

/** Grok's window title, read (measured with 1.0.77): `grok` when fresh; `<spinner> - <what it does> - grok` while it
 *  works, with the session's title once it has one (`<spinner> - <what it does> - <title> - grok`); `<title> - grok`
 *  at rest; and `⚠ Action Required - ` in front while something on its screen waits for an answer. */
export type GrokTitle = {
  /** The session's own title, "" while it has none: never the spinner, what it is doing, or the program's name. */
  readonly title: string;
  readonly working: boolean;
  /** Something on its screen waits for you. */
  readonly attention: boolean;
};

const GROK_ATTENTION = /^\s*⚠\s*Action Required\s*-\s*/u;
const GROK_SPINNER = /^[⠀-⣿]$/u;

export function grokTitle(raw: string): GrokTitle {
  let rest = raw.replace(/\s+/g, " ").trim();
  const attention = GROK_ATTENTION.test(rest);
  if (attention) rest = rest.replace(GROK_ATTENTION, "");
  const parts = rest.split(" - ");
  if (parts.length && parts[parts.length - 1]!.trim().toLowerCase() === "grok") parts.pop();
  const working = parts.length > 0 && GROK_SPINNER.test(parts[0]!.trim());
  // The spinner, then what it is doing now: neither is the session's name.
  if (working) parts.splice(0, 2);
  return { title: parts.join(" - ").trim(), working, attention };
}
