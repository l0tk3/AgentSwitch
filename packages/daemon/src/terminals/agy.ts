/** Antigravity CLI in AgentSwitch's terminals (docs/terminal-v0.md §3 Antigravity; 2026-11-26, user #508).
 *
 *  Google's `agy` (1.5.17) has hooks of its own shape, in files only, and no per-process MCP configuration. What it
 *  does have per process is `--settings <JSON>`: settings.json keys "for this session only, never saved". So:
 *
 *  - **Status comes through its status line.** `statusLine: { type: "command", command, enabled }` runs a command
 *    with the session's state as one JSON object on stdin whenever that state changes, and shows what the command
 *    prints under the input. A terminal of ours names the hook program there (`hookClient.js agy`), which hands the
 *    service what it follows — `agent_state` (`idle | working | tool_use | reviewing | authenticating | initializing |
 *    error`), `tool_confirmation_pending`, the conversation's id and title, the model's name and level, how it asks
 *    (`cycle_mode`) — and prints the model's name, as the line it replaces did. The rest of the object (the account's
 *    e-mail address, its plan, its quota) never leaves the hook program. Nothing is written into the user's files.
 *    Measured 2026-11-26 in a pty: it runs at the start (`authenticating`, `initializing`, `idle`), at each change
 *    during a turn (`working` → `tool_use` with `tool_confirmation_pending: true` while it asks → `working` → `idle`),
 *    several times within a second at some of them, and not at all while nothing changes. An unknown key in
 *    `--settings` ends the program at once, so only keys it documents are sent.
 *  - **How it asks.** Since 1.5.7 it starts in `auto`. Asking each time is its `default` mode, which has no `--mode`
 *    word: `agentMode: ""` with `toolPermission: "request-review"` in the same `--settings` (seen: it then asks before
 *    a command, a numbered list the simple view reads as it is). Not asking at all is `--dangerously-skip-permissions`,
 *    under which it still calls its mode `auto`.
 *  - **The folder question** is a plain list (`> Yes, I trust this folder` / `No, exit`); a yes adds the folder to
 *    `trustedWorkspaces` in its settings.json, which is where AgentSwitch's trusted folders are written before a start
 *    (trustedFolders.ts).
 *  - **The Chat Room's tools.** MCP servers are files only (`~/.gemini/config/mcp_config.json`, shared with the
 *    Antigravity app). AgentSwitch adds one entry of its own there, `agentswitch`, as Grok's table is one of ours in
 *    its config.toml: the Chatroom Kit's server under the service's node, with `--quiet-outside` (roomKitClient.ts) —
 *    in a terminal of ours it speaks for that terminal (agy hands its own environment to the servers it starts:
 *    seen), and anywhere else it is a server with no tools.
 *    `AGENTSWITCH_AGY_MCP=0` keeps AgentSwitch from writing it. */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rootSpellings, type ProtectedPaths } from "../core/protected.js";
import type { PermissionMode, ScreenRow } from "./host.js";

export { AGY_HOME_VAR, agyGeminiDir, agyHome } from "../sessions/agy.js";

/** The event the hook program hands the service for each run of the status line. */
export const AGY_STATUS_EVENT = "AgyStatus";

/** `--settings` for one terminal: the status line that reports to the service (`statusCommand`; none: its status is
 *  guessed from its output), asking each time where that is how the terminal was started, and (`deny`) the protected
 *  paths refused by its own rules. */
export function agySettings(mode: PermissionMode, statusCommand: string | null, deny: readonly string[] = []): Record<string, unknown> {
  return {
    ...(mode === "manual" ? { agentMode: "", toolPermission: "request-review" } : {}),
    ...(statusCommand ? { statusLine: { type: "command", command: statusCommand, enabled: true } } : {}),
    ...(deny.length ? { permissions: { deny } } : {}),
  };
}

/** How many words deep a command is looked through for a protected path (a floor: `sudo -u x sh -c "cat …"` is five). */
const AGY_COMMAND_WORDS = 10;

/** The protected paths as Antigravity's own `permissions.deny` rules (docs/terminal-v0.md §3 Antigravity): no reading
 *  the read-denied ones, no writing the protected ones, and no command one of whose words names one.
 *
 *  Its file rules take a directory and cover everything under it. Its command rules are a word-by-word prefix; with
 *  `regex:` each word is an anchored regular expression, and the rule is one `regex:` for the whole argument — so a path
 *  found in the n-th word is `command(regex:.* … .*<path>.*)` with n-1 `.*` before it (measured 2026-11-26: a path in
 *  the second word is refused by `command(regex:.* .*<path>.*)`). `AGY_COMMAND_WORDS` such rules are made for each path.
 *  A word is matched as it is found in a command: under the home from the home on (`.agentswitch/vault`, in the absolute
 *  word, the `~`/`$HOME` ones and the data volume's alike), and a path with a space by the word after its last space. */
export function agyDenyRules(prot: ProtectedPaths | undefined, home: string = ""): string[] {
  if (!prot) return [];
  const rules = new Set<string>();
  const roots = [...new Set([...prot.roots, ...(prot.readDenied ?? [])])];
  for (const root of roots) {
    for (const p of rootSpellings(root)) rules.add(`read_file(${p})`);
    const needle = regexEscape(commandNeedle(root, home));
    for (let words = 1; words <= AGY_COMMAND_WORDS; words++) {
      rules.add(`command(regex:${[...Array(words - 1).fill(".*"), `.*${needle}.*`].join(" ")})`);
    }
  }
  for (const p of prot.roots.flatMap(rootSpellings)) rules.add(`write_file(${p})`);
  return [...rules];
}

/** The word of a command that names `root`: under the home from the home on, else the part after its last space. */
function commandNeedle(root: string, home: string): string {
  const under = home && (root === home || root.startsWith(`${home}/`)) ? root.slice(home.length + 1) : root;
  const at = under.lastIndexOf(" ");
  return at >= 0 ? under.slice(at + 1) : under;
}

const regexEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type AgyState = "working" | "waiting" | "idle" | "error";

/** What a run of the status line says, as the terminals follow it. */
export type AgyStatus = {
  /** Null: nothing the terminal follows (it is signing in, starting). */
  readonly state: AgyState | null;
  /** How it asks, in the words the screens know (Claude Code's); null when it does not say. */
  readonly mode: string | null;
  readonly title: string;
  /** The model's name as its picker shows it (`Gemini 4 Hydrogen (High)`); "" before it has one. */
  readonly model: string;
  /** When the hook program read it: a later reading counts over an earlier one that arrives after it. */
  readonly at: number;
};

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** `started`: how the terminal was started — under "bypass" its `auto` is asking nothing at all. */
export function agyStatus(p: Readonly<Record<string, unknown>>, started: PermissionMode): AgyStatus {
  const said = text(p.agent_state);
  const asks = p.tool_confirmation_pending === true || said === "reviewing";
  const state: AgyState | null = asks ? "waiting" : said === "working" || said === "tool_use" ? "working" : said === "idle" ? "idle" : said === "error" ? "error" : null;
  const cycle = "cycle_mode" in p ? text(p.cycle_mode) : null;
  const mode = cycle === null ? (state ? "default" : null)
    : cycle === "auto" ? (started === "bypass" ? "bypassPermissions" : "auto")
    : cycle === "plan" ? "plan" : /^accept[-_]?edits$/i.test(cycle) ? "acceptEdits" : cycle === "" || cycle === "default" ? "default" : null;
  return { state, mode, title: text(p.conversation_title).replace(/\s+/g, " ").trim(), model: text(p.model).trim(), at: typeof p.at === "number" ? p.at : 0 };
}

/** Its input line is on the screen and holds nothing typed: the last row that begins with its mark (`>`), with
 *  nothing after it but dim words (in `auto` it names the mode there). */
export function agyInputEmpty(rows: readonly ScreenRow[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const m = /^\s*>(?:\s|$)/u.exec(row.text);
    if (!m) continue;
    for (let x = m[0].length; x < row.text.length; x++) if (row.text[x]!.trim() && !row.dim[x]) return false;
    return true;
  }
  return false;
}

// ── The Chat Room's tools ────────────────────────────────────────────────────────────────────────────────────────────

/** The entry's name in `mcp_config.json`. */
export const AGY_MCP_SERVER = "agentswitch";

/** The entry: the kit's server, which has no tools where it is started outside an AgentSwitch terminal — an `agy`
 *  started in iTerm, the Antigravity app (`--quiet-outside`, as Grok's table: grokHooks.ts `grokKitTable`). The
 *  terminal's three variables are in no file: the server has them from the environment agy hands it. */
export const agyMcpEntry = (node: string, script: string): { command: string; args: string[] } => ({ command: node, args: [script, "--quiet-outside"] });

/** AgentSwitch's entry is in `<gemini dir>/config/mcp_config.json`, written now when it was missing or read otherwise
 *  (`node`, `script`: the service's node and the kit's script, as `ensureGrokKit` takes them);
 *  everything else in the file is kept as it was (read, changed and replaced whole). False when it is not there and
 *  could not be written — no such folder (the program has never run here: this service does not make one for it), a
 *  file that does not parse (left alone), one that cannot be written — or the user turned it off
 *  (`AGENTSWITCH_AGY_MCP=0`): the terminal then starts without the room's tools. Never throws. */
export function ensureAgyMcp(geminiDir: string | null, node: string, script: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!geminiDir || env.AGENTSWITCH_AGY_MCP === "0") return false;
  const dir = join(geminiDir, "config"), file = join(dir, "mcp_config.json");
  try {
    if (!existsSync(geminiDir)) return false;
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    let config: Record<string, unknown> = {};
    // The program itself leaves an empty file there.
    if (before !== null && before.trim() !== "") {
      const parsed: unknown = JSON.parse(before);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      config = parsed as Record<string, unknown>;
    }
    const had = config.mcpServers;
    if (had !== undefined && (!had || typeof had !== "object" || Array.isArray(had))) return false;
    const servers = { ...(had as Record<string, unknown> | undefined) };
    const want = agyMcpEntry(node, script);
    const now = servers[AGY_MCP_SERVER] as { command?: unknown; args?: unknown; disabled?: unknown } | undefined;
    if (now && now.command === want.command && JSON.stringify(now.args) === JSON.stringify(want.args)) return now.disabled !== true;
    // What the user set beside the command (it switched off with `agy mcp disable`) stays.
    servers[AGY_MCP_SERVER] = { ...(now && typeof now === "object" ? now : {}), ...want };
    mkdirSync(dir, { recursive: true });
    let mode = 0o600;
    try { mode = statSync(file).mode & 0o777; } catch { /* a new file */ }
    const part = `${file}.agentswitch-${process.pid}-${Date.now()}.part`;
    writeFileSync(part, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, { mode });
    renameSync(part, file);
    return (now as { disabled?: unknown } | undefined)?.disabled !== true;
  } catch {
    return false;
  }
}
