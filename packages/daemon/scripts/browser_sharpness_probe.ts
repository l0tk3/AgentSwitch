/** Experiment, not a test (docs/browser-v0.md §5 "画面的像素", 2026-10-03): how the shared browser's picture can come at
 *  the viewing screen's device pixels. Runs the user's installed Google Chrome as the host does (playwright-core,
 *  `channel: "chrome"`, new headless, pipe, sandbox on) on throw-away profiles in a temporary folder, serves a test page
 *  from 127.0.0.1, and measures each approach: the frame's pixel size and what Chrome's metadata says about it, JPEG
 *  bytes per frame, Chrome's CPU while a page animates at 15 frames a second, where a click and a wheel land, and what
 *  the page sees (`innerWidth`, `devicePixelRatio`, resize events). Frames are saved for a look. Not part of `npm test`.
 *
 *    npx tsx scripts/browser_sharpness_probe.ts [--keep]     (--keep: leave the frames in the temporary folder)
 *
 *  `PROBE_DIR` puts the temporary folder elsewhere than the system's (tsx's own socket needs a short TMPDIR).
 *
 *  Approaches:
 *    A  today: the viewport emulated at DPR 1; the screencast as it comes.
 *    B  DPR 2 in `Emulation.setDeviceMetricsOverride`, nothing else.
 *    C  DPR 2, and the screencast's maxWidth / maxHeight in device pixels.
 *    D  DPR 2 and the emulation's `scale` 2 (the view's image scaled), the view left at the CSS size.
 *    E  as D, the tab's own view at the device pixels (`dontSetVisibleSize` + `Emulation.setVisibleSize`).
 *    F  the `--force-device-scale-factor=2` launch flag (all of Chrome), DPR 2 emulated.
 *    G  stills: `Page.captureScreenshot` at DPR 2 while the screencast runs at the CSS size.
 *  Then E's details: two tabs at different scales at once, a click and a wheel, an agent's screenshot (Playwright's
 *  `page.screenshot()`) while scaled, back to scale 1, and acks paced as the host paced them before (2026-10-03).
 *
 *  Result with Chrome 154 (browser-v0 §5, 2026-10-03): B, C and D stay at the CSS size (D shows a quarter of the page);
 *  E gives the device pixels per tab, invisible to the page, but takes input in the view's pixels (Playwright's clicks
 *  miss), so the host draws an agent's tabs at the CSS size around its calls; F works but for all of Chrome (every tab
 *  rasterised at 2, agents' device-pixel screenshots doubled, no 3x for the phone); G costs ~50 ms and a resize event
 *  a still. The host uses E. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { jpegSize } from "../src/browser/screencast.js";

const keep = process.argv.includes("--keep");
const root = mkdtempSync(join(process.env.PROBE_DIR ?? tmpdir(), "agentswitch-sharpness-"));
const framesDir = join(root, "frames");
mkdirSync(framesDir, { recursive: true });
const profiles: string[] = [];

/** A page with what blurs first: small text, hairlines, a 1 px checkerboard; a box that moves (frames keep coming);
 *  tall enough to scroll. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Sharpness</title>
<style>
  body { margin: 0; font: 13px -apple-system, "PingFang SC", sans-serif; color: #1f2328; background: #fff; }
  header { height: 48px; border-bottom: 1px solid #d0d7de; display: flex; align-items: center; padding: 0 16px; font-weight: 600; }
  main { display: grid; grid-template-columns: 240px 1fr; gap: 16px; padding: 16px; }
  nav a { display: block; padding: 4px 0; color: #0969da; text-decoration: none; font-size: 12px; }
  pre { font: 11px ui-monospace, Menlo, monospace; background: #f6f8fa; padding: 8px; border: 1px solid #d0d7de; margin: 0; }
  .grid { width: 120px; height: 60px; background: repeating-conic-gradient(#000 0 25%, #fff 0 50%) 0 0 / 2px 2px; }
  .lines { width: 120px; height: 60px; background: repeating-linear-gradient(90deg, #000 0 1px, #fff 1px 3px); }
  #mover { position: fixed; right: 24px; bottom: 24px; width: 40px; height: 40px; background: #e5534b; animation: m 1s linear infinite; }
  body.still #mover { animation: none; }
  @keyframes m { from { transform: translateX(0) } to { transform: translateX(-200px) } }
</style></head><body>
<header>acme / app · Pull request #128 · 修复画面在高像素比屏幕上发虚的问题</header>
<main><nav>${Array.from({ length: 24 }, (_, i) => `<a href="#">src/browser/file-${i}.ts — 第 ${i} 项</a>`).join("")}</nav>
<section>
<p>The quick brown fox jumps over the lazy dog. 天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。 0123456789 — small print follows.</p>
<p style="font-size:11px">${"Eleven pixel text, the kind a status line or a table cell has. 十一像素的文字。 ".repeat(6)}</p>
<pre>${Array.from({ length: 14 }, (_, i) => `  ${i + 1}  const frame = await page.screencast({ quality: 80, maxWidth: 2560 }); // line ${i + 1}`).join("\n")}</pre>
<div style="display:flex;gap:12px;margin-top:12px"><div class="grid"></div><div class="lines"></div></div>
<p>${"Paragraph text at thirteen pixels wraps across the column and fills it. 段落文字在十三像素下换行并填满这一栏。 ".repeat(8)}</p>
<div style="height:3000px"></div>
</section></main>
<div id="mover"></div>
<script>
  window.__resizes = 0; addEventListener("resize", () => { window.__resizes++; });
  window.__clicks = []; addEventListener("mousedown", (e) => { window.__clicks.push([e.clientX, e.clientY]); }, true);
</script>
</body></html>`;

type Row = Record<string, string | number | boolean>;
const rows: Row[] = [];
const notes: string[] = [];

function serve(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PAGE); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` })));
}

async function launch(args: readonly string[] = []): Promise<{ context: BrowserContext; profile: string }> {
  const { chromium } = await import("playwright-core");
  const profile = join(root, `profile-${profiles.length}`);
  profiles.push(profile);
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chrome", headless: true, viewport: null, args: ["--window-size=1280,800", ...args],
    chromiumSandbox: true, acceptDownloads: false, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, timeout: 30_000,
  });
  return { context, profile };
}

/** The Chrome processes of one profile, by its command line. */
function chromePids(profile: string): string[] {
  try { return execFileSync("pgrep", ["-f", "--", `--user-data-dir=${profile}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean); }
  catch { return []; }
}

/** CPU seconds used so far by those processes (`ps -o time=`: [[dd-]hh:]mm:ss.cc). */
function cpuSeconds(pids: readonly string[]): number {
  if (!pids.length) return 0;
  let out = "";
  try { out = execFileSync("ps", ["-o", "time=", "-p", pids.join(",")], { encoding: "utf8" }); } catch { return 0; }
  return out.trim().split("\n").filter(Boolean).reduce((sum, t) => sum + t.trim().split(":").map(Number).reduce((acc, p) => acc * 60 + p, 0), 0);
}

type Frame = { width: number; height: number; deviceWidth: number; deviceHeight: number; bytes: number; data: string };

/** A screencast on `cdp` at `fps`. `paced`: each ack waits its turn (at most `fps` acks a second, whatever is in
 *  flight); otherwise each ack waits `1000 / fps` from the last one sent, as the host did before 2026-10-03 (Chrome
 *  keeps more than one frame in flight, so it made several times `fps`). */
function screencast(cdp: CDPSession, fps = 15, paced = true) {
  const frames: Frame[] = [];
  let next = 0;
  let lastSent = 0;
  const gap = 1000 / fps;
  const onFrame = (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
    const buf = Buffer.from(f.data, "base64");
    const size = jpegSize(buf) ?? { width: 0, height: 0 };
    frames.push({ ...size, deviceWidth: f.metadata.deviceWidth, deviceHeight: f.metadata.deviceHeight, bytes: buf.length, data: f.data });
    const now = Date.now();
    const send = () => { lastSent = Date.now(); void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined); };
    if (paced) {
      const at = Math.max(now, next);
      next = at + gap;
      setTimeout(send, at - now);
    } else {
      setTimeout(send, Math.max(0, lastSent + gap - now));
    }
  };
  cdp.on("Page.screencastFrame", onFrame);
  return {
    frames,
    async start(params: { quality: number; maxWidth?: number; maxHeight?: number }) {
      await cdp.send("Page.startScreencast", { format: "jpeg", everyNthFrame: 1, ...params });
    },
    async stop() { await cdp.send("Page.stopScreencast").catch(() => undefined); cdp.off("Page.screencastFrame", onFrame); },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(get: () => T | undefined, ms = 5_000): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined || Date.now() > end) return v;
    await sleep(25);
  }
}

type Metrics = { width: number; height: number; deviceScaleFactor: number; mobile: boolean; scale?: number };

/** The emulation: the CSS size, DPR and `scale`; with `view`, the tab's own view at `scale` times the CSS size
 *  (approach E), else Chrome sets the view to the CSS size (approaches A–D). */
async function emulate(cdp: CDPSession, m: Metrics, view = false): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...m, screenWidth: m.width, screenHeight: m.height, ...(view ? { dontSetVisibleSize: true } : {}) });
  const s = m.scale ?? 1;
  if (view) await cdp.send("Emulation.setVisibleSize", { width: Math.round(m.width * s), height: Math.round(m.height * s) });
}

/** One approach: a still frame for a look, then 4 s of motion (bytes, frames a second, CPU), a click at the point that
 *  should be CSS (100, 60), and what the page sees. `click`: where to send it (CSS times the view's scale for E). */
async function measure(label: string, page: Page, cdp: CDPSession, profile: string, m: Metrics, cast: { quality: number; maxWidth?: number; maxHeight?: number },
                       opts: { view?: boolean; paced?: boolean } = {}): Promise<void> {
  await emulate(cdp, m, opts.view);
  await page.evaluate(() => { document.body.classList.add("still"); (window as unknown as { __resizes: number }).__resizes = 0; scrollTo(0, 0); });
  await sleep(300);
  const sc = screencast(cdp, 15, opts.paced ?? true);
  await sc.start(cast);
  await until(() => sc.frames[0]);
  await sleep(500);
  const still = sc.frames.at(-1);
  if (still) writeFileSync(join(framesDir, `${label}.jpg`), Buffer.from(still.data, "base64"));

  const pids = chromePids(profile);
  const before = sc.frames.length;
  const cpu0 = cpuSeconds(pids);
  const node0 = process.cpuUsage();
  await page.evaluate(() => document.body.classList.remove("still"));
  const t0 = Date.now();
  await sleep(4_000);
  const seconds = (Date.now() - t0) / 1000;
  const cpu = cpuSeconds(pids) - cpu0;
  const nodeCpu = process.cpuUsage(node0);
  const moving = sc.frames.slice(before);
  await page.evaluate(() => document.body.classList.add("still"));
  await sc.stop();

  const k = opts.view ? m.scale ?? 1 : 1;
  const seen = await clickAndLook(page, cdp, 100 * k, 60 * k);
  const avg = moving.length ? moving.reduce((s, f) => s + f.bytes, 0) / moving.length : 0;
  rows.push({
    approach: label,
    frame: still ? `${still.width}x${still.height}` : "none",
    metadata: still ? `${still.deviceWidth}x${still.deviceHeight}` : "-",
    "still KB": still ? Math.round(still.bytes / 1024) : 0,
    "moving KB/frame": Math.round(avg / 1024),
    fps: Math.round((moving.length / seconds) * 10) / 10,
    "chrome CPU %": Math.round((cpu / seconds) * 100),
    "node CPU %": Math.round(((nodeCpu.user + nodeCpu.system) / 1e6 / seconds) * 100),
    "page sees": `${seen.inner} @${seen.dpr}`,
    [`click sent (${100 * k},${60 * k}) lands`]: seen.click,
    resizes: seen.resizes,
  });
}

async function clickAndLook(page: Page, cdp: CDPSession, x: number, y: number) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  const seen = await page.evaluate(() => {
    const w = window as unknown as { __clicks: number[][]; __resizes: number };
    const out = { inner: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio, click: (w.__clicks.at(-1) ?? []).join(","), resizes: w.__resizes };
    w.__clicks = [];
    return out;
  });
  return seen;
}

async function freshPage(context: BrowserContext, url: string): Promise<{ page: Page; cdp: CDPSession }> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Page.enable");
  await page.goto(url);
  return { page, cdp };
}

/** G: stills by `Page.captureScreenshot` at DPR 2 while a CSS-size screencast runs: their size, bytes and time, and
 *  whether the screencast or the page notices. */
async function stills(page: Page, cdp: CDPSession, profile: string): Promise<void> {
  await emulate(cdp, { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await page.evaluate(() => { document.body.classList.add("still"); (window as unknown as { __resizes: number }).__resizes = 0; });
  const sc = screencast(cdp);
  await sc.start({ quality: 80 });
  await until(() => sc.frames[0]);
  await sleep(300);
  const before = sc.frames.length;
  const pids = chromePids(profile);
  const times: number[] = [];
  let bytes = 0;
  let size = "";
  const cpu0 = cpuSeconds(pids);
  for (let i = 0; i < 8; i++) {
    const s = Date.now();
    const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
    times.push(Date.now() - s);
    const buf = Buffer.from(data, "base64");
    bytes += buf.length;
    const dims = jpegSize(buf);
    size = dims ? `${dims.width}x${dims.height}` : "?";
    if (i === 0) writeFileSync(join(framesDir, "G-still.jpg"), buf);
  }
  const cpu = cpuSeconds(pids) - cpu0;
  await sleep(300);
  const during = sc.frames.slice(before);
  const odd = during.filter((f) => f.width !== 1280 || f.height !== 800).length;
  const resizes = await page.evaluate(() => (window as unknown as { __resizes: number }).__resizes);
  rows.push({ approach: "G captureScreenshot dpr2", frame: size, "still KB": Math.round(bytes / 8 / 1024), "ms each": Math.round(times.reduce((a, b) => a + b, 0) / times.length),
    "chrome CPU ms each": Math.round((cpu / 8) * 1000), "screencast frames meanwhile": during.length, "of them not 1280x800": odd, resizes });
  await sc.stop();
}

/** E in detail. */
async function scaledDetails(context: BrowserContext, url: string): Promise<void> {
  const one = await freshPage(context, url);
  const two = await freshPage(context, url);
  const w1 = await one.cdp.send("Browser.getWindowForTarget");
  const w2 = await two.cdp.send("Browser.getWindowForTarget");
  notes.push(`tabs share a window: ${w1.windowId === w2.windowId} (so a window's size cannot be a tab's own)`);

  // Two tabs at once: one at 2, one at 1 (the older tab is not the window's active one).
  await emulate(one.cdp, { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false, scale: 2 }, true);
  await emulate(two.cdp, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, true);
  const s1 = screencast(one.cdp);
  const s2 = screencast(two.cdp);
  await s1.start({ quality: 80 });
  await s2.start({ quality: 80 });
  await one.page.evaluate(() => document.body.classList.remove("still"));
  await two.page.evaluate(() => document.body.classList.remove("still"));
  await sleep(1_500);
  const last = (f: Frame[]) => (f.length ? `${f.at(-1)!.width}x${f.at(-1)!.height} (${f.length} frames)` : "none");
  notes.push(`two tabs at once: the older at scale 2 → ${last(s1.frames)}; the newer at scale 1 → ${last(s2.frames)}`);

  // A size change without restarting the screencast.
  const count = s1.frames.length;
  await emulate(one.cdp, { width: 1000, height: 700, deviceScaleFactor: 2, mobile: false, scale: 2 }, true);
  await sleep(1_000);
  const after = s1.frames.slice(count);
  notes.push(`resized to 1000x700 at 2 without a restart: ${after.length ? [...new Set(after.map((f) => `${f.width}x${f.height}`))].join(", ") : "no frames"}`);
  await s1.stop();
  await s1.start({ quality: 80 });
  const count2 = s1.frames.length;
  await sleep(800);
  notes.push(`after a restart: ${[...new Set(s1.frames.slice(count2).map((f) => `${f.width}x${f.height}`))].join(", ") || "no frames"}`);
  await s1.stop();
  await s2.stop();
  await two.page.close();

  // A wheel of 100 at scale 2: how far the page scrolls.
  await emulate(one.cdp, { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false, scale: 2 }, true);
  await one.page.evaluate(() => scrollTo(0, 0));
  await one.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 600, deltaX: 0, deltaY: 100 });
  await sleep(500);
  const scrolled = await one.page.evaluate(() => scrollY);
  notes.push(`a wheel of deltaY 100 at scale 2 scrolls the page by ${scrolled} CSS px`);
  await one.page.evaluate(() => scrollTo(0, 0));

  // An agent's screenshot while the tab is scaled, at DPR 2 and at DPR 1; then the view is as it was.
  for (const dpr of [2, 1]) {
    await emulate(one.cdp, { width: 1280, height: 800, deviceScaleFactor: dpr, mobile: false, scale: 2 }, true);
    const shot = await one.page.screenshot({ type: "jpeg", quality: 80 });
    const css = await one.page.screenshot({ type: "jpeg", quality: 80, scale: "css" });
    const sc = screencast(one.cdp);
    await sc.start({ quality: 80 });
    await until(() => sc.frames[0]);
    await one.page.evaluate(() => document.body.classList.remove("still"));
    await sleep(500);
    await one.page.evaluate(() => document.body.classList.add("still"));
    await sc.stop();
    const dims = (b: Buffer) => { const d = jpegSize(b); return d ? `${d.width}x${d.height}` : "?"; };
    notes.push(`an agent's page.screenshot() at DPR ${dpr}, scale 2: ${dims(shot)} (scale "css": ${dims(css)}); frames afterwards ${last(sc.frames)}`);
  }

  // Back to 1: the view at the CSS size again.
  await emulate(one.cdp, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, scale: 1 }, true);
  const sc = screencast(one.cdp);
  await sc.start({ quality: 80 });
  await until(() => sc.frames[0]);
  await sc.stop();
  const seen = await clickAndLook(one.page, one.cdp, 100, 60);
  notes.push(`back to scale 1: frames ${last(sc.frames)}, a click at (100,60) lands at ${seen.click}, the page sees ${seen.inner} @${seen.dpr}`);
  await one.page.close();
}

async function main(): Promise<void> {
  const { server, url } = await serve();
  try {
    const { context, profile } = await launch();
    try {
      const a = await freshPage(context, url);
      const desk = { width: 1280, height: 800 };
      await measure("A-dpr1", a.page, a.cdp, profile, { ...desk, deviceScaleFactor: 1, mobile: false }, { quality: 80 });
      await measure("A-dpr1-old-pacing", a.page, a.cdp, profile, { ...desk, deviceScaleFactor: 1, mobile: false }, { quality: 80 }, { paced: false });
      await measure("B-dpr2", a.page, a.cdp, profile, { ...desk, deviceScaleFactor: 2, mobile: false }, { quality: 80 });
      await measure("C-dpr2-max2560", a.page, a.cdp, profile, { ...desk, deviceScaleFactor: 2, mobile: false }, { quality: 80, maxWidth: 2560, maxHeight: 1600 });
      await measure("D-dpr2-scale2", a.page, a.cdp, profile, { ...desk, deviceScaleFactor: 2, mobile: false, scale: 2 }, { quality: 80 });
      await measure("E-dpr2-scale2", a.page, a.cdp, profile, { ...desk, deviceScaleFactor: 2, mobile: false, scale: 2 }, { quality: 80 }, { view: true });
      await measure("E-dpr1-scale2", a.page, a.cdp, profile, { ...desk, deviceScaleFactor: 1, mobile: false, scale: 2 }, { quality: 80 }, { view: true });
      await measure("E-dpr2-scale2-old-pacing", a.page, a.cdp, profile, { ...desk, deviceScaleFactor: 2, mobile: false, scale: 2 }, { quality: 80 }, { view: true, paced: false });
      await measure("E-dpr2-scale2-q70", a.page, a.cdp, profile, { ...desk, deviceScaleFactor: 2, mobile: false, scale: 2 }, { quality: 70 }, { view: true });
      await measure("E-dpr2-scale2-max1280", a.page, a.cdp, profile, { ...desk, deviceScaleFactor: 2, mobile: false, scale: 2 }, { quality: 80, maxWidth: 1280, maxHeight: 800 }, { view: true });
      // The phone held: 390×844 at DPR 3, frames at 1, 2 and 3 (q70, the phone's on the local network).
      const phone = { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 };
      await measure("A-phone", a.page, a.cdp, profile, phone, { quality: 70 }, { view: true });
      await measure("E-phone-scale2", a.page, a.cdp, profile, { ...phone, scale: 2 }, { quality: 70 }, { view: true });
      await measure("E-phone-scale3", a.page, a.cdp, profile, { ...phone, scale: 3 }, { quality: 70 }, { view: true });
      await stills(a.page, a.cdp, profile);
      await a.page.close();
      await scaledDetails(context, url);
    } finally {
      await context.close().catch(() => undefined);
    }

    // F: the flag, for all of Chrome.
    const forced = await launch(["--force-device-scale-factor=2"]);
    try {
      const f = await freshPage(forced.context, url);
      await measure("F-flag2-dpr2", f.page, f.cdp, forced.profile, { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false }, { quality: 80 });
      await measure("F-flag2-dpr1", f.page, f.cdp, forced.profile, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, { quality: 80 });
      await measure("F-flag2-phone-dpr3", f.page, f.cdp, forced.profile, { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, { quality: 70 });
      await emulate(f.cdp, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      const shot = await f.page.screenshot({ type: "jpeg", quality: 80 });
      const dims = jpegSize(shot);
      notes.push(`with the flag, an agent's page.screenshot() of a 1280x800 tab at DPR 1: ${dims ? `${dims.width}x${dims.height}` : "?"}`);
    } finally {
      await forced.context.close().catch(() => undefined);
    }
  } finally {
    server.close();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(async () => {
  for (const row of rows) console.log(JSON.stringify(row));
  for (const note of notes) console.log(`- ${note}`);
  // Headless Chrome may outlive its context: every process of these profiles goes.
  await sleep(500);
  for (const profile of profiles) {
    const left = chromePids(profile);
    if (left.length) { console.log(`killing ${left.length} Chrome processes left on ${profile}`); try { execFileSync("kill", ["-9", ...left]); } catch { /* gone */ } }
  }
  if (keep) console.log(`frames: ${framesDir}`);
  else rmSync(root, { recursive: true, force: true });
});
