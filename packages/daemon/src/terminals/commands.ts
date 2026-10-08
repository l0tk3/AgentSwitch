/** The slash commands a terminal's agent takes, for the phone's completions when the user types "/": the agent's own
 *  built-in list (read from the installed release, see each list) and the custom commands it would load for the
 *  terminal's folder — the same folders and naming the agent itself uses. Reading is bounded (files, folders, bytes),
 *  never follows a symlink out of a command folder, and skips whatever is missing, unreadable or malformed. */

import { opendirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parse } from "yaml";

export type SlashCommand = { readonly name: string; readonly description: string; readonly source: "builtin" | "user" | "project" };
type Source = SlashCommand["source"];
type Builtin = readonly (readonly [name: string, description: string])[];

/** Claude Code 2.1.284 (the native build in ~/.local/share/claude/versions), read 2026-09-29 from the command objects
 *  and bundled skills in the binary: those an ordinary interactive session shows. Aliases (review → code-review,
 *  cost → usage, …) and commands behind account, platform or feature checks are left out. */
const CLAUDE: Builtin = [
  ["add-dir", "Add a new working directory"],
  ["background", "Send this session to the background and free the terminal"],
  ["batch", "Plan a large change; background agents each open a PR"],
  ["branch", "Create a branch of the current conversation at this point"],
  ["btw", "Ask a quick side question without interrupting the main conversation"],
  ["cd", "Move this session to a new working directory"],
  ["claude-api", "Build and debug apps that use the Claude API"],
  ["clear", "Start a new session with empty context; previous session stays on disk (resumable with /resume)"],
  ["code-review", "Review the current diff or a PR for bugs and cleanups"],
  ["color", "Set the prompt bar color for this session"],
  ["compact", "Free up context by summarizing the conversation so far"],
  ["config", "Open settings"],
  ["context", "Visualize current context usage as a colored grid"],
  ["copy", "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)"],
  ["debug", "Turn on debug logging and investigate problems"],
  ["diff", "View uncommitted changes and per-turn diffs"],
  ["doctor", "Health-check your setup and fix issues: installation, unused extensions, duplicated or bloated memory files, slow hooks, updates, permissions"],
  ["effort", "Set effort level for model usage"],
  ["exit", "Exit the CLI"],
  ["export", "Export the current conversation to a file or clipboard"],
  ["feedback", "Send feedback to Anthropic or report a bug"],
  ["fewer-permission-prompts", "Pre-approve safe read-only commands based on your usage"],
  ["focus", "Toggle focus view: just your prompt, summary, and response"],
  ["fork", "Copy this conversation into a new background session and keep working here"],
  ["goal", "Set a goal Claude checks before stopping"],
  ["help", "Show help and available commands"],
  ["hooks", "View hook configurations for tool events"],
  ["ide", "Manage IDE integrations and show status"],
  ["init", "Initialize a new CLAUDE.md file with codebase documentation"],
  ["insights", "Generate a report analyzing your Claude Code sessions"],
  ["install-github-app", "Set up Claude GitHub Actions for a repository"],
  ["keybindings", "Open your keyboard shortcuts file"],
  ["login", "Sign in with your Anthropic account"],
  ["logout", "Sign out from your Anthropic account"],
  ["loop", "Repeat a prompt or command on an interval (e.g. /loop 5m /foo)"],
  ["mcp", "Manage MCP servers"],
  ["memory", "Edit CLAUDE.md files and memory settings"],
  ["model", "Set the AI model for Claude Code"],
  ["permissions", "Manage allow and deny tool permission rules"],
  ["plan", "Enable plan mode or view the current session plan"],
  ["plugin", "Manage Claude Code plugins"],
  ["powerup", "Discover Claude Code features through quick interactive lessons"],
  ["recap", "Generate a one-line session recap now"],
  ["release-notes", "View release notes"],
  ["reload-plugins", "Activate pending plugin changes in the current session"],
  ["reload-skills", "Pick up skills added or changed on disk during this session"],
  ["remote-control", "Control this session from your phone or claude.ai/code"],
  ["rename", "Rename the current conversation"],
  ["resume", "Resume a previous conversation"],
  ["rewind", "Restore the code and/or conversation to a previous point"],
  ["run", "Launch this project’s app to see your change working"],
  ["schedule", "Create and manage routines: cloud agents on a schedule"],
  ["security-review", "Complete a security review of the pending changes on the current branch"],
  ["simplify", "Clean up the changed code without changing behavior"],
  ["skills", "List available skills"],
  ["status", "Show Claude Code status including version, model, account, API connectivity, and tool statuses"],
  ["statusline", "Set up Claude Code's status line UI"],
  ["tasks", "View and manage everything running in the background"],
  ["theme", "Change the theme"],
  ["update-config", "Change settings: hooks, permissions, environment variables"],
  ["usage", "Show session cost, plan usage, and activity stats"],
];

/** Codex 0.158.0-alpha.2.1 (ChatGPT.app's codex-cli), read 2026-09-29 from the slash-command names and descriptions in
 *  the binary; brought up to 0.162.0-alpha.18 on 2026-10-08 from its source (`tui/src/slash_command.rs`: cwd for pwd,
 *  pet for pets, and auto-review, clean, subagents, tui added; `daybreak` is added where the feature is on, api/terminals.ts). Debug-only, Windows-only and unconfirmed names (approve, btw, tui, subagents, rollout, …) are left out. */
const CODEX: Builtin = [
  ["agents", "open the agent command center"],
  ["app", "continue this session in the Desktop app"],
  ["apps", "manage apps"],
  ["archive", "archive this session"],
  ["auto-review", "approve one retry of a recent auto-review denial"],
  ["cd", "change the current working directory"],
  ["clean", "stop all background terminals"],
  ["clear", "clear the terminal and start a new chat"],
  ["compact", "summarize conversation to prevent hitting the context limit"],
  ["copy", "copy the last response or part of it"],
  ["cwd", "show the current working directory"],
  ["daemon", "Manage the local background server"],
  ["debug-config", "show config layers and requirement sources for debugging"],
  ["delete", "permanently delete this session"],
  ["diff", "show git diff (including untracked files)"],
  ["exit", "exit Codex"],
  ["experimental", "toggle experimental features"],
  ["export", "export the conversation as markdown"],
  ["feedback", "send logs to maintainers"],
  ["fork", "fork the current chat"],
  ["goal", "set or view the goal for a long-running task"],
  ["hooks", "view and manage lifecycle hooks"],
  ["ide", "include current selection, open files, and other context from your IDE"],
  ["import", "import setup, this project, and recent chats from Claude Code"],
  ["init", "create an AGENTS.md file with instructions for Codex"],
  ["keymap", "remap TUI shortcuts"],
  ["logout", "log out of Codex"],
  ["mcp", "list configured MCP tools; use /mcp verbose for details"],
  ["memories", "configure memory use and generation"],
  ["mention", "mention a file"],
  ["model", "choose what model and reasoning effort to use"],
  ["new", "start a new chat during a conversation"],
  ["permissions", "choose what Codex is allowed to do"],
  ["pet", "choose or hide the terminal pet"],
  ["plan", "switch to Plan mode"],
  ["plugins", "browse plugins"],
  ["ps", "list background terminals"],
  ["quit", "exit Codex"],
  ["raw", "toggle raw scrollback mode for copy-friendly terminal selection"],
  ["recap", "summarize the current conversation now"],
  ["rename", "rename the current thread"],
  ["resume", "resume a saved chat"],
  ["review", "review my current changes and find issues"],
  ["side", "start a side conversation in an ephemeral fork"],
  ["skills", "use skills to improve how Codex performs specific tasks"],
  ["status", "show current session configuration and token usage"],
  ["statusline", "configure which items appear in the status line"],
  ["stop", "stop all background terminals"],
  ["subagents", "switch between this session's subagents"],
  ["theme", "choose a syntax highlighting theme"],
  ["title", "configure which items appear in the terminal title"],
  ["tui", "choose the TUI mode for the next launch"],
  ["usage", "view account usage or use a usage limit reset"],
  ["vim", "toggle Vim mode for the composer"],
  ["voice", "start or stop voice; use /voice settings to choose a voice"],
  ["warnings", "view retained warnings and diagnostic details"],
  ["worktree", "start or continue a conversation in a new worktree"],
];

/** OpenCode 2.0.18 (~/.opencode/bin/opencode), read 2026-09-29 from the binary: the TUI's `slash` commands (with their
 *  titles; unshare, off by default, left out) and the server's init and review. */
const OPENCODE: Builtin = [
  ["agents", "Switch agent"],
  ["btw", "Ask a side question"],
  ["cd", "Change working directory"],
  ["clear", "Clear session"],
  ["compact", "Compact session"],
  ["connect", "Connect an integration"],
  ["copy", "Copy session transcript"],
  ["debug", "View debug info"],
  ["diff", "Open diff viewer"],
  ["editor", "Open editor"],
  ["exit", "Exit the app"],
  ["export", "Export session transcript"],
  ["fork", "Fork session"],
  ["help", "Help"],
  ["init", "guided AGENTS.md setup"],
  ["mcps", "MCP servers"],
  ["models", "Switch model"],
  ["new", "New session"],
  ["open", "Open session or project"],
  ["pair", "Pair device"],
  ["plugins", "Plugins"],
  ["redo", "Redo"],
  ["reload", "Reload configuration"],
  ["rename", "Rename session"],
  ["restart", "Restart service"],
  ["review", "review changes [commit|branch|pr], defaults to uncommitted"],
  ["sessions", "Switch session"],
  ["settings", "Open settings"],
  ["share", "Share session"],
  ["skills", "Skills"],
  ["stats", "Usage statistics"],
  ["status", "View status"],
  ["terminal", "New terminal"],
  ["themes", "Switch theme"],
  ["timeline", "Jump to message"],
  ["undo", "Undo previous message"],
  ["update", "Update OpenCode"],
  ["variants", "Switch model variant"],
  ["worktrees", "Manage workspaces"],
];

/** pi 0.87.1 (~/.pi/agent/install/releases), read 2026-09-29 from BUILTIN_SLASH_COMMANDS in dist/core/slash-commands.js. */
const PI: Builtin = [
  ["bug", "Report a bug to the Pi developers"],
  ["changelog", "Show changelog entries"],
  ["clone", "Duplicate the current session at the current position"],
  ["compact", "Manually compact the session context"],
  ["copy", "Copy last agent message to clipboard"],
  ["export", "Export session (HTML default, or specify path: .html/.jsonl)"],
  ["fork", "Create a new fork from a previous user message"],
  ["hotkeys", "Show all keyboard shortcuts"],
  ["import", "Import and resume a session from a JSONL file"],
  ["login", "Configure provider authentication"],
  ["logout", "Remove provider authentication"],
  ["model", "Select model (opens selector UI)"],
  ["name", "Set session display name"],
  ["new", "Start a new session"],
  ["quit", "Quit pi"],
  ["reload", "Reload keybindings, extensions, skills, prompts, themes, and context files"],
  ["resume", "Resume a different session"],
  ["scoped-models", "Enable/disable models for Ctrl+P cycling"],
  ["session", "Show session info and stats"],
  ["settings", "Open settings menu"],
  ["share", "Share session as a secret GitHub gist"],
  ["thinking", "Set thinking level"],
  ["tree", "Navigate session tree (switch branches)"],
  ["trust", "Save project trust decision for future sessions"],
];

/** Per call: files read, folders listed, folder entries looked at. */
type Scan = { files: number; dirs: number; entries: number };
const LIMITS = { files: 300, dirs: 200, entries: 5000 } as const;
const MAX_BYTES = 64 * 1024;
/** Nested command folders (frontend/lint.md is 2). */
const MAX_DEPTH = 5;
/** Folders walked up from the terminal's. */
const MAX_UP = 32;
const MAX_DESCRIPTION = 100;
/** A name one can type after "/": no spaces or control characters. */
const NAME = /^[^\s\u0000-\u001f\u007f]{1,100}$/;
const RANK: Record<Source, number> = { project: 0, user: 1, builtin: 2 };

type Custom = (cwd: string | null, home: string | null, scan: Scan) => SlashCommand[];
const AGENTS = new Map<string, { readonly builtin: Builtin; readonly custom: Custom }>([
  ["claude-code", { builtin: CLAUDE, custom: claudeCustom }],
  ["codex", { builtin: CODEX, custom: codexCustom }],
  ["opencode", { builtin: OPENCODE, custom: opencodeCustom }],
  ["pi", { builtin: PI, custom: piCustom }],
]);

/** Project commands first, then the user's, then built-in; each alphabetical, one per name (project beats user beats
 *  built-in). Unknown agent: none. */
export function slashCommands(harness: string, cwd: string, home: string = homedir(), live: readonly { readonly name: string; readonly description: string }[] | null = null): SlashCommand[] {
  const agent = AGENTS.get(harness);
  if (!agent) return [];
  // `live`: the agent's own list as read off a terminal running it (TerminalHost.learnCommands) — its custom commands
  // too, as it names them; the list kept here stands in until then.
  if (live?.length) return ranked(live.map((c): SlashCommand => ({ name: c.name, description: oneLine(c.description), source: "builtin" })));
  const builtin = agent.builtin.map(([name, description]): SlashCommand => ({ name, description: oneLine(description), source: "builtin" }));
  const abs = (p: unknown) => (typeof p === "string" && isAbsolute(p) ? resolve(p) : null);
  let custom: SlashCommand[] = [];
  try { custom = agent.custom(abs(cwd), abs(home), { files: 0, dirs: 0, entries: 0 }); } catch { /* the built-in ones still */ }
  return ranked([...custom, ...builtin]);
}

/** `commands` with a built-in one more, in its place (one of that name already there stays as it is). */
export function withCommand(commands: readonly SlashCommand[], one: { readonly name: string; readonly description: string }): SlashCommand[] {
  return commands.some((c) => c.name === one.name) ? [...commands] : ranked([...commands, { name: one.name, description: oneLine(one.description), source: "builtin" }]);
}

function ranked(all: readonly SlashCommand[]): SlashCommand[] {
  const best = new Map<string, SlashCommand>();
  for (const c of all) {
    const had = best.get(c.name);
    if (!had || RANK[c.source] < RANK[had.source]) best.set(c.name, c);
  }
  return [...best.values()].sort((a, b) => RANK[a.source] - RANK[b.source] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ── Claude Code ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Verified in 2.1.284: `.claude/commands/**` + `.md` in each folder from the terminal's up to the repository root
 *  (never the home folder) and in ~/.claude, subfolders giving `a:b` names, a `<dir>/SKILL.md` there naming the
 *  command after its folder; skills are `.claude/skills/<name>/SKILL.md` in the same places, named after the folder
 *  (front matter `name` is only the label), hidden by `user-invocable: false`; description from front matter, else
 *  the first line. Plugins: those enabled in the settings and installed for this user or folder, as `<plugin>:<name>`
 *  from their commands/ and skills/ folders and the manifest's `commands`. CLAUDE_CONFIG_DIR, managed (policy)
 *  commands, synced skills and MCP prompts are not read. */
function claudeCustom(cwd: string | null, home: string | null, scan: Scan): SlashCommand[] {
  const out: SlashCommand[] = [];
  const add = (dir: string, source: Source) => out.push(...claudeCommands(join(dir, "commands"), source, scan, ""), ...claudeSkills(join(dir, "skills"), source, scan, ""));
  for (const dir of cwd ? upward(cwd, home) : []) add(join(dir, ".claude"), "project");
  if (home) {
    add(join(home, ".claude"), "user");
    out.push(...claudePlugins(cwd, home, scan));
  }
  return out;
}

function claudeCommands(dir: string, source: Source, scan: Scan, prefix: string): SlashCommand[] {
  return markdown(dir, scan, MAX_DEPTH).flatMap(({ file, parts }) => {
    const last = parts[parts.length - 1] ?? "";
    const path = /^skill\.md$/i.test(last) ? parts.slice(0, -1) : [...parts.slice(0, -1), stem(last)];
    return path.length ? fromFile(prefix + path.join(":"), file, source, scan, invocable) : [];
  });
}

function claudeSkills(dir: string, source: Source, scan: Scan, prefix: string): SlashCommand[] {
  return skillFolders(dir, scan, 1)
    .filter(({ parts }) => parts[0] !== "synced")
    .flatMap(({ file, parts }) => fromFile(prefix + parts.join(":"), file, source, scan, invocable));
}

const invocable = (meta: Readonly<Record<string, unknown>>): boolean => meta["user-invocable"] !== false && meta["user-invocable"] !== "false";

/** ~/.claude/plugins/installed_plugins.json (version 2: `{ plugins: { "<name>@<marketplace>": [{ scope, installPath,
 *  projectPath? }] } }`), enabled by `enabledPlugins` in ~/.claude/settings.json and the folder's own settings. */
function claudePlugins(cwd: string | null, home: string, scan: Scan): SlashCommand[] {
  const settings = [join(home, ".claude", "settings.json"), ...(cwd ? [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")] : [])];
  const enabled = new Map<string, boolean>();
  for (const file of settings) {
    const on = readJson(file, scan)?.["enabledPlugins"];
    if (isRecord(on)) for (const [key, v] of Object.entries(on)) if (typeof v === "boolean") enabled.set(key, v);
  }
  const installed = readJson(join(home, ".claude", "plugins", "installed_plugins.json"), scan)?.["plugins"];
  if (!isRecord(installed)) return [];
  const out: SlashCommand[] = [];
  for (const [key, on] of enabled) {
    const entries = installed[key];
    if (!on || !Array.isArray(entries)) continue;
    const entry: unknown = entries.find((e) => isRecord(e) && typeof e["installPath"] === "string" && (e["scope"] === "user" || (cwd !== null && e["projectPath"] === cwd)));
    if (!isRecord(entry) || typeof entry["installPath"] !== "string" || !isAbsolute(entry["installPath"])) continue;
    const root = entry["installPath"];
    const source: Source = entry["scope"] === "user" ? "user" : "project";
    const manifest = readJson(join(root, ".claude-plugin", "plugin.json"), scan);
    const plugin = typeof manifest?.["name"] === "string" ? manifest["name"] : key.split("@")[0] ?? "";
    if (!plugin) continue;
    out.push(...claudeCommands(join(root, "commands"), source, scan, `${plugin}:`), ...claudeSkills(join(root, "skills"), source, scan, `${plugin}:`));
    const listed: unknown = manifest?.["commands"];
    const top = real(root);
    const paths = top === null ? [] : typeof listed === "string" ? [listed] : Array.isArray(listed) ? listed : [];
    for (const p of paths) {
      const k = top !== null && typeof p === "string" ? kind(resolve(root, p), top) : null;
      if (k?.type === "dir") out.push(...claudeCommands(k.real, source, scan, `${plugin}:`));
      else if (k?.type === "file" && k.real.endsWith(".md")) out.push(...fromFile(`${plugin}:${stem(basename(k.real))}`, k.real, source, scan, invocable));
    }
  }
  return out;
}

// ── Codex ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** ~/.codex/prompts/*.md as `/prompts:<name>`, the custom prompts of earlier Codex releases. Not verified: 0.158.0-alpha.2.1
 *  (installed here) no longer has them — its "/" menu is built-in only, skills are `$name` — but a Codex on PATH may be
 *  older. CODEX_HOME is not read. */
function codexCustom(_cwd: string | null, home: string | null, scan: Scan): SlashCommand[] {
  if (!home) return [];
  return markdown(join(home, ".codex", "prompts"), scan, 1).flatMap(({ file, parts }) => fromFile(`prompts:${stem(parts[0] ?? "")}`, file, "user", scan));
}

// ── OpenCode ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Verified in 2.0.18: `{command,commands}/**` + `.md` in ~/.config/opencode and in each `.opencode` folder from the
 *  terminal's up, named by the path below that folder (`frontend/lint`); and the `command` object of opencode.json /
 *  opencode.jsonc there and next to `.opencode`. OpenCode walks up to the file-system root; here as far as the other
 *  agents (repository root, not the home folder). XDG_CONFIG_HOME and MCP prompts are not read. */
function opencodeCustom(cwd: string | null, home: string | null, scan: Scan): SlashCommand[] {
  const files = (dir: string, source: Source) => ["command", "commands"].flatMap((sub) => markdown(join(dir, sub), scan, MAX_DEPTH).flatMap(({ file, parts }) =>
    fromFile([...parts.slice(0, -1), stem(parts[parts.length - 1] ?? "")].join("/"), file, source, scan)));
  const configs = (paths: readonly string[], source: Source) => paths.flatMap((path): SlashCommand[] => {
    const commands = readJson(path, scan)?.["command"];
    if (!isRecord(commands)) return [];
    return Object.entries(commands).flatMap(([name, c]) => isRecord(c) && typeof c["template"] === "string" && NAME.test(name)
      ? [{ name, description: typeof c["description"] === "string" ? oneLine(c["description"]) : "", source }] : []);
  });
  const out: SlashCommand[] = [];
  for (const dir of cwd ? upward(cwd, home) : []) {
    const own = join(dir, ".opencode");
    out.push(...files(own, "project"), ...configs([join(own, "opencode.jsonc"), join(own, "opencode.json"), join(dir, "opencode.jsonc"), join(dir, "opencode.json")], "project"));
  }
  if (home) {
    const global = join(home, ".config", "opencode");
    out.push(...files(global, "user"), ...configs([join(global, "opencode.jsonc"), join(global, "opencode.json")], "user"));
  }
  return out;
}

// ── pi ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Verified in 0.87.1: prompt templates are the `.md` files directly in ~/.pi/agent/prompts and <cwd>/.pi/prompts,
 *  named by the file; skills are `/skill:<name>` (front matter `name`, else the folder; no description, not loaded)
 *  from ~/.pi/agent/skills, ~/.agents/skills, <cwd>/.pi/skills and `.agents/skills` up to the repository root, unless
 *  `enableSkillCommands` is false. pi loads the project's only once the project is trusted; listed regardless. Pi
 *  packages, extension commands, standalone skill `.md` files and PI_CODING_AGENT_DIR are not read. */
function piCustom(cwd: string | null, home: string | null, scan: Scan): SlashCommand[] {
  const agent = home ? join(home, ".pi", "agent") : null;
  const settings = [agent ? readJson(join(agent, "settings.json"), scan) : null, cwd ? readJson(join(cwd, ".pi", "settings.json"), scan) : null];
  const skillsOn = settings.reduce<boolean>((on, s) => {
    const nested = s?.["skills"];
    const v = s?.["enableSkillCommands"] ?? (isRecord(nested) ? nested["enableSkillCommands"] : undefined);
    return typeof v === "boolean" ? v : on;
  }, true);
  const prompts = (dir: string, source: Source) => markdown(dir, scan, 1).flatMap(({ file, parts }) => fromFile(stem(parts[0] ?? ""), file, source, scan));
  const skills = (dir: string, source: Source) => skillsOn ? skillFolders(dir, scan, MAX_DEPTH).flatMap(({ file, parts }): SlashCommand[] => {
    const doc = readDoc(file, scan);
    const description = doc?.meta["description"];
    if (!doc || typeof description !== "string" || !description.trim()) return [];
    const own = doc.meta["name"];
    const name = `skill:${typeof own === "string" && own ? own : parts[parts.length - 1] ?? ""}`;
    return NAME.test(name) ? [{ name, description: oneLine(description), source }] : [];
  }) : [];
  const out: SlashCommand[] = [];
  if (cwd) {
    out.push(...prompts(join(cwd, ".pi", "prompts"), "project"), ...skills(join(cwd, ".pi", "skills"), "project"));
    for (const dir of upward(cwd, home)) out.push(...skills(join(dir, ".agents", "skills"), "project"));
  }
  if (agent && home) out.push(...prompts(join(agent, "prompts"), "user"), ...skills(join(agent, "skills"), "user"), ...skills(join(home, ".agents", "skills"), "user"));
  return out;
}

// ── Files ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `cwd` and the folders above it, nearest first: up to the repository root (a folder with `.git`), never reaching the
 *  home folder (that is the user's level). */
function upward(cwd: string, home: string | null): string[] {
  const out: string[] = [];
  for (let dir = cwd, n = 0; n < MAX_UP && dir !== home; n++) {
    out.push(dir);
    if (exists(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

type Found = { readonly file: string; readonly parts: readonly string[] };

/** The `.md` files under `dir`, `depth` folders deep, with their path below it. No dot files or folders, no
 *  node_modules, nothing a symlink leads to outside `dir`. */
function markdown(dir: string, scan: Scan, depth: number): Found[] {
  const root = real(dir);
  if (!root) return [];
  const out: Found[] = [];
  const walk = (path: string, parts: readonly string[]): void => {
    for (const e of entries(path, scan)) {
      if (e.name.startsWith(".") || (!e.name.endsWith(".md") && !e.isDirectory() && !e.isSymbolicLink())) continue;
      const k = kind(join(path, e.name), root);
      if (k?.type === "file" && e.name.endsWith(".md")) out.push({ file: k.real, parts: [...parts, e.name] });
      else if (k?.type === "dir" && e.name !== "node_modules" && parts.length + 1 < depth) walk(k.real, [...parts, e.name]);
    }
  };
  walk(root, []);
  return out;
}

/** Skill folders under `dir` (`<name>/SKILL.md`), with their path below it; past `depth` 1, folders that are not a
 *  skill are looked into. Same bounds as `markdown`. */
function skillFolders(dir: string, scan: Scan, depth: number): Found[] {
  const root = real(dir);
  if (!root) return [];
  const out: Found[] = [];
  const walk = (path: string, parts: readonly string[]): void => {
    for (const e of entries(path, scan)) {
      if (e.name.startsWith(".") || e.name === "node_modules" || (!e.isDirectory() && !e.isSymbolicLink())) continue;
      const k = kind(join(path, e.name), root);
      if (k?.type !== "dir") continue;
      const skill = kind(join(k.real, "SKILL.md"), root);
      if (skill?.type === "file") out.push({ file: skill.real, parts: [...parts, e.name] });
      else if (parts.length + 1 < depth) walk(k.real, [...parts, e.name]);
    }
  };
  walk(root, []);
  return out;
}

/** A folder's entries in name order, within the budget. */
function entries(dir: string, scan: Scan): Dirent[] {
  if (scan.dirs >= LIMITS.dirs || scan.entries >= LIMITS.entries) return [];
  scan.dirs++;
  const out: Dirent[] = [];
  try {
    const handle = opendirSync(dir);
    try {
      for (let e = handle.readSync(); e && scan.entries < LIMITS.entries; e = handle.readSync()) { scan.entries++; out.push(e); }
    } finally { handle.closeSync(); }
  } catch { /* what was read so far */ }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** What `path` is once symlinks are resolved, only if that is still under `root`. */
function kind(path: string, root: string): { readonly real: string; readonly type: "file" | "dir" } | null {
  const r = real(path);
  if (!r || (r !== root && !r.startsWith(root.endsWith(sep) ? root : root + sep))) return null;
  try {
    const st = statSync(r);
    return st.isFile() ? { real: r, type: "file" } : st.isDirectory() ? { real: r, type: "dir" } : null;
  } catch { return null; }
}

function real(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function exists(path: string): boolean {
  try { statSync(path); return true; } catch { return false; }
}

/** A regular file of at most MAX_BYTES, within the budget; null otherwise. */
function readSmall(file: string, scan: Scan): string | null {
  if (scan.files >= LIMITS.files) return null;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    scan.files++;
    return readFileSync(file, "utf8");
  } catch { return null; }
}

function readJson(file: string, scan: Scan): Record<string, unknown> | null {
  const text = readSmall(file, scan);
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(plainJson(text));
    return isRecord(v) ? v : null;
  } catch { return null; }
}

type Doc = { readonly meta: Readonly<Record<string, unknown>>; readonly body: string };
const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** A markdown file's YAML front matter and the rest; null when unreadable, too big, over budget, or the front matter
 *  does not parse. */
function readDoc(file: string, scan: Scan): Doc | null {
  const text = readSmall(file, scan)?.replace(/^﻿/, "");
  if (text === undefined) return null;
  const m = FRONT_MATTER.exec(text);
  if (!m) return { meta: {}, body: text };
  try {
    const meta: unknown = parse(m[1] ?? "", { logLevel: "error" });
    return { meta: isRecord(meta) ? meta : {}, body: text.slice(m[0].length) };
  } catch { return null; }
}

/** One command from a markdown file: the front matter's description, else its first line. */
function fromFile(name: string, file: string, source: Source, scan: Scan, keep: (meta: Readonly<Record<string, unknown>>) => boolean = () => true): SlashCommand[] {
  if (!NAME.test(name)) return [];
  const doc = readDoc(file, scan);
  if (!doc || !keep(doc.meta)) return [];
  const d = doc.meta["description"];
  const given = typeof d === "string" || typeof d === "number" || typeof d === "boolean" ? oneLine(String(d)) : "";
  const first = doc.body.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return [{ name, description: given || oneLine(first.replace(/^\s*#+\s*/, "")), source }];
}

/** One line of at most MAX_DESCRIPTION characters. */
function oneLine(text: string): string {
  const s = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...s];
  return chars.length <= MAX_DESCRIPTION ? s : `${chars.slice(0, MAX_DESCRIPTION - 1).join("").trimEnd()}…`;
}

const stem = (file: string): string => file.replace(/\.md$/, "");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** JSON with comments and trailing commas (opencode.jsonc) as plain JSON; plain JSON is unchanged. */
function plainJson(text: string): string {
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (text.startsWith("//", i) || text.startsWith("/*", i)) i = pastComment(text, i);
    else if (c === "," && /[}\]]/.test(text[pastBlank(text, i + 1)] ?? "")) i++;
    else { out += c; i++; }
  }
  return out;
}

function pastComment(text: string, i: number): number {
  const end = text.startsWith("//", i) ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
  return end < 0 ? text.length : text.startsWith("//", i) ? end : end + 2;
}

function pastBlank(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    if (!text.startsWith("//", i) && !text.startsWith("/*", i)) return i;
    i = pastComment(text, i);
  }
}
