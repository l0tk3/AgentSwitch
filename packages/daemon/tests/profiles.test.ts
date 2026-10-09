/** Profiles (docs/profiles-v0.md §2, §3): a Claude Code profile is a folder of its own with the user's set-up and the
 *  sessions linked in and nothing of the account carried over; the current one is what new terminals start under; the
 *  Mac's own folder is never written to. */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { afterEach } from "vitest";
import { exitFor, mountProfiles } from "../src/api/profiles.js";
import { parseExit } from "../src/browser/exit.js";
import { ExitError, ExitPool } from "../src/browser/exits.js";
import type { ApiDeps } from "../src/api/shared.js";
import { markRemote } from "../src/core/caller.js";
import { DEFAULT_PROFILE, ProfileError, ProfileStore } from "../src/profiles/store.js";
import { mountTerminals } from "../src/api/terminals.js";
import { TerminalHost, type LaunchRequest } from "../src/terminals/host.js";
import { agentLauncher, proxyEnv } from "../src/terminals/launch.js";
import { claudeSignedIn } from "../src/terminals/signIn.js";
import { chmodSync } from "node:fs";

const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

/** A proxy somewhere else, made up: it answers whatever it is asked for with where it "lets traffic out", and keeps
 *  who asked (the name and password it was given). `down()`: it stops listening. */
async function upstream(answer?: (url: string) => { status: number; body: string }) {
  const seen: { url: string; auth: string | null }[] = [];
  const server = createServer((req, res) => {
    const auth = req.headers["proxy-authorization"];
    seen.push({ url: String(req.url), auth: typeof auth === "string" ? Buffer.from(auth.replace(/^Basic /, ""), "base64").toString("utf8") : null });
    const said = answer?.(String(req.url)) ?? { status: 200, body: JSON.stringify({ ip: "203.0.113.9", city: "Tokyo", country: "JP", timezone: "Asia/Tokyo" }) };
    res.writeHead(said.status, { "content-type": "application/json" }).end(said.body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const down = () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); });
  closers.push(down);
  return { server: `http://127.0.0.1:${port}`, seen, down };
}
const pool = (resolve?: ConstructorParameters<typeof ExitPool>[0]["resolve"]) => {
  const p = new ExitPool({ ownPorts: () => [4711], lookup: "http://lookup.test/json", others: ["http://trace.test/cdn-cgi/trace"], ...(resolve ? { resolve } : {}) });
  closers.push(() => p.stop());
  return p;
};

function world() {
  const root = mkdtempSync(join(tmpdir(), "agentswitch-profiles-"));
  const userHome = join(root, "user"), home = join(root, "as");
  mkdirSync(join(userHome, ".claude", "skills"), { recursive: true });
  writeFileSync(join(userHome, ".claude", "CLAUDE.md"), "be brief\n");
  writeFileSync(join(userHome, ".claude", "settings.json"), '{"permissions":{"allow":["Bash(ls:*)"]}}');
  writeFileSync(join(userHome, ".claude.json"), JSON.stringify({
    userID: "u".repeat(64), machineID: "m".repeat(64), oauthAccount: { emailAddress: "me@example.com", accountUuid: "a1" }, theme: "dark", hasCompletedOnboarding: true,
    mcpServers: { docs: { command: "x" } }, tipsHistory: { a: 1 },
    projects: { "/w/app": { hasTrustDialogAccepted: true, allowedTools: ["Bash"], lastSessionId: "s1", lastCost: 3 } },
  }));
  return { root, userHome, home, store: new ProfileStore({ home, userHome, now: () => 1_000 }) };
}

describe("the profile store", () => {
  it("has Default for every agent, the Mac's own; a new Claude Code profile is a folder with links and no account", () => {
    const { userHome, home, store } = world();
    expect(store.all()["claude-code"]).toEqual({ current: DEFAULT_PROFILE, creatable: true, profiles: [{ id: "default", name: "Default", kind: "subscription", createdAt: 0, account: "me@example.com" }] });
    expect(store.all().codex).toMatchObject({ current: "default", creatable: false, profiles: [{ id: "default" }] });
    expect(store.homeOf("claude-code", "default")).toBeNull();

    const work = store.create("claude-code", "  Work ", "subscription");
    expect(work).toMatchObject({ name: "Work", kind: "subscription", createdAt: 1_000 });
    const dir = store.homeOf("claude-code", work.id)!;
    expect(dir).toBe(join(home, "profiles", "claude-code", work.id, "home"));
    // The user's own set-up and the sessions are the Mac's, linked; what the Mac does not have is not invented, but
    // the session folders are made there so both write to one place.
    for (const name of ["CLAUDE.md", "skills", "settings.json", "projects", "file-history", "todos", "plans"]) {
      expect(lstatSync(join(dir, name)).isSymbolicLink(), name).toBe(true);
      expect(readlinkSync(join(dir, name))).toBe(join(userHome, ".claude", name));
    }
    expect(existsSync(join(dir, "commands"))).toBe(false);
    expect(existsSync(join(userHome, ".claude", "projects"))).toBe(true);
    // Nothing that names the account or the device; what is the user's is carried once.
    const seeded = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    expect(seeded).toEqual({ theme: "dark", hasCompletedOnboarding: true, mcpServers: { docs: { command: "x" } }, projects: { "/w/app": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] } } });
    expect(JSON.stringify(seeded)).not.toMatch(/userID|machineID|oauthAccount|me@example|lastSessionId/);
    // The Mac's own file is as it was.
    expect(JSON.parse(readFileSync(join(userHome, ".claude.json"), "utf8")).oauthAccount.emailAddress).toBe("me@example.com");
    // Listed, not signed in yet; once Claude Code has written who is, it says.
    expect(store.all()["claude-code"].profiles.map((p) => [p.name, p.account ?? null])).toEqual([["Default", "me@example.com"], ["Work", null]]);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ ...seeded, oauthAccount: { emailAddress: "work@example.com" } }));
    expect(store.all()["claude-code"].profiles[1]!.account).toBe("work@example.com");
  });

  it("keeps a current profile per agent; a removed one's folder goes and Default takes over", () => {
    const { store } = world();
    const work = store.create("claude-code", "Work", "subscription");
    store.setCurrent("claude-code", work.id);
    expect(store.current("claude-code")).toBe(work.id);
    expect(store.current("codex")).toBe("default");
    expect(store.nameOf("claude-code", work.id)).toBe("Work");
    const dir = store.homeOf("claude-code", work.id)!;
    expect(() => store.setCurrent("claude-code", "nope12")).toThrow(ProfileError);
    expect(() => store.create("claude-code", "work", "api")).toThrow(/already/);
    expect(() => store.create("claude-code", "  ", "api")).toThrow(/name/);
    expect(() => store.create("codex", "Team", "subscription")).toThrow(/Claude Code only/);
    expect(() => store.remove("claude-code", "default")).toThrow(ProfileError);
    const relay = store.create("claude-code", "Relay", "api");
    expect(store.othersOf("claude-code", work.id)).toEqual([join(dir, "..", "..", relay.id)].map((p) => join(p)));
    store.remove("claude-code", work.id);
    expect(existsSync(dir)).toBe(false);
    expect(store.current("claude-code")).toBe("default");
    expect(store.homeOf("claude-code", work.id)).toBeNull();
    expect(store.homeOf("claude-code", "../../etc")).toBeNull();
  });
});

describe("a profile's own proxy", () => {
  it("is kept with the profile; the screens are told it has a password, never the password", () => {
    const { store } = world();
    const work = store.create("claude-code", "Work", "subscription");
    expect(store.proxyOf("claude-code", work.id)).toBeNull();
    store.setProxy("claude-code", work.id, { server: "http://proxy.example:8080", username: "me", password: "enc:v1:abcdefghijklmnopqrstuvwx" });
    store.setExit("claude-code", work.id, { ip: "203.0.113.9", place: "Tokyo", timezone: "Asia/Tokyo", checkedAt: 2_000 });
    expect(store.proxyOf("claude-code", work.id)).toEqual({ server: "http://proxy.example:8080", username: "me", password: "enc:v1:abcdefghijklmnopqrstuvwx" });
    const shown = store.all()["claude-code"].profiles[1]!;
    expect(shown).toMatchObject({ name: "Work", proxy: { server: "http://proxy.example:8080", username: "me", sealed: true }, exit: { ip: "203.0.113.9", place: "Tokyo" } });
    expect(JSON.stringify(store.all())).not.toContain("enc:v1:");
    // Another proxy: what was known of the old one's exit goes. None: both go. The Mac's own profile has none here.
    store.setProxy("claude-code", work.id, { server: "socks5://127.0.0.1:1080" });
    expect(store.all()["claude-code"].profiles[1]).toMatchObject({ proxy: { server: "socks5://127.0.0.1:1080", sealed: false } });
    expect(store.all()["claude-code"].profiles[1]!.exit).toBeUndefined();
    store.setProxy("claude-code", work.id, null);
    expect(store.all()["claude-code"].profiles[1]!.proxy).toBeUndefined();
    expect(() => store.setProxy("claude-code", DEFAULT_PROFILE, { server: "http://x:1" })).toThrow(ProfileError);
    expect(() => store.setExit("claude-code", "nope12", null)).toThrow(ProfileError);
  });

  it("is reached through a forwarder on this Mac, checked by asking where it lets traffic out", async () => {
    const far = await upstream();
    const exits = pool(async (token, frames) => ({ value: `pw-of-${token.slice(7, 11)}@${new URL(frames[0]!).host}`, label: "proxy" }));
    const via = await exits.address("claude-code/abc123", { server: far.server });
    expect(via).toMatchObject({ server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), username: "agentswitch" });
    // What a process is given: the forwarder, with its own name and a password made for this run — not the proxy's.
    expect(ExitPool.url(via)).toBe(`http://agentswitch:${via.password}@${new URL(via.server).host}`);
    expect(await exits.check("claude-code/abc123", { server: far.server })).toEqual({ ip: "203.0.113.9", place: "Tokyo", timezone: "Asia/Tokyo" });
    expect(far.seen).toEqual([{ url: "http://lookup.test/json", auth: null }]);
    expect(parseExit("fl=1\nip=203.0.113.9\nloc=SG\n")).toEqual({ ip: "203.0.113.9", place: "SG", timezone: null });
    expect(exits.requests("claude-code/abc123")).toBe(1);
    // The same proxy again: the same forwarder. With a name and a password: the gate gives the password for the
    // proxy's own host, and the forwarder shows it to the proxy.
    expect((await exits.address("claude-code/abc123", { server: far.server })).server).toBe(via.server);
    const sealed = { server: far.server, username: "me", password: "enc:v1:abcdefghijklmnopqrstuvwx" };
    await exits.check("claude-code/abc123", sealed);
    expect(far.seen.at(-1)).toEqual({ url: "http://lookup.test/json", auth: `me:pw-of-abcd@${new URL(far.server).host}` });
    // Nothing gets out past the forwarder without its password.
    const now = new URL((await exits.address("claude-code/abc123", sealed)).server);
    const answered = await new Promise<number>((ok) => { request({ host: now.hostname, port: now.port, path: "http://lookup.test/json" }, (res) => { res.resume(); ok(res.statusCode ?? 0); }).end(); });
    expect(answered).toBe(407);
    // The proxy down: said, with the reason; nothing is asked straight instead.
    await far.down();
    await expect(exits.check("claude-code/abc123", sealed)).rejects.toThrow(ExitError);
    await expect(exits.check("claude-code/abc123", sealed)).rejects.toThrow(/经这个代理连不出去/);
    // A proxy that is not written as one, a password that is not a ciphertext or has no name, no gate to ask.
    await expect(exits.address("k", { server: "proxy.example" })).rejects.toThrow(/scheme:\/\/host:port/);
    await expect(exits.address("k", { server: far.server, username: "me", password: "hunter2" })).rejects.toThrow(/密文/);
    await expect(exits.address("k", { server: far.server, password: "enc:v1:abcdefghijklmnopqrstuvwx" })).rejects.toThrow(/用户名/);
    await expect(pool().address("k", sealed)).rejects.toThrow(/凭据网关不可用/);
  });

  it("is not held to be down because a lookup will not say where it lets traffic out", async () => {
    // The first lookup limits how often an address may ask (seen for real, 2026-10-09): the next one is asked.
    const limited = await upstream((url) => (url.startsWith("http://lookup.test") ? { status: 429, body: "slow down" } : { status: 200, body: "fl=1\nip=203.0.113.9\nts=1.2\nloc=SG\n" }));
    const exits = pool();
    expect(await exits.check("k", { server: limited.server })).toEqual({ ip: "203.0.113.9", place: "SG", timezone: null });
    expect(limited.seen.map((s) => new URL(s.url).host)).toEqual(["lookup.test", "trace.test"]);
    // Every lookup answers and none says: the proxy works, the place is not known — a terminal still starts.
    const mute = await upstream(() => ({ status: 429, body: "slow down" }));
    const { store } = world();
    const work = store.create("claude-code", "Work", "subscription");
    store.setProxy("claude-code", work.id, { server: mute.server });
    const none = pool();
    expect(await none.check(`claude-code.${work.id}`, { server: mute.server })).toEqual({ ip: "", place: null, timezone: null });
    expect(await exitFor({ profiles: store, exits: none }, "claude-code", work.id, "Work")).toEqual({ proxy: expect.stringContaining("@127.0.0.1:"), browserKey: `claude-code.${work.id}` });
    expect(store.all()["claude-code"].profiles[1]!.exit).toBeUndefined();
  });

  it("is checked before anything starts under the profile; one that does not answer starts nothing", async () => {
    const { store } = world();
    const far = await upstream();
    const exits = pool();
    const work = store.create("claude-code", "Work", "subscription"), plain = store.create("claude-code", "Plain", "subscription");
    store.setProxy("claude-code", work.id, { server: far.server });
    const deps = { profiles: store, exits };
    // No proxy of its own: nothing is set, nothing is asked.
    expect(await exitFor(deps, "claude-code", plain.id, "Plain")).toEqual({});
    expect(far.seen).toHaveLength(0);
    const way = await exitFor(deps, "claude-code", work.id, "Work", () => 5_000);
    // With a proxy of its own it has a browser of its own too, by the same key.
    expect(way).toEqual({ proxy: expect.stringMatching(/^http:\/\/agentswitch:[\w-]+@127\.0\.0\.1:\d+$/), exit: { ip: "203.0.113.9", place: "Tokyo" }, browserKey: `claude-code.${work.id}` });
    expect(far.seen).toHaveLength(1);
    expect(store.all()["claude-code"].profiles[1]!.exit).toEqual({ ip: "203.0.113.9", place: "Tokyo", timezone: "Asia/Tokyo", checkedAt: 5_000 });
    await far.down();
    expect(await exitFor(deps, "claude-code", work.id, "Work")).toEqual({ refused: expect.stringMatching(/^配置 Work 的代理没有通，终端没有开：经这个代理连不出去/), status: 502 });
    expect(store.all()["claude-code"].profiles[1]!.exit).toBeUndefined();
    expect(await exitFor({ profiles: store }, "claude-code", work.id, "Work")).toMatchObject({ status: 503 });
  });

  it("is the agent's way out: its environment and, for Claude Code, the settings laid over the user's", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agentswitch-profile-proxy-"));
    const launch = agentLauncher({ binaries: { "claude-code": "/bin/claude", codex: "/bin/codex" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, env: { PATH: "/usr/bin", HOME: "/Users/u", HTTPS_PROXY: "http://old:1" } });
    const via = "http://agentswitch:pw@127.0.0.1:50123";
    const own = launch({ id: "c1", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok", configHome: "/as/p/home", proxy: via });
    expect(own.env).toMatchObject({ HTTPS_PROXY: via, HTTP_PROXY: via, ALL_PROXY: via, https_proxy: via, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" });
    const settings = JSON.parse(readFileSync(join(stateDir, "c1", "settings.json"), "utf8")) as { env?: Record<string, string>; hooks: object };
    expect(settings.env).toEqual(proxyEnv(via));
    expect(settings.hooks).toBeTruthy();
    // Without a proxy of its own nothing is set or laid over: what the user's environment has stays.
    const plain = launch({ id: "c2", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    expect(plain.env.HTTPS_PROXY).toBe("http://old:1");
    expect(JSON.parse(readFileSync(join(stateDir, "c2", "settings.json"), "utf8")).env).toBeUndefined();
  });
});

describe("profiles over HTTP", () => {
  function served() {
    const w = world();
    const app = new Hono();
    const exits = pool(), direct: string[] = [];
    mountProfiles(app, { profiles: w.store, exits, clash: { addDirect: async (address: string) => { direct.push(address); } } } as unknown as ApiDeps);
    const call = async (method: string, path: string, body?: unknown, env: object = {}) => {
      const res = await app.request(path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }, env);
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    return { ...w, call, direct };
  }

  it("sets a profile's proxy on the Mac, checks it at once, and has Clash send its host direct", async () => {
    const { call, direct, store } = served();
    const far = await upstream();
    const id = (await call("POST", "/profiles", { agent: "claude-code", name: "Work" })).json.profile.id as string;
    const set = await call("PUT", `/profiles/claude-code/${id}/proxy`, { server: far.server });
    expect(set.status).toBe(200);
    expect(set.json.agents["claude-code"].profiles[1]).toMatchObject({ proxy: { server: far.server, sealed: false }, exit: { ip: "203.0.113.9", place: "Tokyo" } });
    expect(set.json.problem).toBeUndefined();
    expect(direct).toEqual(["127.0.0.1"]);
    // Asked again from any screen; a paired device may check, not set.
    const phone = markRemote({}, { deviceId: "phone" });
    expect((await call("POST", `/profiles/claude-code/${id}/check`, undefined, phone)).json.agents["claude-code"].profiles[1].exit.ip).toBe("203.0.113.9");
    expect((await call("PUT", `/profiles/claude-code/${id}/proxy`, { server: far.server }, phone)).status).toBe(403);
    // What is not a proxy is refused and nothing changes; a password must be a ciphertext.
    expect(await call("PUT", `/profiles/claude-code/${id}/proxy`, { server: "proxy.example" })).toMatchObject({ status: 400, json: { error: expect.stringContaining("scheme://host:port") } });
    expect((await call("PUT", `/profiles/claude-code/${id}/proxy`, { server: far.server, username: "me", password: "hunter2" })).status).toBe(400);
    expect(store.proxyOf("claude-code", id)).toEqual({ server: far.server });
    expect((await call("PUT", "/profiles/claude-code/nope12/proxy", { server: far.server })).status).toBe(404);
    // A proxy that is down is kept all the same, and said to be: it may be back later.
    await far.down();
    const down = await call("PUT", `/profiles/claude-code/${id}/proxy`, { server: far.server, username: "me" });
    expect(down.json).toMatchObject({ problem: expect.stringContaining("连不出去"), agents: { "claude-code": { profiles: [{}, { proxy: { server: far.server, username: "me", sealed: false } }] } } });
    expect(down.json.agents["claude-code"].profiles[1].exit).toBeUndefined();
    expect((await call("POST", `/profiles/claude-code/${id}/check`)).json.problem).toContain("连不出去");
    // Taken away: this Mac's own way out again.
    const none = await call("PUT", `/profiles/claude-code/${id}/proxy`, { server: null });
    expect(none.json.agents["claude-code"].profiles[1].proxy).toBeUndefined();
    expect((await call("POST", `/profiles/claude-code/${id}/check`)).status).toBe(404);
  });

  it("lists, makes, makes current and removes; a paired device may look and switch, not make or remove", async () => {
    const { call } = served();
    expect((await call("GET", "/profiles")).json.agents["claude-code"].profiles).toHaveLength(1);
    const made = await call("POST", "/profiles", { agent: "claude-code", name: "Work" });
    expect(made.status).toBe(201);
    const id = made.json.profile.id as string;
    expect((await call("POST", "/profiles", { agent: "claude-code", name: "Work" })).status).toBe(409);
    expect((await call("POST", "/profiles", { agent: "codex", name: "Team" })).status).toBe(400);
    const phone = markRemote({}, { deviceId: "phone" });
    expect((await call("POST", "/profiles", { agent: "claude-code", name: "Other" }, phone)).status).toBe(403);
    expect((await call("DELETE", `/profiles/claude-code/${id}`, undefined, phone)).status).toBe(403);
    const switched = await call("POST", "/profiles/current", { agent: "claude-code", id }, phone);
    expect(switched.json.agents["claude-code"].current).toBe(id);
    expect((await call("POST", "/profiles/current", { agent: "claude-code", id: "nope12" })).status).toBe(404);
    expect((await call("DELETE", `/profiles/claude-code/${id}`)).json.agents["claude-code"]).toMatchObject({ current: "default" });
    expect((await call("DELETE", `/profiles/claude-code/${id}`)).status).toBe(404);
  });
});

describe("a terminal under a profile", () => {
  it("starts Claude Code with the profile's folder as its config folder; Default sets nothing", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agentswitch-profile-launch-"));
    const launch = agentLauncher({ binaries: { "claude-code": "/bin/claude", codex: "/bin/codex" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, env: { PATH: "/usr/bin", HOME: "/Users/u" } });
    const own = launch({ id: "c1", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok", configHome: "/as/profiles/claude-code/abc123/home" });
    expect(own.env.CLAUDE_CONFIG_DIR).toBe("/as/profiles/claude-code/abc123/home");
    const plain = launch({ id: "c2", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    expect(plain.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    // Another agent is not given Claude Code's folder.
    expect(launch({ id: "x1", harness: "codex", cwd: "/tmp", mode: "manual", hookToken: "tok", configHome: "/x" }).env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("is given its first input as Claude Code's last argument, after everything else", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agentswitch-profile-first-"));
    const launch = agentLauncher({ binaries: { "claude-code": "/bin/claude" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, env: { PATH: "/usr/bin", HOME: "/Users/u" } });
    const args = launch({ id: "c1", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok", configHome: "/as/p/home", resume: "s-1", firstInput: "/login" }).args;
    expect(args.slice(-3)).toEqual(["--resume", "s-1", "/login"]);
    expect(launch({ id: "c2", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok" }).args).not.toContain("/login");
  });
});

describe("a profile nobody is signed in to", () => {
  /** A stand-in for Claude Code that answers `auth status` as the real one does (JSON, exit 1 when signed out), from
   *  what the folder it is pointed at holds; it writes down the folder and whether a session of another was around it. */
  function standIn(dir: string) {
    const file = join(dir, "claude"), seen = join(dir, "seen");
    writeFileSync(file, `#!/bin/sh
printf '%s|%s|%s\n' "$*" "$CLAUDE_CONFIG_DIR" "\${CLAUDECODE:-none}" >> "${seen}"
case "$(cat "$CLAUDE_CONFIG_DIR/state" 2>/dev/null)" in
  in) printf '{"loggedIn": true, "authMethod": "claude.ai"}'; exit 0 ;;
  out) printf '{"loggedIn": false, "authMethod": "none"}'; exit 1 ;;
  old) echo "error: unknown command 'auth'" >&2; exit 1 ;;
  *) /bin/sleep 30 ;;
esac
`);
    chmodSync(file, 0o755);
    return { file, seen };
  }

  it("is told apart by asking Claude Code itself, in that folder; when it does not say, nothing is assumed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-signin-"));
    const { file, seen } = standIn(dir);
    const folder = (state: string) => { const d = mkdtempSync(join(dir, "home-")); writeFileSync(join(d, "state"), state); return d; };
    process.env.CLAUDECODE = "1";
    closers.push(() => { delete process.env.CLAUDECODE; });
    const out = folder("out");
    expect(await claudeSignedIn(file, folder("in"))).toBe(true);
    expect(await claudeSignedIn(file, out)).toBe(false);
    expect(await claudeSignedIn(file, folder("old"))).toBeNull();
    expect(await claudeSignedIn(join(dir, "nothing-here"), out)).toBeNull();
    // Asked in the profile's folder, and not as a session inside another Claude Code.
    expect(readFileSync(seen, "utf8").split("\n")[1]).toBe(`auth status|${out}|none`);
  });

  /** The start route over a host with a made-up agent: what the launcher was asked, per terminal. */
  function served(signedIn: (harness: string, home: string) => Promise<boolean | null>) {
    const w = world();
    const asked: LaunchRequest[] = [];
    const host = new TerminalHost({ launcher: (req) => { asked.push(req); return { file: "/bin/sh", args: ["-c", "/bin/sleep 30"], env: { PATH: "/usr/bin:/bin" }, hooks: false }; } });
    closers.push(() => host.closeAll());
    const app = new Hono();
    const questions: string[] = [];
    mountTerminals(app, { profiles: w.store, terminals: { host, audit: { record() { /* not looked at */ } }, agents: ["claude-code"], style: () => ({}), elsewhere: async () => null,
      signedIn: (harness: string, home: string) => { questions.push(home); return signedIn(harness, home); } } } as unknown as ApiDeps);
    mountProfiles(app, { profiles: w.store, terminals: { host } } as unknown as ApiDeps);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    return { ...w, host, asked, questions, call };
  }

  it("starts at its sign-in; one that is signed in, the Mac's own, and one that pays by a key start at the prompt", async () => {
    const said = new Map<string, boolean | null>();
    const { store, asked, questions, call, root } = served(async (_h, home) => said.get(home) ?? null);
    const fresh = store.create("claude-code", "Fresh", "subscription"), work = store.create("claude-code", "Work", "subscription");
    const unsure = store.create("claude-code", "Unsure", "subscription"), key = store.create("claude-code", "Key", "api");
    said.set(store.homeOf("claude-code", fresh.id)!, false).set(store.homeOf("claude-code", work.id)!, true).set(store.homeOf("claude-code", key.id)!, false);
    const start = async (profile?: string) => (await call("POST", "/terminals", { harness: "claude-code", cwd: root, ...(profile ? { profile } : {}) })).status;
    expect(await start(fresh.id)).toBe(201);
    expect(asked.at(-1)).toMatchObject({ configHome: store.homeOf("claude-code", fresh.id), firstInput: "/login" });
    for (const id of [work.id, unsure.id, key.id, "default"]) {
      expect(await start(id)).toBe(201);
      expect(asked.at(-1)!.firstInput).toBeUndefined();
    }
    // Asked of those that sign in with an account, each in its own folder; never of the Mac's own or of one with a key.
    expect(questions).toEqual([fresh.id, work.id, unsure.id].map((id) => store.homeOf("claude-code", id)));
    // A session continued under it starts at the sign-in too: it could not go on otherwise.
    expect((await call("POST", "/terminals/resume", { harness: "claude-code", cwd: root, agentSessionId: "0f8fad5b-d9cb-469f-a165-70867728950e", profile: fresh.id })).status).toBe(201);
    expect(asked.at(-1)).toMatchObject({ resume: "0f8fad5b-d9cb-469f-a165-70867728950e", firstInput: "/login" });
  });

  it("has a colour of its own, which its terminals carry — also after it is changed", async () => {
    const { store, call, root } = served(async () => true);
    const a = store.create("claude-code", "A", "subscription"), b = store.create("claude-code", "B", "subscription");
    // No two alike while there are colours left; none for the Mac's own.
    expect(store.all()["claude-code"].profiles.map((p) => p.color)).toEqual([undefined, "violet", "sand"]);
    const started = await call("POST", "/terminals", { harness: "claude-code", cwd: root, profile: b.id });
    expect(started.json.terminal.profile).toEqual({ id: b.id, name: "B", color: "sand" });
    expect((await call("POST", "/terminals", { harness: "claude-code", cwd: root, profile: "default" })).json.terminal.profile).toBeNull();
    expect((await call("PUT", `/profiles/claude-code/${b.id}/color`, { color: "mint" })).json.agents["claude-code"].profiles[2].color).toBe("mint");
    expect((await call("GET", `/terminals/${started.json.terminal.id}`)).json.terminal.profile.color).toBe("mint");
    expect((await call("PUT", `/profiles/claude-code/${a.id}/color`, { color: "red" })).status).toBe(400);
    expect((await call("PUT", "/profiles/claude-code/default/color", { color: "mint" })).status).toBe(404);
  });

  it("gives one made before profiles had colours a colour, once, and keeps it", () => {
    const { store, home } = world();
    const a = store.create("claude-code", "A", "subscription"), b = store.create("claude-code", "B", "subscription");
    const file = join(home, "profiles", "profiles.json");
    const kept = JSON.parse(readFileSync(file, "utf8")) as { agents: Record<string, { profiles: { color?: string }[] }> };
    for (const p of kept.agents["claude-code"]!.profiles) delete p.color;
    kept.agents["claude-code"]!.profiles[1]!.color = "violet";
    writeFileSync(file, JSON.stringify(kept));
    expect([store.colorOf("claude-code", a.id), store.colorOf("claude-code", b.id)]).toEqual(["sand", "violet"]);
    expect((JSON.parse(readFileSync(file, "utf8")) as typeof kept).agents["claude-code"]!.profiles.map((p) => p.color)).toEqual(["sand", "violet"]);
  });
});
