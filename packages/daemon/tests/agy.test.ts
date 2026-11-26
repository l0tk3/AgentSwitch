/** Antigravity CLI as a terminal agent (docs/terminal-v0.md §3 Antigravity; 2026-11-26, user #508): how a terminal
 *  starts it, what the service makes of its status line, its folder trust, its lists, its conversations among the
 *  others, its models and its Chat Room entry. Shapes as `agy` 1.5.17 wrote them on this Mac (a real turn that asked
 *  before a command; scripts/agy_terminal_probe.ts runs the real program). Nothing here starts it or reads `~/.gemini`. */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLocalToken, LocalAuth } from "../src/api/localAuth.js";
import { buildDaemon, listenLocal, terminalBinaries, type DaemonConfig } from "../src/daemon.js";
import { AGY_EFFORTS, effortArgs, effortsFor } from "../src/harness/efforts.js";
import { agyFamilies, agyNamed, agyOwnModel, parseAgyModels } from "../src/models/agyModels.js";
import { agyOffer, ModelOffers } from "../src/models/modelOffers.js";
import { agyGeminiDir, agyHome, agyMessages, agyToolCalls, agyTranscript } from "../src/sessions/agy.js";
import { SessionMonitor, type SessionSources } from "../src/sessions/monitor.js";
import { SessionSearch } from "../src/sessions/search.js";
import { AGY_MCP_SERVER, agyDenyRules, agyInputEmpty, agyMcpEntry, agySettings, agyStatus, ensureAgyMcp } from "../src/terminals/agy.js";
import { slashCommands } from "../src/terminals/commands.js";
import { elsewhereCheck, type Proc } from "../src/terminals/elsewhere.js";
import { choicesOnScreen, TerminalHost, type Launcher } from "../src/terminals/host.js";
import { agentLauncher, HOOK_SCRIPT } from "../src/terminals/launch.js";
import { agySettingsFile, pretrust, trustInAgy } from "../src/terminals/trustedFolders.js";
import { TARGETS_PATH } from "./helpers.js";

const FAKE = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

const fakeLauncher = (url: () => string): Launcher => (req) => ({
  file: process.execPath,
  args: [FAKE],
  env: { ...(process.env as Record<string, string>), FAKE_HOOK_SCRIPT: HOOK_SCRIPT, AGENTSWITCH_TERMINAL_ID: req.id, AGENTSWITCH_TERMINAL_URL: url(), AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken },
  hooks: true,
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

const tmp = (name: string): string => realpathSync(mkdtempSync(join(tmpdir(), `agentswitch-agy-${name}-`)));
const A = "a351c1cc-b89b-4864-b864-b3cdb46bafa8", B = "b351c1cc-b89b-4864-b864-b3cdb46bafa8";

/** What `agy models` printed for this account. */
const MODELS = `Fetching available models...
gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)
gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)
gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)
gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;

describe("an Antigravity terminal", () => {
  it("starts with its status line and how it asks as settings of that one start; the model's level is its id's ending", () => {
    const stateDir = tmp("launch");
    let looked = 0;
    const launch = agentLauncher({ binaries: { agy: "/bin/agy" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, node: "/n/node", hookScript: "/h/hook.js", roomKitScript: "/k/kit.js", env: { PATH: "/usr/bin", HOME: "/nowhere" }, agyMcp: () => { looked++; return true; } });
    const plain = launch({ id: "a1", harness: "agy", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    // Asking each time is stated (it starts in `auto` unless told), and its status line is the hook program.
    expect(plain.args[0]).toBe("--settings");
    expect(JSON.parse(plain.args[1]!)).toEqual({ agentMode: "", toolPermission: "request-review", statusLine: { type: "command", command: '"/n/node" "/h/hook.js" agy', enabled: true } });
    expect(plain.args.slice(2)).toEqual([]);
    expect(plain.hooks).toBe(true);
    // No look for a new version; the entry in its MCP configuration is looked for at the start, and the kit's
    // server has the terminal from the environment agy hands it.
    expect(looked).toBe(1);
    expect(plain.env).toMatchObject({ AGENTSWITCH_TERMINAL_ID: "a1", AGENTSWITCH_TERMINAL_HOOK_TOKEN: "tok", AGENTSWITCH_TERMINAL_URL: "http://127.0.0.1:4711", AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
    // The level goes into the model's id: named beside `--effort`, the program takes neither.
    const chosen = launch({ id: "a2", harness: "agy", cwd: "/tmp", model: "gemini-4-hydrogen-high", effort: "low", mode: "auto", hookToken: "tok" });
    expect(JSON.parse(chosen.args[1]!)).toEqual({ statusLine: { type: "command", command: '"/n/node" "/h/hook.js" agy', enabled: true } });
    expect(chosen.args.slice(2)).toEqual(["--model", "gemini-4-hydrogen-low", "--mode", "auto"]);
    expect(launch({ id: "a3", harness: "agy", cwd: "/tmp", effort: "xhigh", mode: "bypass", hookToken: "tok" }).args.slice(2)).toEqual(["--effort", "xhigh", "--dangerously-skip-permissions"]);
    expect(launch({ id: "a4", harness: "agy", cwd: "/tmp", model: "claude-sonnet-4-6", mode: "manual", hookToken: "tok" }).args.slice(2)).toEqual(["--model", "claude-sonnet-4-6"]);
    // "Continue" goes on in the same conversation; it has no flag for a fork.
    expect(launch({ id: "a5", harness: "agy", cwd: "/tmp", resume: A, fork: true, mode: "manual", hookToken: "tok" }).args.slice(2)).toEqual(["--conversation", A]);
    // A home of AgentSwitch's own naming is the program's own flag for one.
    const moved = agentLauncher({ binaries: { agy: "/bin/agy" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, env: { PATH: "/usr/bin", AGENTSWITCH_AGY_HOME: "/x/gem" } })({ id: "a6", harness: "agy", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    expect(moved.args[0]).toBe("--gemini_dir=/x/gem");
    expect(() => agentLauncher({ binaries: {}, hookUrl: () => "http://127.0.0.1:4711", stateDir, env: {} })({ id: "a7", harness: "agy", cwd: "/tmp", mode: "manual", hookToken: "tok" })).toThrow(/not installed/);
    expect(agySettings("auto", null)).toEqual({});
    // Its levels, and how one is named at a start.
    expect(effortArgs("agy", "high", undefined)).toEqual({ args: ["--effort", "high"], model: undefined });
    expect(effortArgs("agy", "max", "gemini-3.8-flash-low")).toEqual({ args: [], model: "gemini-3.8-flash-max" });
    expect(effortArgs("agy", "high", "claude-opus-4-6-thinking")).toEqual({ args: [], model: "claude-opus-4-6-thinking" });
    expect(effortArgs("agy", "minimal", "gemini-3.8-flash-low")).toEqual({ args: [], model: "gemini-3.8-flash-low" });
    expect(effortsFor({ any: {}, models: {} }, "agy", undefined)).toEqual(AGY_EFFORTS);
    expect(effortsFor({ any: {}, models: { agy: { "claude-sonnet-4-6": [] } } }, "agy", "claude-sonnet-4-6")).toBeNull();
  });

  it("refuses the protected paths by its own rules: no reading, no writing, no command naming them", () => {
    const stateDir = tmp("deny");
    const prot = { roots: ["/Users/u/.agentswitch/vault", "/Library/Application Support/AgentSwitch/gate-public/gate.sock"], exempt: [], readDenied: ["/Users/u/.secret-gate"] };
    const launch = agentLauncher({ binaries: { agy: "/bin/agy" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, node: "/n/node", hookScript: "/h/hook.js", env: { PATH: "/usr/bin", HOME: "/Users/u" }, protected: prot });
    const deny: string[] = JSON.parse(launch({ id: "d1", harness: "agy", cwd: "/tmp", mode: "manual", hookToken: "tok" }).args[1]!).permissions.deny;
    expect(deny).toContain("read_file(/Users/u/.agentswitch/vault)");
    expect(deny).toContain("write_file(/Users/u/.agentswitch/vault)");
    // Read-denied but not protected: no reading; write is refused with the read (its own rule says so).
    expect(deny).toContain("read_file(/Users/u/.secret-gate)");
    // A command that names it: its own word, at any of the first ten (`regex:` words are tried position by position;
    // `.agentswitch/vault` is also in the ~, $HOME and data-volume spellings of the word).
    expect(deny).toContain("command(regex:.*\\.agentswitch/vault.*)");
    expect(deny).toContain("command(regex:.* .*\\.agentswitch/vault.*)");
    // A path with a space: the file rule as written, and the word after its last space for a command.
    expect(deny).toContain("read_file(/Library/Application Support/AgentSwitch/gate-public/gate.sock)");
    expect(deny).toContain("command(regex:.* .*Support/AgentSwitch/gate-public/gate\\.sock.*)");
    // Nothing to refuse, nothing sent.
    expect(agyDenyRules(undefined)).toEqual([]);
    expect(agySettings("auto", null)).toEqual({});
  });

  it("its status line is read: what it does, whether it waits, how it asks, its title and model", () => {
    expect(agyStatus({ agent_state: "initializing" }, "manual")).toMatchObject({ state: null, mode: null });
    expect(agyStatus({ agent_state: "idle", model: "Gemini 4 Hydrogen (High)", at: 5 }, "manual")).toEqual({ state: "idle", mode: "default", title: "", model: "Gemini 4 Hydrogen (High)", at: 5 });
    expect(agyStatus({ agent_state: "working" }, "manual").state).toBe("working");
    expect(agyStatus({ agent_state: "tool_use", tool_confirmation_pending: true }, "manual").state).toBe("waiting");
    expect(agyStatus({ agent_state: "tool_use", tool_confirmation_pending: false }, "manual").state).toBe("working");
    expect(agyStatus({ agent_state: "reviewing" }, "manual").state).toBe("waiting");
    expect(agyStatus({ agent_state: "error" }, "manual").state).toBe("error");
    expect(agyStatus({ agent_state: "idle", cycle_mode: "auto", conversation_title: " Run  Shell Command Rm " }, "auto")).toMatchObject({ mode: "auto", title: "Run Shell Command Rm" });
    // Started asking nothing at all, it still calls its mode `auto`.
    expect(agyStatus({ agent_state: "idle", cycle_mode: "auto" }, "bypass").mode).toBe("bypassPermissions");
    expect(agyStatus({ agent_state: "idle", cycle_mode: "plan" }, "manual").mode).toBe("plan");
    expect(agyStatus({ agent_state: "idle", cycle_mode: "accept-edits" }, "manual").mode).toBe("acceptEdits");
  });

  it("the hook program hands on what the service follows of its status line, never the account, and prints the model's name", async () => {
    // A stand-in for the service: one request, kept.
    const { createServer } = await import("node:http");
    const got: { event?: string; payload?: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => { got.push(JSON.parse(Buffer.concat(parts).toString("utf8")) as never); res.setHeader("content-type", "application/json"); res.end("{}"); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => server.close());
    const said = {
      cwd: "/w", session_id: A, conversation_id: A, conversation_title: "Run Shell Command Rm", transcript_path: "/x/transcript.jsonl",
      model: { id: "Gemini 4 Hydrogen (High)", display_name: "Gemini 4 Hydrogen (High)", effort: "high" }, workspace: { current_dir: "/w/sub", project_dir: "/w" }, version: "1.5.17",
      agent_state: "tool_use", tool_confirmation_pending: true, cycle_mode: "auto", email: "someone@example.com", plan_tier: "Starter", quota: { used: 1 }, context_window: { used_percentage: 3 },
    };
    const run = (env: Record<string, string>) => new Promise<string>((done, fail) => {
      // Not spawnSync: the stand-in server answers on this process's own loop.
      void import("node:child_process").then(({ spawn }) => {
        const child = spawn(process.execPath, [HOOK_SCRIPT, "agy"], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
        child.on("error", fail);
        child.on("close", () => done(out));
        child.stdin.end(JSON.stringify(said));
      });
    });
    const port = (server.address() as AddressInfo).port;
    expect(await run({ AGENTSWITCH_TERMINAL_URL: `http://127.0.0.1:${port}`, AGENTSWITCH_TERMINAL_ID: "t1", AGENTSWITCH_TERMINAL_HOOK_TOKEN: "tok" })).toBe("Gemini 4 Hydrogen (High)");
    expect(got).toHaveLength(1);
    expect(got[0]!.event).toBe("AgyStatus");
    const { at, ...payload } = got[0]!.payload as { at: number };
    expect(typeof at).toBe("number");
    expect(payload).toEqual({ agent_state: "tool_use", tool_confirmation_pending: true, session_id: A, conversation_title: "Run Shell Command Rm", cwd: "/w/sub", model: "Gemini 4 Hydrogen (High)", cycle_mode: "auto" });
    expect(JSON.stringify(got[0])).not.toMatch(/example\.com|Starter|quota/);
    // Outside a terminal of ours it only prints the line.
    expect(await run({})).toBe("Gemini 4 Hydrogen (High)");
    expect(got).toHaveLength(1);
  });

  it("follows it through its status line: at rest, at work, waiting for an answer on its screen, the conversation it writes, its title, its model", async () => {
    const mails: [string, boolean][] = [];
    const host = new TerminalHost({ launcher: fakeLauncher(() => "http://127.0.0.1:9"), mail: (id, takes) => { mails.push([id, takes]); return null; },
      modelNamed: (harness, name) => (harness === "agy" ? agyNamed(agyFamilies(parseAgyModels(MODELS)), name) : null) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "agy", cwd: tmpdir(), mode: "manual" });
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    let at = 100;
    const says = (payload: Record<string, unknown>, when = ++at) => host.hook(info.id, token, { event: "AgyStatus", payload: { at: when, ...payload } });
    const now = () => host.get(info.id)!;
    const events: string[] = [];
    host.subscribe(info.id, null, (e) => { if (e.type === "status") events.push(e.status); });
    // As it starts: signing in, then at rest with a model and no conversation yet.
    await says({ agent_state: "authenticating", session_id: "", model: "" });
    await says({ agent_state: "idle", session_id: "", model: "Gemini 4 Hydrogen (High)", cwd: "/w" });
    expect(now()).toMatchObject({ status: "idle", agentSessionId: null, modeNow: "default", modelNow: "gemini-4-hydrogen-high", effort: "high", workdir: "/w", hooks: true });
    // A turn: the conversation it writes is named with its first word of work.
    await says({ agent_state: "working", session_id: A, model: "Gemini 4 Hydrogen (High)" });
    expect(now()).toMatchObject({ status: "working", agentSessionId: A });
    await says({ agent_state: "tool_use", tool_confirmation_pending: true, session_id: A });
    await says({ agent_state: "tool_use", tool_confirmation_pending: true, session_id: A });
    expect(now().status).toBe("waiting");
    // A reading that left the program earlier and arrives later says nothing new.
    await says({ agent_state: "working", session_id: A }, 50);
    expect(now().status).toBe("waiting");
    await says({ agent_state: "working", tool_confirmation_pending: false, session_id: A });
    expect(now().status).toBe("working");
    expect(mails).toEqual([]);
    await says({ agent_state: "idle", session_id: A, conversation_title: "Run Shell Command Rm" });
    expect(now()).toMatchObject({ status: "idle", name: "Run Shell Command Rm" });
    expect(host.lastTurn(info.id)).toMatchObject({ ok: true });
    // At rest again: what a room has for it is looked for (it leaves no program waiting).
    expect(mails).toEqual([[info.id, false]]);
    // Each change once: two readings that say the same are one.
    expect(events.slice(-4)).toEqual(["working", "waiting", "working", "idle"]);
    expect(events.length).toBeLessThanOrEqual(5);
    // Its model and level changed on its own screen; how it asks.
    await says({ agent_state: "idle", session_id: A, model: "Gemini 3.8 Flash (Low)", cycle_mode: "plan" });
    expect(now()).toMatchObject({ modelNow: "gemini-3.8-flash-high", effort: "low", modeNow: "plan" });
    // A model the list does not have goes by the name it gave.
    await says({ agent_state: "idle", session_id: A, model: "Something New" });
    expect(now().modelNow).toBe("Something New");
    // `/clear`: another conversation, followed.
    await says({ agent_state: "working", session_id: B });
    expect(now().agentSessionId).toBe(B);
    await says({ agent_state: "error", session_id: B });
    expect(now().status).toBe("idle");
    expect(host.lastTurn(info.id)).toMatchObject({ ok: false });
  });

  it("its input line is read by its own mark: empty, or with only its dim words", () => {
    const row = (text: string, dimFrom = Infinity) => ({ text, dim: [...text].map((_, i) => i >= dimFrom) });
    expect(agyInputEmpty([row("  done"), row("──────"), row(">"), row("──────")])).toBe(true);
    expect(agyInputEmpty([row("> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)", 2)])).toBe(true);
    expect(agyInputEmpty([row("> half a thought")])).toBe(false);
    expect(agyInputEmpty([row("Requesting permission for:"), row("   rm x")])).toBe(false);
  });
});

describe("Antigravity over HTTP", () => {
  it("is one of the agents a terminal starts, resumable and not forkable; a screen changes its model and its level by its own commands, while it rests", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-agy-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agentswitch-agy-cwd-"));
    let base = "";
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, opencodeBinary: "" };
    const daemon = buildDaemon(cfg, { terminalLauncher: fakeLauncher(() => base) });
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
    expect((await call("GET", "/terminals")).json.agents).toContain("agy");
    // A level that is not one of its own is refused before anything starts.
    expect((await call("POST", "/terminals", { harness: "agy", cwd, effort: "minimal" })).status).toBe(400);
    const started = await call("POST", "/terminals", { harness: "agy", cwd, model: "gemini-4-hydrogen-high", effort: "max", mode: "auto" });
    expect(started.status).toBe(201);
    expect(started.json.terminal).toMatchObject({ harness: "agy", model: "gemini-4-hydrogen-high", effort: "max", mode: "auto", sets: true });
    const id = started.json.terminal.id as string;
    const host = daemon.terminals!;
    const screen = () => host.screenTail(id, 30).join("\n");
    await until(() => screen().includes("fake agent ready"));
    const hookToken = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(id)!.hookToken;
    await host.hook(id, hookToken, { event: "AgyStatus", payload: { at: 1, agent_state: "idle", session_id: A } });
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "xhigh" })).json).toEqual({ ok: true });
    await until(() => screen().includes("got: /effort xhigh"));
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "minimal" })).status).toBe(400);
    expect((await call("POST", `/terminals/${id}/model`, { model: "gemini-3.8-flash-high" })).json).toEqual({ ok: true });
    await until(() => screen().includes("gemini-3.8-flash-high"));
    // While it works, what is typed would be a message to it: not then.
    await host.hook(id, hookToken, { event: "AgyStatus", payload: { at: 2, agent_state: "working", session_id: A } });
    expect((await call("POST", `/terminals/${id}/effort`, { effort: "low" })).status).toBe(409);
    expect((await call("POST", `/terminals/${id}/model`, { model: "claude-sonnet-4-6" })).status).toBe(409);
    const commands = (await call("GET", `/terminals/${id}/commands`)).json.commands as { name: string }[];
    expect(commands.map((c) => c.name)).toEqual(expect.arrayContaining(["model", "effort", "clear", "resume", "mcp"]));
    // It goes on with a conversation, and cannot fork one.
    expect((await call("POST", "/terminals/resume", { harness: "agy", cwd, agentSessionId: B, fork: true })).status).toBe(400);
  });
});

describe("a folder trusted in AgentSwitch", () => {
  it("is in Antigravity's own list before it starts there: its settings kept as they were, a broken file left alone", () => {
    const gem = tmp("trust"), cwd = tmp("trusted-cwd");
    const env = { AGENTSWITCH_AGY_HOME: gem };
    const file = agySettingsFile(env);
    expect(file).toBe(join(gem, "antigravity-cli", "settings.json"));
    const lines: string[] = [];
    // Not on the list: nothing is written.
    expect(pretrust("agy", cwd, env, [], (l) => lines.push(l))).toBeNull();
    expect(existsSync(file)).toBe(false);
    // On it (the folder above is trusted whole): written where there was no file.
    expect(pretrust("agy", cwd, env, { folders: [resolve(cwd, "..")], only: [] }, (l) => lines.push(l))).toBe("written");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ trustedWorkspaces: [cwd] });
    expect(pretrust("agy", cwd, env, { folders: [], only: [cwd] }, (l) => lines.push(l))).toBe("already");
    // Everything else in the file stays; the folder is added after what is there.
    writeFileSync(file, JSON.stringify({ model: "Gemini 3.8 Flash (High)", trustedWorkspaces: ["/Users/u"], statusLine: { enabled: false } }, null, 2));
    chmodSync(file, 0o640);
    expect(trustInAgy(file, [cwd]).outcome).toBe("written");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ model: "Gemini 3.8 Flash (High)", trustedWorkspaces: ["/Users/u", cwd], statusLine: { enabled: false } });
    expect(statSync(file).mode & 0o777).toBe(0o640);
    // A file that does not parse, or a list kept some other way, is left alone: the program then asks, as before.
    writeFileSync(file, "{ not json");
    expect(pretrust("agy", cwd, env, [cwd], (l) => lines.push(l))).toBe("skipped");
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    writeFileSync(file, JSON.stringify({ trustedWorkspaces: "all" }));
    expect(trustInAgy(file, [cwd]).outcome).toBe("skipped");
    expect(lines.some((l) => l.includes("does not parse"))).toBe(true);
    // A terminal started there writes it on its way.
    writeFileSync(file, "{}");
    agentLauncher({ binaries: { agy: "/bin/agy" }, hookUrl: () => "http://127.0.0.1:1", stateDir: tmp("state"), env: { PATH: "/usr/bin", ...env }, trustedFolders: () => [cwd] })({ id: "t1", harness: "agy", cwd, mode: "manual", hookToken: "tok" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ trustedWorkspaces: [cwd] });
  });
});

describe("the lists Antigravity draws on its screen", () => {
  const TRUST = ["Accessing workspace:", "", "/private/tmp/w1", "", "Do you trust the contents of this project?", "", "Antigravity CLI requires permission to read, edit, and execute files here.", "",
    "> Yes, I trust this folder", "  No, exit", "", "  ↑/↓ Navigate · enter Confirm"];
  const ASK = ["> Run the shell command: rm probe-file.txt  Then reply with the single word done.", "", "● Ran (rm probe-file.txt) (ctrl+o to expand)", "", "Command",
    "────────────────────────────────────────────────────────────", "", "Requesting permission for:", "   rm probe-file.txt", "", "Run this command?",
    "> 1. Yes, run command", "  2. Yes, and always allow in this conversation for commands that start with 'rm probe-file.txt'",
    "  3. Yes, and always allow for commands that start with 'rm probe-file.txt' (Persist to settings.json)", "  4. No, cancel", "", "  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command"];

  it("its folder question and what it asks before a command are read as lists; what it completes while a command is typed is not", () => {
    expect(choicesOnScreen(TRUST, 120, "agy")).toMatchObject({ title: "Do you trust the contents of this project?", options: [{ label: "Yes, I trust this folder" }, { label: "No, exit" }], selected: 0 });
    const ask = choicesOnScreen(ASK, 120, "agy")!;
    expect(ask.title).toBe("Run this command?");
    expect(ask.text).toContain("rm probe-file.txt");
    expect(ask.options.map((o) => o.label)).toEqual(["Yes, run command", "Yes, and always allow in this conversation for commands that start with 'rm probe-file.txt'",
      "Yes, and always allow for commands that start with 'rm probe-file.txt' (Persist to settings.json)", "No, cancel"]);
    expect(ask.selected).toBe(0);
    // In a terminal of ours its status line (the model's name) stands under the hint: passed over.
    expect(choicesOnScreen([...TRUST, "Gemini 3.8 Flash (High)"], 120, "agy")?.options).toHaveLength(2);
    expect(choicesOnScreen([...ASK, "Gemini 3.8 Flash (High)"], 120, "agy")?.options).toHaveLength(4);
    // Its hint names no Enter: only on its own screen is that line a list's.
    expect(choicesOnScreen(ASK, 120, "codex")).toBeNull();
    const typing = ["────────────────────────", "> /m", "────────────────────────", "> /mcp                 Manage MCP servers", "  /model               Switch models", "", "  ↑/↓ Navigate · enter Select · tab Complete"];
    expect(choicesOnScreen(typing, 120, "agy")).toBeNull();
    // At rest there is none.
    expect(choicesOnScreen(["  done", "", "────────────", "> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)", "────────────", "Gemini 4 Hydrogen (High)"], 120, "agy")).toBeNull();
  });
});

describe("Antigravity's conversations", () => {
  /** A home as the program leaves it, with one conversation that used a tool (as a real turn wrote it). */
  function fixture() {
    const root = tmp("sessions");
    const home = join(root, "gem", "antigravity-cli");
    mkdirSync(join(home, "conversations"), { recursive: true });
    const db = new DatabaseSync(join(home, "conversation_summaries.db"));
    db.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL, parent_conversation_id text NOT NULL DEFAULT '', killed numeric NOT NULL DEFAULT false)");
    const at = new Date(Date.now() - 5000).toISOString().replace("T", " ").replace("Z", "+00:00");
    db.prepare("INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris) VALUES (?, ?, ?, ?)").run(A, "Run Shell Command Rm", at, JSON.stringify(["file:///Users/u/code/fan"]));
    db.close();
    writeFileSync(join(home, "conversations", `${A}.db`), "");
    const transcript = agyTranscript(home, A);
    mkdirSync(join(transcript, ".."), { recursive: true });
    const lines = [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-26T04:31:53Z", content: "<USER_REQUEST>\nRun the shell command: rm probe-file.txt  Then reply with the single word done.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-26T12:31:53+08:00.\n</ADDITIONAL_METADATA>" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T04:31:53Z", model: "gemini-4-hydrogen-high", input_tokens: 10724, output_tokens: 67, tool_calls: [{ name: "run_command", args: { CommandLine: "\"rm probe-file.txt\"", WaitMsBeforeAsync: "5000", toolSummary: "\"Remove probe-file.txt\"" } }] },
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T04:31:56Z", content: "Command exited with code 0.\n\nNo output from the command." },
      { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T04:32:32Z", model: "gemini-4-hydrogen-high", content: "done" },
    ];
    writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const sources: SessionSources = { claudeProjects: join(root, "claude"), codexSessions: join(root, "codex"), opencodeDb: join(root, "none.db"), agyHome: home, excluded: ["/tmp/"] };
    return { home, sources, transcript };
  }

  it("a tool is read from the reply that called it: its name and what it is about; what it answered is not a line", () => {
    const { home } = fixture();
    expect(agyToolCalls({ tool_calls: [{ name: "view_file", args: { AbsolutePath: "\"/w/a.txt\"" } }, { name: "odd", args: { n: "3" } }, { args: {} }] })).toEqual([{ tool: "view_file", text: "/w/a.txt" }, { tool: "odd", text: "n: 3" }]);
    expect(agyMessages(home, A, 10)).toEqual([
      { role: "user", text: "Run the shell command: rm probe-file.txt  Then reply with the single word done.", ts: Date.parse("2026-11-26T04:31:53Z"), at: 0 },
      { role: "tool", tool: "run_command", text: "rm probe-file.txt", ts: Date.parse("2026-11-26T04:31:53Z"), at: 1 },
      { role: "assistant", text: "done", ts: Date.parse("2026-11-26T04:32:32Z"), at: 3 }]);
  });

  it("are listed with the others, read, found by what was said, and deleted", async () => {
    const { home, sources, transcript } = fixture();
    const monitor = new SessionMonitor(sources);
    const list = monitor.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ harness: "agy", id: A, cwd: "/Users/u/code/fan", title: "Run Shell Command Rm", named: true, lastText: "done", model: "gemini-4-hydrogen-high" });
    expect(monitor.source("agy", A)).toBe(transcript);
    expect(monitor.locate("agy", A)).toBe(transcript);
    expect(monitor.locate("agy", B)).toBeNull();
    expect(monitor.read("agy", A)!.messages.map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
    const record = monitor.record("agy", A)!;
    expect(record.record.items.some((i) => i.type === "user")).toBe(true);
    const found = await new SessionSearch(monitor).search("probe-file");
    expect(found.map((s) => s.id)).toEqual([A]);
    expect((await new SessionSearch(monitor).search("WaitMsBeforeAsync"))).toEqual([]);
    expect(await monitor.remove("agy", A)).toEqual({ removed: [join(home, "conversations", `${A}.db`)], failed: [] });
    expect(existsSync(transcript)).toBe(false);
    expect(new SessionMonitor(sources).list()).toEqual([]);
    expect(await monitor.remove("agy", A)).toEqual({ removed: [], failed: [] });
  });

  it("one open in another program is found by who holds its mark; the mark alone, left after it quit, says nothing", async () => {
    const home = tmp("elsewhere");
    mkdirSync(join(home, "presence"));
    writeFileSync(join(home, "presence", `${A}.lock`), "");
    writeFileSync(join(home, "presence", `${B}.lock`), "");
    const table = new Map<number, Proc>([
      [100, { ppid: 90, comm: "/Users/u/.local/bin/agy" }], [90, { ppid: 80, comm: "-zsh" }], [80, { ppid: 1, comm: "/Applications/iTerm.app/Contents/MacOS/iTerm2" }],
      [200, { ppid: 210, comm: "agy" }], [210, { ppid: 1, comm: "node" }],
    ]);
    const held: Record<string, number[]> = { [A]: [100], [B]: [] };
    const check = elsewhereCheck({ home: tmp("user"), agyHome: home, holders: async (file) => held[/([0-9a-f-]{36})\.lock$/.exec(file)![1]!] ?? [], processes: async () => table, appName: async () => "iTerm2" });
    expect(await check("agy", A, [210])).toEqual({ pid: 100, app: "iTerm2" });
    expect(await check("agy", B, [210])).toBeNull();
    held[A] = [200];
    expect(await check("agy", A, [210])).toBeNull();   // one of our own terminals
    expect(await check("agy", "c351c1cc-b89b-4864-b864-b3cdb46bafa8", [])).toBeNull();
  });

  it("its home is `~/.gemini`, or what AgentSwitch's own variable names", () => {
    expect(agyGeminiDir({ HOME: "/Users/u" })).toBe("/Users/u/.gemini");
    expect(agyHome({ HOME: "/Users/u" })).toBe("/Users/u/.gemini/antigravity-cli");
    expect(agyHome({ HOME: "/Users/u", AGENTSWITCH_AGY_HOME: "/x/gem" })).toBe("/x/gem/antigravity-cli");
    // Every test runs with it named (tests/setup.ts): none reaches the user's own.
    expect(agyGeminiDir()).toBe(process.env.AGENTSWITCH_AGY_HOME);
    expect(agyGeminiDir()).not.toContain(".gemini");
  });
});

describe("Antigravity's models and commands", () => {
  it("`agy models` is read; a model is offered once, with its variants as its levels", () => {
    const list = parseAgyModels(MODELS);
    expect(list).toHaveLength(10);
    expect(list[0]).toEqual({ id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)" });
    expect(parseAgyModels("Please sign in with `agy` first.\n")).toEqual([]);
    const families = agyFamilies(list);
    expect(families.map((f) => [f.id, f.name, f.efforts, f.defaultEffort])).toEqual([
      ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen", ["high", "xhigh", "medium", "low"], "high"],
      ["gemini-3.8-flash-high", "Gemini 3.8 Flash", ["high", "medium", "low"], "high"],
      ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)", [], undefined],
      ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)", [], undefined],
      ["gpt-oss-120b-medium", "GPT-OSS 120B", ["medium"], "medium"],
    ]);
    expect(agyNamed(families, "Gemini 3.8 Flash (Low)")).toEqual({ model: "gemini-3.8-flash-high", effort: "low" });
    expect(agyNamed(families, "gemini-4-hydrogen-xhigh")).toEqual({ model: "gemini-4-hydrogen-high", effort: "xhigh" });
    expect(agyNamed(families, "Claude Sonnet 4.6 (Thinking)")).toEqual({ model: "claude-sonnet-4-6", effort: null });
    expect(agyNamed(families, "Nothing")).toBeNull();
  });

  it("are offered for a new terminal's menus as the others are; the default follows the user's own settings", async () => {
    const list = parseAgyModels(MODELS);
    const plain = agyOffer(list);
    expect(plain).toMatchObject({ defaultName: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" });
    expect(plain.models.map((m) => m.id)).toEqual(["gemini-4-hydrogen-high", "gemini-3.8-flash-high", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]);
    expect(plain.models[0]).toMatchObject({ name: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" });
    expect(plain.models[2]).toMatchObject({ name: "Claude Sonnet 4.6 (Thinking)", efforts: [] });
    expect(agyOffer(list, "Gemini 3.8 Flash (Low)")).toMatchObject({ defaultName: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], defaultEffort: "low" });
    expect(agyOffer(list, "Claude Opus 4.6 (Thinking)")).toMatchObject({ defaultName: "Claude Opus 4.6 (Thinking)" });
    expect(agyOffer(list, "Claude Opus 4.6 (Thinking)").efforts).toBeUndefined();
    // Its settings name the model new sessions start on; the offer follows the file.
    const home = tmp("models");
    expect(agyOwnModel(home)).toBeNull();
    writeFileSync(join(home, "settings.json"), JSON.stringify({ trustedWorkspaces: [] }));
    const offers = new ModelOffers({ agyBinary: "/bin/agy", agyHome: home, listClaude: async () => [], listAgy: async () => list, log: () => undefined });
    await offers.refresh();
    expect(offers.current().agy).toMatchObject({ defaultName: "Gemini 4 Hydrogen", defaultEffort: "high" });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "Gemini 3.8 Flash (Medium)", trustedWorkspaces: [] }, null, 2));
    expect(agyOwnModel(home)).toBe("Gemini 3.8 Flash (Medium)");
    expect(offers.current().agy).toMatchObject({ defaultName: "Gemini 3.8 Flash", defaultEffort: "medium" });
    expect(offers.agyNamed("Gemini 4 Hydrogen (Low)")).toEqual({ model: "gemini-4-hydrogen-high", effort: "low" });
    expect(new ModelOffers({ listClaude: async () => [] }).agyNamed("Gemini 4 Hydrogen (Low)")).toBeNull();
  });

  it("its commands for a completion's list: its own, and the skills it would load for the folder", () => {
    const root = tmp("commands");
    const home = join(root, "home"), cwd = join(root, "home", "work", "site");
    const skill = (dir: string, name: string, front: string) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, "SKILL.md"), `---\n${front}\n---\nbody\n`); };
    mkdirSync(join(cwd, ".git"), { recursive: true });
    skill(join(cwd, ".agents", "skills"), "ship", "name: ship-it\ndescription: Ship the site");
    skill(join(home, ".gemini", "config", "skills"), "notes", "description: Keep notes");
    skill(join(home, ".gemini", "antigravity-cli", "skills"), "tidy", "description: Tidy up");
    const names = slashCommands("agy", cwd, home).map((c) => `${c.source}:${c.name}`);
    expect(names).toEqual(expect.arrayContaining(["project:ship-it", "user:notes", "user:tidy", "builtin:model", "builtin:effort", "builtin:mcp", "builtin:rewind"]));
    expect(names).not.toContain("builtin:new");
  });

  it("the program a terminal starts: the one chosen (AGY_BIN), else where it is found, else where its installer puts it", () => {
    const root = tmp("bins");
    const userHome = join(root, "home");
    const program = (dir: string): string => { mkdirSync(dir, { recursive: true }); const path = join(dir, "agy"); writeFileSync(path, "#!/bin/sh\n"); chmodSync(path, 0o755); return path; };
    const targets = { harnesses: {} } as unknown as Parameters<typeof terminalBinaries>[0];
    const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ HOME: userHome, PATH: join(root, "bin"), ...extra });
    expect(terminalBinaries(targets, "", env()).agy).toBeUndefined();
    const installed = program(join(userHome, ".local", "bin"));
    expect(terminalBinaries(targets, "", env()).agy).toBe(installed);
    const onPath = program(join(root, "bin"));
    expect(terminalBinaries(targets, "", env()).agy).toBe(onPath);
    const chosen = program(join(root, "chosen"));
    expect(terminalBinaries(targets, "", env({ AGY_BIN: chosen })).agy).toBe(chosen);
  });
});

describe("the Chat Room's tools for Antigravity", () => {
  it("are one entry of ours in its MCP configuration, everything else there kept; written once and again when it is gone", () => {
    const gem = tmp("mcp");
    const NODE = "/n/node", KIT = "/s/kit.js";
    const file = join(gem, "config", "mcp_config.json");
    // The program has never run here (no folder of its own): nothing is made for it.
    expect(ensureAgyMcp(join(gem, "nowhere"), NODE, KIT, {})).toBe(false);
    expect(ensureAgyMcp(null, NODE, KIT, {})).toBe(false);
    // Turned off: not written.
    expect(ensureAgyMcp(gem, NODE, KIT, { AGENTSWITCH_AGY_MCP: "0" })).toBe(false);
    expect(existsSync(file)).toBe(false);
    // The program itself leaves an empty file there.
    mkdirSync(join(gem, "config"));
    writeFileSync(file, "");
    expect(ensureAgyMcp(gem, NODE, KIT, {})).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: { [AGY_MCP_SERVER]: agyMcpEntry(NODE, KIT) } });
    const written = readFileSync(file, "utf8");
    expect(ensureAgyMcp(gem, NODE, KIT, {})).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(written);
    // The user's own servers and other keys stay; ours is added, and put right when it reads otherwise.
    writeFileSync(file, JSON.stringify({ theme: "x", mcpServers: { mine: { command: "node", args: ["s.js"], env: { K: "v" } }, [AGY_MCP_SERVER]: { command: "/old", args: [] } } }));
    expect(ensureAgyMcp(gem, NODE, KIT, {})).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ theme: "x", mcpServers: { mine: { command: "node", args: ["s.js"], env: { K: "v" } }, [AGY_MCP_SERVER]: agyMcpEntry(NODE, KIT) } });
    // Switched off there by the user (`agy mcp disable agentswitch`): left off, and the terminal goes without.
    writeFileSync(file, JSON.stringify({ mcpServers: { [AGY_MCP_SERVER]: { ...agyMcpEntry(NODE, KIT), disabled: true } } }));
    expect(ensureAgyMcp(gem, NODE, KIT, {})).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers[AGY_MCP_SERVER].disabled).toBe(true);
    // A file that does not parse is left alone.
    writeFileSync(file, "{ nope");
    expect(ensureAgyMcp(gem, NODE, KIT, {})).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{ nope");
  });

  it("the entry is the kit's server under the service's node, with no tools outside an AgentSwitch terminal (as Grok's table)", () => {
    expect(agyMcpEntry("/n/node", "/s/kit.js")).toEqual({ command: "/n/node", args: ["/s/kit.js", "--quiet-outside"] });
    // Another node or script (the service moved): the entry is written again, what the user set beside it kept.
    const gem = tmp("mcp-moved");
    const file = join(gem, "config", "mcp_config.json");
    mkdirSync(join(gem, "config"));
    writeFileSync(file, JSON.stringify({ mcpServers: { [AGY_MCP_SERVER]: { ...agyMcpEntry("/old/node", "/s/kit.js"), timeout: 5 } } }));
    expect(ensureAgyMcp(gem, "/new/node", "/s/kit.js", {})).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers[AGY_MCP_SERVER]).toEqual({ command: "/new/node", args: ["/s/kit.js", "--quiet-outside"], timeout: 5 });
  });
});
