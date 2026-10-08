/** The shared browser as a tool of the terminals' agents (docs/terminal-v0.md §3, browser-v0 §2 给 agent): each
 *  harness's own session config carries the `browser` MCP server — the agent bridge itself, with no gate in front
 *  since 2026-10-08 (docs/profiles-v0.md §8: the gate stays in Dispatch) — Codex in its `-c mcp_servers.browser.*`,
 *  Claude Code in its `--mcp-config`, OpenCode in its `OPENCODE_CONFIG`; pi gets none; the session made for the
 *  terminal ends with its program and its tabs close with the terminal. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalHost, type Launcher } from "../src/terminals/host.js";
import { agentLauncher, BROWSER_GUIDANCE, BROWSER_SERVER, HOOK_SCRIPT } from "../src/terminals/launch.js";

const FAKE = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
const BRIDGE = ["/n/node", "/d/bridgeClient.js", "--url", "http://127.0.0.1:4711", "--session", "s1", "--token-file", "/as/browser/sessions/s1.token"];
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

function launcher(browser: ((req: { id: string; harness: string; cwd: string }) => readonly string[] | null) | undefined) {
  const stateDir = mkdtempSync(join(tmpdir(), "agentswitch-term-browser-"));
  const asked: { id: string; harness: string; cwd: string }[] = [];
  const launch = agentLauncher({
    binaries: { "claude-code": "/bin/claude", codex: "/bin/codex", opencode: "/bin/opencode", pi: "/bin/pi" }, hookUrl: () => "http://127.0.0.1:4711", stateDir,
    node: "/n/node", hookScript: "/h/hook.js", piExtension: "/h/pi.ts", env: { PATH: "/usr/bin", HOME: "/Users/u" },
    ...(browser ? { browser: (req) => { asked.push(req); return browser(req); } } : {}),
  });
  return { launch, stateDir, asked };
}

describe("the browser tool in a terminal's session config", () => {
  it("Codex: mcp_servers.browser runs the bridge itself, with time for a held tab; nothing of the gate in the terminal", () => {
    const { launch, asked } = launcher(() => BRIDGE);
    const plan = launch({ id: "x1", harness: "codex", cwd: "/Users/u/Projects/AgentSwitch", mode: "auto", hookToken: "tok" });
    expect(asked).toEqual([{ id: "x1", harness: "codex", cwd: "/Users/u/Projects/AgentSwitch" }]);
    const args = plan.args.join("\n");
    expect(args).toContain(`mcp_servers.${BROWSER_SERVER}.command="/n/node"`);
    expect(args).toContain(`mcp_servers.browser.args=${JSON.stringify(BRIDGE.slice(1))}`);
    expect(args).toContain("mcp_servers.browser.env={}");
    expect(args).toContain("mcp_servers.browser.tool_timeout_sec=300");
    // No gate in a terminal (2026-10-08): not in front of the browser, not as a proxy for the commands it runs, not in
    // its own environment.
    expect(args).not.toContain("secret-gate");
    expect(args).not.toContain("shell_environment_policy");
    expect(Object.keys(plan.env).filter((k) => /proxy|SECRET_GATE|CERT|CA_BUNDLE/i.test(k))).toEqual([]);
    // The token file's path, never a token; nothing of it in Codex's own environment.
    expect(Object.keys(plan.env).some((k) => /BROWSER/.test(k))).toBe(false);
    // Told which browser to use (2026-10-03): its own Chrome DevTools or computer use start a browser of their own.
    expect(plan.args).toContain(`developer_instructions=${JSON.stringify(BROWSER_GUIDANCE)}`);
  });

  it("Codex: the user's own developer_instructions are not replaced", () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-term-home-"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-6-sol"\ndeveloper_instructions = "Answer in Chinese."\n\n[mcp_servers.chrome-devtools]\ncommand = "npx"\n');
    const own = agentLauncher({ binaries: { codex: "/bin/codex" }, hookUrl: () => "", stateDir: mkdtempSync(join(tmpdir(), "agentswitch-term-browser-")), env: { HOME: home }, browser: () => BRIDGE });
    const args = own({ id: "x5", harness: "codex", cwd: "/tmp", mode: "auto", hookToken: "tok" }).args.join("\n");
    expect(args).toContain("mcp_servers.browser.command");
    expect(args).not.toContain("developer_instructions");
    // One under a table is not the top level's.
    writeFileSync(join(home, ".codex", "config.toml"), '[profiles.fast]\ndeveloper_instructions = "Be brief."\n');
    expect(own({ id: "x6", harness: "codex", cwd: "/tmp", mode: "auto", hookToken: "tok" }).args.join("\n")).toContain("developer_instructions");
  });

  it("Claude Code: the browser server alone in its --mcp-config (the gate's own tools are Dispatch's)", () => {
    const { launch, stateDir } = launcher(() => BRIDGE);
    const plan = launch({ id: "c1", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    const config = plan.args[plan.args.indexOf("--mcp-config") + 1]!;
    expect(config).toBe(join(stateDir, "c1", "mcp.json"));
    const servers = JSON.parse(readFileSync(config, "utf8")).mcpServers;
    expect(Object.keys(servers)).toEqual(["browser"]);
    expect(servers.browser).toEqual({ type: "stdio", command: "/n/node", args: BRIDGE.slice(1), env: {} });
    expect(Object.keys(plan.env).filter((k) => /proxy|SECRET_GATE|CERT|CA_BUNDLE/i.test(k))).toEqual([]);
    expect(plan.args[plan.args.indexOf("--append-system-prompt") + 1]).toBe(BROWSER_GUIDANCE);
  });

  it("OpenCode: the browser server in its own OPENCODE_CONFIG, beside the refusals", () => {
    const { launch } = launcher(() => BRIDGE);
    const plan = launch({ id: "o1", harness: "opencode", cwd: "/tmp", mode: "auto", hookToken: "tok" });
    const config = JSON.parse(readFileSync(plan.env.OPENCODE_CONFIG!, "utf8"));
    expect(config.mcp.browser).toEqual({ type: "local", command: BRIDGE, enabled: true, environment: {} });
    expect(config.instructions).toHaveLength(1);
    expect(readFileSync(config.instructions[0], "utf8").trim()).toBe(BROWSER_GUIDANCE);
    const prot = { roots: ["/as/gate"], exempt: [], readDenied: ["/as/gate"] };
    const withRules = agentLauncher({ binaries: { opencode: "/bin/opencode" }, protected: prot, hookUrl: () => "", stateDir: mkdtempSync(join(tmpdir(), "agentswitch-term-browser-")), env: {}, browser: () => BRIDGE });
    const both = JSON.parse(readFileSync(withRules({ id: "o2", harness: "opencode", cwd: "/tmp", mode: "auto", hookToken: "tok" }).env.OPENCODE_CONFIG!, "utf8"));
    expect(both.mcp.browser.command[1]).toBe("/d/bridgeClient.js");
    expect(both.permission.read).toMatchObject({ "/as/gate": "deny" });
  });

  it("none for pi (no MCP), none when the browser is off or gives no bridge", () => {
    const { launch, asked } = launcher(() => BRIDGE);
    const pi = launch({ id: "p1", harness: "pi", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    expect(pi.args.join(" ")).not.toContain("browser");
    expect(asked).toEqual([]);   // no session minted for it
    const off = launcher(undefined);
    expect(off.launch({ id: "x3", harness: "codex", cwd: "/tmp", mode: "manual", hookToken: "tok" }).args.join(" ")).not.toContain("mcp_servers.browser");
    const claude = off.launch({ id: "c2", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    expect(claude.args).not.toContain("--append-system-prompt");
    expect(claude.args).not.toContain("--mcp-config");   // nothing to configure: the gate's tools are not a terminal's
    const refused = launcher(() => null);
    expect(refused.launch({ id: "x4", harness: "codex", cwd: "/tmp", mode: "manual", hookToken: "tok" }).args.join(" ")).not.toContain("mcp_servers.browser");
  });
});

describe("the terminal host tells what was made for a terminal when it ends", () => {
  const fakeLauncher: Launcher = (req) => ({
    file: process.execPath, args: [FAKE],
    env: { ...(process.env as Record<string, string>), FAKE_HOOK_SCRIPT: HOOK_SCRIPT, AGENTSWITCH_TERMINAL_ID: req.id, AGENTSWITCH_TERMINAL_URL: "http://127.0.0.1:9", AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken },
    hooks: false,
  });

  it("its program's exit ends the session; deleting it removes the rest; a start that fails does both", async () => {
    const calls: string[] = [];
    const host = new TerminalHost({ launcher: fakeLauncher, killGraceMs: 200, onExit: (id) => calls.push(`exit ${id}`), onRemove: (id) => calls.push(`remove ${id}`) });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "codex", cwd: tmpdir() });
    await host.stopped(info.id);
    expect(calls).toEqual([`exit ${info.id}`]);
    host.remove(info.id);
    expect(calls).toEqual([`exit ${info.id}`, `exit ${info.id}`, `remove ${info.id}`]);
    const failing = new TerminalHost({ launcher: () => { throw new Error("codex is not installed on this Mac"); }, onExit: (id) => calls.push(`exit ${id}`), onRemove: (id) => calls.push(`remove ${id}`) });
    await expect(failing.spawn({ harness: "codex", cwd: tmpdir() })).rejects.toThrow("not installed");
    expect(calls.slice(-2).map((c) => c.split(" ")[0])).toEqual(["exit", "remove"]);
  });
});

describe("the daemon", () => {
  it("closes a terminal's browser tabs when the terminal is deleted", async () => {
    const { buildDaemon } = await import("../src/daemon.js");
    const { FakeDriver } = await import("./fakeBrowser.js");
    const { TARGETS_PATH } = await import("./helpers.js");
    const daemon = buildDaemon({ home: mkdtempSync(join(tmpdir(), "agentswitch-term-browser-daemon-")), targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" },
      { terminalLauncher: (req) => ({ file: process.execPath, args: [FAKE], env: { ...(process.env as Record<string, string>), FAKE_HOOK_SCRIPT: HOOK_SCRIPT, AGENTSWITCH_TERMINAL_ID: req.id, AGENTSWITCH_TERMINAL_URL: "http://127.0.0.1:9", AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken }, hooks: false }),
        browserDriver: new FakeDriver(), browserEngine: async () => { throw new Error("unused"); } });
    closers.push(() => daemon.close());
    const info = await daemon.terminals!.spawn({ harness: "codex", cwd: tmpdir() });
    const tab = await daemon.browser!.open({ kind: "terminal", id: info.id, label: "codex · tmp" }, "https://a.example/");
    const other = await daemon.browser!.open({ kind: "terminal", id: "someone-else", label: "codex · x" }, "https://b.example/");
    daemon.terminals!.remove(info.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(daemon.browser!.get(tab.id)).toBeNull();
    expect(daemon.browser!.get(other.id)).not.toBeNull();
    await daemon.stopBrowser();
  });
});
