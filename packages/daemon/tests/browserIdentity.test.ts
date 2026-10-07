/** The browser's identity (docs/browser-v0.md §7.2 第 5 条): the fingerprint Camoufox is started with — made once, kept,
 *  changed only when asked — and the proxy its traffic leaves through, whose password is a ciphertext the gate turns
 *  into the value when it is used. */

import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountBrowserIdentity } from "../src/api/browserIdentity.js";
import type { ApiDeps } from "../src/api/shared.js";
import { FillRefused } from "../src/browser/fill.js";
import { exitProbe, parseExit } from "../src/browser/exit.js";
import { Forwarder } from "../src/browser/forwarder.js";
import { BrowserIdentity, generateFingerprint, proxyPlace, summarize } from "../src/browser/identity.js";
import { markRemote } from "../src/core/caller.js";

const file = () => join(realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-identity-"))), "identity.json");
/** Numbers in turn, the same every run. */
const dice = (...values: number[]) => { let i = 0; return () => values[i++ % values.length]!; };
const TOKEN = "enc:v1:abcdefghijklmnopqrstuvwx";

function identity(over: Partial<ConstructorParameters<typeof BrowserIdentity>[0]> = {}) {
  const path = file();
  const asked: { token: string; urls: readonly string[] }[] = [];
  const id = new BrowserIdentity({
    file: path, firefox: () => "156", platform: "darwin", now: () => 1_000, random: dice(0.1, 0.5, 0.9),
    resolve: async (token, urls) => { asked.push({ token, urls }); return { value: "p@ss word", label: "proxy/pass" }; },
    ...over,
  });
  return { id, path, asked };
}

describe("a fingerprint (docs/browser-v0.md §7.2 第 5 条)", () => {
  it("is this Mac as Firefox would show it: nothing of Camoufox in what a page reads, and a few values of its own", () => {
    const config = generateFingerprint({ firefox: "156", platform: "darwin", random: dice(0.1, 0.5, 0.9) });
    expect(config["navigator.userAgent"]).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0");
    expect(config["headers.User-Agent"]).toBe(config["navigator.userAgent"]);
    expect(config).toMatchObject({ "navigator.platform": "MacIntel", "navigator.oscpu": "Intel Mac OS X 10.15", "navigator.appVersion": "5.0 (Macintosh)" });
    expect([4, 8, 10, 12]).toContain(config["navigator.hardwareConcurrency"]);
    expect(Number.isInteger(config["audio:seed"]) && (config["audio:seed"] as number) > 0).toBe(true);
    expect(JSON.stringify(config)).not.toMatch(/camoufox/i);
    // The window and the screen are the real ones: a window with a made-up size could not be sized by its person.
    expect(Object.keys(config).filter((k) => k.startsWith("window.") || k.startsWith("screen."))).toEqual([]);
    // Another throw of the dice: another one.
    expect(generateFingerprint({ firefox: "156", platform: "darwin", random: dice(0.9, 0.2, 0.4) })["audio:seed"]).not.toBe(config["audio:seed"]);
    expect(generateFingerprint({ firefox: "156", platform: "linux", random: dice(0.1) })["navigator.platform"]).toBe("Linux x86_64");
  });

  it("is summed up in a few words for the person", () => {
    const config = generateFingerprint({ firefox: "156", platform: "darwin", random: dice(0.1, 0.5, 0.9) });
    expect(summarize(config)).toEqual({ system: "macOS", browser: "Firefox 156", cores: config["navigator.hardwareConcurrency"], language: null, timezone: null, timezoneFrom: "system" });
    expect(summarize({ "navigator.userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0", "navigator.language": "de-DE", timezone: "Europe/Berlin" }))
      .toEqual({ system: "Windows", browser: "Firefox 140", cores: null, language: "de-DE", timezone: "Europe/Berlin", timezoneFrom: "fingerprint" });
  });

  it("is made once, written down, and the same from then on", () => {
    const { id, path } = identity();
    const first = id.config();
    expect(existsSync(path)).toBe(true);
    expect(id.config()).toEqual(first);
    // Another service on the same file reads the same one.
    expect(new BrowserIdentity({ file: path, firefox: () => "156", random: dice(0.7) }).config()).toEqual(first);
    expect(id.view().fingerprint).toMatchObject({ since: 1_000, source: "generated", summary: { system: "macOS", browser: "Firefox 156" } });
  });

  it("changes only when asked: a new one, or one brought from elsewhere", async () => {
    const { id } = identity();
    const first = id.config();
    await id.setFingerprint("new");
    expect(id.config()).not.toEqual(first);
    await id.setFingerprint({ config: { "navigator.userAgent": "Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0", "navigator.hardwareConcurrency": 16 } });
    expect(id.view().fingerprint).toMatchObject({ source: "imported", summary: { system: "Linux", cores: 16 } });
    await expect(id.setFingerprint({ config: [] as never })).rejects.toThrow("指纹");
    await expect(id.setFingerprint({ config: { fonts: "x".repeat(600_000) } })).rejects.toThrow("过大");
  });

  it("follows a Camoufox of another Firefox: the browser a page reads is the one that runs", () => {
    let firefox = "156";
    const { id } = identity({ firefox: () => firefox });
    expect(id.config()["navigator.userAgent"]).toContain("Firefox/156.0");
    firefox = "157";
    expect(id.config()["navigator.userAgent"]).toContain("rv:157.0) Gecko/20100101 Firefox/157.0");
    expect(id.config()["headers.User-Agent"]).toBe(id.config()["navigator.userAgent"]);
  });
});

describe("a proxy (docs/browser-v0.md §7.2 第 5 条)", () => {
  it("is read as a scheme, a host and a port", () => {
    expect(proxyPlace("socks5://proxy.example.net:1080")).toEqual({ scheme: "socks5", host: "proxy.example.net", port: 1080 });
    expect(proxyPlace("http://10.0.0.2:3128")).toEqual({ scheme: "http", host: "10.0.0.2", port: 3128 });
    for (const bad of ["proxy.example.net:1080", "ftp://x:1", "socks5://host", "http://user:pw@host:80", "http://host:80/path", ""]) expect(proxyPlace(bad), bad).toBeNull();
  });

  it("without one, traffic leaves straight; with one, through it, at once", async () => {
    const { id } = identity();
    expect(id.upstream()).toBeNull();
    await id.setProxy({ server: "socks5://proxy.example.net:1080" });
    expect(id.upstream()).toBe("socks5://proxy.example.net:1080");
    expect(id.view().proxy).toEqual({ server: "socks5://proxy.example.net:1080", sealed: false });
    expect(id.view().exit).toBeNull();
    await id.setProxy(null);
    expect(id.upstream()).toBeNull();
  });

  it("a password is a ciphertext for the proxy's own host: stored as it came, turned into the value by the gate, never written down", async () => {
    const { id, path, asked } = identity();
    await id.setProxy({ server: "http://proxy.example.net:3128", username: "l0tk3", password: TOKEN });
    expect(asked).toEqual([{ token: TOKEN, urls: ["http://proxy.example.net:3128/"] }]);
    expect(id.upstream()).toBe("http://l0tk3:p%40ss%20word@proxy.example.net:3128");
    expect(id.view().proxy).toEqual({ server: "http://proxy.example.net:3128", username: "l0tk3", sealed: true });
    const stored = readFileSync(path, "utf8");
    expect(stored).toContain(TOKEN);
    expect(stored).not.toContain("p@ss");
    expect(JSON.stringify(id.view())).not.toContain("p@ss");
  });

  it("a change that keeps the password sends none: the stored ciphertext stays, asked of the gate again for the new place", async () => {
    const { id, path, asked } = identity();
    await id.setProxy({ server: "http://proxy.example.net:3128", username: "l0tk3", password: TOKEN });
    await id.setProxy({ server: "http://proxy.example.net:3129", username: "other" }, { keepPassword: true });
    expect(asked[1]).toEqual({ token: TOKEN, urls: ["http://proxy.example.net:3129/"] });
    expect(id.upstream()).toBe("http://other:p%40ss%20word@proxy.example.net:3129");
    expect(readFileSync(path, "utf8")).toContain(TOKEN);
    // Without the word, a proxy set without a password has none.
    await id.setProxy({ server: "http://proxy.example.net:3129", username: "other" });
    expect(id.view().proxy).toEqual({ server: "http://proxy.example.net:3129", username: "other", sealed: false });
  });

  it("a password in the clear is refused, and so is one the gate will not give for that host; nothing changes then", async () => {
    const { id } = identity({ resolve: async () => { throw new FillRefused("此密文不允许用于 proxy.example.net:3128。"); } });
    await expect(id.setProxy({ server: "http://proxy.example.net:3128", username: "u", password: "hunter2" })).rejects.toThrow("密文");
    await expect(id.setProxy({ server: "http://proxy.example.net:3128", username: "u", password: TOKEN })).rejects.toBeInstanceOf(FillRefused);
    await expect(id.setProxy({ server: "nonsense" })).rejects.toThrow("代理地址");
    expect(id.upstream()).toBeNull();
    const none = identity({ resolve: undefined as never });
    await expect(none.id.setProxy({ server: "http://proxy.example.net:3128", username: "u", password: TOKEN })).rejects.toThrow("凭据网关");
  });

  it("a stored proxy whose password has not been turned into its value yet lets nothing out: not straight either", async () => {
    const { path } = identity();
    writeFileSync(path, JSON.stringify({ fingerprint: { config: { a: 1 }, since: 1, source: "imported" }, proxy: { server: "http://proxy.example.net:3128", username: "u", password: TOKEN } }));
    let answer: (v: { value: string; label: string }) => void = () => {};
    const id = new BrowserIdentity({ file: path, firefox: () => "156", resolve: () => new Promise((r) => { answer = r; }) });
    expect(() => id.upstream()).toThrow("上游代理");
    const ready = id.start();
    expect(() => id.upstream()).toThrow("上游代理");
    answer({ value: "pw", label: "proxy/pass" });
    await ready;
    expect(id.upstream()).toBe("http://u:pw@proxy.example.net:3128");
  });
});

describe("a proxy's exit (docs/browser-v0.md §7.2 第 5 条)", () => {
  const tokyo = { ip: "203.0.113.24", place: "Tokyo", timezone: "Asia/Tokyo" };

  it("is read from what the lookup answers; an answer without an address is none", () => {
    expect(parseExit('{"ip":"203.0.113.24","city":"Tokyo","country":"JP","timezone":"Asia/Tokyo"}')).toEqual(tokyo);
    expect(parseExit('{"ip":"2001:db8::1","country":"DE","timezone":{"id":"Europe/Berlin"}}')).toEqual({ ip: "2001:db8::1", place: "DE", timezone: "Europe/Berlin" });
    expect(parseExit('{"ip":"203.0.113.24","timezone":"Not/AZone"}')).toEqual({ ip: "203.0.113.24", place: null, timezone: null });
    for (const bad of ['{"ip":"not an address"}', "{}", "<html>", ""]) expect(() => parseExit(bad), bad).toThrow();
  });

  it("is asked when a proxy is set, shown, and gone with the proxy; without a proxy nothing is asked", async () => {
    let asked = 0;
    const { id } = identity({ probe: async () => { asked++; return tokyo; } });
    await id.start();
    expect(asked).toBe(0);
    expect(id.view().exit).toBeNull();
    await id.setProxy({ server: "socks5://proxy.example.net:1080" });
    expect(asked).toBe(1);
    expect(id.view().exit).toEqual({ ...tokyo, checkedAt: 1_000 });
    await id.setProxy(null);
    expect(id.view().exit).toBeNull();
  });

  it("the time zone follows the exit, unless the fingerprint names its own; in force when the browser next starts", async () => {
    const { id, path } = identity({ probe: async () => tokyo });
    expect(id.launchConfig().timezone).toBeUndefined();
    expect(id.view({ running: true }).restartNeeded).toBe(false);
    await id.setProxy({ server: "socks5://proxy.example.net:1080" });
    expect(id.config().timezone).toBe("Asia/Tokyo");
    expect(id.view().fingerprint.summary).toMatchObject({ timezone: "Asia/Tokyo", timezoneFrom: "exit" });
    // The running browser was started without it.
    expect(id.view({ running: true }).restartNeeded).toBe(true);
    expect(id.view({ running: false }).restartNeeded).toBe(false);
    expect(id.launchConfig().timezone).toBe("Asia/Tokyo");
    expect(id.view({ running: true }).restartNeeded).toBe(false);
    // Kept with the proxy: the next service starts its browser in that zone without asking first.
    expect(new BrowserIdentity({ file: path, firefox: () => "156" }).config().timezone).toBe("Asia/Tokyo");
    await id.setProxy(null);
    expect(id.config().timezone).toBeUndefined();
    expect(id.view({ running: true }).restartNeeded).toBe(true);
    await id.setFingerprint({ config: { "navigator.userAgent": "Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0", timezone: "Europe/Berlin" } });
    await id.setProxy({ server: "socks5://proxy.example.net:1080" });
    expect(id.config().timezone).toBe("Europe/Berlin");
    expect(id.view().fingerprint.summary).toMatchObject({ timezone: "Europe/Berlin", timezoneFrom: "fingerprint" });
  });

  it("a lookup that fails leaves the proxy set and says so", async () => {
    const { id } = identity({ probe: async () => { throw new Error("connect ETIMEDOUT"); } });
    await id.setProxy({ server: "socks5://proxy.example.net:1080" });
    expect(id.upstream()).toBe("socks5://proxy.example.net:1080");
    expect(id.view().exit).toEqual({ problem: "未能查到出口地址。" });
    expect(id.config().timezone).toBeUndefined();
  });

  it("goes the way the browser's traffic goes: through the forwarder", async () => {
    const target = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ip: "203.0.113.24", city: "Tokyo", timezone: "Asia/Tokyo", via: req.headers.via ?? null })); });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const forwarder = new Forwarder({ ownPorts: () => [] });
    try {
      const probe = exitProbe({ forwarder: () => forwarder.start(), url: `http://127.0.0.1:${(target.address() as AddressInfo).port}/json` });
      expect(await probe()).toEqual(tokyo);
      expect(forwarder.stats().requests).toBe(1);
    } finally {
      await forwarder.stop();
      target.close();
    }
  });
});

describe("the identity over the API (GET, PUT /browser/identity)", () => {
  function setup() {
    const { id } = identity();
    let restarts = 0;
    const app = new Hono();
    mountBrowserIdentity(app, { browser: { identity: id, host: { running: true, restart: async () => { restarts++; } } } } as unknown as ApiDeps);
    const put = (body: unknown, env?: object) => app.request("/browser/identity", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
    return { app, id, put, restarts: () => restarts };
  }

  it("shows the fingerprint and the proxy, without the password", async () => {
    const { app } = setup();
    const view = await (await app.request("/browser/identity")).json() as Record<string, any>;
    expect(view.fingerprint.summary).toMatchObject({ system: "macOS", browser: "Firefox 156" });
    expect(view.proxy).toBeNull();
  });

  it("a new fingerprint restarts the browser; a proxy does not", async () => {
    const { put, restarts, id } = setup();
    const before = id.config();
    expect((await put({ fingerprint: "new" })).status).toBe(200);
    expect(restarts()).toBe(1);
    expect(id.config()).not.toEqual(before);
    const withProxy = await put({ proxy: { server: "socks5://proxy.example.net:1080", keepPassword: true } });
    expect(((await withProxy.json()) as Record<string, any>).proxy.server).toBe("socks5://proxy.example.net:1080");
    expect(restarts()).toBe(1);
    expect((await put({ proxy: null })).status).toBe(200);
    expect(id.upstream()).toBeNull();
  });

  it("restarts the browser when asked, so a time zone that changed with the proxy is in force", async () => {
    const { app, restarts } = setup();
    const r = await app.request("/browser/identity/restart", { method: "POST" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as Record<string, unknown>).restartNeeded).toBe(false);
    expect(restarts()).toBe(1);
    expect((await app.request("/browser/identity/restart", { method: "POST" }, markRemote({}, { deviceId: "dev-phone" }))).status).toBe(403);
  });

  it("refuses what it cannot take, in words; and is not for a paired phone", async () => {
    const { put, app } = setup();
    expect((await put({ proxy: { server: "nonsense" } })).status).toBe(400);
    expect((await put({ proxy: { server: "http://h:1", username: "u", password: "clear" } })).status).toBe(400);
    expect((await put({ fingerprint: "old" })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    const phone = markRemote({}, { deviceId: "dev-phone" });
    expect((await put({ proxy: null }, phone)).status).toBe(403);
    expect((await app.request("/browser/identity", {}, phone)).status).toBe(403);
  });
});
