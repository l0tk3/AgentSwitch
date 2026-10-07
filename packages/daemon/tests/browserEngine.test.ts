import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EngineStore } from "../src/browser/engine/store.js";
import { EngineUpdater, type EngineSource, type UpdateDeps } from "../src/browser/engine/update.js";
import { camoufoxReleases, firefoxOf, newestCamoufox, playwrightRelease } from "../src/browser/engine/releases.js";

const root = () => join(realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-engine-"))), "engine");
const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const sha512 = (text: string) => `sha512-${createHash("sha512").update(text).digest("base64")}`;

/** An unpacked copy as an update would leave it in `incoming`. */
function unpacked(store: EngineStore, part: "camoufox" | "playwright", marker: string): string {
  const dir = store.incoming(part);
  writeFileSync(join(dir, "marker.txt"), marker);
  return dir;
}

describe("the engine's folder (docs/browser-v0.md §7: one copy on disk)", () => {
  it("has nothing installed at first", () => {
    const store = new EngineStore(root());
    expect(store.installed("camoufox")).toBeNull();
    expect(store.installed("playwright")).toBeNull();
    expect(existsSync(store.dir("camoufox"))).toBe(false);
  });

  it("puts a new copy in place and deletes the one it replaces: one copy after, and what it says of itself", () => {
    const store = new EngineStore(root());
    store.switchTo("camoufox", unpacked(store, "camoufox", "one"), { version: "156.0.1-beta.34", digest: "sha256:aa", bytes: 10, installedAt: 1 });
    expect(readFileSync(join(store.dir("camoufox"), "marker.txt"), "utf8")).toBe("one");
    expect(store.installed("camoufox")).toEqual({ version: "156.0.1-beta.34", digest: "sha256:aa", bytes: 10, installedAt: 1 });
    store.switchTo("camoufox", unpacked(store, "camoufox", "two"), { version: "156.0.1-beta.36", digest: "sha256:bb", bytes: 12, installedAt: 2 });
    expect(readFileSync(join(store.dir("camoufox"), "marker.txt"), "utf8")).toBe("two");
    expect(store.installed("camoufox")?.version).toBe("156.0.1-beta.36");
    // Nothing but the copy in use: no archive, no copy moved aside, no folder of an update.
    expect(readdirSync(store.root).sort()).toEqual(["camoufox"]);
    expect(readdirSync(join(store.root, "camoufox"))).toEqual(["current"]);
  });

  it("clears what an interrupted update left behind, and leaves the copy in use alone", () => {
    const store = new EngineStore(root());
    store.switchTo("playwright", unpacked(store, "playwright", "kept"), { version: "1.65.1", digest: "sha512-x", bytes: 1, installedAt: 1 });
    const half = store.incoming("camoufox");
    writeFileSync(join(half, "camoufox.zip.part"), "half of a download");
    mkdirSync(join(store.root, "playwright", "previous-1a2b"), { recursive: true });
    writeFileSync(join(store.root, "stray.zip"), "an archive");
    const removed = store.sweep();
    expect(removed.length).toBe(3);
    expect(readdirSync(store.root).sort()).toEqual(["playwright"]);
    expect(readdirSync(join(store.root, "playwright"))).toEqual(["current"]);
    expect(readFileSync(join(store.dir("playwright"), "marker.txt"), "utf8")).toBe("kept");
  });

  it("a copy that does not say what it is counts as not installed", () => {
    const store = new EngineStore(root());
    mkdirSync(store.dir("camoufox"), { recursive: true });
    expect(store.installed("camoufox")).toBeNull();
    writeFileSync(join(store.dir("camoufox"), "installed.json"), "{not json");
    expect(store.installed("camoufox")).toBeNull();
  });

  it("removes a part outright (back to the bundled Playwright)", () => {
    const store = new EngineStore(root());
    store.switchTo("playwright", unpacked(store, "playwright", "x"), { version: "1.65.1", digest: "sha512-x", bytes: 1, installedAt: 1 });
    store.remove("playwright");
    expect(store.installed("playwright")).toBeNull();
    expect(existsSync(join(store.root, "playwright"))).toBe(false);
  });
});

/** An updater over real folders with made-up downloads: `content` is what the server sends for a URL. */
function updater(over: Partial<UpdateDeps> = {}, content: Record<string, string> = {}) {
  const store = new EngineStore(root());
  const log: string[] = [];
  const deps: UpdateDeps = {
    store,
    now: () => 1000,
    download: async (source, file, progress) => {
      log.push(`download ${source.part}`);
      const body = content[source.url] ?? "";
      progress(body.length, body.length);
      writeFileSync(file, body);
    },
    unpack: async (part, archive, into) => {
      log.push(`unpack ${part}`);
      writeFileSync(join(into, "marker.txt"), readFileSync(archive, "utf8"));
    },
    selfCheck: async (candidate) => {
      log.push(`check camoufox=${candidate.camoufox ? "new" : "-"} playwright=${candidate.playwright ? "new" : "-"}`);
      return { ok: true };
    },
    ...over,
  };
  return { store, log, updater: new EngineUpdater(deps) };
}

const fox = (body: string, version = "156.0.1-beta.36"): EngineSource => ({ part: "camoufox", version, url: `https://example.test/camoufox-${version}.zip`, bytes: body.length, digest: sha256(body) });
const pw = (body: string, version = "1.65.1"): EngineSource => ({ part: "playwright", version, url: `https://example.test/playwright-core-${version}.tgz`, bytes: body.length, digest: sha512(body) });

describe("updating the engine (docs/browser-v0.md §7.2 第 6 条)", () => {
  it("downloads, checks the digest, unpacks, checks the pair itself, switches over and leaves one copy of each", async () => {
    const a = fox("camoufox 36"), b = pw("playwright 1.65.1");
    const { store, log, updater: u } = updater({}, { [a.url]: "camoufox 36", [b.url]: "playwright 1.65.1" });
    expect(u.start([a, b])).toEqual({ ok: true });
    expect(u.state().running).toBe(true);
    expect(u.start([a])).toEqual({ ok: false, reason: "busy" });
    const end = await u.done();
    expect(end).toMatchObject({ running: false, ok: true, to: { camoufox: "156.0.1-beta.36", playwright: "1.65.1" }, finishedAt: 1000 });
    expect(log).toEqual(["download camoufox", "unpack camoufox", "download playwright", "unpack playwright", "check camoufox=new playwright=new"]);
    expect(store.installed("camoufox")).toEqual({ version: "156.0.1-beta.36", digest: a.digest, bytes: a.bytes, installedAt: 1000 });
    expect(store.installed("playwright")?.version).toBe("1.65.1");
    expect(readdirSync(store.root).sort()).toEqual(["camoufox", "playwright"]);
    expect(readdirSync(join(store.root, "camoufox"))).toEqual(["current"]);
    // The archive is not kept.
    expect(readdirSync(store.dir("camoufox")).sort()).toEqual(["installed.json", "marker.txt"]);
  });

  it("a download that is not what the release published is thrown away: nothing switches", async () => {
    const a = fox("camoufox 36");
    const { store, log, updater: u } = updater({}, { [a.url]: "something else" });
    u.start([a]);
    const end = await u.done();
    expect(end).toMatchObject({ running: false, ok: false, phase: "verify" });
    expect(end.error).toContain("校验值");
    expect(log).toEqual(["download camoufox"]);
    expect(store.installed("camoufox")).toBeNull();
    expect(existsSync(store.root) ? readdirSync(store.root) : []).toEqual([]);
  });

  it("a pair that fails its own check is not switched to: the copy in use stays, the reason is told, nothing is left over", async () => {
    const first = fox("camoufox 34", "156.0.1-beta.34"), next = fox("camoufox 36");
    const { store, updater: u } = updater({}, { [first.url]: "camoufox 34", [next.url]: "camoufox 36" });
    u.start([first]);
    await u.done();
    const failing = new EngineUpdater({ ...(u as unknown as { deps: UpdateDeps }).deps, selfCheck: async () => ({ ok: false, reason: "改尺寸时协议报错" }) });
    failing.start([next]);
    const end = await failing.done();
    expect(end).toMatchObject({ ok: false, phase: "check", error: "改尺寸时协议报错" });
    expect(store.installed("camoufox")?.version).toBe("156.0.1-beta.34");
    expect(readFileSync(join(store.dir("camoufox"), "marker.txt"), "utf8")).toBe("camoufox 34");
    expect(readdirSync(store.root)).toEqual(["camoufox"]);
  });

  it("the check is given the new copies, and the copy in use for the part that is not changing", async () => {
    const b = pw("playwright 1.65.1");
    const seen: unknown[] = [];
    const { store, updater: u } = updater({ selfCheck: async (candidate) => { seen.push({ ...candidate, exists: candidate.playwright ? existsSync(join(candidate.playwright, "marker.txt")) : false }); return { ok: true }; } }, { [b.url]: "playwright 1.65.1" });
    u.start([b]);
    await u.done();
    expect(seen).toEqual([{ camoufox: null, playwright: expect.stringContaining("incoming-playwright-"), exists: true }]);
    expect(store.installed("playwright")?.version).toBe("1.65.1");
  });

  it("can be cancelled: what was downloaded so far is removed", async () => {
    const a = fox("camoufox 36");
    let release: () => void = () => {};
    const { store, updater: u } = updater({
      download: (_source, file, _progress, signal) => new Promise((resolve, reject) => {
        writeFileSync(file, "half");
        release = () => resolve();
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });
    u.start([a]);
    await new Promise((r) => setTimeout(r, 10));
    expect(u.state()).toMatchObject({ running: true, phase: "download", part: "camoufox" });
    u.cancel();
    const end = await u.done();
    expect(end).toMatchObject({ running: false, ok: false, cancelled: true });
    expect(existsSync(store.root) ? readdirSync(store.root) : []).toEqual([]);
    release();
  });

  it("says how far a download is", async () => {
    const a = fox("0123456789");
    let stateMid: unknown;
    const { updater: u } = updater({
      download: async (_source, file, progress) => { progress(4, 10); stateMid = { ...u.state() }; writeFileSync(file, "0123456789"); progress(10, 10); },
    });
    u.start([a]);
    await u.done();
    expect(stateMid).toMatchObject({ running: true, phase: "download", part: "camoufox", received: 4, total: 10 });
  });
});

describe("what can be installed (docs/browser-v0.md §7.2 第 6 条)", () => {
  const releases = [
    { tag_name: "v156.0.1-beta.35", prerelease: true, published_at: "2026-10-05T01:00:00Z", assets: [
      { name: "camoufox-156.0.1-beta.35-mac.arm64.zip", size: 1289000000, digest: "sha256:35", browser_download_url: "https://github.test/35-arm.zip" }] },
    { tag_name: "v156.0.1-beta.34", prerelease: false, published_at: "2026-10-03T01:00:00Z", assets: [
      { name: "camoufox-156.0.1-beta.34-mac.arm64.zip", size: 1289764252, digest: "sha256:34", browser_download_url: "https://github.test/34-arm.zip" },
      { name: "camoufox-156.0.1-beta.34-mac.x86_64.zip", size: 1297000000, digest: "sha256:34x", browser_download_url: "https://github.test/34-x86.zip" },
      { name: "camoufox-156.0.1-beta.34-lin.x86_64.zip", size: 900000000, digest: "sha256:34l", browser_download_url: "https://github.test/34-lin.zip" }] },
    { tag_name: "v152.0.4-beta.28", prerelease: false, published_at: "2026-07-19T01:00:00Z", assets: [
      { name: "camoufox-152.0.4-beta.28-mac.arm64.zip", size: 700000000, digest: "sha256:28", browser_download_url: "https://github.test/28-arm.zip" }] },
    { tag_name: "v157.0-beta.1", prerelease: false, published_at: "2026-10-06T01:00:00Z", assets: [
      { name: "camoufox-157.0-beta.1-mac.arm64.zip", size: 1300000000, browser_download_url: "https://github.test/157-arm.zip" }] },
  ];

  it("reads Camoufox's releases for this kind of Mac, newest first, leaving out builds without a published digest", () => {
    const list = camoufoxReleases(releases, { platform: "darwin", arch: "arm64" });
    expect(list.map((r) => r.version)).toEqual(["156.0.1-beta.35", "156.0.1-beta.34", "152.0.4-beta.28"]);
    expect(list[1]).toEqual({ part: "camoufox", version: "156.0.1-beta.34", url: "https://github.test/34-arm.zip", bytes: 1289764252, digest: "sha256:34", prerelease: false, publishedAt: Date.parse("2026-10-03T01:00:00Z") });
    expect(camoufoxReleases(releases, { platform: "darwin", arch: "x64" }).map((r) => r.url)).toEqual(["https://github.test/34-x86.zip"]);
    expect(camoufoxReleases(releases, { platform: "linux", arch: "x64" }).map((r) => r.url)).toEqual(["https://github.test/34-lin.zip"]);
    expect(camoufoxReleases({ message: "rate limited" }, { platform: "darwin", arch: "arm64" })).toEqual([]);
  });

  it("picks the newest build of the Firefox this Playwright drives; pre-releases only when asked", () => {
    const list = camoufoxReleases(releases, { platform: "darwin", arch: "arm64" });
    expect(newestCamoufox(list, { firefox: "156.0" })?.version).toBe("156.0.1-beta.34");
    expect(newestCamoufox(list, { firefox: "156.0", prerelease: true })?.version).toBe("156.0.1-beta.35");
    expect(newestCamoufox(list, { firefox: "152.0" })?.version).toBe("152.0.4-beta.28");
    expect(newestCamoufox(list, { firefox: "140.0" })).toBeNull();
  });

  it("reads which Firefox a Playwright drives from its own list of browsers", () => {
    expect(firefoxOf({ browsers: [{ name: "chromium", browserVersion: "150.0" }, { name: "firefox", revision: "1549", browserVersion: "156.0" }] })).toBe("156.0");
    expect(firefoxOf({ browsers: [] })).toBeNull();
    expect(firefoxOf(null)).toBeNull();
  });

  it("reads one version of playwright-core from the registry: where it is and what it must hash to", () => {
    const registry = { versions: { "1.65.1": { dist: { tarball: "https://registry.test/playwright-core-1.65.1.tgz", integrity: "sha512-abc", unpackedSize: 13500000 } } }, time: { "1.65.1": "2026-10-20T00:00:00Z" } };
    expect(playwrightRelease(registry, "1.65.1")).toEqual({ part: "playwright", version: "1.65.1", url: "https://registry.test/playwright-core-1.65.1.tgz", bytes: 13500000, digest: "sha512-abc" });
    expect(playwrightRelease(registry, "9.9.9")).toBeNull();
    expect(playwrightRelease({ versions: { "1.0.0": { dist: { tarball: "x" } } } }, "1.0.0")).toBeNull();
  });
});

// ---- the service and its routes ----
import { Hono } from "hono";
import { EngineKit } from "../src/browser/engine/kit.js";
import { mountBrowserEngine } from "../src/api/browserEngine.js";
import { bundledPlaywright, firefoxVersion } from "../src/browser/engine/loader.js";
import type { ApiDeps } from "../src/api/shared.js";

const FIREFOX = firefoxVersion(bundledPlaywright())!;
const MAJOR = FIREFOX.split(".")[0];

function kit(over: { selfCheck?: UpdateDeps["selfCheck"]; registry?: unknown } = {}) {
  const body = (v: string) => `camoufox ${v}`;
  const release = (v: string, prerelease = false, day = 1) => ({ tag_name: `v${v}`, prerelease, published_at: `2026-10-0${day}T00:00:00Z`, assets: [
    { name: `camoufox-${v}-mac.arm64.zip`, size: body(v).length, digest: sha256(body(v)), browser_download_url: `https://github.test/${v}.zip` }] });
  const releases = [release(`${MAJOR}.0.1-beta.35`, true, 5), release(`${MAJOR}.0.1-beta.34`, false, 3), release("100.0-beta.1", false, 1)];
  const asked: string[] = [];
  const k = new EngineKit({
    root: root(), platform: "darwin", arch: "arm64", now: () => 5000,
    fetchJson: async (url) => { asked.push(url); return url.includes("github") ? releases : (over.registry ?? { versions: {} }); },
    download: async (source, file, progress) => { progress(1, 1); writeFileSync(file, source.part === "camoufox" ? body(source.version) : `playwright ${source.version}`); },
    unpack: async (_part, archive, into) => { writeFileSync(join(into, "marker.txt"), readFileSync(archive, "utf8")); },
    selfCheck: over.selfCheck ?? (async () => ({ ok: true })),
  });
  return { kit: k, asked };
}

describe("the engine as the service has it (GET /browser/engine, POST /browser/engine/update)", () => {
  it("says what is installed: no Camoufox at first, the bundled Playwright and the Firefox it drives", () => {
    const { kit: k } = kit();
    const s = k.status();
    expect(s.camoufox).toEqual({ installed: null, ready: false });
    expect(s.playwright).toMatchObject({ active: "bundled", installed: null, firefox: FIREFOX });
    expect(s.playwright.bundled).toBe(bundledPlaywright().version);
    expect(s.update).toEqual({ running: false });
    expect(s.available).toBeUndefined();
  });

  it("a check lists the newest build of the Firefox in use; pre-releases only when asked", async () => {
    const { kit: k, asked } = kit();
    expect((await k.check()).available).toEqual({ camoufox: { version: `${MAJOR}.0.1-beta.34`, bytes: `camoufox ${MAJOR}.0.1-beta.34`.length, prerelease: false }, checkedAt: 5000 });
    expect(asked).toEqual(["https://api.github.com/repos/daijro/camoufox/releases?per_page=30"]);
    expect((await k.check({ prerelease: true })).available?.camoufox?.version).toBe(`${MAJOR}.0.1-beta.35`);
  });

  it("a check that cannot reach the releases says so and offers nothing", async () => {
    const k = new EngineKit({ root: root(), platform: "darwin", arch: "arm64", now: () => 1, fetchJson: async () => { throw new Error("offline"); } });
    expect((await k.check()).available).toEqual({ camoufox: null, checkedAt: 1, problem: "无法读取可用的版本：offline" });
  });

  it("installs the newest compatible Camoufox when asked for `latest`, and is then ready", async () => {
    const { kit: k } = kit();
    await k.check();
    expect(await k.update({ camoufox: "latest" })).toEqual({ ok: true });
    await k.settled();
    const s = k.status();
    expect(s.available?.camoufox, "what was offered before is not offered once it is installed").toBeNull();
    expect(s.camoufox.installed?.version).toBe(`${MAJOR}.0.1-beta.34`);
    expect(s.update).toMatchObject({ running: false, ok: true });
    // Nothing to offer once the newest is in use.
    expect((await k.check()).available?.camoufox).toBeNull();
  });

  it("refuses what it cannot install: nothing asked, a version that was not published, a build for another Firefox", async () => {
    const { kit: k } = kit();
    expect(await k.update({})).toMatchObject({ ok: false, status: 400 });
    expect(await k.update({ camoufox: "1.2.3" })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("1.2.3") });
    expect(await k.update({ camoufox: "100.0-beta.1" })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining(`Firefox ${MAJOR}`) });
    expect(await k.update({ playwright: "9.9.9" })).toMatchObject({ ok: false, status: 400 });
    expect(k.status().update).toEqual({ running: false });
  });

  it("a pair that fails its own check leaves things as they were, with the reason in the state", async () => {
    const { kit: k } = kit({ selfCheck: async () => ({ ok: false, reason: "自检未通过：连续出帧：3 秒内只有 1 帧" }) });
    await k.update({ camoufox: "latest" });
    await k.settled();
    expect(k.status()).toMatchObject({ camoufox: { installed: null }, update: { ok: false, phase: "check", error: "自检未通过：连续出帧：3 秒内只有 1 帧" } });
  });

  it("switches to the new copy around whoever runs a browser on the old one: stopped first, the copy changed in between", async () => {
    const { kit: k } = kit();
    const order: string[] = [];
    k.aroundSwitch(async (apply) => {
      order.push(`stop (installed: ${k.store.installed("camoufox")?.version ?? "none"})`);
      apply();
      order.push(`start (installed: ${k.store.installed("camoufox")?.version})`);
    });
    await k.update({ camoufox: "latest" });
    await k.settled();
    expect(order).toEqual(["stop (installed: none)", `start (installed: ${MAJOR}.0.1-beta.34)`]);
    expect(k.status().update).toMatchObject({ ok: true });
  });

  it("clears an interrupted update's leftovers as it starts", () => {
    const { kit: k } = kit();
    const half = k.store.incoming("camoufox");
    writeFileSync(join(half, "archive"), "half");
    k.start();
    expect(existsSync(half)).toBe(false);
  });

  it("over the API: the state, a check, an update that is accepted, one refused while another runs, a cancel", async () => {
    let hold: (r: { ok: true }) => void = () => {};
    const { kit: k } = kit({ selfCheck: () => new Promise((resolve) => { hold = resolve; }) });
    const app = new Hono();
    mountBrowserEngine(app, { engineKit: k } as unknown as ApiDeps);
    const json = async (r: Response | Promise<Response>) => (await r).json() as Promise<Record<string, any>>;
    expect((await json(app.request("/browser/engine"))).camoufox).toEqual({ installed: null, ready: false });
    expect((await json(app.request("/browser/engine?check=1"))).available.camoufox.version).toBe(`${MAJOR}.0.1-beta.34`);
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/browser/engine/update", { camoufox: "nope" })).status).toBe(400);
    expect((await post("/browser/engine/update", { camoufox: 5 })).status).toBe(400);
    const accepted = await post("/browser/engine/update", { camoufox: "latest" });
    expect(accepted.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect((await json(app.request("/browser/engine"))).update).toMatchObject({ running: true, phase: "check" });
    expect((await post("/browser/engine/update", { camoufox: "latest" })).status).toBe(409);
    expect((await post("/browser/engine/cancel", {})).status).toBe(200);
    hold({ ok: true });
    await k.settled();
    expect((await json(app.request("/browser/engine"))).update).toMatchObject({ running: false, ok: false, cancelled: true });
  });

  it("without the engine the routes are not there", async () => {
    const app = new Hono();
    mountBrowserEngine(app, {} as unknown as ApiDeps);
    expect((await app.request("/browser/engine")).status).toBe(404);
  });
});

// ---- archives: fetched and unpacked with the system's tools ----
import { execFileSync } from "node:child_process";
import { camoufoxExecutable, downloadArchive, unpackArchive } from "../src/browser/engine/files.js";
import { playwrightIn } from "../src/browser/engine/loader.js";

describe("an engine archive", () => {
  it("is streamed to a file with how far it is; a refusal is told", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-archive-")));
    const seen: number[] = [];
    const fetcher = (async () => new Response("0123456789", { headers: { "content-length": "10" } })) as unknown as typeof fetch;
    await downloadArchive(fox("0123456789"), join(dir, "a"), (received) => seen.push(received), new AbortController().signal, fetcher);
    expect(readFileSync(join(dir, "a"), "utf8")).toBe("0123456789");
    expect(seen.at(-1)).toBe(10);
    const refused = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(downloadArchive(fox("x"), join(dir, "b"), () => {}, new AbortController().signal, refused)).rejects.toThrow("HTTP 404");
  });

  it("playwright-core's tarball becomes a package Playwright can be loaded from", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-archive-")));
    mkdirSync(join(dir, "src", "package"), { recursive: true });
    writeFileSync(join(dir, "src", "package", "package.json"), JSON.stringify({ name: "playwright-core", version: "9.9.9", main: "index.js" }));
    writeFileSync(join(dir, "src", "package", "index.js"), "module.exports = { made: 'up' };");
    writeFileSync(join(dir, "src", "package", "browsers.json"), JSON.stringify({ browsers: [{ name: "firefox", browserVersion: "200.0" }] }));
    execFileSync("tar", ["-czf", join(dir, "archive"), "-C", join(dir, "src"), "package"]);
    const into = join(dir, "into");
    mkdirSync(into);
    await unpackArchive("playwright", join(dir, "archive"), into, new AbortController().signal);
    const copy = playwrightIn(into)!;
    expect(copy).toMatchObject({ from: "installed", version: "9.9.9" });
    expect(copy.require("playwright-core")).toEqual({ made: "up" });
    expect(firefoxVersion(copy)).toBe("200.0");
    expect(playwrightIn(join(dir, "nowhere"))).toBeNull();
  });

  it("Camoufox's zip is unpacked as the app it holds; what is not an archive is refused", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-archive-")));
    const app = join(dir, "src", "Camoufox.app", "Contents", "MacOS");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "camoufox"), "#!/bin/sh\n", { mode: 0o755 });
    execFileSync("/usr/bin/zip", ["-q", "-r", join(dir, "archive"), "Camoufox.app"], { cwd: join(dir, "src") });
    const into = join(dir, "into");
    mkdirSync(into);
    await unpackArchive("camoufox", join(dir, "archive.zip"), into, new AbortController().signal);
    expect(camoufoxExecutable(into, "darwin")).toBe(join(into, "Camoufox.app", "Contents", "MacOS", "camoufox"));
    expect(camoufoxExecutable(into, "linux")).toBeNull();
    writeFileSync(join(dir, "junk"), "not a zip");
    await expect(unpackArchive("camoufox", join(dir, "junk"), into, new AbortController().signal)).rejects.toThrow("解包失败");
  });
});
