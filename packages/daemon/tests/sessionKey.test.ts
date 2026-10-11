/** A profile's claude.ai session key (docs/profiles-v0.md §3.4) and the device Claude Code says it is (§3.5): the key
 *  is kept as a ciphertext, told to no screen, and put into the profile's own browser as claude.ai's sign-in cookie —
 *  at once when that browser runs, before its first page when it starts; one the browser already has is left alone.
 *  The device is read from Claude Code's own file, a folder's own, and carried by the terminals. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountProfiles } from "../src/api/profiles.js";
import type { ApiDeps } from "../src/api/shared.js";
import { sharedBrowser } from "../src/browser/setup.js";
import { markRemote } from "../src/core/caller.js";
import { SESSION_KEY, sessionCookie, SessionKeyError, SessionKeys } from "../src/browser/sessionKey.js";
import { ProfileStore } from "../src/profiles/store.js";
import { TerminalHost } from "../src/terminals/host.js";
import { FakeDriver } from "./fakeBrowser.js";

const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

const KEY = `sk-ant-sid01-${"Ab3_-".repeat(12)}`, OTHER = `sk-ant-sid01-${"Zz9".repeat(20)}`;
const SEALED = "enc:v1:aaaaaaaaaaaaaaaaaaaaaaaa", SEALED_OTHER = "enc:v1:bbbbbbbbbbbbbbbbbbbbbbbb", SEALED_API = "enc:v1:cccccccccccccccccccccccc", SEALED_ELSEWHERE = "enc:v1:dddddddddddddddddddddddd";
const DEVICE = "56967b93".repeat(8);

/** A gate, made up: what each ciphertext stands for, given only for the site it was sealed for. */
function gate() {
  const asked: { token: string; frames: readonly string[] }[] = [];
  const values: Record<string, string> = { [SEALED]: KEY, [SEALED_OTHER]: OTHER, [SEALED_API]: "sk-ant-api03-not-a-session-key-at-all-000000" };
  const resolve = async (token: string, frames: readonly string[]) => {
    asked.push({ token, frames });
    const value = values[token];
    if (!value) throw new Error("not for this site");
    return { value, label: "profile/session-key" };
  };
  return { resolve, asked };
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "agentswitch-session-key-"));
  const userHome = join(root, "user"), home = join(root, "as");
  mkdirSync(join(userHome, ".claude"), { recursive: true });
  writeFileSync(join(userHome, ".claude.json"), JSON.stringify({ userID: DEVICE, machineID: "ab".repeat(32), oauthAccount: { emailAddress: "me@example.com" } }));
  const store = new ProfileStore({ home, userHome, now: () => 1_000 });
  const profile = store.create("claude-code", "Work", "subscription");
  const driver = new FakeDriver(), g = gate();
  // As the service wires it: the profile's own browser tells the keys when it has started.
  const browser = sharedBrowser({ home, userHome, driver, ownPorts: () => [4711], protected: { roots: [], exempt: [] },
    own: { name: `claude-code.${profile.id}`, forwarder: { start: async () => ({ server: "http://127.0.0.1:1", username: "agentswitch", password: "x" }) },
      launched: () => keys.launched("claude-code", profile.id) } });
  closers.push(async () => { await browser.agents.shutdown(); await browser.host.shutdown(); await browser.stop(); });
  const keys: SessionKeys = new SessionKeys({ store, resolve: g.resolve, browser: (_agent, id) => (id === profile.id ? browser.host : null), now: () => 2_000_000 });
  const stored = () => JSON.parse(readFileSync(join(home, "profiles", "profiles.json"), "utf8")).agents["claude-code"].profiles[0] as Record<string, unknown>;
  return { root, home, userHome, store, profile, driver, browser, keys, gate: g, stored };
}

describe("a profile's session key", () => {
  it("is claude.ai's own sign-in cookie, for a year", () => {
    expect(sessionCookie(KEY, 2_000_000)).toEqual({ name: "sessionKey", value: KEY, domain: ".claude.ai", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: 2_000 + 365 * 86_400 });
    expect(SESSION_KEY.test(KEY)).toBe(true);
    for (const not of ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz", "sk-ant-sid01-short", `${KEY} `, `sessionKey=${KEY}`]) expect(SESSION_KEY.test(not)).toBe(false);
  });

  it("is kept as a ciphertext and told to no screen; the browser that is not running is given it when it starts, before its first page", async () => {
    const { store, profile, keys, driver, browser, gate, stored } = world();
    await keys.set("claude-code", profile.id, SEALED);
    // Asked of the gate for claude.ai, and nothing but the ciphertext written down.
    expect(gate.asked).toEqual([{ token: SEALED, frames: ["https://claude.ai/"] }]);
    expect(stored()).toMatchObject({ sessionKey: SEALED, sessionKeyDue: true });
    expect(readFileSync(join(store["dir" as never] as string, "profiles.json"), "utf8")).not.toContain(KEY);
    const shown = store.all()["claude-code"].profiles[1]!;
    expect(shown.sessionKey).toBe(true);
    expect(JSON.stringify(store.all())).not.toContain(SEALED);
    expect(driver.browsers).toHaveLength(0);
    // The first tab starts the browser: the cookie is there before the page is handed out.
    await browser.host.open({ kind: "you", id: "you", label: "You" }, "https://claude.ai/");
    expect(driver.browser.cookies.get("sessionKey")).toMatchObject({ value: KEY, domain: ".claude.ai", httpOnly: true, secure: true });
    expect(stored().sessionKeyDue).toBeUndefined();
  });

  it("is given at once to a browser that runs, over what it had; later starts leave what the browser has alone", async () => {
    const { profile, keys, driver, browser, stored } = world();
    await browser.host.open({ kind: "you", id: "you", label: "You" }, "https://example.com/");
    expect(driver.browser.cookies.size).toBe(0);
    await keys.set("claude-code", profile.id, SEALED);
    expect(driver.browser.cookies.get("sessionKey")?.value).toBe(KEY);
    expect(stored().sessionKeyDue).toBeUndefined();
    // Signed in by hand as somebody else since: a start does not put the kept key back over it.
    driver.browser.cookies.set("sessionKey", { ...sessionCookie("signed-in-by-hand"), value: "signed-in-by-hand" });
    await keys.launched("claude-code", profile.id);
    expect(driver.browser.cookies.get("sessionKey")?.value).toBe("signed-in-by-hand");
    // A browser with none (another engine's folder, cookies cleared) is given it again.
    driver.browser.cookies.clear();
    await keys.launched("claude-code", profile.id);
    expect(driver.browser.cookies.get("sessionKey")?.value).toBe(KEY);
    // A new key replaces the one the browser has.
    await keys.set("claude-code", profile.id, SEALED_OTHER);
    expect(driver.browser.cookies.get("sessionKey")?.value).toBe(OTHER);
  });

  it("is refused when it is not a session key, not sealed, or not the gate's to give; forgetting it leaves the browser as it is", async () => {
    const { store, profile, keys, driver, browser, stored } = world();
    await expect(keys.set("claude-code", profile.id, SEALED_API)).rejects.toThrow(/sk-ant-sid/);
    await expect(keys.set("claude-code", profile.id, SEALED_ELSEWHERE)).rejects.toBeInstanceOf(SessionKeyError);
    await expect(keys.set("claude-code", profile.id, KEY)).rejects.toThrow(/密文/);
    expect(stored().sessionKey).toBeUndefined();
    // Not for the Mac's own, nor for a profile that is not there.
    await expect(keys.set("claude-code", "default", SEALED)).rejects.toThrow(/no such profile/);
    // Without the gate nothing can be kept.
    await expect(new SessionKeys({ store, browser: () => null }).set("claude-code", profile.id, SEALED)).rejects.toThrow(/凭据网关不可用/);
    await browser.host.open({ kind: "you", id: "you", label: "You" }, "https://example.com/");
    await keys.set("claude-code", profile.id, SEALED);
    await keys.set("claude-code", profile.id, null);
    expect(store.all()["claude-code"].profiles[1]!.sessionKey).toBeUndefined();
    expect(stored()).not.toHaveProperty("sessionKey");
    expect(driver.browser.cookies.get("sessionKey")?.value).toBe(KEY);
    // Nothing kept: a start gives nothing.
    driver.browser.cookies.clear();
    await keys.launched("claude-code", profile.id);
    expect(driver.browser.cookies.size).toBe(0);
  });

  it("is set over HTTP on the Mac only, and never sent back", async () => {
    const { store, profile, keys, stored } = world();
    const app = new Hono();
    mountProfiles(app, { profiles: store, sessionKeys: keys } as unknown as ApiDeps);
    const call = async (method: string, path: string, body?: unknown, env: object = {}) => {
      const res = await app.request(path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }, env);
      const text = await res.text();
      return { status: res.status, text, json: JSON.parse(text) as Record<string, any> };
    };
    const at = `/profiles/claude-code/${profile.id}/session-key`;
    const remote = markRemote({}, { deviceId: "phone" });
    expect((await call("PUT", at, { key: SEALED }, remote)).status).toBe(403);
    expect((await call("PUT", at, { key: KEY })).status).toBe(400);
    expect((await call("PUT", at, { key: SEALED_API })).json.error).toMatch(/sk-ant-sid/);
    expect((await call("PUT", "/profiles/claude-code/nosuchprofile/session-key", { key: SEALED })).status).toBe(404);
    expect((await call("PUT", "/profiles/claude-code/default/session-key", { key: SEALED })).status).toBe(404);
    const set = await call("PUT", at, { key: SEALED });
    expect(set.status).toBe(200);
    expect(set.json.agents["claude-code"].profiles[1].sessionKey).toBe(true);
    expect(set.text).not.toContain(SEALED);
    expect(set.text).not.toContain(KEY);
    expect((await call("GET", "/profiles")).text).not.toContain("enc:v1:");
    expect((await call("PUT", at, { key: null })).json.agents["claude-code"].profiles[1].sessionKey).toBeUndefined();
    expect(stored()).not.toHaveProperty("sessionKey");
    // A service without the keys says so.
    const bare = new Hono();
    mountProfiles(bare, { profiles: store } as unknown as ApiDeps);
    expect((await bare.request(at, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: SEALED }) })).status).toBe(503);
  });
});

describe("the device Claude Code says it is", () => {
  it("is a folder's own: the Mac's for Default, none for a profile till Claude Code has run there", () => {
    const { store, profile, home } = world();
    expect(store.deviceOf("claude-code", "default")).toBe(DEVICE);
    expect(store.all()["claude-code"].profiles.map((p) => p.device)).toEqual([DEVICE, undefined]);
    expect(store.deviceOf("claude-code", profile.id)).toBeNull();
    // Claude Code makes one on its first run under the profile.
    const own = "0f".repeat(32), file = join(home, "profiles", "claude-code", profile.id, "home", ".claude.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), userID: own }));
    expect(store.deviceOf("claude-code", profile.id)).toBe(own);
    expect(store.all()["claude-code"].profiles[1]!.device).toBe(own);
    // What is not an id is not shown; another agent has none here.
    writeFileSync(file, JSON.stringify({ userID: "<script>" }));
    expect(store.deviceOf("claude-code", profile.id)).toBeNull();
    expect(store.deviceOf("codex", "default")).toBeNull();
  });

  it("is carried by a terminal: read when it starts, and again once the agent reports a session if it had none", async () => {
    const { store, profile, home, root } = world();
    const tokens: string[] = [];
    const host = new TerminalHost({ launcher: (req) => { tokens.push(req.hookToken); return { file: "/bin/sh", args: ["-c", "/bin/sleep 30"], env: { PATH: "/usr/bin:/bin" }, hooks: false }; },
      deviceOf: (harness, id) => (harness === "claude-code" ? store.deviceOf("claude-code", id ?? "default") : null) });
    closers.push(() => host.closeAll());
    const mine = await host.spawn({ harness: "claude-code", cwd: root });
    expect(mine.device).toBe(DEVICE);
    const theirs = await host.spawn({ harness: "claude-code", cwd: root, profile: { id: profile.id, name: "Work", home: join(home, "profiles", "claude-code", profile.id, "home") } });
    expect(theirs.device).toBeNull();
    expect((await host.spawn({ harness: "codex", cwd: root })).device).toBeNull();
    const own = "0f".repeat(32), file = join(home, "profiles", "claude-code", profile.id, "home", ".claude.json");
    writeFileSync(file, JSON.stringify({ userID: own }));
    await host.hook(theirs.id, tokens[1]!, { event: "SessionStart", payload: { session_id: "11111111-1111-4111-8111-111111111111" } });
    expect(host.get(theirs.id)?.device).toBe(own);
  });
});
