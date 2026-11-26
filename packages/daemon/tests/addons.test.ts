/** Settings › Add-Ons (profiles/addons.ts): what a profile has, read from its folder with credentials struck out; an
 *  MCP server installed, switched and removed by the agent's own command; files copied and removed; on this node only. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect((await app.request("/profiles/addons?agent=gemini")).status).toBe(400);
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

describe("the other four agents (user #567)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  /** A place of each in a temporary folder, and a runner that is each agent's `mcp` as far as these tests go. */
  function places() {
    const root = mkdtempSync(join(tmpdir(), "agentswitch-addons-four-"));
    const oc: AddonPlace = { agent: "opencode", id: "default", config: join(root, "xdg", "opencode"), json: join(root, "xdg", "opencode", "opencode.json"), kept: join(root, "kept", "oc.json"), own: false };
    const pi: AddonPlace = { agent: "pi", id: "default", config: join(root, "pi"), kept: join(root, "kept", "pi.json"), own: false };
    const grok: AddonPlace = { agent: "grok", id: "g1", config: join(root, "grok-g1"), kept: join(root, "kept", "g1.json"), own: true };
    const agy: AddonPlace = { agent: "agy", id: "default", config: join(root, "gemini", "config"), json: join(root, "gemini", "config", "mcp_config.json"), kept: join(root, "kept", "agy.json"), own: false, args: [`--gemini_dir=${join(root, "gemini")}`] };
    for (const p of [oc, pi, grok, agy]) mkdirSync(p.config, { recursive: true });
    const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const grokServers: Record<string, Record<string, unknown>> = {};
    const run: Runner = async (file, args, opts) => {
      calls.push({ file, args, env: opts.env });
      if (file === "/bin/grok") {
        const [, verb, name] = args;
        if (verb === "list") return { ok: true, out: JSON.stringify([...Object.entries(grokServers).map(([n, d]) => ({ ...d, name: n, scope: "user" })), { name: "chatroom", command: "node", enabled: true, scope: "user" }, { name: "here", command: "x", scope: "project" }]) };
        if (verb === "add") { grokServers[args[6]!] = { command: args[8], args: args.slice(9), env: { K: "v" }, enabled: true }; return { ok: true, out: "" }; }
        if (!(name! in grokServers)) return { ok: false, out: `MCP server '${name}' not found\n` };
        if (verb === "remove") delete grokServers[name!]; else grokServers[name!]!.enabled = verb === "enable";
        return { ok: true, out: "" };
      }
      return { ok: true, out: "" };
    };
    const addons = new Addons({ binaries: { opencode: "/bin/opencode", grok: "/bin/grok", agy: "/bin/agy" }, run, userHome: root });
    return { root, oc, pi, grok, agy, calls, addons };
  }

  it("read each one's own `mcp add`, always for the user, and refuse AgentSwitch's own names and pi", () => {
    expect(readInstall("opencode mcp add fs -- npx -y pkg", "opencode")).toEqual({ name: "fs", args: ["mcp", "add", "--global", "fs", "--", "npx", "-y", "pkg"] });
    expect(readInstall("opencode mcp add --global --url https://x.example/mcp --header Authorization=Bearer\\ t api", "opencode"))
      .toEqual({ name: "api", args: ["mcp", "add", "--global", "--url", "https://x.example/mcp", "--header", "Authorization=Bearer t", "api"] });
    expect(readInstall("grok mcp add -s project -e K=V fs -- npx -y pkg", "grok")).toEqual({ name: "fs", args: ["mcp", "add", "-s", "user", "-e", "K=V", "fs", "--", "npx", "-y", "pkg"] });
    expect(readInstall("agy mcp add --env K=V gh -- docker run -i img", "agy")).toEqual({ name: "gh", args: ["mcp", "add", "--env", "K=V", "gh", "--", "docker", "run", "-i", "img"] });
    expect(readInstall("agy mcp add api https://x.example/mcp", "agy")).toEqual({ name: "api", args: ["mcp", "add", "api", "https://x.example/mcp"] });
    for (const [bad, agent] of [["grok mcp add chatroom -- node x", "grok"], ["agy mcp add agentswitch -- node x", "agy"], ["claude mcp add fs -- x", "grok"], ["pi mcp add fs -- x", "pi"]] as const)
      expect(readInstall(bad, agent), bad).toHaveProperty("err");
  });

  it("OpenCode: its servers from opencode.json (either shape), switched and removed in the file, installed by its command", async () => {
    const { oc, calls, addons } = places();
    writeFileSync(oc.json!, JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "m", mcp: { servers: {
      fs: { type: "local", command: ["npx", "-y", "pkg", "--token", "abcdefabcdefabcdefabcdefabcdefabcdef"], environment: { K: "v" } },
      api: { type: "remote", url: "https://x.example/mcp?key=s", headers: { Authorization: "Bearer s" }, enabled: false } } } }));
    mkdirSync(join(oc.config, "agent"), { recursive: true });
    writeFileSync(join(oc.config, "agent", "review.md"), "x");
    mkdirSync(join(oc.config, "skills", "pdf"), { recursive: true });
    writeFileSync(join(oc.config, "skills", "pdf", "SKILL.md"), "---\ndescription: PDFs\n---\n");
    const items = await addons.list(oc);
    expect(items).toEqual([
      { kind: "mcp", name: "api", shared: false, enabled: false, transport: "http", command: "https://x.example/mcp", secrets: 1 },
      { kind: "mcp", name: "fs", shared: false, enabled: true, transport: "stdio", command: "npx -y pkg --token •••", secrets: 1 },
      { kind: "skills", name: "pdf", shared: false, about: "PDFs" },
      { kind: "agents", name: "review", shared: false },
    ]);
    expect(JSON.stringify(items)).not.toMatch(/Bearer|key=s|abcdefabcdef/);
    expect(await addons.switchMcp("api", true, [oc])).toEqual([{ profile: "default", ok: true, said: "" }]);
    expect(await addons.switchMcp("fs", false, [oc])).toEqual([{ profile: "default", ok: true, said: "" }]);
    let doc = JSON.parse(readFileSync(oc.json!, "utf8"));
    expect(doc.model).toBe("m");
    expect(doc.mcp.servers.api).not.toHaveProperty("enabled");
    expect(doc.mcp.servers.fs).toMatchObject({ enabled: false, environment: { K: "v" } });
    expect(await addons.removeMcp("api", [oc])).toEqual([{ profile: "default", ok: true, said: "" }]);
    expect((await addons.removeMcp("api", [oc]))[0]).toMatchObject({ ok: false, said: "it is not there" });
    doc = JSON.parse(readFileSync(oc.json!, "utf8"));
    expect(Object.keys(doc.mcp.servers)).toEqual(["fs"]);
    // The shape before 2.x: servers straight under `mcp`.
    writeFileSync(oc.json!, JSON.stringify({ mcp: { old: { type: "local", command: ["x", "y"] } } }));
    expect((await addons.list(oc)).filter((i) => i.kind === "mcp").map((i) => i.name)).toEqual(["old"]);
    await addons.switchMcp("old", false, [oc]);
    expect(JSON.parse(readFileSync(oc.json!, "utf8"))).toEqual({ mcp: { old: { type: "local", command: ["x", "y"], enabled: false } } });
    // Installed by its own command, into the folder named for it.
    await addons.install("opencode mcp add fs2 -- npx pkg", [oc]);
    expect(calls.at(-1)).toMatchObject({ file: "/bin/opencode", args: ["mcp", "add", "--global", "fs2", "--", "npx", "pkg"] });
    expect(calls.at(-1)!.env).toMatchObject({ XDG_CONFIG_HOME: dirname(oc.config), OPENCODE_DISABLE_AUTOUPDATE: "1" });
    // A `.jsonc` is read, and left alone.
    const jsonc: AddonPlace = { ...oc, json: join(oc.config, "opencode.jsonc") };
    writeFileSync(jsonc.json!, '{\n  // mine\n  "mcp": { "servers": { "c": { "type": "local", "command": ["a"], }, }, },\n}\n');
    expect((await addons.list(jsonc)).filter((i) => i.kind === "mcp").map((i) => i.name)).toEqual(["c"]);
    expect((await addons.switchMcp("c", false, [jsonc]))[0]).toMatchObject({ ok: false });
  });

  it("Grok: listed, switched and removed by its own command under the profile's GROK_HOME; AgentSwitch's chatroom not shown", async () => {
    const { grok, calls, addons } = places();
    await addons.install("grok mcp add -e K=v fs -- npx pkg", [grok]);
    expect(calls.at(-1)).toMatchObject({ file: "/bin/grok", args: ["mcp", "add", "-s", "user", "-e", "K=v", "fs", "--", "npx", "pkg"] });
    expect(calls.at(-1)!.env).toMatchObject({ GROK_HOME: grok.config, GROK_DISABLE_AUTOUPDATER: "1" });
    mkdirSync(join(grok.config, "skills", "s1"), { recursive: true });
    mkdirSync(join(grok.config, "agents"), { recursive: true });
    writeFileSync(join(grok.config, "agents", "planner.md"), "x");
    expect(await addons.list(grok)).toEqual([
      { kind: "mcp", name: "fs", shared: false, enabled: true, transport: "stdio", command: "npx pkg", secrets: 1 },
      { kind: "skills", name: "s1", shared: false },
      { kind: "agents", name: "planner", shared: false },
    ]);
    expect(await addons.switchMcp("fs", false, [grok])).toEqual([{ profile: "g1", ok: true, said: "" }]);
    expect(calls.at(-1)!.args).toEqual(["mcp", "disable", "fs"]);
    expect((await addons.list(grok)).find((i) => i.name === "fs")?.enabled).toBe(false);
    expect(await addons.removeMcp("fs", [grok])).toEqual([{ profile: "g1", ok: true, said: "" }]);
    expect(calls.at(-1)!.args).toEqual(["mcp", "remove", "fs", "-s", "user"]);
    expect((await addons.removeMcp("fs", [grok]))[0]).toMatchObject({ ok: false, said: "MCP server 'fs' not found" });
  });

  it("agy: its mcp_config.json read, its own commands with --gemini_dir; AgentSwitch's entry not shown; rules and workflows by name", async () => {
    const { agy, calls, addons } = places();
    writeFileSync(agy.json!, JSON.stringify({ mcpServers: { agentswitch: { command: "node", args: ["kit.js"] }, fs: { command: "npx", args: ["-y", "pkg"], env: { K: "v" }, disabled: true }, api: { serverUrl: "https://x.example/mcp?k=1", headers: { A: "b" } } } }));
    mkdirSync(join(agy.config, "rules"), { recursive: true });
    writeFileSync(join(agy.config, "rules", "style.md"), "x");
    mkdirSync(join(agy.config, "global_workflows"), { recursive: true });
    writeFileSync(join(agy.config, "global_workflows", "ship.md"), "x");
    mkdirSync(join(agy.config, "workflows"), { recursive: true });
    writeFileSync(join(agy.config, "workflows", "deploy.md"), "x");
    expect(await addons.list(agy)).toEqual([
      { kind: "mcp", name: "api", shared: false, enabled: true, transport: "http", command: "https://x.example/mcp", secrets: 1 },
      { kind: "mcp", name: "fs", shared: false, enabled: false, transport: "stdio", command: "npx -y pkg", secrets: 1 },
      { kind: "rules", name: "style", shared: false },
      { kind: "workflows", name: "ship", shared: false },
      { kind: "workflows", name: "deploy", shared: false },
    ]);
    await addons.switchMcp("fs", true, [agy]);
    expect(calls.at(-1)).toMatchObject({ file: "/bin/agy", args: [agy.args![0], "mcp", "enable", "fs"] });
    expect(calls.at(-1)!.env).toMatchObject({ AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
    await addons.removeMcp("api", [agy]);
    expect(calls.at(-1)!.args).toEqual([agy.args![0], "mcp", "remove", "api"]);
    expect(addons.removeFile("workflows", "deploy", [agy])).toEqual([{ profile: "default", ok: true, said: "" }]);
    expect(existsSync(join(agy.config, "workflows", "deploy.md"))).toBe(false);
  });

  it("pi: skills, prompts and extensions as files, copied as they are", async () => {
    const { root, pi, addons } = places();
    mkdirSync(join(pi.config, "skills", "pdf"), { recursive: true });
    mkdirSync(join(pi.config, "prompts"), { recursive: true });
    writeFileSync(join(pi.config, "prompts", "review.md"), "x");
    mkdirSync(join(pi.config, "extensions", "kit"), { recursive: true });
    writeFileSync(join(pi.config, "extensions", "one.ts"), "export default () => {}");
    expect(await addons.list(pi)).toEqual([
      { kind: "skills", name: "pdf", shared: false },
      { kind: "prompts", name: "review", shared: false },
      { kind: "extensions", name: "kit", shared: false },
      { kind: "extensions", name: "one.ts", shared: false },
    ]);
    const other: AddonPlace = { ...pi, id: "x", config: join(root, "pi2") };
    expect(addons.copyFile("extensions", "one.ts", pi, [other])).toEqual([{ profile: "x", ok: true, said: "" }]);
    expect(readFileSync(join(other.config, "extensions", "one.ts"), "utf8")).toBe("export default () => {}");
    await expect(addons.install("pi mcp add a -- b", [pi])).rejects.toThrow(/MCP/);
  });

  it("the routes list each of them from the Mac's own folders — a Grok profile from its own — and refuse MCP for pi", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentswitch-addons-four-api-"));
    const userHome = join(root, "user");
    vi.stubEnv("XDG_CONFIG_HOME", ""); vi.stubEnv("PI_CODING_AGENT_DIR", ""); vi.stubEnv("GROK_HOME", ""); vi.stubEnv("AGENTSWITCH_AGY_HOME", "");
    mkdirSync(join(userHome, ".config", "opencode"), { recursive: true });
    writeFileSync(join(userHome, ".config", "opencode", "opencode.json"), JSON.stringify({ mcp: { servers: { fs: { type: "local", command: ["x"] } } } }));
    mkdirSync(join(userHome, ".pi", "agent", "skills", "pdf"), { recursive: true });
    mkdirSync(join(userHome, ".gemini", "config", "skills", "notes"), { recursive: true });
    mkdirSync(join(userHome, ".grok", "skills", "mine"), { recursive: true });
    const store = new ProfileStore({ home: join(root, "service"), userHome });
    const work = store.create("grok", "Work", "subscription");
    mkdirSync(join(store.homeOf("grok", work.id)!, "skills", "theirs"), { recursive: true });
    const addons = new Addons({ binaries: {}, userHome, run: async () => ({ ok: true, out: "" }) });
    const app = new Hono<any>();
    mountAddons(app, { profiles: store, addons } as ApiDeps);
    const names = async (agent: string) => (await (await app.request(`/profiles/addons?agent=${agent}`)).json()).profiles.map((p: { id: string; items: { name: string }[] }) => [p.id, p.items.map((i) => i.name)]);
    expect(await names("opencode")).toEqual([["default", ["fs"]]]);
    expect(await names("pi")).toEqual([["default", ["pdf"]]]);
    expect(await names("agy")).toEqual([["default", ["notes"]]]);
    expect(await names("grok")).toEqual([["default", ["mine"]], [work.id, ["theirs"]]]);
    expect((await (await app.request("/profiles/addons?agent=pi")).json()).kinds).toEqual(["skills", "prompts", "extensions"]);
    const post = (path: string, body: object) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/profiles/addons/mcp/switch", { agent: "pi", name: "x", on: false, profiles: ["default"] })).status).toBe(400);
    expect((await post("/profiles/addons/mcp/install", { agent: "opencode", command: "opencode mcp add x -- y", profiles: ["nobody0000"] })).status).toBe(404);
    expect((await post("/profiles/addons/copy", { agent: "grok", kind: "skills", name: "mine", from: "default", profiles: [work.id] })).status).toBe(200);
    expect(existsSync(join(store.homeOf("grok", work.id)!, "skills", "mine"))).toBe(true);
  });
});
