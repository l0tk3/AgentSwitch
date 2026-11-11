/** Grok in AgentSwitch's terminals (docs/terminal-v0.md §3 Grok; 2026-11-11, user: 能否增加对Grok的支持？目前还没有Grok):
 *  its hooks' file, what its hooks say read in the host's terms, its window title, how it is started, its lists on the
 *  screen, its sessions, its models, its commands. The payloads, screens and files are as Grok 1.0.77 gave them on the
 *  user's Mac (headless runs and its TUI in a pty, 2026-11-11). A fake agent in a real pseudo-terminal; no model is
 *  called and nothing of the user's Grok is read. */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, terminalBinaries, type DaemonConfig } from "../src/daemon.js";
import { effortArgs, effortsFor, GROK_EFFORTS } from "../src/harness/efforts.js";
import { grokKeptModels, grokOwnDefaults, listGrokModels, parseGrokModels } from "../src/router/grokModels.js";
import { grokOffer, ModelOffers } from "../src/router/modelOffers.js";
import { grokFacts, grokHome, grokMessages } from "../src/sessions/grok.js";
import { SessionMonitor, type SessionSources } from "../src/sessions/monitor.js";
import { SessionSearch } from "../src/sessions/search.js";
import { slashCommands } from "../src/terminals/commands.js";
import { elsewhereCheck, grokRunning, type Proc } from "../src/terminals/elsewhere.js";
import { ensureGrokHooks, GROK_HOOK_COMMAND, GROK_HOOK_EVENTS, GROK_HOOK_FILE, grokCall, grokHookFile, grokTitle, grokTool } from "../src/terminals/grokHooks.js";
import { choicesOnScreen, TerminalHost, terminalName, type Launcher } from "../src/terminals/host.js";
import { agentLauncher, grokDenyArgs, HOOK_SCRIPT } from "../src/terminals/launch.js";
import { TARGETS_PATH } from "./helpers.js";

const FAKE = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

const fakeLauncher = (url: () => string, hooks: boolean): Launcher => (req) => ({
  file: process.execPath,
  args: [FAKE],
  env: { ...(process.env as Record<string, string>), FAKE_HOOK_SCRIPT: HOOK_SCRIPT, AGENTSWITCH_TERMINAL_ID: req.id, AGENTSWITCH_TERMINAL_URL: url(), AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken },
  hooks,
});

async function until<T>(get: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const tmp = (name: string): string => realpathSync(mkdtempSync(join(tmpdir(), `agentswitch-grok-${name}-`)));

/** A session of Grok's and one of a sub-agent it sent off, by their ids as Grok made them. */
const PARENT = "01a1c8a4-bebe-7303-ae48-7b3641e8bc53";
const CHILD = "01a1c8a4-d975-7462-bffc-4fe1de1bfae0";

describe("Grok's hooks", () => {
  it("are one file in Grok's own folder that does nothing outside a terminal of ours, written once and again when it is gone", () => {
    const home = join(tmp("home"), ".grok");
    // Grok's folder is Grok's to make: without one (it has never run) nothing is written.
    expect(ensureGrokHooks(home, 10, {})).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(ensureGrokHooks(null, 10, {})).toBe(false);
    mkdirSync(home);
    expect(ensureGrokHooks(home, 10, {})).toBe(true);
    const file = join(home, "hooks", GROK_HOOK_FILE);
    const written = JSON.parse(readFileSync(file, "utf8")) as { hooks: Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]> };
    expect(Object.keys(written.hooks)).toEqual([...GROK_HOOK_EVENTS]);
    for (const event of GROK_HOOK_EVENTS) expect(written.hooks[event]).toEqual([{ hooks: [{ type: "command", command: GROK_HOOK_COMMAND, timeout: 10 }] }]);
    // No path of this installation in it: a developer's copy of the service and the installed one share the file.
    expect(readFileSync(file, "utf8")).not.toContain(process.execPath);
    expect(readFileSync(file, "utf8")).toBe(grokHookFile(10));
    // There already: left as it is (not written again).
    const before = statSync(file).mtimeMs;
    expect(ensureGrokHooks(home, 10, {})).toBe(true);
    expect(statSync(file).mtimeMs).toBe(before);
    // Changed or deleted by hand: written again when the next Grok terminal starts.
    writeFileSync(file, "{}");
    expect(ensureGrokHooks(home, 10, {})).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(grokHookFile(10));
    rmSync(file);
    expect(ensureGrokHooks(home, 10, {})).toBe(true);
    expect(existsSync(file)).toBe(true);
    // The user's switch: AgentSwitch writes nothing there (what is there stays; Grok's own `/hooks` turns it off).
    rmSync(file);
    expect(ensureGrokHooks(home, 10, { AGENTSWITCH_GROK_HOOKS: "0" })).toBe(false);
    expect(existsSync(file)).toBe(false);
    // Where Grok's folder is: GROK_HOME, else ~/.grok.
    expect(grokHome({ HOME: "/Users/u" })).toBe("/Users/u/.grok");
    expect(grokHome({ HOME: "/Users/u", GROK_HOME: "/data/grok" })).toBe("/data/grok");
    expect(grokHome({})).toBeNull();
  });

  it("the command: in a terminal of ours the hook program it names, with the event; anywhere else the event is read and nothing happens", () => {
    const dir = tmp("cmd");
    const echo = join(dir, "echo.mjs");
    writeFileSync(echo, "process.stdin.pipe(process.stdout);\n");
    const run = (env: Record<string, string>) => execFileSync("/bin/sh", ["-c", GROK_HOOK_COMMAND], { input: '{"hook_event_name":"Stop"}\n', env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } }).toString();
    // A `grok` in iTerm: silent, and done (exit 0, or execFileSync would throw).
    expect(run({})).toBe("");
    // Named in part only (a stale environment): still nothing.
    expect(run({ AGENTSWITCH_TERMINAL_ID: "t1" })).toBe("");
    expect(run({ AGENTSWITCH_TERMINAL_ID: "t1", AGENTSWITCH_TERMINAL_NODE: process.execPath, AGENTSWITCH_TERMINAL_HOOK_SCRIPT: echo })).toBe('{"hook_event_name":"Stop"}\n');
  });

  it("its tools go under the names the floor and the screens read; a file under file_path", () => {
    expect(grokTool("run_terminal_command", { command: "npm test", description: "Run the tests" })).toEqual({ tool: "Bash", input: { command: "npm test", description: "Run the tests" } });
    expect(grokTool("read_file", { target_file: "/a/b.ts", limit: 20 })).toEqual({ tool: "Read", input: { target_file: "/a/b.ts", limit: 20, file_path: "/a/b.ts" } });
    expect(grokTool("search_replace", { file_path: "/a/b.ts", old_string: "x", new_string: "y" }).tool).toBe("Edit");
    expect(grokTool("write", { file_path: "/a/c.ts", content: "" }).tool).toBe("Write");
    expect(grokTool("list_dir", { target_directory: "/a" })).toEqual({ tool: "LS", input: { target_directory: "/a", path: "/a" } });
    expect(grokTool("grep", { pattern: "TODO", path: "src" }).tool).toBe("Grep");
    expect(grokTool("web_fetch", { url: "https://x.ai" }).tool).toBe("WebFetch");
    // What a sub-agent is sent to do names it on the screens.
    expect(grokTool("spawn_subagent", { description: "List folder names", prompt: "…", background: false })).toEqual({ tool: "Task", input: { description: "List folder names", prompt: "…", background: false, subagent_type: "general-purpose" } });
    // An MCP server's tool, and anything else of its own: as it is. A missing input is an empty one.
    expect(grokTool("linear__save_issue", { title: "x" })).toEqual({ tool: "linear__save_issue", input: { title: "x" } });
    expect(grokTool("scheduler_list", undefined)).toEqual({ tool: "scheduler_list", input: {} });
  });

  it("what its hooks say is read in the host's terms: a sub-agent's own session is the terminal's sub-agent, its goodbye is nothing", () => {
    const common = { cwd: "/w", workspaceRoot: "/w", permission_mode: "default", permissionMode: "default" };
    // The main agent's tool call: Claude Code's name for the tool, the rest as Grok sent it.
    const pre = grokCall({ event: "PreToolUse", payload: { ...common, hook_event_name: "PreToolUse", session_id: PARENT, tool_name: "run_terminal_command", tool_input: { command: "rm probe-file.txt", description: "Remove it" }, tool_use_id: "call-1" } });
    expect(pre).toMatchObject({ event: "PreToolUse", payload: { session_id: PARENT, cwd: "/w", tool_name: "Bash", tool_input: { command: "rm probe-file.txt" }, tool_use_id: "call-1" } });
    expect(pre!.payload.agent_id).toBeUndefined();
    // A sub-agent starts: said by the session that sent it, which the terminal stays on.
    expect(grokCall({ event: "SubagentStart", payload: { ...common, session_id: PARENT, subagentId: CHILD, subagentType: "general-purpose", description: "List folder names" } }))
      .toMatchObject({ event: "SubagentStart", payload: { session_id: PARENT, agent_id: CHILD, agent_type: "general-purpose" } });
    expect(grokCall({ event: "SubagentStart", payload: { session_id: PARENT, subagentType: "general-purpose" } })).toBeNull();   // which one, it did not say
    // The sub-agent's own session speaks: its tool calls are that sub-agent's, in no session and no folder of the terminal's.
    const child = grokCall({ event: "PreToolUse", payload: { ...common, cwd: "/w/.worktrees/x", session_id: CHILD, transcript_path: `/g/sessions/%2Fw/${CHILD}/updates.jsonl`, subagentType: "general-purpose", tool_name: "read_file", tool_input: { target_file: "/w/a.ts" }, tool_use_id: "call-2" } });
    expect(child).toMatchObject({ event: "PreToolUse", payload: { agent_id: CHILD, agent_type: "general-purpose", tool_name: "Read", tool_input: { file_path: "/w/a.ts" } } });
    expect(child!.payload).not.toHaveProperty("session_id");
    expect(child!.payload).not.toHaveProperty("transcript_path");
    expect(child!.payload).not.toHaveProperty("cwd");
    // Its prompt and its end are not the terminal's; its stop says which sub-agent is done.
    for (const event of ["UserPromptSubmit", "SessionEnd", "Stop", "StopCancelled", "StopFailure"]) expect(grokCall({ event, payload: { session_id: CHILD, subagentType: "general-purpose" } })).toBeNull();
    expect(grokCall({ event: "SubagentStop", payload: { session_id: CHILD, subagentId: CHILD, subagentType: "general-purpose", last_assistant_message: "No names." } }))
      .toMatchObject({ event: "SubagentStop", payload: { agent_id: CHILD } });
    // The main agent's turn ends; as the program goes it says Stop once more, which is no turn.
    expect(grokCall({ event: "Stop", payload: { session_id: PARENT, reason: "end_turn", last_assistant_message: "done" } })).toMatchObject({ event: "Stop", payload: { last_assistant_message: "done" } });
    expect(grokCall({ event: "Stop", payload: { session_id: PARENT, reason: "shutdown" } })).toBeNull();
    expect(grokCall({ event: "SessionEnd", payload: { session_id: PARENT, reason: "shutdown" } })).toBeNull();
    // A tool that failed to run is a tool call that ended.
    expect(grokCall({ event: "PostToolUseFailure", payload: { session_id: PARENT, tool_name: "web_fetch", tool_input: { url: "https://x.ai" }, tool_use_id: "call-3" } }))
      .toMatchObject({ event: "PostToolUse", payload: { tool_name: "WebFetch", tool_use_id: "call-3" } });
    // The payload it was given is not changed.
    const given = { session_id: CHILD, subagentType: "explore", tool_name: "grep", tool_input: { pattern: "x" } };
    grokCall({ event: "PreToolUse", payload: given });
    expect(given).toEqual({ session_id: CHILD, subagentType: "explore", tool_name: "grep", tool_input: { pattern: "x" } });
  });

  it("its window title is read: the session's own title, whether it works, whether its screen waits for you", () => {
    expect(grokTitle("grok")).toEqual({ title: "", working: false, attention: false });
    expect(grokTitle("⠸ - Waiting for response… - grok")).toEqual({ title: "", working: true, attention: false });
    expect(grokTitle("⠧ - Writing command… - Run touch probe-file.txt shell command - grok")).toEqual({ title: "Run touch probe-file.txt shell command", working: true, attention: false });
    expect(grokTitle("Run touch probe-file.txt shell command - grok")).toEqual({ title: "Run touch probe-file.txt shell command", working: false, attention: false });
    expect(grokTitle("⚠ Action Required - ⠦ - Remove probe-file.txt as requested… - Delete probe-file.txt with rm command - grok"))
      .toEqual({ title: "Delete probe-file.txt with rm command", working: true, attention: true });
    // A title with a dash of its own stays whole; one that is not Grok's form is taken as it is.
    expect(grokTitle("⠙ - Thinking - Fix the build - again - grok").title).toBe("Fix the build - again");
    expect(grokTitle("fake agent")).toEqual({ title: "fake agent", working: false, attention: false });
    // The name the screens show is never the program's own name: the folder's until the session has a title.
    expect(terminalName(null, grokTitle("grok").title, "grok", "/Users/u/code/app")).toBe("app");
    expect(terminalName(null, grokTitle("Fix the build - grok").title, "grok", "/Users/u/code/app")).toBe("Fix the build");
  });
});

describe("a Grok terminal", () => {
  it("starts with how it asks and the session to go on with in Grok's own arguments, its model and its level as this start's configuration; its hooks are its environment", () => {
    const stateDir = tmp("launch");
    const launch = agentLauncher({ binaries: { grok: "/bin/grok" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, node: "/n/node", hookScript: "/h/hook.js", env: { PATH: "/usr/bin", SECRET_GATE_REPAIR_KEY: "k" }, grokHooks: () => true });
    const plain = launch({ id: "g1", harness: "grok", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    // Asking is stated, not left to its config.toml (the user's may say never to ask).
    expect(plain.args).toEqual(["--permission-mode", "default"]);
    expect(plain.hooks).toBe(true);
    expect(plain.env).toMatchObject({ AGENTSWITCH_TERMINAL_ID: "g1", AGENTSWITCH_TERMINAL_HOOK_TOKEN: "tok", AGENTSWITCH_TERMINAL_URL: "http://127.0.0.1:4711", AGENTSWITCH_TERMINAL_NODE: "/n/node", AGENTSWITCH_TERMINAL_HOOK_SCRIPT: "/h/hook.js", TERM: "xterm-256color" });
    expect(plain.env.SECRET_GATE_REPAIR_KEY).toBeUndefined();
    expect(plain.env.GROK_CONFIG).toBeUndefined();
    // The model and the level: laid over its configuration for this one start, never `--model` or
    // `--reasoning-effort` — started with those, Grok writes them into the user's config.toml as what every later
    // session of theirs starts on (measured 2026-11-11, Grok 1.0.77).
    const chosen = launch({ id: "g2", harness: "grok", cwd: "/tmp", model: "grok-4.7", effort: "xhigh", mode: "auto", hookToken: "tok" });
    expect(chosen.args).toEqual(["--permission-mode", "auto"]);
    expect(JSON.parse(chosen.env.GROK_CONFIG!)).toEqual({ models: { default: "grok-4.7", default_reasoning_effort: "xhigh" } });
    expect(JSON.parse(launch({ id: "g2b", harness: "grok", cwd: "/tmp", effort: "low", mode: "manual", hookToken: "tok" }).env.GROK_CONFIG!)).toEqual({ models: { default_reasoning_effort: "low" } });
    // What the service's own environment had there stays, but for these two.
    const laidOver = agentLauncher({ binaries: { grok: "/bin/grok" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, env: { PATH: "/usr/bin", GROK_CONFIG: '{"features":{"x":true},"models":{"default":"grok-4.5","web_search":"grok-4.5"}}' } });
    expect(JSON.parse(laidOver({ id: "g2c", harness: "grok", cwd: "/tmp", model: "grok-4.6", mode: "manual", hookToken: "tok" }).env.GROK_CONFIG!))
      .toEqual({ features: { x: true }, models: { default: "grok-4.6", web_search: "grok-4.5" } });
    expect(laidOver({ id: "g2d", harness: "grok", cwd: "/tmp", mode: "manual", hookToken: "tok" }).env.GROK_CONFIG).toBe('{"features":{"x":true},"models":{"default":"grok-4.5","web_search":"grok-4.5"}}');
    expect(launch({ id: "g3", harness: "grok", cwd: "/tmp", mode: "bypass", hookToken: "tok" }).args).toEqual(["--permission-mode", "bypassPermissions"]);
    // "Continue" goes on in the same session; a fork only when asked for.
    expect(launch({ id: "g4", harness: "grok", cwd: "/tmp", resume: PARENT, mode: "manual", hookToken: "tok" }).args).toEqual(["--permission-mode", "default", "--resume", PARENT]);
    expect(launch({ id: "g5", harness: "grok", cwd: "/tmp", resume: PARENT, fork: true, mode: "manual", hookToken: "tok" }).args.slice(-3)).toEqual(["--resume", PARENT, "--fork-session"]);
    // A level that is no level is not passed on.
    const odd = launch({ id: "g6", harness: "grok", cwd: "/tmp", effort: "X High", mode: "manual", hookToken: "tok" });
    expect(odd.args).toEqual(["--permission-mode", "default"]);
    expect(odd.env.GROK_CONFIG).toBeUndefined();
    // Without AgentSwitch's hook file (turned off, or Grok's folder cannot be written): no hooks, and nothing named
    // for a hook to run; its status is read from its title and its output.
    const bare = agentLauncher({ binaries: { grok: "/bin/grok" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, node: "/n/node", hookScript: "/h/hook.js", env: { PATH: "/usr/bin" }, grokHooks: () => false })({ id: "g7", harness: "grok", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    expect(bare.hooks).toBe(false);
    expect(bare.env.AGENTSWITCH_TERMINAL_NODE).toBeUndefined();
    expect(agentLauncher({ binaries: { grok: "/bin/grok" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, env: {} })({ id: "g8", harness: "grok", cwd: "/tmp", mode: "manual", hookToken: "tok" }).hooks).toBe(false);
    expect(() => agentLauncher({ binaries: {}, hookUrl: () => "http://127.0.0.1:4711", stateDir, env: {} })({ id: "g9", harness: "grok", cwd: "/tmp", mode: "manual", hookToken: "tok" })).toThrow(/not installed/);
    // How hard it thinks takes no argument of its own (it is in the start's configuration); its own levels where its
    // list is not known.
    expect(effortArgs("grok", "high", "grok-4.6")).toEqual({ args: [], model: "grok-4.6" });
    expect(effortsFor({ any: {}, models: {} }, "grok", undefined)).toEqual(GROK_EFFORTS);
    expect(effortsFor({ any: {}, models: { grok: { "grok-4.5": ["low", "medium", "high"] } } }, "grok", "grok-4.5")).toEqual(["low", "medium", "high"]);
  });

  it("refuses the protected paths its own way: deny rules of one start, a path as it is written", () => {
    const prot = { roots: ["/as/home", "/as/gate"], exempt: [], readDenied: ["/as/gate", "/as/home/local-token"] };
    const launch = agentLauncher({ binaries: { grok: "/bin/grok" }, protected: prot, hookUrl: () => "http://127.0.0.1:4711", stateDir: tmp("deny"), node: "/n/node", hookScript: "/h/hook.js", env: { PATH: "/usr/bin", HOME: "/Users/u" }, grokHooks: () => true });
    const args = launch({ id: "g1", harness: "grok", cwd: "/tmp", mode: "bypass", hookToken: "tok" }).args;
    const denied = args.flatMap((a, i) => (a === "--deny" ? [args[i + 1]] : []));
    // One slash, not Claude Code's two: Grok takes `//` for part of the name. A folder's rule and all under it.
    expect(denied).toEqual(expect.arrayContaining(["Read(/as/gate)", "Read(/as/gate/**)", "Read(/as/home/local-token)", "Edit(/as/home)", "Edit(/as/home/**)", "Edit(/as/gate/**)"]));
    expect(denied.every((r) => /^(Read|Edit)\(\/[^/]/.test(r!))).toBe(true);
    expect(args.slice(0, 2)).toEqual(["--permission-mode", "bypassPermissions"]);   // in every mode
    expect(grokDenyArgs()).toEqual([]);
  });

  it("follows Grok through its hooks: its session and where it is kept, the floor under Claude Code's names, a turn, its sub-agents, its goodbye", async () => {
    const floor = (tool: string, input: Record<string, unknown>) =>
      (String(input.file_path ?? input.path ?? input.command ?? "").includes("local-token") ? `denied ${tool}` : null);
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), floor });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "grok", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const hook = (event: string, payload: Record<string, unknown>) => host.hook(info.id, token, { event, payload: { hook_event_name: event, ...payload } });
    const now = () => host.get(info.id)!;
    const record = `/Users/u/.grok/sessions/%2Fw/${PARENT}/updates.jsonl`;
    // As its TUI starts: the session it writes, before anything is asked of it. A session is a folder named for it.
    await hook("SessionStart", { session_id: PARENT, source: "new", permission_mode: "default", cwd: "/w" });
    expect(now()).toMatchObject({ agentSessionId: PARENT, status: "idle", modeNow: "default", workdir: "/w", hooks: true });
    await hook("UserPromptSubmit", { session_id: PARENT, transcript_path: record, prompt: "list this folder" });
    expect(now().status).toBe("working");
    expect(host.recordFileOf(info.id)).toBe(record);
    // The floor, whatever the mode, under Claude Code's names and fields.
    const deny = (tool: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `denied ${tool}` } });
    expect(await hook("PreToolUse", { session_id: PARENT, tool_name: "read_file", tool_input: { target_file: "/x/local-token" } })).toEqual(deny("Read"));
    expect(await hook("PreToolUse", { session_id: PARENT, tool_name: "run_terminal_command", tool_input: { command: "cat /x/local-token", description: "Read it" } })).toEqual(deny("Bash"));
    expect(await hook("PreToolUse", { session_id: PARENT, tool_name: "write", tool_input: { file_path: "/x/local-token", content: "" } })).toEqual(deny("Write"));
    expect(await hook("PreToolUse", { session_id: PARENT, tool_name: "search_replace", tool_input: { file_path: "/x/local-token", old_string: "a", new_string: "b" } })).toEqual(deny("Edit"));
    expect(await hook("PreToolUse", { session_id: PARENT, tool_name: "list_dir", tool_input: { target_directory: "/x" } })).toBeNull();
    expect(now().activity).toMatchObject({ tool: "LS", target: "/x" });
    // It sends a sub-agent off: named by what it was sent to do, working under its own session's id — and the
    // terminal stays on the session, and in the folder, it was on.
    await hook("PreToolUse", { session_id: PARENT, tool_name: "spawn_subagent", tool_input: { description: "List folder names", prompt: "Run ls -a", background: false }, tool_use_id: "call-1" });
    await hook("SubagentStart", { session_id: PARENT, subagentId: CHILD, subagentType: "general-purpose", description: "List folder names" });
    expect(now().subagents).toMatchObject([{ id: CHILD, type: "general-purpose", name: "List folder names", activity: null }]);
    await hook("UserPromptSubmit", { session_id: CHILD, subagentType: "general-purpose", prompt: "Run ls -a" });
    await hook("PreToolUse", { session_id: CHILD, subagentType: "general-purpose", cwd: "/w/elsewhere", transcript_path: `/Users/u/.grok/sessions/%2Fw/${CHILD}/updates.jsonl`, tool_name: "run_terminal_command", tool_input: { command: "ls -a", description: "List all files" }, tool_use_id: "call-2" });
    expect(now()).toMatchObject({ agentSessionId: PARENT, workdir: "/w", status: "working" });
    expect(host.recordFileOf(info.id)).toBe(record);
    expect(now().subagents[0]!.activity).toEqual({ tool: "Bash", target: "ls -a", note: "List all files" });
    await hook("PostToolUse", { session_id: CHILD, subagentType: "general-purpose", tool_name: "run_terminal_command", tool_input: { command: "ls -a" }, tool_use_id: "call-2" });
    await hook("SubagentStop", { session_id: CHILD, subagentId: CHILD, subagentType: "general-purpose", last_assistant_message: "No names were observed." });
    expect(now().subagents).toEqual([]);
    await hook("SessionEnd", { session_id: CHILD, subagentType: "general-purpose", reason: "shutdown" });
    expect(now().agentSessionId).toBe(PARENT);
    await hook("PostToolUse", { session_id: PARENT, tool_name: "spawn_subagent", tool_input: { description: "List folder names" }, tool_use_id: "call-1" });
    await hook("Stop", { session_id: PARENT, reason: "end_turn", last_assistant_message: "done" });
    expect(now().status).toBe("idle");
    expect(host.lastTurn(info.id)).toMatchObject({ ok: true, line: "done" });
    const ended = host.lastTurn(info.id)!.at;
    // Its goodbye as the program goes — Stop once more, after a turn that ended long ago — is no turn.
    await hook("UserPromptSubmit", { session_id: PARENT, prompt: "and again" });
    await hook("Stop", { session_id: PARENT, reason: "shutdown" });
    await hook("SessionEnd", { session_id: PARENT, reason: "shutdown" });
    expect(now().status).toBe("working");
    expect(host.lastTurn(info.id)).toMatchObject({ at: ended, line: "done" });
  });

  it("waits while Grok asks on its own screen, goes on when the tool it asked about ran or was refused, rests when the turn is given up; compacting is work", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "grok", cwd: tmpdir() });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const hook = (event: string, payload: Record<string, unknown> = {}) => host.hook(info.id, token, { event, payload: { session_id: PARENT, ...payload } });
    const status = () => host.get(info.id)!.status;
    const rm = { tool_name: "run_terminal_command", tool_input: { command: "rm probe-file.txt", description: "Remove it" }, tool_use_id: "call-1" };
    await hook("SessionStart", { source: "new" });
    await hook("UserPromptSubmit", { prompt: "remove it" });
    await hook("PreToolUse", rm);
    // Nothing asks through a hook (Grok has no PermissionRequest): it says that it asks.
    await hook("Notification", { notification_type: "permission_prompt", message: "Tool permission requested" });
    expect(status()).toBe("waiting");
    expect(host.get(info.id)!.permissions).toEqual([]);
    // Answered "yes" on its screen: the tool ran, the turn goes on.
    await hook("PostToolUse", rm);
    expect(status()).toBe("working");
    await hook("Stop", { reason: "end_turn", last_assistant_message: "removed" });
    expect(status()).toBe("idle");
    expect(host.lastTurn(info.id)).toMatchObject({ ok: true, line: "removed" });
    // Refused there: nothing waits; the turn it then gives up is no result to tell of.
    await hook("UserPromptSubmit", { prompt: "again" });
    await hook("PreToolUse", rm);
    await hook("Notification", { notification_type: "permission_prompt" });
    expect(status()).toBe("waiting");
    await hook("PermissionDenied", rm);
    expect(status()).toBe("working");
    await hook("StopCancelled", { reason: "permission_rejected" });
    expect(status()).toBe("idle");
    expect(host.lastTurn(info.id)).toMatchObject({ line: "removed" });
    // It says when it compacts its context, and when that is over: at work on Compact meanwhile, then what it was.
    await hook("PreCompact", { trigger: "manual" });
    expect(host.get(info.id)).toMatchObject({ status: "working", activity: { tool: "Compact" } });
    await hook("PostCompact", { trigger: "manual" });
    expect(host.get(info.id)).toMatchObject({ status: "idle", activity: null });
    // A turn that ended on an error is told as one.
    await hook("UserPromptSubmit", { prompt: "once more" });
    await hook("StopFailure", { error: "rate_limit", error_details: "try again later" });
    expect(host.lastTurn(info.id)).toMatchObject({ ok: false, line: "rate_limit: try again later" });
  });

  it("is named by its session's title alone, and waits for as long as its title says its screen does (the answer given there is in no hook)", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "grok", cwd: join(tmpdir()) });
    const now = () => host.get(info.id)!;
    const title = (t: string) => host.write(info.id, `title ${t}\r`);
    await until(() => now().title === "fake agent");
    // At work: the spinner and the step are not its name.
    title("⠧ - Writing command… - Delete probe-file.txt with rm command - grok");
    await until(() => now().title === "Delete probe-file.txt with rm command");
    expect(now().name).toBe("Delete probe-file.txt with rm command");
    expect(now().status).toBe("idle");   // its hooks say when it works, not its title
    // Something on its screen waits for you.
    title("⚠ Action Required - ⠦ - Remove probe-file.txt as requested… - Delete probe-file.txt with rm command - grok");
    await until(() => now().status === "waiting");
    expect(now().name).toBe("Delete probe-file.txt with rm command");
    // Answered there, and it goes on with the turn.
    title("⠹ - Remove probe-file.txt as requested… - Delete probe-file.txt with rm command - grok");
    await until(() => now().status === "working");
    // Asked again, and refused there: the turn is over.
    title("⚠ Action Required - ⠼ - Remove probe-file.txt as requested… - Delete probe-file.txt with rm command - grok");
    await until(() => now().status === "waiting");
    title("Delete probe-file.txt with rm command - grok");
    await until(() => now().status === "idle");
    expect(now().name).toBe("Delete probe-file.txt with rm command");
  });
});

describe("Grok over HTTP", () => {
  async function start() {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-grok-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agentswitch-grok-cwd-"));
    let base = "";
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const daemon = buildDaemon(cfg, { terminalLauncher: fakeLauncher(() => base, true) });
    const token = ensureLocalToken(home);
    const port = await new Promise<number>((done) => {
      const server = listenLocal(daemon, 0, (info: AddressInfo) => done(info.port), new LocalAuth(token));
      closers.push(() => { server.close(); daemon.close(); });
    });
    daemon.setLocalPort(port);
    base = `http://127.0.0.1:${port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    return { cwd, call, daemon };
  }

  it("is one of the agents a terminal starts, at its own levels; a screen changes its model and its level by its own commands, while it rests", async () => {
    const { cwd, call, daemon } = await start();
    expect((await call("GET", "/terminals")).json.agents).toContain("grok");
    // A level that is not one of Grok's is refused before anything starts.
    expect((await call("POST", "/terminals", { harness: "grok", cwd, effort: "max" })).status).toBe(400);
    const started = await call("POST", "/terminals", { harness: "grok", cwd, model: "grok-4.7", effort: "high", mode: "auto" });
    expect(started.status).toBe(201);
    expect(started.json.terminal).toMatchObject({ harness: "grok", model: "grok-4.7", effort: "high", mode: "auto", status: "idle", sets: true });
    const id = started.json.terminal.id as string;
    const host = daemon.terminals!;
    const screen = () => host.screenTail(id, 30).join("\n");
    await until(() => screen().includes("fake agent ready"));
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "xhigh" })).json).toEqual({ ok: true });
    await until(() => screen().includes("got: /effort xhigh"));
    expect(host.get(id)!.effort).toBe("xhigh");
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "max" })).status).toBe(400);   // Claude Code's, not Grok's
    expect((await call("POST", `/terminals/${id}/model`, { model: "grok-4.6" })).json).toEqual({ ok: true });
    await until(() => screen().includes("grok-4.6"));
    expect(host.get(id)!.modelNow).toBe("grok-4.6");
    // While it works, what is typed would wait in its queue as a message: not then.
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(id)!.hookToken;
    await host.hook(id, token, { event: "UserPromptSubmit", payload: { session_id: PARENT } });
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "low" })).status).toBe(409);
    expect((await call("POST", `/terminals/${id}/model`, { model: "grok-4.5" })).status).toBe(409);
    // It has its own commands for a completion's list.
    const commands = (await call("GET", `/terminals/${id}/commands`)).json.commands as { name: string }[];
    expect(commands.map((c) => c.name)).toEqual(expect.arrayContaining(["model", "effort", "new", "resume"]));
  });
});

describe("the lists Grok draws on its screen", () => {
  const PERMISSION = [
    "  /p/t/c/-/4/s/grokprobe/trustme                                                              24K / 256K │ [Dashboard]",
    "     ❯ Run the shell command: rm probe-file.txt  Then reply with the single word done.                      11:25 AM",
    "     ◆ Thought for 5.2s",
    "     I'll remove probe-file.txt and then reply with the single word you asked for.                          11:26 AM",
    "     ◆ Running remove probe-file.txt as requested",
    "   ◆ Remove probe-file.txt as requested… 1.5s                                                     10s ⇣24.0k [↓][stop]",
    "  ┃",
    "  ┃  ›  Remove probe-file.txt as requested",
    "  ┃  │ rm probe-file.txt",
    "  ┃  ← → narrow scope  ·  e edit pattern",
    "  ┃",
    "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
    "  ┃  2 (○) Always allow: rm probe-file.txt",
    "  ┃  3 (●) Yes, proceed",
    "  ┃  4 (○) No, reject (type to add feedback)",
    "  ┃  5 (○) Never allow: rm probe-file.txt",
    "  ┃",
    "  1/5:select  │  Tab:next option  │  ←/→:scope  │  e:edit pattern  │  Ctrl+o:always-approve  │  Ctrl+c:cancel",
  ];
  const mid = (s: string) => " ".repeat(Math.floor((120 - s.length) / 2)) + s;
  const TRUST = [
    "",
    "  /p/t/c/-/4/s/grokprobe/trustme",
    "", "", "",
    mid("⠀⠀⠀⠀⠀⠀⣀⣀⡀⠀⠀⠀⢀⠄"), mid("⠀⠀⠀⣠⣾⠿⠛⠛⠛⠛⢀⡴⠁⠀"), mid("⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀"), mid("⠀⠀⣿⡇⠀⠀⠀⠔⠁⠀⠀⣿⡇⠀"), mid("⠀⠀⢹⣷⠀⠀⠀⠀⠀⢀⣴⡿⠀⠀"), mid("⠀⢀⠞⠁⠠⢶⣶⣶⣶⠿⠋⠀⠀⠀"), mid("⠐⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀"),
    "", "",
    mid("Do you trust the contents of this directory?"),
    "    /private/tmp/a-folder/with-a-long-name/that-fills-the-row/as-the-real-one-did/scratchpad/work/grokprobe/trustme",
    "",
    mid("Grok Build may run or modify contents in this directory,"),
    mid("posing security risks."),
    "",
    `${" ".repeat(45)}Yes, proceed                 y`,
    `${" ".repeat(45)}No, quit                     n`,
    "", "", "", "", "", "",
    `${" ".repeat(91)}Grok Build  1.0.77 [stable]`,
  ];

  it("what it asks before a tool: numbered rows with a round mark, the filled one selected; above them what it is about to do", () => {
    expect(choicesOnScreen(PERMISSION, 120, "grok")).toEqual({
      title: "Remove probe-file.txt as requested",
      text: "Remove probe-file.txt as requested\nrm probe-file.txt",
      options: [
        { label: "Yes, and don't ask again for anything (always-approve mode)" }, { label: "Always allow: rm probe-file.txt" }, { label: "Yes, proceed" },
        { label: "No, reject (type to add feedback)" }, { label: "Never allow: rm probe-file.txt" },
      ],
      selected: 2,
    });
    // The selection moved (the arrow keys): read where it stands now.
    const moved = PERMISSION.map((l) => l.replace("3 (●)", "3 (○)").replace("4 (○)", "4 (●)"));
    expect(choicesOnScreen(moved, 120, "grok")?.selected).toBe(3);
    // Not a list: none marked, two marked, rows out of order, a single row, rows scrolled far above the screen's end.
    expect(choicesOnScreen(PERMISSION.map((l) => l.replace("(●)", "(○)")), 120, "grok")).toBeNull();
    expect(choicesOnScreen(PERMISSION.map((l) => l.replace("5 (○)", "5 (●)")), 120, "grok")).toBeNull();
    expect(choicesOnScreen(PERMISSION.map((l) => l.replace("  ┃  2 (○)", "  ┃  7 (○)")), 120, "grok")).toBeNull();
    expect(choicesOnScreen(["  ┃  1 (●) Yes, proceed", "  1/1:select"], 120, "grok")).toBeNull();
    expect(choicesOnScreen([...PERMISSION, ...Array.from({ length: 8 }, (_, i) => `   an answer's line ${i}`)], 120, "grok")).toBeNull();
    // Only Grok draws it: on another agent's screen such rows are words.
    expect(choicesOnScreen(PERMISSION, 120, "claude-code")).toBeNull();
    expect(choicesOnScreen(PERMISSION, 120)).toBeNull();
  });

  it("its question about a folder it does not trust: two rows, each with the key that takes it; nothing marked, Enter takes the first", () => {
    const read = choicesOnScreen(TRUST, 120, "grok");
    expect(read).toMatchObject({ options: [{ label: "Yes, proceed", key: "y" }, { label: "No, quit", key: "n" }], selected: 0 });
    expect(read!.title).toContain("Do you trust the contents of this directory?");
    expect(read!.title).toContain("/grokprobe/trustme");
    // All it says above the rows, without the logo it draws.
    expect(read!.text).toContain("Grok Build may run or modify contents in this directory,");
    expect(read!.text).not.toMatch(/[⠀-⣿]/u);
    // Not such a list: rows whose key is not their own first letter, one row, rows under nothing that asks, rows far
    // above the screen's end — an answer may hold lines that end in a letter.
    expect(choicesOnScreen(TRUST.map((l) => l.replace(/y$/, "p")), 120, "grok")).toBeNull();
    expect(choicesOnScreen(TRUST.filter((l) => !l.includes("No, quit")), 120, "grok")).toBeNull();
    expect(choicesOnScreen(["Two ways to go:", "", "    alpha        a", "    beta         b"], 120, "grok")).toBeNull();
    expect(choicesOnScreen([...TRUST, "one more line", "and another", "and a third"], 120, "grok")).toBeNull();
    expect(choicesOnScreen(TRUST, 120, "codex")).toBeNull();
  });

  it("a screen takes a row as the terminal would: the arrow keys and Enter in the list before a tool, the row's key in the folder question", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9", true), choiceLookMs: 30 });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "grok", cwd: tmpdir() });
    const screen = () => host.screenTail(info.id, 30).join("\n");
    await until(() => screen().includes("fake agent ready"));
    host.write(info.id, "grokperm\r");
    const list = await until(() => host.get(info.id)!.choices);
    expect(list).toMatchObject({ title: "Remove probe-file.txt as requested", selected: 2 });
    expect(list.options.map((o) => o.label)[3]).toBe("No, reject (type to add feedback)");
    // A row that is not what the screen shows there: nothing is typed.
    expect(() => host.choose(info.id, 3, "Yes, proceed")).toThrow(/no longer shows/);
    host.choose(info.id, 3, "No, reject (type to add feedback)");
    await until(() => screen().includes("permission: No, reject (type to add feedback)"));
    await until(() => host.get(info.id)!.choices === null);
    // The folder question: keys one at a time, as a full-screen program takes them.
    host.write(info.id, "raw\r");
    await until(() => screen().includes("raw on"));
    host.write(info.id, "groktrust\r");
    const asked = await until(() => host.get(info.id)!.choices);
    expect(asked).toMatchObject({ options: [{ label: "Yes, proceed", key: "y" }, { label: "No, quit", key: "n" }], selected: 0 });
    host.choose(info.id, 1, "No, quit");
    await until(() => screen().includes("folder: No, quit"));
  });
});

describe("Grok's sessions", () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  /** A session as Grok 1.0.77 keeps one: its folder under the folder it ran in, `summary.json`, `updates.jsonl`. */
  function session(root: string, cwd: string, id: string, o: { title?: string; kind?: string; updates: { type: string; more: Record<string, unknown>; at: number }[]; children?: string[] }): string {
    const dir = join(root, encodeURIComponent(cwd), id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({
      info: { id, cwd }, ...(o.title ? { generated_title: o.title, session_summary: o.title } : {}), created_at: iso(now - 60_000), updated_at: iso(now - 5_000), last_active_at: iso(now - 5_000),
      current_model_id: "grok-4.7", reasoning_effort: "xhigh", agent_name: "grok-build-plan", ...(o.kind ? { session_kind: o.kind } : {}),
    }));
    writeFileSync(join(dir, "updates.jsonl"), o.updates.map((u) => JSON.stringify({ timestamp: Math.floor(u.at / 1000), method: u.type.startsWith("hook") || u.type === "turn_completed" ? "_x.ai/session/update" : "session/update",
      params: { sessionId: id, update: { sessionUpdate: u.type, ...u.more }, _meta: { agentTimestampMs: u.at } } })).join("\n") + "\n");
    for (const child of o.children ?? []) mkdirSync(join(dir, "subagents", child), { recursive: true });
    return dir;
  }
  const said = (type: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk", text: string, at: number) => ({ type, more: { content: { type: "text", text } }, at });
  function fixture() {
    const root = tmp("sessions");
    const grokSessions = join(root, "grok", "sessions");
    const sources: SessionSources = { claudeProjects: join(root, "claude"), codexSessions: join(root, "codex"), opencodeDb: join(root, "none.db"), grokSessions, excluded: ["/tmp/"] };
    const dir = session(grokSessions, "/Users/u/code/fan", PARENT, {
      title: "Tidy the fan control", children: [CHILD],
      updates: [
        { type: "hook_execution", more: { event_name: "session_start", runs: [] }, at: now - 60_000 },
        said("user_message_chunk", "风扇控制在断网后会回退吗", now - 50_000),
        said("agent_thought_chunk", "Looking at the config first.", now - 45_000),
        said("agent_message_chunk", "先看一下 fanctl 的配置。", now - 40_000),
        { type: "tool_call", more: { toolCallId: "call-1", title: "run_terminal_command", rawInput: { command: "grep -n fallback fanctl.toml", description: "Find the fallback" }, _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } } }, at: now - 35_000 },
        { type: "tool_call_update", more: { toolCallId: "call-1", kind: "execute", title: "Execute `grep -n fallback fanctl.toml`" }, at: now - 34_000 },
        said("agent_message_chunk", "会：offline_fallback = true，断网后回到固定转速。", now - 10_000),
        { type: "turn_completed", more: { stop_reason: "end_turn" }, at: now - 9_000 },
      ],
    });
    // The sub-agent it sent off is a session of its own among the others, marked as one.
    const child = session(grokSessions, "/Users/u/code/fan", CHILD, { title: "Read the fan config", kind: "subagent", updates: [said("user_message_chunk", "read fanctl.toml", now - 30_000), said("agent_message_chunk", "offline_fallback = true", now - 29_000)] });
    const other = session(grokSessions, "/Users/u/code/site", "01a1c8a5-0000-7000-8000-000000000001", { updates: [said("user_message_chunk", "换一下首页的配色", now - 20_000), said("agent_message_chunk", "换好了。", now - 15_000)] });
    return { sources, grokSessions, dir, child, other };
  }

  it("are listed with the others: Grok's own title for each, its latest words, its model, where it ran; a sub-agent's session is not one", () => {
    const f = fixture();
    const list = new SessionMonitor(f.sources).list();
    const of = (id: string) => list.find((s) => s.id === id)!;
    expect(list.map((s) => `${s.harness}:${s.id}`).sort()).toEqual([`grok:${PARENT}`, "grok:01a1c8a5-0000-7000-8000-000000000001"]);
    expect(of(PARENT)).toMatchObject({ harness: "grok", id: PARENT, cwd: "/Users/u/code/fan", title: "Tidy the fan control", lastText: "会：offline_fallback = true，断网后回到固定转速。", model: "grok-4.7", active: true });
    expect(of(PARENT).startedAt).toBe(now - 60_000);
    // Without a title of Grok's: the first thing typed.
    expect(of("01a1c8a5-0000-7000-8000-000000000001")).toMatchObject({ title: "换一下首页的配色", lastText: "换好了。", cwd: "/Users/u/code/site" });
    expect(grokFacts(join(f.child, "updates.jsonl"), now)).toBeNull();
    // Grok's own title stands; a session it has not named goes by the title its terminal showed (sessions/titles.ts).
    const kept = new SessionMonitor({ ...f.sources, agentTitle: () => "From the terminal" }).list();
    expect(kept.find((s) => s.id === PARENT)).toMatchObject({ title: "Tidy the fan control", named: true });
    expect(kept.find((s) => s.id === "01a1c8a5-0000-7000-8000-000000000001")).toMatchObject({ title: "From the terminal" });
    // A folder that is no session's, and a session whose summary is not written yet (its folder's name says where it ran).
    expect(grokFacts(join(f.grokSessions, "nowhere", "x", "updates.jsonl"), now)).toBeNull();
    rmSync(join(f.other, "summary.json"));
    expect(grokFacts(join(f.other, "updates.jsonl"), now)).toMatchObject({ id: "01a1c8a5-0000-7000-8000-000000000001", cwd: "/Users/u/code/site", title: "换一下首页的配色" });
  });

  it("are read: what was typed, the replies, a line a tool call — not its thinking, its hooks or a turn's end", () => {
    const f = fixture();
    const monitor = new SessionMonitor(f.sources);
    const read = monitor.read("grok", PARENT)!;
    expect(read.messages.map((m) => [m.role, m.tool ?? "", m.text])).toEqual([
      ["user", "", "风扇控制在断网后会回退吗"],
      ["assistant", "", "先看一下 fanctl 的配置。"],
      ["tool", "run_terminal_command", "grep -n fallback fanctl.toml"],
      ["assistant", "", "会：offline_fallback = true，断网后回到固定转速。"],
    ]);
    expect(read.messages[0]!.ts).toBe(now - 50_000);
    expect(grokMessages(join(f.dir, "updates.jsonl"), 2).map((m) => m.role)).toEqual(["tool", "assistant"]);
    // The simple view's record, from the same messages.
    expect(monitor.record("grok", PARENT)!.record.items.length).toBeGreaterThan(0);
    // Where it is kept: its conversation, in the folder named for it — also one the list leaves out (a terminal of ours).
    expect(monitor.locate("grok", PARENT)).toBe(join(f.dir, "updates.jsonl"));
    expect(monitor.source("grok", PARENT)).toBe(join(f.dir, "updates.jsonl"));
    expect(new SessionMonitor(f.sources).locate("grok", CHILD)).toBe(join(f.child, "updates.jsonl"));
    expect(monitor.locate("grok", "../../etc")).toBeNull();
    // A session the list leaves out (it ran in a scratch folder) is read all the same when it is a terminal's of ours —
    // the simple view of such a terminal had no record (found with scripts/grok_terminal_probe.ts, 2026-11-11) — and
    // by nobody else.
    const scratch = new SessionMonitor({ ...f.sources, excluded: ["/Users/u/code/fan"] });
    expect(scratch.list().map((s) => s.id)).not.toContain(PARENT);
    expect(scratch.record("grok", PARENT)).toBeNull();
    const ours = scratch.record("grok", PARENT, {}, true)!;
    expect(ours.session).toMatchObject({ id: PARENT, cwd: "/Users/u/code/fan", title: "Tidy the fan control" });
    expect(ours.record.items.map((i) => i.type)).toEqual(expect.arrayContaining(["user", "answer"]));
  });

  it("are searched by what was said in them", async () => {
    const f = fixture();
    const search = new SessionSearch(new SessionMonitor(f.sources));
    expect((await search.search("fanctl")).map((h) => `${h.harness}:${h.id}`)).toEqual([`grok:${PARENT}`]);
    expect((await search.search("配色")).map((h) => h.id)).toEqual(["01a1c8a5-0000-7000-8000-000000000001"]);
    // Its thinking and its tools' input are not what was said.
    expect(await search.search("Looking at the config")).toEqual([]);
    expect(await search.search("grep -n fallback")).toEqual([]);
  });

  it("are deleted whole: the session's own folder and those of the sub-agents it sent off, nothing else", async () => {
    const f = fixture();
    const monitor = new SessionMonitor(f.sources);
    monitor.list();
    expect(await monitor.remove("grok", PARENT)).toEqual({ removed: [f.child, f.dir], failed: [] });
    expect(existsSync(f.dir)).toBe(false);
    expect(existsSync(f.child)).toBe(false);
    expect(existsSync(f.other)).toBe(true);
    expect(monitor.list().map((s) => s.id)).toEqual(["01a1c8a5-0000-7000-8000-000000000001"]);
    // One that is not there, or no id at all: nothing happens.
    expect(await monitor.remove("grok", PARENT)).toEqual({ removed: [], failed: [] });
    expect(await monitor.remove("grok", "../site")).toEqual({ removed: [], failed: [] });
    expect(existsSync(f.other)).toBe(true);
  });

  it("one open in another program is found by Grok's own list of what is open; not one of ours, not a stale entry", async () => {
    const home = tmp("elsewhere");
    const grok = join(home, ".grok");
    mkdirSync(grok);
    const file = join(grok, "active_sessions.json");
    expect(grokRunning(file, "in-iterm")).toEqual([]);   // no list yet
    writeFileSync(file, JSON.stringify([
      { session_id: "in-iterm", pid: 100, pid_start: 1, cwd: "/w", opened_at: "2026-11-10T16:03:27Z" }, { session_id: "in-ours", pid: 200 }, { session_id: "gone", pid: 300 }, { session_id: "reused", pid: 400 }, { session_id: "odd", pid: "x" },
    ]));
    expect(grokRunning(file, "in-iterm")).toEqual([100]);
    expect(grokRunning(file, "odd")).toEqual([]);
    const table = new Map<number, Proc>([
      [100, { ppid: 90, comm: "/Users/u/.grok/bin/grok" }], [90, { ppid: 80, comm: "-zsh" }], [80, { ppid: 1, comm: "/Applications/iTerm.app/Contents/MacOS/iTerm2" }],
      [200, { ppid: 210, comm: "grok" }], [210, { ppid: 1, comm: "node" }],
      [400, { ppid: 1, comm: "/Applications/Safari.app/Contents/MacOS/Safari" }],
    ]);
    const check = elsewhereCheck({ home, grokHome: grok, processes: async () => table, alive: (pid) => pid !== 300, appName: async () => "iTerm2" });
    expect(await check("grok", "in-iterm", [210])).toEqual({ pid: 100, app: "iTerm2" });
    expect(await check("grok", "in-ours", [210])).toBeNull();
    expect(await check("grok", "gone", [210])).toBeNull();
    expect(await check("grok", "reused", [210])).toBeNull();
    expect(await check("grok", "never-open", [210])).toBeNull();
  });
});

describe("Grok's models and commands", () => {
  const SAID = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5\n  - grok-next\n";
  const efforts = (...levels: string[]) => levels.map((value) => ({ id: value, value, label: value, description: "", default: value === "high" }));
  function home(config = '[cli]\nauto_update = true\n\n[models]\ndefault = "grok-4.7"\ndefault_reasoning_effort = "xhigh"\n\n[privacy]\ndefault_reasoning_effort = "low"\n'): string {
    const dir = tmp("models");
    const model = (id: string, name: string, description: string, levels: string[], more: Record<string, unknown> = {}) => [id, { info: { id, model: id, name, description, hidden: false, supports_reasoning_effort: true, reasoning_effort: "high", reasoning_efforts: efforts(...levels), ...more }, api_key: null }];
    writeFileSync(join(dir, "models_cache.json"), JSON.stringify({ fetched_at: "2026-11-11T03:19:11Z", grok_version: "1.0.77", models: Object.fromEntries([
      model("grok-4.7", "Grok 4.7", "SpaceXAI's latest frontier model", ["xhigh", "high", "medium", "low"]),
      model("grok-4.7-build-fast", "Grok 4.7 Fast", "Fast variant. 2x the price.", ["xhigh", "high", "medium", "low"]),
      model("grok-4.6", "Grok 4.6", "", ["xhigh", "high", "medium", "low"]),
      model("grok-4.5", "Grok 4.5", "", ["high", "medium", "low"]),
      model("grok-internal", "Internal", "", ["high"], { hidden: true }),
      model("grok-plain", "Plain", "", [], { supports_reasoning_effort: false, reasoning_efforts: null }),
    ]) }));
    writeFileSync(join(dir, "config.toml"), config);
    return dir;
  }
  function program(output: string, code = 0): string {
    const file = join(tmp("bin"), "grok");
    writeFileSync(file, `#!/bin/sh\n[ "$1" = models ] || exit 9\ncat <<'EOF'\n${output}EOF\nexit ${code}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  it("`grok models` says which models and which one new sessions start on; the list Grok keeps says the rest of each", async () => {
    expect(parseGrokModels(SAID)).toEqual({ ids: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5", "grok-next"], byDefault: "grok-4.7" });
    expect(parseGrokModels("Available models:\n  - a\n  * b (default)\n")).toEqual({ ids: ["a", "b"], byDefault: "b" });
    expect(parseGrokModels("error: not signed in\n")).toEqual({ ids: [], byDefault: null });
    const dir = home();
    const kept = grokKeptModels(dir);
    expect(kept.map((m) => m.id)).toEqual(["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5", "grok-plain"]);   // not the one it hides
    expect(kept[0]).toEqual({ id: "grok-4.7", name: "Grok 4.7", description: "SpaceXAI's latest frontier model", efforts: ["xhigh", "high", "medium", "low"], defaultEffort: "high" });
    expect(kept.find((m) => m.id === "grok-plain")).toEqual({ id: "grok-plain", name: "Plain", efforts: [] });   // it takes no level
    expect(grokKeptModels(tmp("none"))).toEqual([]);
    // What the user's own Grok starts a session on, as its config.toml has it: under [models] only.
    expect(grokOwnDefaults(dir)).toEqual({ model: "grok-4.7", effort: "xhigh" });
    expect(grokOwnDefaults(home("[models]\ndefault = \"grok-4.6\"\n"))).toEqual({ model: "grok-4.6", effort: null });
    expect(grokOwnDefaults(home("default_reasoning_effort = \"low\"\ndefault = \"x\"\n[models]\n"))).toEqual({ model: null, effort: null });
    expect(grokOwnDefaults(home("[models]\ndefault = \"not a model\"\ndefault_reasoning_effort = \"X High\"\n"))).toEqual({ model: null, effort: null });
    expect(grokOwnDefaults(tmp("none"))).toEqual({ model: null, effort: null });
    const list = await listGrokModels(program(SAID), dir);
    expect(list.map((m) => m.id)).toEqual(["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5", "grok-next"]);
    // Which one new sessions start on, as the command said; each at Grok's own level for it.
    expect(list[0]).toEqual({ id: "grok-4.7", name: "Grok 4.7", description: "SpaceXAI's latest frontier model", efforts: ["xhigh", "high", "medium", "low"], defaultEffort: "high", isDefault: true });
    expect(list[2]).toEqual({ id: "grok-4.6", name: "Grok 4.6", efforts: ["xhigh", "high", "medium", "low"], defaultEffort: "high" });
    expect(list[4]).toEqual({ id: "grok-next" });   // listed by the command, not known to the kept list: under its id
    // The command does not answer: the kept list alone. Neither: said so.
    expect((await listGrokModels(join(tmp("gone"), "grok"), dir)).map((m) => m.id)).toEqual(["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5", "grok-plain"]);
    await expect(listGrokModels(program("error: not signed in\n", 1), tmp("none"))).rejects.toThrow(/lists no models/);
    await expect(listGrokModels(program(SAID), null)).resolves.toMatchObject([{ id: "grok-4.7", isDefault: true }, { id: "grok-4.7-build-fast" }, { id: "grok-4.6" }, { id: "grok-4.5" }, { id: "grok-next" }]);
  });

  it("are offered for a new terminal's menus as the others are: the default named, each model's levels lowest first, the older ones marked", async () => {
    const dir = home();
    const list = await listGrokModels(program(SAID), dir);
    const offer = grokOffer(list);
    expect(offer).toMatchObject({ defaultName: "Grok 4.7", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" });
    // The user's own default model and level come first, where they name one of these and a level that model takes.
    expect(grokOffer(list, { model: null, effort: "xhigh" })).toMatchObject({ defaultName: "Grok 4.7", defaultEffort: "xhigh" });
    expect(grokOffer(list, { model: null, effort: "xhigh" }).models[0]).toMatchObject({ id: "grok-4.7", defaultEffort: "xhigh" });
    expect(grokOffer(list, { model: null, effort: "xhigh" }).models[2]).toMatchObject({ id: "grok-4.6", defaultEffort: "high" });   // the others at Grok's own
    expect(grokOffer(list, { model: "grok-4.6", effort: "low" })).toMatchObject({ defaultName: "Grok 4.6", defaultEffort: "low" });
    expect(grokOffer(list, { model: "grok-4.5", effort: "xhigh" })).toMatchObject({ defaultName: "Grok 4.5", efforts: ["low", "medium", "high"], defaultEffort: "high" });   // 4.5 has no xhigh
    expect(grokOffer(list, { model: "grok-gone", effort: "ultra" })).toEqual(offer);
    expect(offer.models.map((m) => [m.id, m.name, m.older ?? false])).toEqual([
      ["grok-4.7", "Grok 4.7", false], ["grok-4.7-build-fast", "Grok 4.7 Fast", false], ["grok-4.6", "Grok 4.6", true], ["grok-4.5", "Grok 4.5", true], ["grok-next", "grok-next", false],
    ]);
    expect(offer.models[3]).toMatchObject({ efforts: ["low", "medium", "high"], defaultEffort: "high" });
    expect(offer.models[4]!.efforts).toBeUndefined();   // not said: Grok's own levels then (harness/efforts.ts)
    const offers = new ModelOffers({ log: () => undefined, listClaude: async () => [], listCodex: async () => [], listGrok: async () => list });
    // Only a terminal runs Grok: its ids are no part of what the router's catalog is given.
    expect(await offers.refresh()).toEqual({ "claude-code": [], codex: [] });
    expect(offers.current().grok).toEqual(offer);
    // An answer that failed keeps what was offered before.
    let fail = false;
    const flaky = new ModelOffers({ log: () => undefined, listClaude: async () => [], listCodex: async () => [], listGrok: async () => { if (fail) throw new Error("no"); return list; } });
    await flaky.refresh();
    fail = true;
    await flaky.refresh();
    expect(flaky.current().grok?.defaultName).toBe("Grok 4.7");
    // What "default" is follows the user's own Grok as it stands when asked — a `/model` or an `/effort` typed in any
    // session of theirs writes its config.toml — not as it stood when the models were last listed.
    const live = new ModelOffers({ log: () => undefined, listClaude: async () => [], listCodex: async () => [], listGrok: async () => list, grokHome: dir });
    await live.refresh();
    expect(live.current().grok).toMatchObject({ defaultName: "Grok 4.7", defaultEffort: "xhigh" });
    writeFileSync(join(dir, "config.toml"), '[models]\ndefault = "grok-4.6"\ndefault_reasoning_effort = "low"\n');
    utimesSync(join(dir, "config.toml"), new Date(), new Date(Date.now() + 5000));
    expect(live.current().grok).toMatchObject({ defaultName: "Grok 4.6", defaultEffort: "low" });
    expect(live.current().grok!.models.find((m) => m.id === "grok-4.7")).toMatchObject({ defaultEffort: "high" });
    rmSync(join(dir, "config.toml"));
    expect(live.current().grok).toMatchObject({ defaultName: "Grok 4.7", defaultEffort: "high" });   // none of its own: as Grok said
  });

  it("its commands for a completion's list: its own, and the skills and commands it would load for the folder", () => {
    const root = tmp("commands");
    const userHome = join(root, "home"), cwd = join(root, "repo", "pkg");
    const skill = (dir: string, name: string, front: string, body = "Do the thing.") => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, "SKILL.md"), `---\n${front}\n---\n\n${body}\n`); };
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    skill(join(cwd, ".grok", "skills"), "deploy", "name: deploy\ndescription: Ship the current branch");
    skill(join(cwd, ".grok", "skills"), "internal", "name: internal\ndescription: Not for typing\nuser-invocable: false");
    skill(join(root, "repo", ".agents", "skills"), "review-folder", "name: review\ndescription: Review the diff");
    mkdirSync(join(cwd, ".grok", "commands"), { recursive: true });
    writeFileSync(join(cwd, ".grok", "commands", "lint.md"), "Run the linters and fix what they find.\n");
    skill(join(userHome, ".grok", "skills"), "notes", "description: Keep notes");
    skill(join(root, ".grok", "skills"), "above-the-repo", "description: Not this project's");
    const commands = slashCommands("grok", cwd, userHome);
    const by = (name: string) => commands.find((c) => c.name === name);
    expect(by("deploy")).toEqual({ name: "deploy", description: "Ship the current branch", source: "project" });
    expect(by("review")).toEqual({ name: "review", description: "Review the diff", source: "project" });   // named by its front matter, from the repository's root
    expect(by("lint")).toEqual({ name: "lint", description: "Run the linters and fix what they find.", source: "project" });
    expect(by("notes")).toEqual({ name: "notes", description: "Keep notes", source: "user" });
    expect(by("internal")).toBeUndefined();
    expect(by("above-the-repo")).toBeUndefined();
    expect(by("effort")).toMatchObject({ source: "builtin" });
    expect(by("model")).toMatchObject({ source: "builtin" });
    // Project first, then the user's, then its own; each alphabetical.
    expect(commands.slice(0, 4).map((c) => c.name)).toEqual(["deploy", "lint", "review", "notes"]);
    expect(commands.filter((c) => c.source === "builtin").map((c) => c.name)).toEqual([...commands.filter((c) => c.source === "builtin").map((c) => c.name)].sort());
  });

  it("the program a terminal starts: the one chosen (GROK_BIN), else where it is found, else where its installer puts it", () => {
    const root = tmp("bins");
    const userHome = join(root, "home");
    const program = (dir: string): string => { mkdirSync(dir, { recursive: true }); const path = join(dir, "grok"); writeFileSync(path, "#!/bin/sh\n"); chmodSync(path, 0o755); return path; };
    const targets = { harnesses: {} } as unknown as Parameters<typeof terminalBinaries>[0];
    const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ HOME: userHome, PATH: join(root, "bin"), ...extra });
    expect(terminalBinaries(targets, "", env()).grok).toBeUndefined();
    const installed = program(join(userHome, ".grok", "bin"));
    expect(terminalBinaries(targets, "", env()).grok).toBe(installed);
    const linked = program(join(userHome, ".local", "bin"));
    expect(terminalBinaries(targets, "", env()).grok).toBe(linked);
    const onPath = program(join(root, "bin"));
    expect(terminalBinaries(targets, "", env()).grok).toBe(onPath);
    const chosen = program(join(root, "chosen"));
    expect(terminalBinaries(targets, "", env({ GROK_BIN: chosen })).grok).toBe(chosen);
    // A choice that is gone is not followed.
    expect(terminalBinaries(targets, "", env({ GROK_BIN: join(root, "nowhere", "grok") })).grok).toBe(onPath);
  });
});
