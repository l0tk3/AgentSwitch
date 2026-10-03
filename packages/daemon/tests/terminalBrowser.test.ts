/** The shared browser as a tool of the terminals' agents (docs/terminal-v0.md §3, browser-v0 §2 给 agent): each
 *  harness's own session config carries the `browser` MCP server — `secret-gate browser -- <the bridge>` — Codex in its
 *  `-c mcp_servers.browser.*`, Claude Code in its `--mcp-config`, OpenCode in its `OPENCODE_CONFIG`; pi and an ungated
 *  terminal get none; the session made for the terminal ends with its program and its tabs close with the terminal. */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalHost, type Launcher } from "../src/terminals/host.js";
import { agentLauncher, BROWSER_SERVER, HOOK_SCRIPT } from "../src/terminals/launch.js";

const FAKE = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
const GATE = { bin: "/g/bin/secret-gate", home: "/g/home", proxy: "http://127.0.0.1:8080", playwrightVersion: "0.0.82", allowedOrigins: [] };
const BRIDGE = ["/n/node", "/d/bridgeClient.js", "--url", "http://127.0.0.1:4711", "--session", "s1", "--token-file", "/as/browser/sessions/s1.token"];
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

function launcher(browser: ((req: { id: string; harness: string; cwd: string }) => readonly string[] | null) | undefined, gate: typeof GATE | null = GATE) {
  const stateDir = mkdtempSync(join(tmpdir(), "agentswitch-term-browser-"));
  const asked: { id: string; harness: string; cwd: string }[] = [];
  const launch = agentLauncher({
    binaries: { "claude-code": "/bin/claude", codex: "/bin/codex", opencode: "/bin/opencode", pi: "/bin/pi" }, gate, hookUrl: () => "http://127.0.0.1:4711", stateDir,
    node: "/n/node", hookScript: "/h/hook.js", piExtension: "/h/pi.ts", env: { PATH: "/usr/bin", HOME: "/Users/u" },
    ...(browser ? { browser: (req) => { asked.push(req); return browser(req); } } : {}),
  });
  return { launch, stateDir, asked };
}

describe("the browser tool in a terminal's session config", () => {
  it("Codex: mcp_servers.browser runs the bridge behind the gate, with time for a held tab", () => {
    const { launch, asked } = launcher(() => BRIDGE);
    const plan = launch({ id: "x1", harness: "codex", cwd: "/Users/u/Projects/AgentSwitch", mode: "auto", hookToken: "tok" });
    expect(asked).toEqual([{ id: "x1", harness: "codex", cwd: "/Users/u/Projects/AgentSwitch" }]);
    const args = plan.args.join("\n");
    expect(args).toContain(`mcp_servers.${BROWSER_SERVER}.command="/g/bin/secret-gate"`);
    expect(args).toContain(`mcp_servers.browser.args=${JSON.stringify(["browser", "--", ...BRIDGE])}`);
    expect(args).toContain('mcp_servers.browser.env={ "SECRET_GATE_HOME" = "/g/home" }');
    expect(args).toContain("mcp_servers.browser.tool_timeout_sec=300");
    // The token file's path, never a token; nothing of it in Codex's own environment.
    expect(Object.keys(plan.env).some((k) => /BROWSER/.test(k))).toBe(false);
  });

  it("Claude Code: the browser server beside secret-gate's own in its --mcp-config", () => {
    const { launch, stateDir } = launcher(() => BRIDGE);
    const plan = launch({ id: "c1", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    const config = plan.args[plan.args.indexOf("--mcp-config") + 1]!;
    expect(config).toBe(join(stateDir, "c1", "mcp.json"));
    const servers = JSON.parse(readFileSync(config, "utf8")).mcpServers;
    expect(Object.keys(servers)).toEqual(["secret-gate", "browser"]);
    expect(servers.browser).toEqual({ type: "stdio", command: "/g/bin/secret-gate", args: ["browser", "--", ...BRIDGE], env: { SECRET_GATE_HOME: "/g/home" } });
  });

  it("OpenCode: the browser server in its own OPENCODE_CONFIG, beside the refusals", () => {
    const { launch } = launcher(() => BRIDGE);
    const plan = launch({ id: "o1", harness: "opencode", cwd: "/tmp", mode: "auto", hookToken: "tok" });
    const config = JSON.parse(readFileSync(plan.env.OPENCODE_CONFIG!, "utf8"));
    expect(config.mcp.browser).toEqual({ type: "local", command: ["/g/bin/secret-gate", "browser", "--", ...BRIDGE], enabled: true, environment: { SECRET_GATE_HOME: "/g/home" } });
    const prot = { roots: ["/as/gate"], exempt: [], readDenied: ["/as/gate"] };
    const withRules = agentLauncher({ binaries: { opencode: "/bin/opencode" }, gate: GATE, protected: prot, hookUrl: () => "", stateDir: mkdtempSync(join(tmpdir(), "agentswitch-term-browser-")), env: {}, browser: () => BRIDGE });
    const both = JSON.parse(readFileSync(withRules({ id: "o2", harness: "opencode", cwd: "/tmp", mode: "auto", hookToken: "tok" }).env.OPENCODE_CONFIG!, "utf8"));
    expect(both.mcp.browser.command[1]).toBe("browser");
    expect(both.permission.read).toMatchObject({ "/as/gate": "deny" });
  });

  it("none for pi (no MCP), none without the gate (no ungated browser for an agent), none when the browser is off", () => {
    const { launch, asked } = launcher(() => BRIDGE);
    const pi = launch({ id: "p1", harness: "pi", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    expect(pi.args.join(" ")).not.toContain("browser");
    expect(asked).toEqual([]);   // no session minted for it
    const ungated = launcher(() => BRIDGE, null);
    expect(ungated.launch({ id: "x2", harness: "codex", cwd: "/tmp", mode: "manual", hookToken: "tok" }).args.join(" ")).not.toContain("mcp_servers.browser");
    expect(ungated.asked).toEqual([]);
    const off = launcher(undefined);
    expect(off.launch({ id: "x3", harness: "codex", cwd: "/tmp", mode: "manual", hookToken: "tok" }).args.join(" ")).not.toContain("mcp_servers.browser");
    const claude = off.launch({ id: "c2", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    expect(Object.keys(JSON.parse(readFileSync(claude.args[claude.args.indexOf("--mcp-config") + 1]!, "utf8")).mcpServers)).toEqual(["secret-gate"]);
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
