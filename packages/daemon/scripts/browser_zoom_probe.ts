/** Opt-in check of the page zoom against the real Google Chrome (docs/browser-v0.md §1 页面缩放, 2026-10-03, user:
 *  然后我发现agentswitch的浏览器页没有放大缩小的选项，加上 用来调节大小); not part of `npm test`. The service knows no
 *  zoom: the screen that holds a tab sets a smaller size to zoom in (a larger one to zoom out) and asks its stream for
 *  its device pixels times the zoom, up to 8 frame pixels per CSS pixel (3 before). This runs the shared browser as the
 *  daemon does (the user's installed Chrome, new headless, over the pipe) with everything in a temporary folder
 *  (AgentSwitch's home, the `main` profile, the user's home, the page), and drives it through the routes a screen calls,
 *  in this process: no port is opened, no model is called, the user's own Chrome profiles are never touched.
 *
 *    npx tsx scripts/browser_zoom_probe.ts [--keep] [--last] [--fit]   (--keep: leave the frames in the temporary folder;
 *                                                                      --last: only the last picture, below;
 *                                                                      --fit: only the page without a viewport tag)
 *
 *  `PROBE_DIR` puts the temporary folder elsewhere than the system's.
 *
 *  A 3x phone with 402×690 points of browser area on a 1206×2622 screen, from 100% to 200%, between quarters, and out.
 *  Its stream asks what the phone's does (the Kit's BrowserPageZoom.streamScale, on the local network): its 3 pixels a
 *  point times the zoom, 0.02 more where the page is zoomed and that is over 1 (the screen's pixels then settle the
 *  view), within the whole screen; at a step the size and the stream asked again go together, the stream before ends
 *  after.
 *    100%  the tab at 402×690, pixel ratio 3, the stream asking 3: frames 1206×2070 at scale 3.
 *    200%  the tab at 201×345, pixel ratio 4: that stream's frames are 603×1035 (what a service with the limit of 3
 *          gives); the stream asked again at 6.02: frames 1206×2070 at scale 6 of a 201×345 page that sees itself 201
 *          wide at 4 and no resize when its view is redrawn. A tap on a frame pixel lands on the button under it, also
 *          when it was aimed at a frame from before the view was redrawn; a drag scrolls by its CSS distance.
 *          While the view is being redrawn (a stream asking 6.02 comes to the one asking 3): a tap sent just after,
 *          and one sent just before, land where they were aimed; a stream that comes and goes at once leaves the view
 *          at 3.
 *    110%  the tab at 365×627, pixel ratio 3.3, the stream asked again at 3.32: the screen holds 3.304 of it, a view
 *          of 1205.96×2071.6, frames 1206×2072 that still say a 365×627 page, and a tap lands.
 *    125%  the tab at 322×552, the stream asked at 3.77: the screen holds 3.745 of it, frames 1206×2067; sharper than
 *          the frame at 3.5 that a view in quarter steps gave, stretched to the same pixels.
 *     25%  the tab at 1608×2760, pixel ratio 0.75, the stream asked again without a scale: frames 1206×2070 at scale
 *          0.75.
 *  A 2x Mac: at 400% the tab at 320×200, the stream asking more than the most (12): frames 2560×1600 at scale 8. At
 *  110% of a 990×721 area the tab at 900×655, the stream asking 2.2: frames 1980×1441, sharper than the frame at 2.
 *  A page that repaints all the time, through the phone's steps, in and out: every frame says a page size that was
 *  set (Chrome may first send what it captured of the view before a step). Then between two sizes whose views are the
 *  same 3840×2400 pixels: no frame that says the new page was sent by Chrome before that page was asked for.
 *  A page that does not follow the device's width (no viewport tag: Chrome lays it out 980 wide in a phone's layout
 *  and fits it to the screen), through the phone's steps: fitted at every one (2026-10-04; the driver enters the
 *  phone's layout at a new size by way of the desktop layout, without which 50% filled half the screen).
 *  How sharp: one frame against a smaller one of the same page stretched over the same pixels, as a screen stretches
 *  it: the mean squared difference between neighbouring pixels (a soft edge spreads its step over more pixels and
 *  scores less), and how many pixels a black bar's edge takes from white to black.
 *
 *  The last picture of a burst (§5 回执, 2026-10-03), which this script runs after the above, or alone with `--last`:
 *  a stream ends on the page as it is after a navigation, an animation or a scroll, at no cost in frames where the page
 *  keeps changing or is still, and a stream that takes over from another gets its frames from the first. The checks,
 *  their pages and what they measure are in scripts/browser_last_picture.ts. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Page } from "playwright-core";
import { mountBrowser } from "../src/api/browser.js";
import type { ApiDeps } from "../src/api/shared.js";
import { sharedBrowser } from "../src/browser/setup.js";
import type { FrameEvent, TabInfo } from "../src/browser/types.js";
import { defaultProtected } from "../src/executors/protected.js";
import { lastPages, lastPicture, type Probe, type Stream } from "./browser_last_picture.js";

const keep = process.argv.includes("--keep");
const onlyLast = process.argv.includes("--last");
const onlyFit = process.argv.includes("--fit");
const root = mkdtempSync(join(process.env.PROBE_DIR ?? tmpdir(), "agentswitch-zoom-"));
const home = join(root, "agentswitch-home");
const userHome = join(root, "user");
const framesDir = join(root, "frames");
for (const dir of [home, join(userHome, "site"), framesDir]) mkdirSync(dir, { recursive: true });

/** The phone's and the Mac's screen ids, their browser areas in points, and what their streams ask at every zoom: the
 *  phone its screen's 1206×2622 pixels, the Mac its display's. */
const PHONE = "phone-zoom";
const MAC = "mac-zoom";
const PHONE_AREA = { width: 402, height: 690 };
const MAC_AREA = { width: 990, height: 721 };
const PHONE_PIXELS = "quality=70&fps=15&maxWidth=1206&maxHeight=2622";
const MAC_PIXELS = "quality=80&fps=15&maxWidth=3024&maxHeight=1964";
/** What the phone's stream asks over its pixels a point times the zoom, where its bound is the screen's own pixels (the
 *  Kit's BrowserPageZoom.streamMargin). */
const PHONE_MARGIN = 0.02;
/** A picture counts as still once no frame has come for this long. */
const STILL_MS = 700;
/** A frame counts as sharper than a smaller one when its neighbouring pixels differ this many times more (squared, on
 *  average) than the smaller one's stretched to its size: a frame that was only a stretched picture itself would score
 *  about 1. */
const SHARPER = 1.25;
/** Taps sent around a redraw of the view, streams that come and go at once, and zoom steps of the repainting page. */
const TAPS = 24;
const VISITS = 12;
const STEPS = [100, 110, 125, 150, 175, 200, 150, 125, 90, 80, 67, 50, 100];
const ROUNDS = 3;
/** Steps between two sizes whose views are the same 3840×2400 pixels (1280×800 at 3, 1920×1200 at 2), and the stream
 *  that asks for them. */
const SAME_SIZE: readonly (readonly [number, number])[] = [[1280, 800], [1920, 1200]];
const SAME_SIZE_STREAM = "quality=70&fps=30&maxWidth=3840&maxHeight=2400&scale=3";
const SAME_SIZE_STEPS = 60;
/** A page as a phone-sized site: small text, a black bar with hard edges, two buttons that stay where they are, room to
 *  scroll. Its title says what it sees: its size, pixel ratio, scroll position, resizes, and where the last tap landed.
 *  `moving`: a dot that moves every animation frame, so the page repaints all the time. */
const pageOf = (moving: boolean): string => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Zoom</title>
<style>
  html, body { margin: 0; }
  body { font: 13px -apple-system, "PingFang SC", sans-serif; color: #1f2328; background: #fff; }
  #top { height: 110px; }
  p { margin: 0 8px 6px; }
  #bar { position: fixed; left: 20px; top: 40px; width: 30px; height: 60px; background: #000; }
  #dot { position: fixed; left: 0; top: 200px; width: 12px; height: 12px; background: #c00; }
  button { position: fixed; padding: 0; font: inherit; }
  #b { left: 60px; top: 120px; width: 80px; height: 40px; }
  #c { left: 150px; top: 290px; width: 45px; height: 40px; }
  #tall { height: 6000px; }
</style></head><body>
<div id="top"></div><div id="bar"></div>${moving ? `<div id="dot"></div>` : ""}<button id="b">Go</button><button id="c">Up</button>
<p>The quick brown fox jumps over the lazy dog. 天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。 0123456789</p>
<p style="font-size:11px">${"Eleven pixel text, the kind a status line or a table cell has. 十一像素的文字。 ".repeat(4)}</p>
<p>${"Paragraph text at thirteen pixels wraps across the column and fills it. 段落文字在十三像素下换行。 ".repeat(3)}</p>
<div id="tall"></div>
<script>
  const seen = { resizes: 0, taps: 0, hit: "-", at: "-" };
  const say = () => { document.title = "w=" + innerWidth + " h=" + innerHeight + " dpr=" + devicePixelRatio + " y=" + Math.round(scrollY)
    + " resizes=" + seen.resizes + " hit=" + seen.hit + " at=" + seen.at; };
  addEventListener("resize", () => { seen.resizes++; say(); });
  addEventListener("scroll", say);
  addEventListener("pointerdown", (e) => { seen.at = e.clientX + "," + e.clientY; }, true);
  addEventListener("click", (e) => { seen.hit = (e.target.id || e.target.tagName.toLowerCase()) + ":" + (++seen.taps); say(); }, true);
  say();
  ${moving ? `let x = 0; const move = () => { x = (x + 2) % 150; document.getElementById("dot").style.left = x + "px"; requestAnimationFrame(move); }; requestAnimationFrame(move);` : ""}
</script></body></html>`;

/** Run in a blank tab on `{sharp, soft, edge}`: two JPEGs (base64) of the same page, the second smaller, and where a
 *  hard edge crosses a row (fractions of the picture). Both are drawn at the first one's size, the smaller stretched
 *  with bilinear smoothing as a screen does. Script text, not a function: tsx's helpers are not in the page. */
const MEASURE = `async (input) => {
  const picture = (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/jpeg" }));
  const luma = (image, w, h) => {
    const g = new OffscreenCanvas(w, h).getContext("2d");
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "low";
    g.drawImage(image, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2];
    return out;
  };
  const acutance = (l, w, h) => {
    let sum = 0;
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const i = y * w + x, dx = l[i + 1] - l[i], dy = l[i + w] - l[i];
      sum += dx * dx + dy * dy;
    }
    return sum / ((w - 1) * (h - 1));
  };
  const between = (l, w, row, from, to) => {
    let n = 0;
    for (let x = from; x < to; x++) { const v = l[row * w + x]; if (v > 25.5 && v < 229.5) n++; }
    return n;
  };
  const sharp = await picture(input.sharp), soft = await picture(input.soft);
  const w = sharp.width, h = sharp.height;
  const a = luma(sharp, w, h), b = luma(soft, w, h);
  let apart = 0;
  for (let i = 0; i < a.length; i++) apart += Math.abs(a[i] - b[i]);
  const row = Math.round(input.edge.y * h), from = Math.round(input.edge.from * w), to = Math.round(input.edge.to * w);
  return { width: w, height: h, sharp: acutance(a, w, h), soft: acutance(b, w, h), edgeSharp: between(a, w, row, from, to),
    edgeSoft: between(b, w, row, from, to), apart: apart / a.length };
}`;
type Sharpness = { width: number; height: number; sharp: number; soft: number; edgeSharp: number; edgeSoft: number; apart: number };

const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kb = (frame: FrameEvent) => Math.round(Buffer.from(frame.data, "base64").length / 1024);
const size = (f: FrameEvent | null) => (f ? `${f.width}x${f.height} at scale ${f.scale}, viewport ${f.viewport.width}x${f.viewport.height}, ${kb(f)} KB` : "no frame");
/** A frame of a `width`×`height` picture with `scale` frame pixels per CSS pixel. */
const is = (f: FrameEvent | null, width: number, height: number, scale: number): f is FrameEvent => !!f && f.width === width && f.height === height && f.scale === scale;

async function until<T>(get: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(50);
  }
}

const api = sharedBrowser({ home, userHome, protected: defaultProtected({ ...process.env, HOME: userHome, AGENTSWITCH_HOME: home }), ownPorts: () => [] });
const app = new Hono();
mountBrowser(app, { browser: api } as unknown as ApiDeps);

/** One of the screens' routes, as a screen calls it. */
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

/** A screen's stream of a tab (the route's SSE): its frames as they come, until `stop`. */
async function watch(tab: string, query: string): Promise<Stream> {
  const res = await app.request(`/browser/tabs/${tab}/stream?${query}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: FrameEvent[] = [];
  const cameAt: number[] = [];
  const reading = (async () => {
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
      const blocks = text.split("\n\n");
      text = blocks.pop()!;
      for (const block of blocks) {
        if (!block.startsWith("event: frame\n")) continue;
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        frames.push(JSON.parse(data.slice(6)) as FrameEvent);
        cameAt.push(Date.now());
      }
    }
  })().catch(() => undefined);
  return { frames, cameAt, stop: async () => { await reader.cancel().catch(() => undefined); await reading; } };
}

/** What became of a stream after `since`: how long the first frame `wanted` took, whether every frame from it on was
 *  one, and the latest frame once the picture has been still for a moment (Chrome may send a frame of a redrawn view
 *  before its tiles are all drawn at the new scale). */
async function settled(stream: Stream, since: number, wanted: (f: FrameEvent) => boolean): Promise<{ frame: FrameEvent | null; ms: number | null; steady: boolean }> {
  const first = await until(async () => { const i = stream.frames.findIndex(wanted); return i >= 0 ? { i } : null; });
  if (!first) return { frame: stream.frames.at(-1) ?? null, ms: null, steady: false };
  let count = -1;
  while (count !== stream.frames.length) { count = stream.frames.length; await sleep(STILL_MS); }
  return { frame: stream.frames.at(-1) ?? null, ms: stream.cameAt[first.i]! - since, steady: stream.frames.slice(first.i).every(wanted) };
}

type Seen = { w: number; h: number; dpr: number; y: number; resizes: number; hit: string; at: [number, number] | null };

/** What the page says it sees (its title, as the host reads it). */
async function page(tab: string): Promise<Seen | null> {
  const title = ((await call("GET", `/browser/tabs/${tab}`)).json.tab as TabInfo | undefined)?.title ?? "";
  const m = /^w=(\d+) h=(\d+) dpr=([\d.]+) y=(-?\d+) resizes=(\d+) hit=(\S+) at=(\S+)$/.exec(title);
  if (!m) return null;
  const at = m[7]!.split(",").map(Number);
  return { w: Number(m[1]), h: Number(m[2]), dpr: Number(m[3]), y: Number(m[4]), resizes: Number(m[5]), hit: m[6]!, at: at.length === 2 ? [at[0]!, at[1]!] : null };
}

const says = (s: Seen | null) => (s ? `${s.w}x${s.h} at ${s.dpr}, scrolled ${s.y}, ${s.resizes} resizes, last tap ${s.hit} at ${s.at?.join(",") ?? "-"}` : "nothing");
/** The page's own size and pixel ratio (Chrome keeps the ratio as a single-precision number: 3.3 reads 3.2999999523). */
const sees = (s: Seen | null, w: number, h: number, dpr: number) => !!s && s.w === w && s.h === h && Math.abs(s.dpr - dpr) < 0.001;
const input = (tab: string, screen: string, events: object[]) => call("POST", `/browser/tabs/${tab}/input`, { screen, events });
const resize = (tab: string, screen: string, width: number, height: number, scale: number, mobile: boolean) =>
  call("POST", `/browser/tabs/${tab}/viewport`, { width, height, scale, mobile, screen });
const save = (name: string, frame: FrameEvent | null) => { if (frame) writeFileSync(join(framesDir, `${name}.jpg`), Buffer.from(frame.data, "base64")); };

/** A tap at frame pixel (x, y), on frame `seq` when given, lands on `button` at CSS (cssX, cssY) within half a pixel. */
async function lands(tab: string, screen: string, what: string, at: { x: number; y: number; seq?: number }, button: string, cssX: number, cssY: number): Promise<void> {
  const before = await page(tab);
  const sent = await input(tab, screen, [{ type: "mouse", action: "click", ...at }]);
  const after = await until(async () => { const s = await page(tab); return s && s.hit !== before?.hit ? s : null; });
  const ok = sent.status === 200 && !!after?.at && after.hit.startsWith(`${button}:`) && Math.abs(after.at[0] - cssX) <= 0.5 && Math.abs(after.at[1] - cssY) <= 0.5;
  const said = after ? `${after.hit} at ${after.at?.join(",")}` : `no tap (status ${sent.status})`;
  check(ok, `${what}: sent at frame (${at.x}, ${at.y}), wanted on #${button} at CSS (${cssX}, ${cssY}); the page says ${said}`);
}

/** A wheel of `delta` frame pixels scrolls the page by `css` CSS pixels. */
async function scrolls(tab: string, screen: string, what: string, at: { x: number; y: number }, delta: number, css: number): Promise<void> {
  const from = (await page(tab))?.y ?? 0;
  await input(tab, screen, [{ type: "wheel", ...at, deltaY: delta }]);
  const done = await until(async () => { const s = await page(tab); return s && s.y === from + css ? s : null; }, 8_000);
  check(!!done, `${what}: a wheel of ${delta} frame pixels scrolls ${css} CSS pixels (from ${from} to ${(await page(tab))?.y})`);
}

/** What a screen sets and asks at a zoom of `percent` (browser-v0 §1 页面缩放): the page's size (its browser area over
 *  the zoom), the page's pixel ratio (the screen's times the zoom, to the hundredth, within the route's 0.5 to 4) and
 *  the scale its stream asks: the screen's pixels per point times the zoom at every step, never under 1, at most 8.
 *  `margin`: the phone's little more where the page is zoomed and the product is over 1, to the hundredth. */
function zoomStep(area: { width: number; height: number }, perPoint: number, percent: number, margin = 0): { width: number; height: number; ratio: number; ask: number } {
  const factor = percent / 100;
  const product = perPoint * factor;
  const asked = margin > 0 && factor !== 1 && product > 1 ? Math.round((product + margin) * 100) / 100 : product;
  return {
    width: Math.round(area.width / factor), height: Math.round(area.height / factor),
    ratio: Math.min(4, Math.max(0.5, Math.round(product * 100) / 100)), ask: Math.min(8, Math.max(1, asked)),
  };
}

/** A stream's query for `pixels` at a step: the scale is said only where it is over 1, as the screens do. */
const asking = (pixels: string, ask: number): string => (ask > 1 ? `${pixels}&scale=${ask}` : pixels);

/** The phone at 200%: the tab at 201×345, pixel ratio 4, its stream asking 6.02. */
const AT_200 = zoomStep(PHONE_AREA, 3, 200, PHONE_MARGIN);

/** A product as a screen sends it (3 × 1.1 is 3.3000000000000003), for a line of the report. */
const short = (n: number): number => Math.round(n * 1000) / 1000;

/** A page drawn twice, for the sharpness: `sharp` at the screen's pixels, `soft` with fewer; `page`: its CSS size. */
type Pair = { readonly what: string; readonly sharp: FrameEvent | null; readonly soft: FrameEvent | null; readonly page: { readonly width: number; readonly height: number } };

/** The phone from 100% to 200%, between quarters, then 25%. Answers the 200% page at 6 and at 3 and the 125% page at
 *  3.745 and at 3.5, for the sharpness. */
async function phone(tab: string): Promise<Pair[]> {
  await call("POST", `/browser/tabs/${tab}/take`, { screen: PHONE });
  await resize(tab, PHONE, 402, 690, 3, true);
  let since = Date.now();
  const old = await watch(tab, `${PHONE_PIXELS}&scale=3`);
  const whole = await settled(old, since, (f) => is(f, 1206, 2070, 3));
  check(is(whole.frame, 1206, 2070, 3), `100%, the stream asking 3: frames 1206x2070 at scale 3 (${size(whole.frame)})`);
  // 200%: the size first. That stream still asks 3, the most there was before.
  since = Date.now();
  const sized = await resize(tab, PHONE, 201, 345, 4, true);
  const half = await settled(old, since, (f) => is(f, 603, 1035, 3));
  check(sized.status === 200 && is(half.frame, 603, 1035, 3) && half.steady,
    `200%, the tab at 201x345 and that stream: frames 603x1035 at scale 3, ${half.ms} ms after the size was set (${size(half.frame)})`);
  await redrawn(tab, old);
  const early = old.frames.at(-1) ?? null;
  const before = await page(tab);
  // Then the stream asked again at the phone's pixels times the zoom, and its little more.
  since = Date.now();
  const stream = await watch(tab, asking(PHONE_PIXELS, AT_200.ask));
  const full = await settled(stream, since, (f) => is(f, 1206, 2070, 6));
  check(is(full.frame, 1206, 2070, 6) && full.frame.viewport.width === 201 && full.frame.viewport.height === 345 && full.steady,
    `200%, the stream asking ${AT_200.ask}: frames 1206x2070 at scale 6 of a 201x345 page, ${full.ms} ms after it was asked (${size(full.frame)})`);
  const now = await page(tab);
  check(sees(now, 201, 345, 4), `the page sees itself 201x345 at pixel ratio 4 (${says(now)})`);
  check(!!now && !!before && now.resizes === before.resizes, `and no resize when its view was redrawn from 3 to 6 (${before?.resizes} before, ${now?.resizes} after)`);
  save("200-at-3", half.frame);
  save("200-at-6", full.frame);
  await driven(tab, is(early, 603, 1035, 3) ? early : null);
  await old.stop();
  const between = await betweenQuarters(tab, stream);
  await (await zoomedOut(tab, between.stream)).stop();
  return [{ what: "200% at 6 against 3", sharp: full.frame, soft: half.frame, page: { width: 201, height: 345 } }, between.pair];
}

/** While the view is being redrawn. The tab is at 201×345 and `base` asks 3; a stream asking the phone's 6.02 comes,
 *  so the view goes from 3 to 6, and leaves again. A tap at CSS (100, 140) on the latest frame is sent a few
 *  milliseconds after that stream came, or just before it (Chrome has the new scale before the service has recorded it,
 *  and a click is three calls). Then such a stream comes and leaves at once, within the redraw it caused: the view must
 *  be left at 3. */
async function redrawn(tab: string, base: Stream): Promise<void> {
  const missed: string[] = [];
  for (let i = 0; i < TAPS; i++) {
    const tapFirst = i % 2 === 1;
    const was = await page(tab);
    const frame = base.frames.at(-1)!;
    const tap = [{ type: "mouse", action: "click", x: 100 * frame.scale, y: 140 * frame.scale, seq: frame.seq }];
    const sent = tapFirst ? input(tab, PHONE, tap) : null;
    if (tapFirst) await sleep(i % 3);
    const more = await watch(tab, asking(PHONE_PIXELS, AT_200.ask));
    if (!tapFirst) await sleep(i % 8);
    await (sent ?? input(tab, PHONE, tap));
    const now = await until(async () => { const s = await page(tab); return s && s.hit !== was?.hit ? s : null; }, 4_000);
    const landed = !!now?.at && now.hit.startsWith("b:") && Math.abs(now.at[0] - 100) <= 0.5 && Math.abs(now.at[1] - 140) <= 0.5;
    if (!landed) missed.push(`${tapFirst ? "before" : "after"} it: ${now ? `${now.hit} at ${now.at?.join(",")}` : "no tap"}`);
    await more.stop();
    await sleep(250);
  }
  check(missed.length === 0, `${TAPS} taps at CSS (100, 140) sent within a few milliseconds of a stream asking ${AT_200.ask} coming to the view at 3, half just after it, half just before: `
    + `${TAPS - missed.length} landed there${missed.length ? ` (${missed.slice(0, 4).join("; ")})` : ""}`);
  let left = 0;
  for (let i = 0; i < VISITS; i++) {
    const more = await watch(tab, asking(PHONE_PIXELS, AT_200.ask));
    await sleep(i % 4);
    await more.stop();
    await sleep(400);
    if (!is(base.frames.at(-1) ?? null, 603, 1035, 3)) left += 1;
  }
  check(left === 0, `${VISITS} streams asking ${AT_200.ask} that came and left within 0 to 3 ms: the view was left at another scale than 3 after ${left} of them `
    + `(the stream asking 3 has ${size(base.frames.at(-1) ?? null)})`);
}

/** Taps and drags on the 200% page at 6. #b is CSS (60..140, 120..160), #c (150..195, 290..330). */
async function driven(tab: string, early: FrameEvent | null): Promise<void> {
  if (early) await lands(tab, PHONE, "a tap aimed at a frame from before the view was redrawn (3 then, 6 now)", { x: 300, y: 420, seq: early.seq }, "b", 100, 140);
  else check(false, "a tap aimed at a frame from before the view was redrawn: no frame at 3 to aim at");
  await lands(tab, PHONE, "a tap on a frame at 6", { x: 603, y: 840 }, "b", 100.5, 140);
  await lands(tab, PHONE, "a tap near the far corner of a frame at 6", { x: 1035, y: 1860 }, "c", 172.5, 310);
  await scrolls(tab, PHONE, "at 6", { x: 603, y: 1035 }, 600, 100);
  await scrolls(tab, PHONE, "and back", { x: 603, y: 1035 }, -300, -50);
}

/** A zoom step as the phone takes it: the size and its stream asked again for the new zoom go together, and the stream
 *  before ends once the new one is there. Answers the new stream and what the size was answered. */
async function phoneStep(tab: string, running: Stream | undefined, percent: number, pixels = PHONE_PIXELS): Promise<{ stream: Stream; status: number }> {
  const s = zoomStep(PHONE_AREA, 3, percent, PHONE_MARGIN);
  const [sized, stream] = await Promise.all([resize(tab, PHONE, s.width, s.height, s.ratio, true), watch(tab, asking(pixels, s.ask))]);
  await running?.stop();
  return { stream, status: sized.status };
}

/** Such a step, with its frames and what the page sees checked; answers the new stream and the frame it settled on. */
async function stepTo(tab: string, running: Stream, percent: number, width: number, height: number, scale: number): Promise<{ stream: Stream; frame: FrameEvent | null }> {
  const s = zoomStep(PHONE_AREA, 3, percent, PHONE_MARGIN);
  const since = Date.now();
  const { stream, status } = await phoneStep(tab, running, percent);
  const got = await settled(stream, since, (f) => is(f, width, height, scale));
  check(status === 200 && is(got.frame, width, height, scale) && got.frame.viewport.width === s.width && got.frame.viewport.height === s.height && got.steady,
    `${percent}%, the tab at ${s.width}x${s.height} and the stream asked again ${s.ask > 1 ? `at ${short(s.ask)}` : "without a scale"}: frames ${width}x${height} at scale ${scale} (${size(got.frame)})`);
  const now = await page(tab);
  check(sees(now, s.width, s.height, s.ratio), `the page sees itself ${s.width}x${s.height} at pixel ratio ${short(s.ratio)} (${says(now)})`);
  save(`${percent}-at-${scale}`, got.frame);
  return { stream, frame: got.frame };
}

/** 110% and 125%: steps between quarters, where the view went in quarter steps before (3.25 and 3.5, each stretched to
 *  the screen). Answers the stream left running (it asks 3.5) and the 125% page at 3.745 and at 3.5. */
async function betweenQuarters(tab: string, running: Stream): Promise<{ stream: Stream; pair: Pair }> {
  // 110%: the screen holds 1206 / 365 = 3.304 of the page, less than the 3.32 asked: a view of 1205.96×2071.6, the
  // screen's width to the pixel (at 3.3 itself it was 1205 wide).
  const at110 = await stepTo(tab, running, 110, 1206, 2072, 3.304);
  await lands(tab, PHONE, "a tap on a frame at 3.304", { x: 330.4, y: 462.56 }, "b", 100, 140);
  await lands(tab, PHONE, "a tap near the far corner of a frame at 3.304", { x: 570, y: 1023 }, "c", 172.52, 309.62);
  await scrolls(tab, PHONE, "at 3.304", { x: 600, y: 1000 }, 330.4, 100);
  // 125%: 402 / 1.25 rounds up to 322, and the screen holds 1206 / 322 = 3.745 of that, not the 3.77 asked.
  const at125 = await stepTo(tab, at110.stream, 125, 1206, 2067, 3.745);
  await lands(tab, PHONE, "a tap on a frame at 3.745", { x: 374.5, y: 524.3 }, "b", 100, 140);
  // What a view in quarter steps gave of the same page: 3.5.
  const since = Date.now();
  const quarter = await watch(tab, `${PHONE_PIXELS}&scale=3.5`);
  await at125.stream.stop();
  const soft = await settled(quarter, since, (f) => is(f, 1127, 1932, 3.5));
  check(is(soft.frame, 1127, 1932, 3.5), `125% with only a stream asking 3.5: frames 1127x1932 at scale 3.5, what quarter steps drew (${size(soft.frame)})`);
  return { stream: quarter, pair: { what: "a phone's 125% at 3.745 against 3.5", sharp: at125.frame, soft: soft.frame, page: { width: 322, height: 552 } } };
}

/** 25%: the page four times the size. Three pixels a point times a quarter is under 1: the stream asks no scale, the
 *  view is the CSS size, and the screencast makes the frame as small as the screen. Answers the stream left running. */
async function zoomedOut(tab: string, running: Stream): Promise<Stream> {
  const { stream } = await stepTo(tab, running, 25, 1206, 2070, 0.75);
  await lands(tab, PHONE, "a tap on a frame at 0.75", { x: 75, y: 105 }, "b", 100, 140);
  await scrolls(tab, PHONE, "at 0.75", { x: 600, y: 1000 }, 300, 400);
  return stream;
}

/** A 2x Mac, which takes the tab from the phone, so its size starts from the default. At 400% of a 1280×800 area, the
 *  most; then at 110% of a 990×721 area, a step between quarters (the first ⌘+). Answers the 110% page at 2.2 and at
 *  2, which is what quarter steps drew. */
async function mac(tab: string): Promise<Pair> {
  await call("POST", `/browser/tabs/${tab}/take`, { screen: MAC });
  const sized = await resize(tab, MAC, 320, 200, 4, false);
  let since = Date.now();
  const asking12 = await watch(tab, `${MAC_PIXELS}&scale=12`);
  const most = await settled(asking12, since, (f) => is(f, 2560, 1600, 8));
  check(sized.status === 200 && is(most.frame, 2560, 1600, 8) && most.frame.viewport.width === 320 && most.frame.viewport.height === 200 && most.steady,
    `a Mac at 400%, the stream asking 12: frames 2560x1600 at scale 8 of a 320x200 page (${size(most.frame)})`);
  let now = await page(tab);
  check(sees(now, 320, 200, 4), `the page sees itself 320x200 at pixel ratio 4 (${says(now)})`);
  save("mac-400-at-8", most.frame);
  await lands(tab, MAC, "a tap on a frame at 8", { x: 804, y: 1120 }, "b", 100.5, 140);
  await scrolls(tab, MAC, "at 8", { x: 804, y: 800 }, 160, 20);
  // Back to the top of the page, where its text is, for the sharpness of the next step.
  await input(tab, MAC, [{ type: "wheel", x: 804, y: 800, deltaY: -100_000 }]);
  await until(async () => (await page(tab))?.y === 0, 8_000);
  const s = zoomStep(MAC_AREA, 2, 110);
  const resized = await resize(tab, MAC, s.width, s.height, s.ratio, false);
  since = Date.now();
  const asking = await watch(tab, `${MAC_PIXELS}&scale=${s.ask}`);
  await asking12.stop();
  const sharp = await settled(asking, since, (f) => is(f, 1980, 1441, 2.2));
  check(resized.status === 200 && is(sharp.frame, 1980, 1441, 2.2) && sharp.frame.viewport.width === 900 && sharp.frame.viewport.height === 655 && sharp.steady,
    `a Mac at 110%, the tab at ${s.width}x${s.height} and the stream asking ${short(s.ask)}: frames 1980x1441 at scale 2.2 (${size(sharp.frame)})`);
  now = await page(tab);
  check(sees(now, 900, 655, 2.2), `the page sees itself 900x655 at pixel ratio 2.2 (${says(now)})`);
  save("mac-110-at-2.2", sharp.frame);
  await lands(tab, MAC, "a tap on a frame at 2.2", { x: 220, y: 308 }, "b", 100, 140);
  since = Date.now();
  const asking2 = await watch(tab, `${MAC_PIXELS}&scale=2`);
  await asking.stop();
  const soft = await settled(asking2, since, (f) => is(f, 1800, 1310, 2));
  check(is(soft.frame, 1800, 1310, 2), `110% with only a stream asking 2: frames 1800x1310 at scale 2, what quarter steps drew (${size(soft.frame)})`);
  await asking2.stop();
  return { what: "a Mac's 110% at 2.2 against 2", sharp: sharp.frame, soft: soft.frame, page: { width: 900, height: 655 } };
}

/** A page that repaints all the time, through the phone's zoom steps, each taken as the phone takes it. Chrome may
 *  first send what it captured of the view before a step, which the service holds back: every frame that reaches a
 *  stream must say a page size that was set. */
async function repainting(): Promise<void> {
  const opened = await call("POST", "/browser/tabs", { path: "~/site/moving.html" });
  const tab = (opened.json.tab as TabInfo | undefined)?.id;
  if (!tab || !await until(() => page(tab))) { check(false, `the repainting page opens (status ${opened.status})`); return; }
  await call("POST", `/browser/tabs/${tab}/take`, { screen: PHONE });
  // When Chrome sent each frame, by its picture; the same picture comes again on a page that moves in a loop.
  const sent: Sent[] = [];
  api.host.page(tab)?.on("frame", (f) => sent.push({ print: print(f.data), stamp: f.metadata.timestamp, at: Date.now() }));
  const pixels = PHONE_PIXELS.replace("fps=15", "fps=30");
  const set = new Set(["1280x800"]);
  const streams: Stream[] = [];
  for (let i = 0; i < STEPS.length * ROUNDS; i++) {
    const s = zoomStep(PHONE_AREA, 3, STEPS[i % STEPS.length]!, PHONE_MARGIN);
    set.add(`${s.width}x${s.height}`);
    streams.push((await phoneStep(tab, streams.at(-1), STEPS[i % STEPS.length]!, pixels)).stream);
    await sleep(160);
  }
  const frames = streams.flatMap((s) => s.frames);
  const never = frames.filter((f) => !set.has(`${f.viewport.width}x${f.viewport.height}`));
  check(frames.length > 0 && never.length === 0, `a page that repaints all the time, ${STEPS.length * ROUNDS} zoom steps in and out, the stream asked again at each: `
    + `${frames.length} frames reached the streams, ${never.length} said a page size that was never set${never[0] ? ` (${size(never[0])})` : ""}`);
  await sameSize(tab, streams.at(-1)!, sent);
}

/** A page made for a desktop: no viewport tag, so in a phone's layout Chrome lays it out 980 wide and fits it to the
 *  screen. Its title says the layout's width, the width in view and the page's scale. */
const DESK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Desk</title><style>html, body { margin: 0; } #tall { height: 4000px; }</style></head><body>
<div style="height:40px;background:#ccc"></div><p>A page made for a desktop: no viewport tag.</p><div id="tall"></div>
<script>
  const say = () => { document.title = "layout=" + document.documentElement.clientWidth + " shown=" + Math.round(visualViewport.width)
    + " scale=" + (Math.round(visualViewport.scale * 1000) / 1000); };
  addEventListener("resize", say); visualViewport.addEventListener("resize", say); setInterval(say, 100); say();
</script></body></html>`;
const FIT_STEPS = [100, 50, 100, 200, 100, 33, 90, 100];

/** The phone's steps on such a page (browser-v0 §1 页面缩放, 2026-10-04): at every size it is fitted to the screen —
 *  the whole layout's width in view, or Chrome's least scale (0.25) where the screen is narrower than a quarter of
 *  it. Closes the tab. */
async function fitted(): Promise<void> {
  const opened = await call("POST", "/browser/tabs", { path: "~/site/desk.html" });
  const tab = (opened.json.tab as TabInfo | undefined)?.id;
  const said = async (): Promise<{ layout: number; shown: number; scale: number } | null> => {
    const title = ((await call("GET", `/browser/tabs/${tab}`)).json.tab as TabInfo | undefined)?.title ?? "";
    const m = /^layout=(\d+) shown=(\d+) scale=([\d.]+)$/.exec(title);
    return m ? { layout: Number(m[1]), shown: Number(m[2]), scale: Number(m[3]) } : null;
  };
  if (!tab || !await until(said)) { check(false, `the page without a viewport tag opens (status ${opened.status})`); return; }
  await call("POST", `/browser/tabs/${tab}/take`, { screen: PHONE });
  const fits = (s: { layout: number; shown: number; scale: number }) => Math.abs(s.shown - s.layout) <= 1 || s.scale === 0.25;
  let stream: Stream | undefined;
  const wrong: number[] = [], seen: string[] = [];
  for (const percent of FIT_STEPS) {
    const step = zoomStep(PHONE_AREA, 3, percent, PHONE_MARGIN);
    const stepped = await phoneStep(tab, stream, percent);
    stream = stepped.stream;
    // In a phone's layout a page like this is laid out 980 wide, or as wide as the tab where that is more. The title
    // is read a moment late: what it says is of this step once the width in view times the scale is the tab's width.
    const wide = Math.max(980, step.width);
    const ofStep = (s: { shown: number; scale: number }) => Math.abs(s.shown * s.scale - step.width) <= 2;
    const got = await until(async () => { const s = await said(); return s && ofStep(s) && s.layout === wide && fits(s) ? s : null; }, 4000)
      ?? await until(async () => { const s = await said(); return s && ofStep(s) ? s : null; }, 2000) ?? await said();
    seen.push(`${percent}% ${got ? `${got.layout} wide at ${got.scale}, ${got.shown} in view` : "nothing"}${stepped.status === 200 ? "" : ` (size refused: ${stepped.status})`}`);
    if (stepped.status !== 200 || !got || !ofStep(got) || got.layout !== wide || !fits(got)) wrong.push(percent);
  }
  await stream?.stop();
  check(wrong.length === 0, `a page without a viewport tag through the phone's steps: fitted to the screen at each (${seen.join("; ")})`);
  await call("DELETE", `/browser/tabs/${tab}`);
}

/** A frame as Chrome sent it: its picture's print, Chrome's stamp of when it sent it (seconds), and when it came. */
type Sent = { readonly print: string; readonly stamp: number | undefined; readonly at: number };
const print = (data: string): string => createHash("sha1").update(data).digest("base64");

/** The repainting page between two sizes whose views are the same in pixels, where a capture of the view before a step
 *  cannot be told by its size: Chrome stamps a frame when it sends it, and no frame that says the new page may have
 *  been sent before that page was asked for. The views are the largest there are, whose frames take longest to come
 *  (a phone's 90% and 80% are both 1206×2069 too: there such a frame was rare, 9 over 60 steps in the review and none
 *  over 120 here). What Chrome captures of the new view before the page is laid out for it says the new page too, and
 *  shows the one before: nothing tells those (about one a step at 30 frames a second). `sent`: the tab's frames as
 *  Chrome sends them. Ends `running` and closes the tab. */
async function sameSize(tab: string, running: Stream, sent: readonly Sent[]): Promise<void> {
  const stream = await watch(tab, SAME_SIZE_STREAM);
  await running.stop();
  const asked: { at: number; says: string }[] = [];
  for (let i = 0; i < SAME_SIZE_STEPS; i++) {
    const [width, height] = SAME_SIZE[i % 2]!;
    asked.push({ at: Date.now(), says: `${width}x${height}` });
    await resize(tab, PHONE, width, height, 2, false);
    await sleep(250);
  }
  // The tab is closed, or it would go on repainting while the last picture's cost is measured; before its stream is
  // ended, which would have the view of a closing tab redrawn.
  await call("DELETE", `/browser/tabs/${tab}`);
  await stream.stop();
  // A frame came after step `i` was asked and before the next: where it says that step's page, Chrome sent it after
  // the step was asked.
  let unstamped = 0;
  const early: number[] = [];
  stream.frames.forEach((f, n) => {
    const step = asked.findLast((a) => a.at <= stream.cameAt[n]!);
    const key = print(f.data);
    const stamp = sent.findLast((r) => r.print === key && r.at <= stream.cameAt[n]!)?.stamp;
    if (stamp === undefined) unstamped += 1;
    else if (step && `${f.viewport.width}x${f.viewport.height}` === step.says && stamp * 1000 < step.at) early.push(Math.round(step.at - stamp * 1000));
  });
  check(stream.frames.length > 0 && unstamped === 0 && early.length === 0, `${SAME_SIZE_STEPS} steps between ${SAME_SIZE.map(([w, h]) => `${w}x${h}`).join(" and ")}, whose views are both 3840x2400: `
    + `${stream.frames.length} frames reached the stream, ${early.length} of them said the new page and were sent by Chrome before it was asked for`
    + `${early.length ? ` (${Math.min(...early)} to ${Math.max(...early)} ms before)` : ""}${unstamped ? `; ${unstamped} had no stamp of Chrome's` : ""}`);
}

/** A blank tab's page, to look at pictures in. */
async function blankTab(): Promise<Page | undefined> {
  const blank = ((await call("POST", "/browser/tabs", { url: "about:blank" })).json.tab as TabInfo | undefined)?.id;
  return blank ? api.host.page(blank)?.playwright?.() as Page | undefined : undefined;
}

/** `pair.sharp` against `pair.soft` stretched over the same pixels, measured in `measuring` (a blank tab). */
async function sharper(measuring: Page, pair: Pair): Promise<void> {
  const { what, sharp, soft } = pair;
  if (!sharp || !soft) { check(false, `${what}: sharpness could not be measured: a frame is missing`); return; }
  // The bar's left edge is at CSS x 20, crossed at CSS y 70; looked at from x 14 to 26.
  const arg = { sharp: sharp.data, soft: soft.data, edge: { y: 70 / pair.page.height, from: 14 / pair.page.width, to: 26 / pair.page.width } };
  const m = await measuring.evaluate(`(${MEASURE})(${JSON.stringify(arg)})`) as Sharpness;
  const ratio = m.soft > 0 ? m.sharp / m.soft : 0;
  check(ratio >= SHARPER && m.edgeSharp <= m.edgeSoft,
    `${what}, on the same ${m.width}x${m.height} pixels: mean squared neighbour difference ${m.sharp.toFixed(1)} against ${m.soft.toFixed(1)} `
    + `(${ratio.toFixed(2)} times); the bar's edge takes ${m.edgeSharp} pixels from white to black against ${m.edgeSoft}; `
    + `the two pictures are ${m.apart.toFixed(2)} of 255 apart on average; JPEG ${kb(sharp)} KB against ${kb(soft)} KB`);
}

async function main(): Promise<void> {
  writeFileSync(join(userHome, "site", "zoom.html"), pageOf(false));
  writeFileSync(join(userHome, "site", "moving.html"), pageOf(true));
  for (const [name, html] of Object.entries(lastPages)) writeFileSync(join(userHome, "site", name), html);
  writeFileSync(join(userHome, "site", "desk.html"), DESK_PAGE);
  const probe: Probe = { call, watch, check, page: (id) => api.host.page(id), chromePids };
  if (onlyLast) {
    const looking = await blankTab();
    if (looking) await lastPicture(probe, looking);
    else check(false, "the last picture could not be looked at: no blank tab to look in");
    return;
  }
  if (onlyFit) { await fitted(); return; }
  const opened = await call("POST", "/browser/tabs", { path: "~/site/zoom.html" });
  const tab = (opened.json.tab as TabInfo | undefined)?.id;
  check(opened.status === 201 && !!tab, `the page opens as the user's tab (status ${opened.status})`);
  if (!tab) return;
  const loaded = await until(() => page(tab));
  check(sees(loaded, 1280, 800, 1), `it loads at the default size (${says(loaded)})`);
  const pairs = [...await phone(tab), await mac(tab)];
  await repainting();
  await fitted();
  const measuring = await blankTab();
  if (!measuring) { check(false, "sharpness could not be measured, nor the last picture looked at: no blank tab to measure in"); return; }
  for (const pair of pairs) await sharper(measuring, pair);
  await lastPicture(probe, measuring);
}

/** The Chrome processes of this run's profile, by its command line. */
function chromePids(): string[] {
  try { return execFileSync("pgrep", ["-f", "--", `--user-data-dir=${join(home, "browser-profiles", "main")}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean); }
  catch { return []; }
}

main().catch((err) => { failures.push(String(err)); console.error(err); }).finally(async () => {
  await api.agents.shutdown().catch(() => undefined);
  await api.host.shutdown().catch(() => undefined);
  await sleep(500);
  // Only this run's Chrome: the one on the profile in the temporary folder.
  const left = chromePids();
  check(left.length === 0, `Chrome quits on shutdown (${left.length} processes left on this run's profile)`);
  if (left.length) { try { execFileSync("kill", ["-9", ...left]); } catch { /* gone */ } }
  if (keep) console.log(`frames: ${framesDir}`);
  else rmSync(root, { recursive: true, force: true });
  console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
  process.exit(failures.length ? 1 : 0);
});
