import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markRemote } from "../src/core/caller.js";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { agentLauncher } from "../src/terminals/launch.js";
import { claudeConfigFile, loadTrustedFolders, pretrust, saveTrustedFolders, trustedRootOf, trustInClaude, trustInCodex, trustRefusal } from "../src/terminals/trustedFolders.js";
import { TARGETS_PATH } from "./helpers.js";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-trust-")));

describe("trusted folders", () => {
  it("refuses the home folder, a folder above it, / and a relative path", () => {
    const home = join(temp(), "me");
    mkdirSync(home);
    for (const bad of [home, `${home}/`, "/", join(home, ".."), "relative/x"]) expect(trustRefusal(bad, home), bad).not.toBeNull();
    expect(trustRefusal(join(home, "code"), home)).toBeNull();
    const as = temp();
    expect(() => saveTrustedFolders(as, [join(home, "code"), "/"], home)).toThrow(/root folder/);
    expect(() => saveTrustedFolders(as, [home], home)).toThrow(/home folder/);
    expect(loadTrustedFolders(as)).toEqual([]);
    expect(saveTrustedFolders(as, [join(home, "code"), join(home, "code/")], home)).toEqual([join(home, "code")]);
    expect(loadTrustedFolders(as)).toEqual([join(home, "code")]);
    expect(statSync(join(as, "trusted-folders.json")).mode & 0o777).toBe(0o600);
  });

  it("a folder below a trusted one inherits it; a sibling does not", () => {
    const root = temp();
    mkdirSync(join(root, "work/app/src"), { recursive: true });
    mkdirSync(join(root, "workshop"));
    expect(trustedRootOf(join(root, "work/app/src"), [join(root, "work")])).toBe(join(root, "work"));
    expect(trustedRootOf(join(root, "work"), [join(root, "work")])).toBe(join(root, "work"));
    expect(trustedRootOf(join(root, "workshop"), [join(root, "work")])).toBeNull();
    // A link into a trusted folder counts by where it leads.
    symlinkSync(join(root, "work/app"), join(root, "link"));
    expect(trustedRootOf(join(root, "link"), [join(root, "work")])).toBe(join(root, "work"));
  });

  it("Claude Code: marks the folder in the profile's .claude.json and keeps everything else", () => {
    const root = temp(), config = join(root, "profile");
    mkdirSync(config);
    const cwd = join(root, "work/app");
    mkdirSync(cwd, { recursive: true });
    const file = join(config, ".claude.json");
    const before = { numStartups: 7, theme: "dark", oauthAccount: { x: 1 }, projects: { "/other": { allowedTools: ["Bash"], hasTrustDialogAccepted: false }, [cwd]: { allowedTools: ["Read"], mcpServers: { a: {} } } } };
    writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
    expect(pretrust("claude-code", cwd, { HOME: join(root, "home"), CLAUDE_CONFIG_DIR: config }, [join(root, "work")], () => undefined)).toBe("written");
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after).toMatchObject({ numStartups: 7, theme: "dark", oauthAccount: { x: 1 } });
    expect(after.projects["/other"]).toEqual({ allowedTools: ["Bash"], hasTrustDialogAccepted: false });
    expect(after.projects[cwd]).toEqual({ allowedTools: ["Read"], mcpServers: { a: {} }, hasTrustDialogAccepted: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(pretrust("claude-code", cwd, { CLAUDE_CONFIG_DIR: config }, [join(root, "work")], () => undefined)).toBe("already");
    // Not on the list: nothing.
    expect(pretrust("claude-code", join(root, "elsewhere"), { CLAUDE_CONFIG_DIR: config }, [join(root, "work")])).toBeNull();
    // A new folder gets Claude Code's own defaults with the question answered; a file that does not parse is left alone.
    const fresh = join(root, "work/new");
    mkdirSync(fresh);
    trustInClaude(file, [fresh]);
    expect(JSON.parse(readFileSync(file, "utf8")).projects[fresh]).toMatchObject({ allowedTools: [], hasTrustDialogAccepted: true });
    writeFileSync(file, "{ broken");
    const logs: string[] = [];
    expect(pretrust("claude-code", fresh, { CLAUDE_CONFIG_DIR: config }, [join(root, "work")], (l) => logs.push(l))).toBe("skipped");
    expect(readFileSync(file, "utf8")).toBe("{ broken");
    expect(logs.join()).toContain("does not parse");
  });

  it("Claude Code: the Mac's own is ~/.claude.json; the repository's root inside the trusted folder is marked too", () => {
    const root = temp(), home = join(root, "home");
    mkdirSync(join(root, "work/repo/.git"), { recursive: true });
    mkdirSync(join(root, "work/repo/pkg"));
    mkdirSync(home);
    expect(claudeConfigFile({ HOME: home })).toBe(join(home, ".claude.json"));
    pretrust("claude-code", join(root, "work/repo/pkg"), { HOME: home }, [join(root, "work")]);
    const projects = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects;
    expect(Object.keys(projects).sort()).toEqual([join(root, "work/repo"), join(root, "work/repo/pkg")]);
    // A repository whose root is above the trusted folder: only the folder itself.
    pretrust("claude-code", join(root, "work/repo/pkg"), { HOME: join(root, "h2") }, [join(root, "work/repo/pkg")]);
    expect(Object.keys(JSON.parse(readFileSync(join(root, "h2/.claude.json"), "utf8")).projects)).toEqual([join(root, "work/repo/pkg")]);
  });

  it("Codex: appends the table once, leaves the rest of config.toml as it was, and keeps the user's own no", () => {
    const root = temp(), home = join(root, "codex");
    mkdirSync(home);
    const cwd = join(root, "work/app");
    mkdirSync(cwd, { recursive: true });
    const file = join(home, "config.toml");
    const before = `model = "gpt-5"   # mine\n\n[mcp_servers.x]\ncommand = "y"\n\n[projects."/somewhere"]\ntrust_level = "trusted"\n`;
    writeFileSync(file, before);
    expect(pretrust("codex", cwd, { CODEX_HOME: home }, [join(root, "work")])).toBe("written");
    const once = readFileSync(file, "utf8");
    expect(once).toBe(`${before}\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`);
    expect(pretrust("codex", cwd, { CODEX_HOME: home }, [join(root, "work")])).toBe("already");
    expect(readFileSync(file, "utf8")).toBe(once);
    // A table there without a level gets the line under its header.
    const other = join(root, "work/b");
    writeFileSync(file, `[projects.${JSON.stringify(other)}]\n\n[x]\ny = 1\n`);
    trustInCodex(file, [other]);
    expect(readFileSync(file, "utf8")).toBe(`[projects.${JSON.stringify(other)}]\ntrust_level = "trusted"\n\n[x]\ny = 1\n`);
    // The user marked it untrusted in Codex: left so.
    writeFileSync(file, `[projects.${JSON.stringify(other)}]\ntrust_level = "untrusted"\n`);
    expect(trustInCodex(file, [other]).outcome).toBe("skipped");
    // Projects kept inline: not touched (a second definition would break the file).
    writeFileSync(file, `projects = { "/a" = { trust_level = "trusted" } }\n`);
    expect(trustInCodex(file, [other]).outcome).toBe("skipped");
    // No file yet: made with just the table.
    const empty = join(root, "codex2");
    expect(pretrust("codex", cwd, { CODEX_HOME: empty }, [join(root, "work")])).toBe("written");
    expect(readFileSync(join(empty, "config.toml"), "utf8")).toBe(`[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`);
  });

  it("Codex: a profile's config.toml linked to the user's own is changed there, the link kept", () => {
    const root = temp();
    mkdirSync(join(root, "own"));
    mkdirSync(join(root, "profile"));
    mkdirSync(join(root, "work"));
    writeFileSync(join(root, "own/config.toml"), "model = \"x\"\n");
    symlinkSync(join(root, "own/config.toml"), join(root, "profile/config.toml"));
    pretrust("codex", join(root, "work"), { CODEX_HOME: join(root, "profile") }, [join(root, "work")]);
    expect(readFileSync(join(root, "own/config.toml"), "utf8")).toContain("trust_level = \"trusted\"");
    expect(realpathSync(join(root, "profile/config.toml"))).toBe(join(root, "own/config.toml"));
  });

  it("the launcher marks the folder in the profile's own config folder before Claude Code and Codex start", () => {
    const root = temp();
    mkdirSync(join(root, "work/app"), { recursive: true });
    mkdirSync(join(root, "claude-profile"));
    mkdirSync(join(root, "codex-profile"));
    const launch = agentLauncher({ binaries: { "claude-code": "/bin/claude", codex: "/bin/codex" }, hookUrl: () => "http://127.0.0.1:1", stateDir: join(root, "state"),
      env: { PATH: "/usr/bin:/bin", HOME: join(root, "home") }, codexLayer: () => false, trustedFolders: () => [join(root, "work")] });
    launch({ id: "c1", harness: "claude-code", hookToken: "t", mode: "manual", cwd: join(root, "work/app"), configHome: join(root, "claude-profile") });
    expect(JSON.parse(readFileSync(join(root, "claude-profile/.claude.json"), "utf8")).projects[join(root, "work/app")].hasTrustDialogAccepted).toBe(true);
    launch({ id: "x1", harness: "codex", hookToken: "t", mode: "manual", cwd: join(root, "work/app"), configHome: join(root, "codex-profile") });
    expect(readFileSync(join(root, "codex-profile/config.toml"), "utf8")).toContain(`[projects.${JSON.stringify(join(root, "work/app"))}]\ntrust_level = "trusted"`);
  });

  it("GET/PUT /settings/trusted-folders on the Mac only", async () => {
    const base = temp();
    const cfg: DaemonConfig = { home: join(base, "as"), targetsPath: TARGETS_PATH, port: 0, opencodeBinary: "" };
    const d = buildDaemon(cfg);
    const call = async (method: string, path: string, body?: unknown, remote = false) => {
      const res = await d.app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, remote ? markRemote({}, { deviceId: "phone" }) : undefined);
      return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
    };
    expect((await call("GET", "/settings/trusted-folders")).body).toEqual({ folders: [] });
    const work = join(base, "work");
    expect(await call("PUT", "/settings/trusted-folders", { folders: [work] })).toMatchObject({ status: 200, body: { folders: [work] } });
    for (const bad of ["/", process.env.HOME!, "relative"]) expect((await call("PUT", "/settings/trusted-folders", { folders: [work, bad] })).status, bad).toBe(400);
    expect((await call("GET", "/settings/trusted-folders")).body).toEqual({ folders: [work] });
  });
});
