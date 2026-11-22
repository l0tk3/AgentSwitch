/** Settings › Add-Ons (profiles/addons.ts): what a profile has, read from its folder with credentials struck out; an
 *  MCP server installed, switched and removed by the agent's own command; files copied and removed; on this node only. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountAddons } from "../src/api/addons.js";
import type { ApiDeps } from "../src/api/shared.js";
import { markRemote } from "../src/core/caller.js";
import { Addons, codexMcpOff, readInstall, shownCommand, words, type AddonPlace, type Runner } from "../src/profiles/addons.js";
import { ProfileStore } from "../src/profiles/store.js";
import { agentLauncher } from "../src/terminals/launch.js";

function world() {
  const root = mkdtempSync(join(tmpdir(), "agentswitch-addons-"));
  const cc: AddonPlace = { agent: "claude-code", id: "a", config: join(root, "a"), json: join(root, "a", ".claude.json"), kept: join(root, "kept", "a.json"), own: true };
  const other: AddonPlace = { agent: "claude-code", id: "b", config: join(root, "b"), json: join(root, "b", ".claude.json"), kept: join(root, "kept", "b.json"), own: true };
  for (const p of [cc, other]) mkdirSync(p.config, { recursive: true });
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv; input?: string }[] = [];
  // Claude Code as far as these tests go: `mcp add`, `add-json` and `remove` on the folder's `.claude.json`.
  const run: Runner = async (_file, args, opts) => {
    calls.push({ args, env: opts.env, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    const file = join(opts.env.CLAUDE_CONFIG_DIR ?? root, ".claude.json");
    const doc = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    doc.mcpServers ??= {};
    if (args[1] === "remove") { if (!(args[2]! in doc.mcpServers)) return { ok: false, out: "No MCP server found\n" }; delete doc.mcpServers[args[2]!]; }
    else if (args[1] === "add-json") doc.mcpServers[args[2]!] = JSON.parse(opts.input!);
    else if (args[1] === "add") { const rest = args.slice(4).filter((a) => a !== "--"); doc.mcpServers[rest[0]!] = { type: "stdio", command: rest[1], args: rest.slice(2), env: { TOKEN: "t" } }; }
    writeFileSync(file, JSON.stringify(doc));
    return { ok: true, out: "" };
  };
  return { root, cc, other, calls, addons: new Addons({ binaries: { "claude-code": "/bin/claude", codex: "/bin/codex" }, run, userHome: root }) };
}

describe("reading what is typed and what is shown", () => {
  it("splits a command as a shell would, with no expansion; an open quote is refused", () => {
    expect(words(`claude mcp add "my server" -- npx -y 'a b' c\\ d $HOME`)).toEqual(["claude", "mcp", "add", "my server", "--", "npx", "-y", "a b", "c d", "$HOME"]);
    expect(words(`say "open`)).toBeNull();
  });

  it("takes the agent's own mcp add: the name, for the user whatever scope was typed, nothing else", () => {
    expect(readInstall("claude mcp add sentry -- npx -y @sentry/mcp-server", "claude-code")).toEqual({ name: "sentry", args: ["mcp", "add", "-s", "user", "sentry", "--", "npx", "-y", "@sentry/mcp-server"] });
    expect(readInstall("claude mcp add -s project --transport http -H 'Authorization: Bearer x' linear https://mcp.example/linear", "claude-code"))
      .toEqual({ name: "linear", args: ["mcp", "add", "-s", "user", "--transport", "http", "-H", "Authorization: Bearer x", "linear", "https://mcp.example/linear"] });
    expect(readInstall("codex mcp add sentry --env K=V -- npx -y pkg", "codex")).toEqual({ name: "sentry", args: ["mcp", "add", "sentry", "--env", "K=V", "--", "npx", "-y", "pkg"] });
    for (const bad of ["rm -rf ~", "claude mcp remove x", "codex mcp add x -- y", "claude mcp add", "claude mcp add bad/name -- x", "claude mcp add browser -- x", "claude mcp add lonely", "claude mcp add a -- b\nclaude mcp add c -- d", `claude mcp add "x -- y`])
      expect(readInstall(bad, "claude-code"), bad).toHaveProperty("err");
  });

  it("strikes out what looks like a credential in a command", () => {
    expect(shownCommand(["npx", "-y", "pkg", "--api-key", "abcdef", "--port", "8080", "--token=xyz", "sk-ant-0123456789", "A".repeat(40)])).toBe("npx -y pkg --api-key ••• --port 8080 --token=••• ••• •••");
  });
});

describe("a profile's add-ons", () => {
  it("are listed from its folder: servers with their secrets counted, skills by their own line, what is linked as shared", async () => {
    const { root, cc, addons } = world();
    writeFileSync(cc.json!, JSON.stringify({ mcpServers: { db: { command: "uvx", args: ["mcp-pg", "--password", "hunter2hunter2"], env: { A: "1", B: "2" } }, web: { type: "http", url: "https://mcp.example/x?key=secret", headers: { Authorization: "Bearer s" } } } }));
    mkdirSync(join(cc.config, "skills", "pdf"), { recursive: true });
    writeFileSync(join(cc.config, "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Read and fill PDF files\n---\n");
    mkdirSync(join(root, "shared-agents"));
    writeFileSync(join(root, "shared-agents", "reviewer.md"), "x");
    symlinkSync(join(root, "shared-agents"), join(cc.config, "agents"));
    mkdirSync(join(cc.config, "plugins"));
    writeFileSync(join(cc.config, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "hud@market": [{ scope: "user", version: "1.2.0" }] } }));
    writeFileSync(join(cc.config, "settings.json"), JSON.stringify({ enabledPlugins: { "hud@market": false } }));
    const items = await addons.list(cc);
    expect(items).toEqual([
      { kind: "mcp", name: "db", shared: false, enabled: true, transport: "stdio", command: "uvx mcp-pg --password •••", secrets: 2 },
      { kind: "mcp", name: "web", shared: false, enabled: true, transport: "http", command: "https://mcp.example/x", secrets: 1 },
      { kind: "skills", name: "pdf", shared: false, about: "Read and fill PDF files" },
      { kind: "agents", name: "reviewer", shared: true },
      { kind: "plugins", name: "hud@market", shared: false, enabled: false, version: "1.2.0" },
    ]);
    expect(JSON.stringify(items)).not.toMatch(/hunter2|key=secret|Bearer/);
  });

  it("installs by the agent's own command under each profile, switches a server off and on whole, and removes it", async () => {
    const { cc, other, calls, addons } = world();
    expect(await addons.install("claude mcp add db -- uvx mcp-pg", [cc, other])).toEqual([{ profile: "a", ok: true, said: "" }, { profile: "b", ok: true, said: "" }]);
    expect(calls.map((c) => [c.env.CLAUDE_CONFIG_DIR, c.args.join(" ")])).toEqual([[cc.config, "mcp add -s user db -- uvx mcp-pg"], [other.config, "mcp add -s user db -- uvx mcp-pg"]]);
    expect(Object.keys(calls[0]!.env).sort()).toEqual(["CLAUDE_CONFIG_DIR", "HOME", "LANG", "NO_COLOR", "PATH", "TERM"]);
    // Off under one: taken out of Claude Code's file and kept here whole; the other is untouched.
    expect(await addons.switchMcp("db", false, [cc])).toEqual([{ profile: "a", ok: true, said: "" }]);
    expect(JSON.parse(readFileSync(cc.json!, "utf8")).mcpServers).toEqual({});
    expect(JSON.parse(readFileSync(cc.kept, "utf8")).off.db).toEqual({ type: "stdio", command: "uvx", args: ["mcp-pg"], env: { TOKEN: "t" } });
    expect((await addons.list(cc)).map((i) => [i.name, i.enabled])).toEqual([["db", false]]);
    expect((await addons.list(other)).map((i) => [i.name, i.enabled])).toEqual([["db", true]]);
    // On again: the definition as it was, on stdin.
    await addons.switchMcp("db", true, [cc]);
    expect(calls.at(-1)).toMatchObject({ args: ["mcp", "add-json", "db", "-", "-s", "user"], input: JSON.stringify({ type: "stdio", command: "uvx", args: ["mcp-pg"], env: { TOKEN: "t" } }) });
    expect(JSON.parse(readFileSync(cc.kept, "utf8")).off).toEqual({});
    // Removed while off: only what was kept goes, the agent is not asked.
    await addons.switchMcp("db", false, [cc]);
    const before = calls.length;
    expect(await addons.removeMcp("db", [cc, other])).toEqual([{ profile: "a", ok: true, said: "" }, { profile: "b", ok: true, said: "" }]);
    expect(calls.slice(before).map((c) => c.args.join(" "))).toEqual(["mcp remove db -s user"]);
    expect(await addons.list(cc)).toEqual([]);
    expect((await addons.removeMcp("db", [other]))[0]).toMatchObject({ ok: false, said: "No MCP server found" });
    await expect(addons.install("claude mcp remove db", [cc])).rejects.toThrow();
  });

  it("copies a skill or an agent between profiles as it is, never over one or into a shared folder, and removes it", () => {
    const { root, cc, other, addons } = world();
    mkdirSync(join(cc.config, "skills", "pdf"), { recursive: true });
    writeFileSync(join(cc.config, "skills", "pdf", "SKILL.md"), "one");
    symlinkSync("/etc/hosts", join(cc.config, "skills", "pdf", "link"));
    expect(addons.copyFile("skills", "pdf", cc, [other])).toEqual([{ profile: "b", ok: true, said: "" }]);
    expect(readFileSync(join(other.config, "skills", "pdf", "SKILL.md"), "utf8")).toBe("one");
    expect(existsSync(join(other.config, "skills", "pdf", "link"))).toBe(false);
    writeFileSync(join(cc.config, "skills", "pdf", "SKILL.md"), "two");
    expect(addons.copyFile("skills", "pdf", cc, [other])[0]).toMatchObject({ ok: true, said: "has it" });
    expect(readFileSync(join(other.config, "skills", "pdf", "SKILL.md"), "utf8")).toBe("one");
    mkdirSync(join(root, "theirs"));
    symlinkSync(join(root, "theirs"), join(other.config, "agents"));
    mkdirSync(join(cc.config, "agents"));
    writeFileSync(join(cc.config, "agents", "reviewer.md"), "x");
    expect(addons.copyFile("agents", "reviewer", cc, [other])[0]).toMatchObject({ ok: false, said: "shares Default's" });
    expect(addons.removeFile("agents", "reviewer", [other])[0]).toMatchObject({ ok: false });
    expect(addons.removeFile("skills", "pdf", [other])).toEqual([{ profile: "b", ok: true, said: "" }]);
    expect(existsSync(join(other.config, "skills", "pdf"))).toBe(false);
    for (const bad of ["../a", "a/b", ""]) expect(() => addons.copyFile("skills", bad, cc, [other])).toThrow();
    expect(() => addons.copyFile("mcp", "x", cc, [other])).toThrow();
  });

  it("Codex starts with its switched-off servers disabled — those its config still defines, no other", () => {
    const { root } = world();
    const keptFile = join(root, "addons.json"), toml = join(root, "config.toml");
    writeFileSync(keptFile, JSON.stringify({ off: { linear: {}, gone: {}, "bad name": {} } }));
    writeFileSync(toml, 'model = "x"\n[mcp_servers.linear]\ncommand = "npx"\n[mcp_servers.other]\ncommand = "y"\n');
    expect(codexMcpOff(keptFile, toml)).toEqual(["linear"]);
    expect(codexMcpOff(keptFile, join(root, "none.toml"))).toEqual([]);
    const args = agentLauncher({ binaries: { codex: "/bin/codex" }, hookUrl: () => "http://127.0.0.1:1", stateDir: join(root, "state"), env: { PATH: "/usr/bin", HOME: root }, codexMcpOff: () => ["linear"] })({ id: "x1", harness: "codex", cwd: root, mode: "manual", hookToken: "t" }).args;
    expect(args[args.indexOf("mcp_servers.linear.enabled=false") - 1]).toBe("-c");
  });
});

describe("the routes", () => {
  it("list every profile of an agent, and change nothing for a paired device", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentswitch-addons-api-"));
    const userHome = join(root, "user");
    mkdirSync(join(userHome, ".claude", "skills", "pdf"), { recursive: true });
    writeFileSync(join(userHome, ".claude.json"), JSON.stringify({ mcpServers: { db: { command: "uvx", args: ["pg"] } } }));
    const store = new ProfileStore({ home: join(root, "service"), userHome });
    const own = store.create("claude-code", "Apart", "subscription", undefined, { skills: [] });
    const addons = new Addons({ binaries: {}, userHome, run: async () => ({ ok: true, out: "" }) });
    const app = new Hono<any>();
    mountAddons(app, { profiles: store, addons } as ApiDeps);
    const listed = await (await app.request("/profiles/addons?agent=claude-code")).json();
    expect(listed.kinds).toEqual(["mcp", "skills", "plugins", "agents", "commands"]);
    expect(listed.profiles.map((p: { id: string; items: { name: string }[] }) => [p.id, p.items.map((i) => i.name)])).toEqual([["default", ["db", "pdf"]], [own.id, []]]);
    expect((await app.request("/profiles/addons?agent=pi")).status).toBe(400);
    const post = (path: string, body: object, env: object = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
    for (const [path, body] of [["/profiles/addons/mcp/install", { agent: "claude-code", command: "claude mcp add x -- y", profiles: [own.id] }], ["/profiles/addons/mcp/remove", { agent: "claude-code", name: "x", profiles: [own.id] }],
      ["/profiles/addons/mcp/switch", { agent: "claude-code", name: "x", on: false, profiles: [own.id] }], ["/profiles/addons/copy", { agent: "claude-code", kind: "skills", name: "pdf", from: "default", profiles: [own.id] }],
      ["/profiles/addons/remove", { agent: "claude-code", kind: "skills", name: "pdf", profiles: [own.id] }]] as const)
      expect((await post(path, body, markRemote({}, { deviceId: "phone" }))).status, path).toBe(403);
    expect((await post("/profiles/addons/copy", { agent: "claude-code", kind: "skills", name: "pdf", from: "default", profiles: [own.id] })).status).toBe(200);
    expect(existsSync(join(store.homeOf("claude-code", own.id)!, "skills", "pdf"))).toBe(true);
    expect((await post("/profiles/addons/mcp/install", { agent: "claude-code", command: "rm -rf /", profiles: [own.id] })).status).toBe(400);
    expect((await post("/profiles/addons/mcp/install", { agent: "claude-code", command: "claude mcp add x -- y", profiles: ["nobody0000"] })).status).toBe(404);
    expect((await post("/profiles/addons/copy", { agent: "claude-code", kind: "prompts", name: "x", from: "default", profiles: [own.id] })).status).toBe(400);
  });
});
