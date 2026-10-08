/** A profile's own browser (docs/profiles-v0.md §5.1): one beside the shared browser for each profile that has a proxy,
 *  with its own folder and state, everything it sends through the profile's forwarder; served like the shared one
 *  under its own address; the place a web address the agent asks the system to open is opened in. */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountBrowser, mountProfileBrowsers } from "../src/api/browser.js";
import { LocalAuth } from "../src/api/localAuth.js";
import { exitKey, profileOfKey } from "../src/api/profiles.js";
import type { ApiDeps } from "../src/api/shared.js";
import { ProfileBrowsers } from "../src/browser/fleet.js";
import type { ProxySetting } from "../src/browser/identity.js";
import { sharedBrowser, type SharedBrowser } from "../src/browser/setup.js";
import { mountTerminals } from "../src/api/terminals.js";
import { TerminalError } from "../src/terminals/host.js";
import { agentLauncher, openInProfileBrowser } from "../src/terminals/launch.js";
import { FakeDriver } from "./fakeBrowser.js";

const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

function world() {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-profile-browser-"));
  const driver = new FakeDriver();
  const options = { home, userHome: home, driver, ownPorts: () => [4711], protected: { roots: [], exempt: [] } };
  const proxies: Record<string, ProxySetting | null> = { "claude-code.abc123def0": { server: "http://proxy.example:8080" } };
  const asked: string[] = [];
  const made: SharedBrowser[] = [];
  const fleet = new ProfileBrowsers((key, forwarder) => { const b = sharedBrowser({ ...options, own: { name: key, forwarder } }); made.push(b); return b; },
    { address: async (key, proxy) => { asked.push(`${key} ${proxy.server}`); return { server: "http://127.0.0.1:50123", username: "agentswitch", password: "pw" }; } },
    (key) => proxies[key] ?? null);
  const shared = sharedBrowser(options);
  closers.push(() => fleet.stop(), () => shared.host.shutdown());
  return { home, driver, fleet, shared, proxies, asked, made };
}

describe("a profile's own browser", () => {
  it("is made once for a profile with a proxy, anew when the proxy changes, and not at all without one", async () => {
    const { fleet, proxies, made } = world();
    const key = "claude-code.abc123def0";
    expect(fleet.get(key)).toBeNull();
    const first = fleet.of(key);
    expect(first).not.toBeNull();
    expect(fleet.of(key)).toBe(first);
    expect(fleet.get(key)).toBe(first);
    expect(fleet.of("claude-code.0000000000")).toBeNull();
    // Another proxy: the browser made for the old one is not used again.
    proxies[key] = { server: "socks5://10.0.0.2:1080" };
    const second = fleet.of(key);
    expect(second).not.toBe(first);
    expect(made).toHaveLength(2);
    // The proxy taken away: it has no browser of its own any more.
    proxies[key] = null;
    expect(fleet.of(key)).toBeNull();
    expect(fleet.get(key)).toBeNull();
    expect(fleet.keys()).toEqual([]);
  });

  it("has its own folder and state beside the shared browser's, and is started through the profile's forwarder", async () => {
    const { fleet, shared, driver, home } = world();
    const own = fleet.of("claude-code.abc123def0")!;
    const mine = await own.host.open({ kind: "you", id: "you", label: "You" }, "https://claude.ai/login");
    await shared.host.open({ kind: "you", id: "you", label: "You" }, "https://example.com/");
    expect(driver.launches.map((l) => l.profileDir.replace(home, ""))).toEqual(["/browser-profiles/claude-code.abc123def0", "/browser-profiles/main"]);
    // Each lists its own tabs; neither knows the other's.
    expect(own.host.list().map((t) => t.url)).toEqual(["https://claude.ai/login"]);
    expect(shared.host.list().map((t) => t.url)).toEqual(["https://example.com/"]);
    expect(shared.host.get(mine.id)).toBeNull();
    own.audit.record({ tab: mine.id, action: "open", via: "test" });
    expect(existsSync(join(home, "browser", "of", "claude-code.abc123def0", "audit.jsonl"))).toBe(true);
    expect(existsSync(join(home, "browser", "audit.jsonl"))).toBe(false);
    // The shared one has no window unless it is Camoufox with windows; a profile's shows when the service has windows.
    expect([shared.visible(), own.visible()]).toEqual([false, false]);
    const windowed = sharedBrowser({ home, userHome: home, driver, ownPorts: () => [], protected: { roots: [], exempt: [] }, headless: false, own: { name: "x", forwarder: { start: async () => ({ server: "http://127.0.0.1:1", username: "a", password: "b" }) } } });
    expect(windowed.visible()).toBe(true);
  });

  it("has a fingerprint of its own, in the time zone where the profile's proxy lets traffic out", () => {
    const { home, driver, shared } = world();
    let zone: string | null = "Asia/Tokyo";
    const make = (name: string) => sharedBrowser({ home, userHome: home, driver, ownPorts: () => [], protected: { roots: [], exempt: [] },
      own: { name, forwarder: { start: async () => ({ server: "http://127.0.0.1:1", username: "a", password: "b" }) }, zone: () => zone } });
    const one = make("claude-code.aaaaaaaaaa"), two = make("claude-code.bbbbbbbbbb");
    // What Camoufox would be started with: each profile's own, kept in its own state, and not the shared browser's.
    expect(one.identity.config().timezone).toBe("Asia/Tokyo");
    expect(JSON.stringify(one.identity.config())).not.toBe(JSON.stringify(two.identity.config()));
    expect(existsSync(join(home, "browser", "of", "claude-code.aaaaaaaaaa", "identity.json"))).toBe(true);
    expect(shared.identity.config().timezone).toBeUndefined();
    // The exit found elsewhere now, or not known: the next start is in that zone, or in this Mac's own.
    zone = "America/Los_Angeles";
    expect(one.identity.launchConfig().timezone).toBe("America/Los_Angeles");
    zone = null;
    expect(one.identity.config().timezone).toBeUndefined();
  });

  it("is served like the shared one under its own address, the agents' bridge included", async () => {
    const { fleet, shared } = world();
    const key = "claude-code.abc123def0";
    const app = new Hono();
    const deps = { browser: shared, profileBrowsers: fleet, sseHeartbeatMs: 20 } as unknown as ApiDeps;
    mountBrowser(app, deps);
    mountProfileBrowsers(app, deps);
    // Not started yet: nothing is there under its address.
    expect((await app.request(`/profile-browser/${key}/browser/tabs`)).status).toBe(404);
    const own = fleet.of(key)!;
    await own.host.open({ kind: "you", id: "you", label: "You" }, "https://claude.ai/login");
    const listed = await (await app.request(`/profile-browser/${key}/browser/tabs`)).json() as { running: boolean; groups: { tabs: { url: string }[] }[] };
    expect(listed.groups.flatMap((g) => g.tabs.map((t) => t.url))).toEqual(["https://claude.ai/login"]);
    expect(((await (await app.request("/browser/tabs")).json()) as { groups: unknown[] }).groups).toEqual([]);
    // A tab opened through its address is its own.
    const opened = await app.request(`/profile-browser/${key}/browser/tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://console.anthropic.com/" }) });
    expect(opened.status).toBe(201);
    expect(own.host.list()).toHaveLength(2);
    expect(shared.host.list()).toHaveLength(0);
    expect((await app.request("/profile-browser/claude-code.nope000000/browser/tabs")).status).toBe(404);
    expect((await app.request("/profile-browser/Bad Key/browser/tabs")).status).toBe(404);
    // The local listener lets its agents' bridge through as it does the shared browser's — and nothing else of it.
    const auth = new LocalAuth("local-token-0123456789abcdefghijklmnopqrstuv");
    const open = (path: string, method = "GET") => auth.check(new Request(`http://127.0.0.1:4711${path}`, { method })) === null;
    expect([open(`/profile-browser/${key}/browser/agent/mcp`), open(`/profile-browser/${key}/browser/agent/mcp/c-1`, "POST"), open("/terminals/open", "POST")]).toEqual([true, true, true]);
    expect([open(`/profile-browser/${key}/browser/tabs`), open(`/profile-browser/${key}/browser/tabs`, "POST"), open("/terminals/open"), open("/profile-browser/x/../browser/agent/mcp")]).toEqual([false, false, false, false]);
  });

  it("is named by a key that says whose it is", () => {
    expect(exitKey("claude-code", "abc123def0")).toBe("claude-code.abc123def0");
    expect(profileOfKey("claude-code.abc123def0")).toEqual({ agent: "claude-code", id: "abc123def0" });
    expect([profileOfKey("nobody.abc123def0"), profileOfKey("claude-code"), profileOfKey("")]).toEqual([null, null, null]);
  });
});

describe("a web address the agent asks the system to open", () => {
  /** The service, made up: it keeps what it was asked and answers `status`. */
  async function service(status: number) {
    const asked: { path: string; terminal: string; auth: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => { asked.push({ path: String(req.url), terminal: String(req.headers["x-agentswitch-terminal"]), auth: String(req.headers.authorization), body }); res.writeHead(status).end("{}"); });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    closers.push(() => new Promise<void>((ok) => server.close(() => ok())));
    return { url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, asked };
  }
  const run = (file: string, args: string[], env: Record<string, string>) => new Promise<{ code: number | null; err: string }>((resolve) => {
    const child = spawn(file, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, err }));
  });

  it("goes to the terminal's own browser by way of the service; one the service does not take is not opened elsewhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-open-"));
    const env = openInProfileBrowser(dir, "/usr/bin:/bin");
    expect(env).toEqual({ PATH: `${join(dir, "bin")}:/usr/bin:/bin`, BROWSER: join(dir, "bin", "open") });
    const taken = await service(200);
    const mine = { ...env, AGENTSWITCH_TERMINAL_URL: taken.url, AGENTSWITCH_TERMINAL_ID: "t1", AGENTSWITCH_TERMINAL_HOOK_TOKEN: "hook-token" };
    const link = "https://claude.ai/oauth/authorize?code=true&client_id=abc&scope=a+b";
    expect(await run(env.BROWSER!, [link], mine)).toEqual({ code: 0, err: "" });
    expect(taken.asked).toEqual([{ path: "/terminals/open", terminal: "t1", auth: "Bearer hook-token", body: `url=${encodeURIComponent(link)}` }]);
    // As Claude Code calls it: by the name `open`, found first on the PATH.
    expect((await run("/bin/sh", ["-c", `open "${link}"`], mine)).code).toBe(0);
    expect(taken.asked).toHaveLength(2);
    // The service says no (no window to sign in in): it fails and says so; nothing else is opened.
    const refused = await service(409);
    const said = await run(env.BROWSER!, [link], { ...mine, AGENTSWITCH_TERMINAL_URL: refused.url });
    expect(said.code).toBe(1);
    expect(said.err).toContain("was not opened in the profile's browser (409)");
    expect((await run(env.BROWSER!, [link], { ...mine, AGENTSWITCH_TERMINAL_URL: "http://127.0.0.1:1" })).code).toBe(1);
  });

  it("is opened by the service in that terminal's own browser, for a call proven by the terminal's hook token", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-open-route-"));
    const driver = new FakeDriver();
    const options = { home, userHome: home, driver, ownPorts: () => [4711], protected: { roots: [], exempt: [] } };
    const fleetOf = (headless: boolean) => new ProfileBrowsers((key, forwarder) => sharedBrowser({ ...options, headless, own: { name: key, forwarder } }),
      { address: async () => ({ server: "http://127.0.0.1:50123", username: "agentswitch", password: "pw" }) }, (key) => (key === "claude-code.abc123def0" ? { server: "http://proxy.example:8080" } : null));
    // The terminals, made up: `t1` runs under the profile with a browser of its own, `t2` under the Mac's own.
    const host = { onWorkDone() { /* not used */ }, list: () => [], browserOf: (id: string, token: string) => {
      if (token !== "hook-token" || (id !== "t1" && id !== "t2")) throw new TerminalError("forbidden", "unknown terminal or hook token");
      return id === "t1" ? "claude-code.abc123def0" : null;
    } };
    const served = (fleet: ProfileBrowsers) => {
      closers.push(() => fleet.stop());
      const app = new Hono();
      mountTerminals(app, { terminals: { host, audit: { record() { /* not looked at */ } }, agents: [] }, profileBrowsers: fleet } as unknown as ApiDeps);
      return (terminal: string, token: string, url: string) => app.request("/terminals/open", { method: "POST", headers: { "x-agentswitch-terminal": terminal, authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ url }).toString() });
    };
    const link = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A55473%2Fcallback";
    const windows = fleetOf(false), open = served(windows);
    expect((await open("t1", "hook-token", link)).status).toBe(200);
    expect(windows.get("claude-code.abc123def0")!.host.list().map((t) => [t.url, t.owner.kind])).toEqual([[link, "you"]]);
    // What is kept of it names the site, not the whole address (it carries the sign-in's own secrets).
    expect(readFileSync(join(home, "browser", "of", "claude-code.abc123def0", "audit.jsonl"), "utf8")).toContain('"url":"https://claude.com"');
    expect(readFileSync(join(home, "browser", "of", "claude-code.abc123def0", "audit.jsonl"), "utf8")).not.toContain("client_id");
    // Not this terminal's token, a terminal with no browser of its own, something that is not a web address.
    expect((await open("t1", "wrong", link)).status).toBe(403);
    expect((await open("t2", "hook-token", link)).status).toBe(409);
    expect((await open("t1", "hook-token", "file:///etc/passwd")).status).toBe(400);
    // A browser that shows no window on this Mac: nobody could sign in there, so it is not opened.
    const hidden = fleetOf(true);
    expect((await served(hidden)("t1", "hook-token", link)).status).toBe(409);
    expect(hidden.get("claude-code.abc123def0")!.host.list()).toEqual([]);
  });

  it("is set up for a terminal whose profile has a browser of its own, and for no other", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agentswitch-open-launch-"));
    const keys: (string | undefined)[] = [];
    const launch = agentLauncher({ binaries: { "claude-code": "/bin/claude", codex: "/bin/codex" }, hookUrl: () => "http://127.0.0.1:4711", stateDir, env: { PATH: "/usr/bin", HOME: "/Users/u" },
      browser: (req) => { keys.push(req.browserKey); return ["node", "bridge.js", "--session", req.id]; } });
    const own = launch({ id: "c1", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok", configHome: "/as/p/home", proxy: "http://agentswitch:pw@127.0.0.1:50123", browserKey: "claude-code.abc123def0" });
    expect(own.env.BROWSER).toBe(join(stateDir, "c1", "bin", "open"));
    expect(own.env.PATH).toBe(`${join(stateDir, "c1", "bin")}:/usr/bin`);
    expect(readFileSync(own.env.BROWSER!, "utf8")).toContain("/terminals/open");
    const plain = launch({ id: "c2", harness: "claude-code", cwd: "/tmp", mode: "manual", hookToken: "tok" });
    expect([plain.env.BROWSER, plain.env.PATH]).toEqual([undefined, "/usr/bin"]);
    // The agent's browser tool is asked for with the profile's browser named, or not.
    expect(keys).toEqual(["claude-code.abc123def0", undefined]);
  });
});
