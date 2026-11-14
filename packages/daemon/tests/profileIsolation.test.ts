import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { ProfileStore } from "../src/profiles/store.js";
import { transferClaudeContext } from "../src/profiles/context.js";
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

it("clears inherited credentials and endpoint selectors before applying the profile proxy and settings", () => {
  const w = world(), p = w.store.create("claude-code", "A", "subscription", undefined, { skills: [] });
  const launch = agentLauncher({ binaries: { "claude-code": "/bin/claude" }, hookUrl: () => "http://127.0.0.1:1", stateDir: join(w.root, "launch"), env: { PATH: "/usr/bin:/bin", HOME: w.userHome, ANTHROPIC_API_KEY: "bad", ANTHROPIC_AUTH_TOKEN: "bad", ANTHROPIC_BASE_URL: "https://wrong.test", CLAUDE_CODE_OAUTH_TOKEN: "bad", CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "other", HTTPS_PROXY: "http://other:1", NODE_OPTIONS: "--require other", BASH_ENV: "/other.rc", UNKNOWN_VENDOR_TOKEN: "bad" } });
  const plan = launch({ id: "one", harness: "claude-code", hookToken: "test", mode: "manual", cwd: p.workspace!, configHome: w.store.homeOf("claude-code", p.id)!, isolated: true, proxy: "http://127.0.0.1:2345", api: { name: "A", baseUrl: "https://chosen.test" }, browserKey: "claude-code." + p.id });
  expect(plan.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "AWS_PROFILE", "BASH_ENV", "NODE_OPTIONS", "UNKNOWN_VENDOR_TOKEN"]) expect(plan.env).not.toHaveProperty(key);
  expect(plan.env.HOME).not.toBe(w.userHome);
  expect(plan.env.HTTPS_PROXY).toBe("http://127.0.0.1:2345");
  expect(plan.args).toContain("--setting-sources");
  const settings = JSON.parse(readFileSync(plan.args[1]!, "utf8"));
  expect(settings.env.ANTHROPIC_BASE_URL).toBe("https://chosen.test");
  expect(settings.apiKeyHelper).toContain(" key");
});

it("copies only one transcript with a fresh id, discovers it and deletes it independently", async () => {
  const w = world(), target = w.store.create("claude-code", "Private", "subscription", undefined, { skills: [] });
  const source = transcript(join(w.userHome, ".claude", "projects"), w.root);
  const before = readFileSync(source, "utf8");
  const id = transferClaudeContext(source, w.store.claudeProjectsOf(target.id), target.workspace!);
  expect(id).not.toBe(session);
  const sessions = monitor(w);
  const located = sessions.locate("claude-code", id)!;
  expect(located).toContain(target.id);
  expect(JSON.parse(readFileSync(located, "utf8"))).toMatchObject({ sessionId: id, cwd: target.workspace, message: { content: "old context" } });
  expect(sessions.list().some((s) => s.id === id)).toBe(true);
  expect((await sessions.remove("claude-code", id)).failed).toEqual([]);
  expect(existsSync(located)).toBe(false);
  expect(readFileSync(source, "utf8")).toBe(before);
});

it("starts inside the private workspace and requires consent before stopping and transferring a session", async () => {
  const w = world(), target = w.store.create("claude-code", "Private", "subscription", undefined, { skills: [] });
  const source = transcript(join(w.userHome, ".claude", "projects"), w.root), sessions = monitor(w);
  const asked: LaunchRequest[] = [];
  const host = new TerminalHost({ launcher: (req) => { asked.push(req); return { file: "/bin/sh", args: ["-c", "sleep 30"], env: { PATH: "/usr/bin:/bin" }, hooks: false }; }, onSession: (agent, id, profile) => w.store.noteSession(agent as "claude-code", id, profile) });
  cleanup.push(() => host.closeAll());
  const app = new Hono();
  mountTerminals(app, { profiles: w.store, sessions, profileBrowsers: { of: () => ({ visible: () => false }) }, terminals: { host, audit: { record() {} }, agents: ["claude-code"], style: () => ({}), elsewhere: async () => null } } as unknown as ApiDeps);
  const post = (path: string, body: object) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const original = await (await post("/terminals/resume", { harness: "claude-code", cwd: w.root, agentSessionId: session })).json();
  const body = { harness: "claude-code", cwd: w.root, agentSessionId: session, profile: target.id, switchFrom: original.terminal.id };
  expect((await post("/terminals/resume", body)).status).toBe(409);
  expect(host.get(original.terminal.id)?.status).not.toBe("exited");
  const response = await post("/terminals/resume", { ...body, allowContextTransfer: true });
  expect(response.status).toBe(201);
  expect(asked.at(-1)).toMatchObject({ isolated: true, cwd: realpathSync(target.workspace!), browserKey: "claude-code." + target.id });
  expect(asked.at(-1)!.resume).not.toBe(session);
  expect(existsSync(source)).toBe(true);
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
