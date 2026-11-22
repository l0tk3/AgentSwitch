import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { ProfileStore } from "../src/profiles/store.js";
import { moveClaudeSession } from "../src/profiles/context.js";
import { agentLauncher } from "../src/terminals/launch.js";
import { claudeSignedIn } from "../src/terminals/signIn.js";
import { TerminalHost, type LaunchRequest } from "../src/terminals/host.js";
import { SessionMonitor } from "../src/sessions/monitor.js";
import { mountProfiles, exitFor } from "../src/api/profiles.js";
import { mountTerminals } from "../src/api/terminals.js";
import type { ApiDeps } from "../src/api/shared.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function writable(path: string) {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) writable(join(path, name));
}
function world() {
  const root = mkdtempSync(join(tmpdir(), "agentswitch-isolation-"));
  cleanup.push(() => { writable(root); rmSync(root, { recursive: true, force: true }); });
  const userHome = join(root, "user"), home = join(root, "service");
  mkdirSync(join(userHome, ".claude", "skills", "chosen"), { recursive: true });
  mkdirSync(join(userHome, ".claude", "skills", "other"));
  writeFileSync(join(userHome, ".claude", "skills", "chosen", "SKILL.md"), "explicit content");
  writeFileSync(join(userHome, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "other-account" }, hooks: { other: [] } }));
  writeFileSync(join(userHome, ".claude.json"), JSON.stringify({ userID: "old", oauthAccount: { emailAddress: "old@example.test" }, mcpServers: { old: { command: "other-account" } } }));
  const store = new ProfileStore({ home, userHome });
  return { root, home, userHome, store };
}
const session = "0f8fad5b-d9cb-469f-a165-70867728950e";
function transcript(projects: string, cwd: string) {
  const dir = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, session + ".jsonl");
  writeFileSync(path, JSON.stringify({ type: "user", uuid: "message-1", sessionId: session, cwd, timestamp: new Date().toISOString(), message: { role: "user", content: "old context" } }) + "\n");
  return path;
}
function monitor(w: ReturnType<typeof world>) {
  return new SessionMonitor({ claudeProjects: join(w.userHome, ".claude", "projects"), claudeProfileProjects: () => w.store.claudeProjectRoots(), codexSessions: join(w.root, "codex"), opencodeDb: join(w.root, "missing.db"), excluded: [], ranHere: () => true });
}

it("new profiles from the API have private configuration, history and explicitly selected read-only skills", async () => {
  const w = world(), app = new Hono();
  mountProfiles(app, { profiles: w.store } as unknown as ApiDeps);
  const old = w.store.create("claude-code", "Legacy", "subscription");
  const response = await app.request("/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "claude-code", name: "Private", sharedSkills: ["chosen"] }) });
  expect(response.status).toBe(201);
  const { profile } = await response.json();
  expect(profile.isolated).toBe(true);
  expect(profile.workspace).toBeUndefined();
  const home = w.store.homeOf("claude-code", profile.id)!;
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({});
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual({});
  for (const name of ["projects", "file-history", "todos", "plans", "skills", "plugins"]) expect(lstatSync(join(home, name)).isSymbolicLink()).toBe(false);
  expect(readdirSync(join(home, "skills"))).toEqual(["chosen"]);
  expect(lstatSync(join(home, "skills", "chosen", "SKILL.md")).mode & 0o222).toBe(0);
  writeFileSync(join(w.userHome, ".claude", "skills", "chosen", "SKILL.md"), "changed source");
  expect(readFileSync(join(home, "skills", "chosen", "SKILL.md"), "utf8")).toBe("explicit content");
  expect(lstatSync(join(w.store.homeOf("claude-code", old.id)!, "settings.json")).isSymbolicLink()).toBe(true);
  w.store.remove("claude-code", profile.id);
  expect(existsSync(home)).toBe(false);
  expect(existsSync(join(w.userHome, ".claude", "settings.json"))).toBe(true);
});

it("rejects skill traversal and links before creating any profile", () => {
  const w = world();
  symlinkSync(join(w.userHome, ".claude.json"), join(w.userHome, ".claude", "skills", "chosen", "account"));
  for (const skill of ["../..", "chosen", "missing"]) expect(() => w.store.create("claude-code", "Bad", "subscription", undefined, { skills: [skill] })).toThrow();
  expect(w.store.all()["claude-code"].profiles).toHaveLength(1);
});

it("lists copy checkboxes without credentials and copies only selected configuration", async () => {
  const w = world(), app = new Hono();
  for (const folder of ["commands", "agents"]) {
    mkdirSync(join(w.userHome, ".claude", folder));
    writeFileSync(join(w.userHome, ".claude", folder, "chosen.md"), "chosen instructions");
    writeFileSync(join(w.userHome, ".claude", folder, "other.md"), "not selected");
  }
  writeFileSync(join(w.userHome, ".claude", "CLAUDE.md"), "global instructions");
  writeFileSync(join(w.userHome, ".claude", "settings.json"), JSON.stringify({ model: "my-model", language: "zh", env: { ANTHROPIC_API_KEY: "never-copy" }, hooks: { bad: [] }, apiKeyHelper: "never-copy" }));
  writeFileSync(join(w.userHome, ".claude.json"), JSON.stringify({ userID: "never-copy", oauthAccount: { emailAddress: "never-copy" }, mcpServers: { chosen: { type: "http", url: "https://private.example", headers: { Authorization: "service-secret" } }, other: { command: "never-copy" } } }));
  mountProfiles(app, { profiles: w.store } as unknown as ApiDeps);
  const response = await app.request("/profiles/claude-code/copy-options");
  const text = await response.text();
  expect(text).not.toMatch(/service-secret|never-copy|private\.example/);
  expect(JSON.parse(text)).toMatchObject({ mcpServers: ["chosen", "other"], commands: ["chosen.md", "other.md"], instructions: true, preferences: true });
  const made = await app.request("/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "claude-code", name: "Selected", copyFromDefault: { skills: ["chosen"], mcpServers: ["chosen"], commands: ["chosen.md"], agents: [], instructions: true, preferences: true } }) });
  expect(made.status).toBe(201);
  const id = (await made.json()).profile.id;
  const home = w.store.homeOf("claude-code", id)!;
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({ mcpServers: { chosen: { type: "http", url: "https://private.example", headers: { Authorization: "service-secret" } } } });
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual({ model: "my-model", language: "zh" });
  expect(readdirSync(join(home, "commands"))).toEqual(["chosen.md"]);
  expect(readdirSync(join(home, "agents"))).toEqual([]);
  expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("global instructions");
  expect(lstatSync(join(home, "commands", "chosen.md")).mode & 0o222).toBe(0);
  writeFileSync(join(w.userHome, ".claude.json"), "{}");
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers).toHaveProperty("chosen");
  expect(() => w.store.create("claude-code", "Invalid", "subscription", undefined, { mcpServers: ["missing"] })).toThrow();
  expect(w.store.all()["claude-code"].profiles).toHaveLength(2);
});

/** `Default` with one plugin installed the way Claude Code 2.1.325 records it, and a status line that draws through it. */
function withPlugin(userHome: string) {
  const plugins = join(userHome, ".claude", "plugins"), at = join(plugins, "cache", "hud", "hud", "1.0.0"), market = join(plugins, "marketplaces", "hud");
  mkdirSync(join(at, "dist"), { recursive: true });
  mkdirSync(join(market, ".git"), { recursive: true });
  writeFileSync(join(at, "dist", "index.js"), "draw()");
  writeFileSync(join(market, "marketplace.json"), "{}");
  writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "hud@hud": [{ scope: "user", installPath: at, version: "1.0.0" }],
    "elsewhere@hud": [{ scope: "user", installPath: "/etc", version: "1" }],
    "lost@gone": [{ scope: "user", installPath: at, version: "1" }] } }));
  writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify({ hud: { source: { source: "github", repo: "x/hud" }, installLocation: market } }));
  writeFileSync(join(userHome, ".claude", "settings.json"), JSON.stringify({ model: "my-model", env: { ANTHROPIC_API_KEY: "never-copy" }, hooks: { bad: [] },
    enabledPlugins: { "hud@hud": true }, extraKnownMarketplaces: { hud: { source: { source: "github", repo: "x/hud" } } }, statusLine: { type: "command", command: "draw" } }));
  return { at, market };
}

it("copies a plugin with its marketplace and the status line, each only when ticked (2026-11-15)", () => {
  const w = world();
  withPlugin(w.userHome);
  // Only a plugin whose files are in the cache and whose marketplace is known can be copied.
  expect(w.store.copyOptions()).toMatchObject({ plugins: ["hud@hud"], statusLine: true });
  const none = w.store.create("claude-code", "None", "subscription", undefined, { skills: [] });
  expect(readdirSync(join(w.store.homeOf("claude-code", none.id)!, "plugins"))).toEqual([]);
  expect(() => w.store.create("claude-code", "Bad", "subscription", undefined, { plugins: ["elsewhere@hud"] })).toThrow();
  const p = w.store.create("claude-code", "Hud", "subscription", undefined, { plugins: ["hud@hud"], statusLine: true });
  const home = w.store.homeOf("claude-code", p.id)!, own = join(home, "plugins", "cache", "hud", "hud", "1.0.0");
  // Its own copy, where its own record says it is; nothing of it points back into Default's folder.
  expect(readFileSync(join(own, "dist", "index.js"), "utf8")).toBe("draw()");
  expect(JSON.parse(readFileSync(join(home, "plugins", "installed_plugins.json"), "utf8"))).toEqual({ version: 2, plugins: { "hud@hud": [{ scope: "user", installPath: own, version: "1.0.0" }] } });
  expect(JSON.parse(readFileSync(join(home, "plugins", "known_marketplaces.json"), "utf8"))).toEqual({ hud: { source: { source: "github", repo: "x/hud" }, installLocation: join(home, "plugins", "marketplaces", "hud") } });
  expect(existsSync(join(home, "plugins", "marketplaces", "hud", ".git"))).toBe(true);
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual({ statusLine: { type: "command", command: "draw" }, enabledPlugins: { "hud@hud": true }, extraKnownMarketplaces: { hud: { source: { source: "github", repo: "x/hud" } } } });
  // The plugin's copy is the profile's to update: writable, unlike a copied skill.
  expect(lstatSync(join(own, "dist", "index.js")).mode & 0o200).toBe(0o200);
});

it("a profile's copies are changed after it was made: what is named is added or removed, the rest is left (2026-11-15)", async () => {
  const w = world(), app = new Hono();
  withPlugin(w.userHome);
  writeFileSync(join(w.userHome, ".claude", "CLAUDE.md"), "global instructions");
  mountProfiles(app, { profiles: w.store } as unknown as ApiDeps);
  const p = w.store.create("claude-code", "Later", "subscription", undefined, { skills: ["chosen"] });
  const home = w.store.homeOf("claude-code", p.id)!;
  // What the profile got some other way: an MCP server it added itself, a setting of its own.
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ userID: "its-own", mcpServers: { mine: { command: "x" } } }));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ env: { OWN: "1" } }));
  const got = await (await app.request(`/profiles/claude-code/${p.id}/copies`)).text();
  expect(got).not.toMatch(/never-copy|other-account/);
  expect(JSON.parse(got)).toMatchObject({ options: { skills: ["chosen", "other"], plugins: ["hud@hud"], mcpServers: ["old"] }, held: { skills: ["chosen"], plugins: [], mcpServers: ["mine"], statusLine: false, instructions: false, preferences: false } });
  const put = (body: unknown) => app.request(`/profiles/claude-code/${p.id}/copies`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const changed = await put({ add: { skills: ["other"], plugins: ["hud@hud"], mcpServers: ["old"], instructions: true, preferences: true, statusLine: true }, remove: { skills: ["chosen"] } });
  expect(changed.status).toBe(200);
  expect((await changed.json()).held).toEqual({ skills: ["other"], commands: [], agents: [], mcpServers: ["mine", "old"], plugins: ["hud@hud"], instructions: true, preferences: true, statusLine: true });
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({ userID: "its-own", mcpServers: { mine: { command: "x" }, old: { command: "other-account" } } });
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toMatchObject({ env: { OWN: "1" }, model: "my-model", statusLine: { command: "draw" }, enabledPlugins: { "hud@hud": true } });
  // Taken back: each goes, and only it.
  expect((await put({ remove: { skills: ["other"], plugins: ["hud@hud"], mcpServers: ["old"], instructions: true, preferences: true, statusLine: true } })).status).toBe(200);
  expect(w.store.copiesOf(p.id).held).toEqual({ skills: [], commands: [], agents: [], mcpServers: ["mine"], plugins: [], instructions: false, preferences: false, statusLine: false });
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toMatchObject({ env: { OWN: "1" }, enabledPlugins: {} });
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).not.toHaveProperty("model");
  expect(existsSync(join(home, "plugins", "cache", "hud", "hud", "1.0.0"))).toBe(false);
  expect(existsSync(join(w.userHome, ".claude", "plugins", "cache", "hud", "hud", "1.0.0", "dist", "index.js"))).toBe(true);
  // Nothing is written when any of it is wrong; a profile linked to Default's configuration has none of its own.
  expect((await put({ add: { skills: ["chosen"] }, remove: { skills: ["../.."] } })).status).toBe(400);
  expect((await put({ add: { plugins: ["lost@gone"] } })).status).toBe(400);
  expect(w.store.copiesOf(p.id).held.skills).toEqual([]);
  const linked = w.store.create("claude-code", "Linked", "subscription");
  expect((await app.request(`/profiles/claude-code/${linked.id}/copies`)).status).toBe(400);
  expect((await app.request("/profiles/claude-code/nobody00/copies")).status).toBe(404);
});

it("clears inherited credentials and endpoint selectors before applying the profile proxy and settings", () => {
  const w = world(), p = w.store.create("claude-code", "A", "subscription", undefined, { skills: [] });
  const launch = agentLauncher({ binaries: { "claude-code": "/bin/claude" }, hookUrl: () => "http://127.0.0.1:1", stateDir: join(w.root, "launch"), env: { PATH: "/usr/bin:/bin", HOME: w.userHome, ANTHROPIC_API_KEY: "bad", ANTHROPIC_AUTH_TOKEN: "bad", ANTHROPIC_BASE_URL: "https://wrong.test", CLAUDE_CODE_OAUTH_TOKEN: "bad", CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "other", HTTPS_PROXY: "http://other:1", NODE_OPTIONS: "--require other", BASH_ENV: "/other.rc", UNKNOWN_VENDOR_TOKEN: "bad" } });
  const plan = launch({ id: "one", harness: "claude-code", hookToken: "test", mode: "manual", cwd: w.root, configHome: w.store.homeOf("claude-code", p.id)!, isolated: true, proxy: "http://127.0.0.1:2345", api: { name: "A", baseUrl: "https://chosen.test" }, browserKey: "claude-code." + p.id });
  expect(plan.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "AWS_PROFILE", "BASH_ENV", "NODE_OPTIONS", "UNKNOWN_VENDOR_TOKEN"]) expect(plan.env).not.toHaveProperty(key);
  expect(plan.env.HOME).toBe(w.userHome);
  for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) expect(plan.env).not.toHaveProperty(key);
  expect(existsSync(join(w.store.homeOf("claude-code", p.id)!, "..", "system-home"))).toBe(false);
  expect(plan.env.HTTPS_PROXY).toBe("http://127.0.0.1:2345");
  expect(plan.args).toContain("--setting-sources");
  const settings = JSON.parse(readFileSync(plan.args[1]!, "utf8"));
  expect(settings.env.ANTHROPIC_BASE_URL).toBe("https://chosen.test");
  expect(settings.apiKeyHelper).toContain(" key");
});

it("removes the private home folder isolated profiles used to have, and nothing else of the profile", () => {
  const w = world(), p = w.store.create("claude-code", "Old", "subscription", undefined, { skills: [] });
  const root = join(w.store.homeOf("claude-code", p.id)!, "..");
  mkdirSync(join(root, "system-home", ".local", "share"), { recursive: true });
  writeFileSync(join(root, "system-home", ".local", "share", "copy"), "x");
  chmodSync(join(root, "system-home", ".local"), 0o500);
  expect(w.store.removeOldSystemHomes()).toBe(1);
  expect(existsSync(join(root, "system-home"))).toBe(false);
  expect(existsSync(join(root, "home", "settings.json"))).toBe(true);
  expect(w.store.removeOldSystemHomes()).toBe(0);
});

it("moves a session's record to the profile it goes on under, under a new id, with what stands beside it — and back again", async () => {
  const w = world(), target = w.store.create("claude-code", "Private", "subscription", undefined, { skills: [] });
  const own = join(w.userHome, ".claude"), theirs = join(w.store.homeOf("claude-code", target.id)!);
  const source = transcript(join(own, "projects"), w.root);
  const folderName = w.root.replace(/[^a-zA-Z0-9]/g, "-"), folder = join(source, "..");
  // A line that only mentions the id (in what somebody said) is left as it is.
  writeFileSync(source, readFileSync(source, "utf8") + JSON.stringify({ type: "user", sessionId: session, message: { content: `about ${session}` } }) + "\n");
  const before = readFileSync(source, "utf8");
  // What Claude Code keeps beside a record by its id, and another session's, which stays.
  for (const dir of [join(folder, session, "subagents"), join(own, "file-history", session), join(own, "session-env", session), join(own, "todos"), join(own, "file-history", "another-session")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(folder, session, "subagents", "a.jsonl"), JSON.stringify({ sessionId: session, agentId: "a" }) + "\n");
  writeFileSync(join(own, "file-history", session, "f@v1"), "old");
  writeFileSync(join(own, "todos", `${session}-agent-${session}.json`), "[]");
  writeFileSync(join(own, "todos", "another-session.json"), "[]");
  const id = moveClaudeSession(source, w.store.claudeProjectsOf(target.id));
  expect(id).not.toBe(session);
  const sessions = monitor(w);
  const located = sessions.locate("claude-code", id)!;
  expect(located).toBe(join(theirs, "projects", folderName, id + ".jsonl"));
  expect(readFileSync(located, "utf8")).toBe(before.split(`"sessionId":"${session}"`).join(`"sessionId":"${id}"`));
  expect(readFileSync(located, "utf8")).toContain(`about ${session}`);
  // One record: the old one is gone, and the list has the conversation once.
  expect(existsSync(source)).toBe(false);
  expect(sessions.locate("claude-code", session)).toBeNull();
  expect(sessions.list().filter((s) => s.cwd === w.root).map((s) => s.id)).toEqual([id]);
  expect(readFileSync(join(theirs, "projects", folderName, id, "subagents", "a.jsonl"), "utf8")).toBe(JSON.stringify({ sessionId: id, agentId: "a" }) + "\n");
  for (const moved of [join("file-history", id, "f@v1"), join("session-env", id), join("todos", `${id}-agent-${id}.json`)]) expect(existsSync(join(theirs, moved)), moved).toBe(true);
  for (const gone of [join("projects", folderName, session), join("file-history", session), join("session-env", session), join("todos", `${session}-agent-${session}.json`)]) expect(existsSync(join(own, gone)), gone).toBe(false);
  expect(existsSync(join(own, "file-history", "another-session"))).toBe(true);
  expect(existsSync(join(own, "todos", "another-session.json"))).toBe(true);
  // A record of the new id already there is never written over; the record stays where it is.
  expect(() => moveClaudeSession(located, join(theirs, "projects"), id)).toThrow();
  writeFileSync(join(own, "projects", folderName, "11111111-2222-3333-4444-555555555555.jsonl"), "taken\n");
  expect(() => moveClaudeSession(located, join(own, "projects"), "11111111-2222-3333-4444-555555555555")).toThrow();
  expect(existsSync(located)).toBe(true);
  // And back: the same record with what was said meanwhile, under another new id.
  writeFileSync(located, readFileSync(located, "utf8") + JSON.stringify({ type: "assistant", sessionId: id, message: { content: "more" } }) + "\n");
  const again = moveClaudeSession(located, join(own, "projects"));
  expect([session, id]).not.toContain(again);
  expect(readFileSync(join(own, "projects", folderName, again + ".jsonl"), "utf8")).toContain(`"sessionId":"${again}","message":{"content":"more"}`);
  expect(existsSync(located)).toBe(false);
  expect(existsSync(join(own, "file-history", again, "f@v1"))).toBe(true);
  // Between profiles that share their sessions it is renamed where it is.
  const renamed = moveClaudeSession(join(own, "projects", folderName, again + ".jsonl"), join(own, "projects"));
  expect(readdirSync(join(own, "projects", folderName)).filter((n) => n.endsWith(".jsonl")).sort()).toEqual(["11111111-2222-3333-4444-555555555555.jsonl", renamed + ".jsonl"].sort());
  expect(() => moveClaudeSession(join(folder, "notes.txt"), join(theirs, "projects"))).toThrow();
});

it("keeps the user-selected project directory and requires consent before transferring a session", async () => {
  const w = world(), target = w.store.create("claude-code", "Private", "subscription", undefined, { skills: [] });
  const source = transcript(join(w.userHome, ".claude", "projects"), w.root), sessions = monitor(w);
  const asked: LaunchRequest[] = [];
  const host = new TerminalHost({ launcher: (req) => { asked.push(req); return { file: "/bin/sh", args: ["-c", "sleep 30"], env: { PATH: "/usr/bin:/bin" }, hooks: false }; }, onSession: (agent, id, profile) => w.store.noteSession(agent as "claude-code", id, profile) });
  cleanup.push(() => host.closeAll());
  const app = new Hono();
  mountTerminals(app, { profiles: w.store, sessions, profileBrowsers: { of: () => ({ visible: () => false }) }, terminals: { host, audit: { record() {} }, agents: ["claude-code"], style: () => ({}), elsewhere: async () => null } } as unknown as ApiDeps);
  const post = (path: string, body: object) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("/terminals", { harness: "claude-code", cwd: join(w.root, "missing"), profile: target.id })).status).toBe(400);
  const fresh = await post("/terminals", { harness: "claude-code", cwd: w.root, profile: target.id });
  expect(fresh.status).toBe(201);
  expect(asked.at(-1)?.cwd).toBe(w.root);
  const original = await (await post("/terminals/resume", { harness: "claude-code", cwd: w.root, agentSessionId: session })).json();
  const body = { harness: "claude-code", cwd: w.root, agentSessionId: session, profile: target.id, switchFrom: original.terminal.id };
  expect((await post("/terminals/resume", body)).status).toBe(409);
  expect(host.get(original.terminal.id)?.status).not.toBe("exited");
  const response = await post("/terminals/resume", { ...body, allowContextTransfer: true });
  expect(response.status).toBe(201);
  expect(asked.at(-1)).toMatchObject({ isolated: true, cwd: w.root, browserKey: "claude-code." + target.id });
  // The same conversation under a new id: its record is the target profile's now, the old one is gone, listed once.
  const moved = asked.at(-1)!.resume!;
  expect(moved).not.toBe(session);
  expect(existsSync(source)).toBe(false);
  expect(sessions.locate("claude-code", moved)).toContain(target.id);
  expect(sessions.list().filter((s) => s.cwd === w.root).map((s) => s.id)).toEqual([moved]);
  expect(w.store.sessionProfile("claude-code", moved)).toBe(target.id);
  expect(host.get(original.terminal.id)).toBeNull();
});

it("never falls back to a shared browser when an isolated browser is unavailable", async () => {
  const w = world(), p = w.store.create("claude-code", "Private", "subscription", undefined, { skills: [] });
  expect(await exitFor({ profiles: w.store }, "claude-code", p.id, p.name)).toHaveProperty("refused");
});

it("checks an isolated account's sign-in without the daemon's credentials", async () => {
  const w = world(), p = w.store.create("claude-code", "Private", "subscription", undefined, { skills: [] });
  const binary = join(w.root, "fake-claude");
  writeFileSync(binary, `#!/bin/sh
if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$UNKNOWN_VENDOR_TOKEN" ] && [ "$1" = "--setting-sources" ]; then
  echo '{"loggedIn":true}'
else
  echo '{"loggedIn":false}'
fi
`, { mode: 0o755 });
  vi.stubEnv("ANTHROPIC_API_KEY", "not-this-account");
  vi.stubEnv("UNKNOWN_VENDOR_TOKEN", "not-this-account");
  try { expect(await claudeSignedIn(binary, w.store.homeOf("claude-code", p.id)!, true)).toBe(true); }
  finally { vi.unstubAllEnvs(); }
});
