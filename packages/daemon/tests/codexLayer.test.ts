import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_LAYER, codexLayerArgs, codexNamesOwnProfile, codexTakesLayer } from "../src/terminals/codexLayer.js";
import { agentLauncher, ROOM_KIT_SCRIPT } from "../src/terminals/launch.js";

const BRIDGE = ["/n/node", "/app/bridgeClient.js", "--url", "http://127.0.0.1:4711", "--session", "abc", "--token-file", "/t/abc.token"];
const home = () => mkdtempSync(join(tmpdir(), "agentswitch-codex-layer-"));

describe("AgentSwitch's own layer in Codex's configuration", () => {
  it("is a file beside the user's config naming the browser server's program and no session, written once", () => {
    const dir = join(home(), ".codex");
    expect(codexLayerArgs(dir, "browser", "/n/node", "/app/bridgeClient.js")).toEqual(["--profile", CODEX_LAYER]);
    const file = join(dir, "agentswitch.config.toml");
    const text = readFileSync(file, "utf8");
    expect(text).toContain('[mcp_servers.browser]\ncommand = "/n/node"\nargs = ["/app/bridgeClient.js"]\n');
    expect(text).not.toContain("abc");
    chmodSync(file, 0o400);   // the same text is not written again
    expect(codexLayerArgs(dir, "browser", "/n/node", "/app/bridgeClient.js")).toEqual(["--profile", CODEX_LAYER]);
    chmodSync(file, 0o600);
    codexLayerArgs(dir, "browser", "/n2/node", "/app/bridgeClient.js");
    expect(readFileSync(file, "utf8")).toContain('command = "/n2/node"');
    // Where it cannot be written, the terminal starts as before.
    const blocked = join(home(), "file");
    writeFileSync(blocked, "");
    expect(codexLayerArgs(join(blocked, ".codex"), "browser", "/n/node", "/s.js")).toEqual([]);
  });

  it("is taken only by a Codex whose --profile is a file layer, asked of the program itself", () => {
    const dir = home();
    const program = (name: string, help: string) => { const file = join(dir, name); writeFileSync(file, `#!/bin/sh\ncat <<'END'\n${help}\nEND\n`, { mode: 0o755 }); return file; };
    expect(codexTakesLayer(program("new", "  -p, --profile <CONFIG_PROFILE_V2>\n          Layer $CODEX_HOME/<name>.config.toml on top of the base user config"))).toBe(true);
    expect(codexTakesLayer(program("old", "  -p, --profile <CONFIG_PROFILE>\n          Configuration profile from config.toml"))).toBe(false);
    expect(codexTakesLayer(join(dir, "missing"))).toBe(false);
  });

  it("is left out where the user's own config selects a profile table", () => {
    const dir = home();
    expect(codexNamesOwnProfile(dir)).toBe(false);
    writeFileSync(join(dir, "config.toml"), 'model = "x"\n[profiles.work]\nprofile = "not the top level"\n');
    expect(codexNamesOwnProfile(dir)).toBe(false);
    writeFileSync(join(dir, "config.toml"), 'model = "x"\nprofile = "work"\n[profiles.work]\nmodel = "y"\n');
    expect(codexNamesOwnProfile(dir)).toBe(true);
  });

  it("a Codex terminal is started with the layer, naming the browser and the Chatroom Kit; an older Codex as before", () => {
    const user = home();
    const launch = (codexLayer: boolean, browser: boolean) => agentLauncher({
      binaries: { codex: "/bin/codex" }, hookUrl: () => "http://127.0.0.1:4711", stateDir: join(user, "state"), node: "/n/node", hookScript: "/h/hook.js",
      env: { PATH: "/usr/bin", HOME: user }, codexLayer: () => codexLayer, ...(browser ? { browser: () => BRIDGE } : {}),
    })({ id: "x1", harness: "codex", cwd: user, mode: "auto", hookToken: "tok" }).args;
    expect(launch(false, true)).not.toContain("--profile");
    expect(existsSync(join(user, ".codex", "agentswitch.config.toml"))).toBe(false);
    // Without the browser: the Chatroom Kit's server alone, which every terminal has.
    expect(launch(true, false)).toContain("--profile");
    expect(readFileSync(join(user, ".codex", "agentswitch.config.toml"), "utf8")).toContain(`[mcp_servers.chatroom]\ncommand = "/n/node"\nargs = [${JSON.stringify(ROOM_KIT_SCRIPT)}]\n`);
    expect(readFileSync(join(user, ".codex", "agentswitch.config.toml"), "utf8")).not.toContain("mcp_servers.browser");
    const args = launch(true, true);
    expect(readFileSync(join(user, ".codex", "agentswitch.config.toml"), "utf8")).toMatch(/\[mcp_servers\.browser\][\s\S]+\[mcp_servers\.chatroom\]/);
    // The Kit's server is told the terminal by the names of its variables, never by their values on a command line.
    expect(args.join("\n")).toContain('mcp_servers.chatroom.env_vars=["AGENTSWITCH_TERMINAL_ID","AGENTSWITCH_TERMINAL_URL","AGENTSWITCH_TERMINAL_HOOK_TOKEN"]');
    expect(args.join("\n")).not.toContain("mcp_servers.chatroom.env=");
    expect(args.slice(args.indexOf("--profile"), args.indexOf("--profile") + 2)).toEqual(["--profile", "agentswitch"]);
    expect(args.join("\n")).toContain(`mcp_servers.browser.args=${JSON.stringify(BRIDGE.slice(1))}`);   // the terminal's own bridge still by its flags
    expect(readFileSync(join(user, ".codex", "agentswitch.config.toml"), "utf8")).toContain('args = ["/app/bridgeClient.js"]');
    mkdirSync(join(user, ".codex"), { recursive: true });
    writeFileSync(join(user, ".codex", "config.toml"), 'profile = "work"\n');
    expect(launch(true, true)).not.toContain("--profile");
  });
});
