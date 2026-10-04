/** The last picture of a burst, checked against the real Google Chrome (docs/browser-v0.md §5 回执, 2026-10-03). Not a
 *  script of its own: scripts/browser_zoom_probe.ts runs it after its own checks, or alone with `--last`, and gives it
 *  its routes, its streams and its checks (`Probe`).
 *
 *  Chrome sends nothing it captures while three frames wait for their acknowledgement, and does not send that capture
 *  later; the service paces its acks, so after a burst of changes the last picture could be left unsent, and it now
 *  runs the screencast again once the page is still (src/browser/screencast.ts). A stream at 15 frames a second asking
 *  2, on a tab at the default 1280×800 (frames 2560×1600):
 *    24 navigations from a page that repaints all the time to a still one: the stream ends on the still page's picture
 *       (the colour of a band across its top) within 2 s of the navigation.
 *    24 bursts of 30 animation frames started by a tap, a bar drawn 8 px longer on each: the stream ends on the bar at
 *       its full length within 2 s of the last step; the same 12 times at 5 and at 30 frames a second, and at 30
 *       asking 3 (frames 3840×2400, which take longer to come than the acks are apart: the frame Chrome sent while two
 *       acks were out comes after they have gone, and is told by Chrome's stamp of when it sent it).
 *    24 scrolls of 30 wheel events: the stream ends on a frame at the page's own scroll position.
 *    What it costs: on a still page Chrome sends no frame and the screencast is not started in 5 s; on the page that
 *       repaints all the time Chrome sends as many frames a second as the stream asks, a few percent more at most, and
 *       the screencast is not started in 10 s. Starts are read off Chrome's own count: a frame is acknowledged by the
 *       number of its screencast's run, which is one more at every start.
 *    40 streams that take over from another on the page that repaints all the time, as the Mac's does at a zoom step
 *       (the one before ended, then this one asked): frames come at the stream's rate from its first. A frame that
 *       came between the two, while nobody watched, had its ack paced at one a second and its turn left in the queue,
 *       and the new stream stood still for most of a second (review, 2026-10-03). */

import { execFileSync } from "node:child_process";
import type { Page } from "playwright-core";
import type { DriverPage } from "../src/browser/driver.js";
import type { FrameEvent, TabInfo } from "../src/browser/types.js";

/** A stream's frames in the order they came, when each came, and how to end it. */
export type Stream = { readonly frames: FrameEvent[]; readonly cameAt: number[]; stop(): Promise<void> };

/** What these checks take from the probe that runs them. */
export type Probe = {
  /** One of the screens' routes, as a screen calls it. */
  readonly call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
  /** A screen's stream of a tab (the route's SSE). */
  readonly watch: (tab: string, query: string) => Promise<Stream>;
  readonly check: (ok: boolean, what: string) => void;
  /** The page behind a tab, as the host holds it. */
  readonly page: (tab: string) => DriverPage | null;
  /** The Chrome processes of this run's profile. */
  readonly chromePids: () => string[];
};

/** The stream's rate (the Mac's and a phone's on the local network) and what it asks at a rate and a scale; then a slow
 *  phone's rate, the most, and the most on the largest view (rate, scale). */
const LAST_RATE = 15;
const lastStream = (fps: number, scale = 2): string => `quality=80&fps=${fps}&scale=${scale}`;
const OTHER_STREAMS: readonly (readonly [number, number])[] = [[5, 2], [30, 2], [30, 3]];
/** A stream must end on the page's last picture within this long of the page reaching it. */
const LAST_WITHIN_MS = 2_000;
const LAST_RUNS = 24;
const LAST_RUNS_OTHER = 12;
/** A burst: this many animation frames, the bar `BAR_STEP` CSS pixels longer on each; or as many wheel events of
 *  `WHEEL` frame pixels. */
const BURST_FRAMES = 30;
const BAR_STEP = 8;
const WHEEL = 80;
/** How long the cost is measured on the page that repaints all the time, and on the still one. */
const COST_MS = 10_000;
const COST_STILL_MS = 5_000;
/** Chrome may send this many times the stream's rate at most (a few percent over), and sends at least this much of it
 *  where the page repaints all the time (less would mean the page did not). */
const COST_OVER = 1.05;
const COST_UNDER = 0.8;
/** Streams that take over from another; how long each is looked at; and what counts as standing still: this long
 *  without a frame (an interval at 15 frames a second is 67 ms; a start takes a few tens of milliseconds more). */
const TAKEOVERS = 40;
const TAKEOVER_MS = 1_200;
const TAKEOVER_STILL_MS = 400;
/** The screen these checks drive the tab as. */
const SCREEN = "mac-last";

/** A page told by its picture: a band across its top in `colour`. `moving`: a dot that moves every animation frame, so
 *  the page repaints all the time. */
const bandPage = (title: string, colour: string, moving: boolean): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  html, body { margin: 0; background: #fff; }
  #band { position: fixed; left: 0; top: 0; width: 100%; height: 60px; background: ${colour}; }
  #dot { position: fixed; left: 0; top: 200px; width: 12px; height: 12px; background: #000; }
</style></head><body><div id="band"></div>${moving ? `<div id="dot"></div>
<script>let x = 0; const move = () => { x = (x + 2) % 600; document.getElementById("dot").style.left = x + "px"; requestAnimationFrame(move); }; requestAnimationFrame(move);</script>` : ""}
</body></html>`;

/** A page that changes in bursts and is still between them. A click draws a black bar along its top `BAR_STEP` px
 *  longer on every animation frame, `BURST_FRAMES` times, and stops; it is tall, so a wheel scrolls it. `seen` says how
 *  far it is: the bar's steps, the bursts finished, and when it last changed (the last step, the last scroll). */
const BURST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Burst</title>
<style>
  html, body { margin: 0; background: #fff; }
  #bar { position: fixed; left: 0; top: 0; width: 0; height: 40px; background: #000; }
  #tall { height: 200000px; background: repeating-linear-gradient(#fff 0 40px, #e4e4e4 40px 80px); }
</style></head><body><div id="tall"></div><div id="bar"></div>
<script>
  const seen = { count: 0, bursts: 0, running: false, at: 0 };
  addEventListener("scroll", () => { seen.at = Date.now(); });
  addEventListener("click", () => {
    if (seen.running) return;
    seen.running = true;
    seen.count = 0;
    const bar = document.getElementById("bar");
    const step = () => {
      seen.count++;
      bar.style.width = (seen.count * ${BAR_STEP}) + "px";
      seen.at = Date.now();
      if (seen.count < ${BURST_FRAMES}) requestAnimationFrame(step);
      else { seen.running = false; seen.bursts++; }
    };
    requestAnimationFrame(step);
  });
</script></body></html>`;

/** The pages these checks open, by file name: the probe writes them into its site folder (`~/site`). */
export const lastPages: Readonly<Record<string, string>> = {
  "repaint.html": bandPage("Repaint", "#c00000", true),
  "quiet.html": bandPage("Quiet", "#0040c0", false),
  "burst.html": BURST_PAGE,
};

/** Run in a blank tab on `{data, x, y, row}`: the mean colour of a JPEG (base64) around (x, y), and how many pixels from
 *  its left edge along `row` are dark. Script text, not a function: tsx's helpers are not in the page. */
const LOOK = `async (input) => {
  const image = await createImageBitmap(new Blob([Uint8Array.from(atob(input.data), (c) => c.charCodeAt(0))], { type: "image/jpeg" }));
  const g = new OffscreenCanvas(image.width, image.height).getContext("2d");
  g.drawImage(image, 0, 0);
  const px = g.getImageData(input.x - 2, input.y - 2, 5, 5).data;
  const colour = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) colour[c] += px[i + c] / (px.length / 4);
  const row = g.getImageData(0, input.row, image.width, 1).data;
  let dark = 0;
  while (dark < image.width && row[4 * dark] + row[4 * dark + 1] + row[4 * dark + 2] < 384) dark++;
  return { colour, dark };
}`;
type Looked = { colour: [number, number, number]; dark: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(get: () => Promise<T | null | undefined | false>, ms = 15_000, every = 50): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

/** Every frame as Chrome sent it for a tab, before any stream's pacing: when it came, and the run of the screencast it
 *  is of. Chrome numbers the runs: a frame is acknowledged by its run's number, which is one more at every start. */
type Sent = { readonly at: number[]; readonly run: number[] };

function sentBy(p: Probe, tab: string): Sent {
  const sent: Sent = { at: [], run: [] };
  p.page(tab)?.on("frame", (f) => { sent.at.push(Date.now()); sent.run.push(f.ackId); });
  return sent;
}

/** The run Chrome's latest frame was of. */
const runOf = (sent: Sent): number => sent.run.at(-1) ?? 0;

/** CPU seconds used so far by those processes (`ps -o time=`: [[dd-]hh:]mm:ss.cc). */
function cpuSeconds(pids: readonly string[]): number {
  if (!pids.length) return 0;
  try {
    return execFileSync("ps", ["-o", "time=", "-p", pids.join(",")], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
      .reduce((sum, t) => sum + t.trim().split(":").map(Number).reduce((acc, part) => acc * 60 + part, 0), 0);
  } catch { return 0; }
}

/** The middle and the most of some milliseconds, for a line of the report. */
function middle(ms: readonly number[]): string {
  const sorted = [...ms].sort((a, b) => a - b);
  return sorted.length ? `${sorted[Math.floor(sorted.length / 2)]} ms in the middle, ${sorted.at(-1)} ms at most` : "never";
}

const says = (f: FrameEvent | null): string => (f ? `${f.width}x${f.height} at scale ${f.scale}, viewport ${f.viewport.width}x${f.viewport.height}` : "no frame");

/** Waits for a tab to say `title`. */
const titled = (p: Probe, tab: string, title: string) => until(async () => ((await p.call("GET", `/browser/tabs/${tab}`)).json.tab as TabInfo | undefined)?.title === title);

const goTo = (p: Probe, tab: string, file: string) => p.call("POST", `/browser/tabs/${tab}/navigate`, { path: `~/site/${file}` });

const input = (p: Probe, tab: string, events: object[]) => p.call("POST", `/browser/tabs/${tab}/input`, { screen: SCREEN, events });

/** What a frame shows: which band page (the colour across its top), and how long the burst page's bar is, in steps. */
async function look(measuring: Page, frame: FrameEvent): Promise<{ page: "repaint" | "quiet" | "other"; bar: number }> {
  const arg = { data: frame.data, x: Math.round(frame.width / 2), y: Math.round(30 * frame.scale), row: Math.round(20 * frame.scale) };
  const { colour: [red, , blue], dark } = await measuring.evaluate(`(${LOOK})(${JSON.stringify(arg)})`) as Looked;
  return { page: red > 128 && blue < 96 ? "repaint" : blue > 128 && red < 96 ? "quiet" : "other", bar: Math.round(dark / frame.scale / BAR_STEP) };
}

/** What the burst page says of itself: its bar's steps, the bursts finished, when it last changed, where it is scrolled. */
type Burst = { readonly count: number; readonly bursts: number; readonly at: number; readonly y: number };

/** The burst page as it is now; null while the tab shows another page. */
async function burstPage(p: Probe, tab: string): Promise<Burst | null> {
  const shown = p.page(tab)?.playwright?.() as Page | undefined;
  if (!shown) return null;
  try { return JSON.parse(await shown.evaluate("JSON.stringify({ count: seen.count, bursts: seen.bursts, at: seen.at, y: Math.round(scrollY) })") as string) as Burst; }
  catch { return null; }
}

/** Whether a stream ends on the page's last picture within `LAST_WITHIN_MS` of `since`, when the page reached it: its
 *  latest frame is looked at as frames come, until one is `final`. Answers how long after `since` that frame came (it
 *  may have come a little before: the page says when it changed, not when that was drawn), or null when the time was
 *  up. */
async function endsOn(stream: Stream, since: number, final: (frame: FrameEvent) => Promise<boolean> | boolean): Promise<number | null> {
  let looked: FrameEvent | undefined;
  for (;;) {
    const late = Date.now() > since + LAST_WITHIN_MS;
    const i = stream.frames.length - 1;
    const frame = stream.frames[i];
    if (frame && frame !== looked) {
      looked = frame;
      const ms = stream.cameAt[i]! - since;
      if (ms <= LAST_WITHIN_MS && await final(frame)) return ms;
    }
    if (late) return null;
    await sleep(20);
  }
}

/** From the page that repaints all the time to the still one, `LAST_RUNS` times: the stream ends on the still page. */
async function navigations(p: Probe, tab: string, stream: Stream, sent: Sent, measuring: Page): Promise<void> {
  const run = runOf(sent);
  const took: number[] = [];
  const left: string[] = [];
  for (let i = 0; i < LAST_RUNS; i++) {
    await goTo(p, tab, "repaint.html");
    if (!await titled(p, tab, "Repaint")) { left.push("the repainting page did not load"); continue; }
    await sleep(600 + (i * 37) % 200);
    const since = Date.now();
    await goTo(p, tab, "quiet.html");
    let shown = "no frame";
    const ms = await endsOn(stream, since, async (f) => { shown = (await look(measuring, f)).page; return shown === "quiet"; });
    if (ms === null) left.push(shown === "repaint" ? "the page before" : shown); else took.push(ms);
    await titled(p, tab, "Quiet");
  }
  const before = left.filter((l) => l === "the page before").length;
  p.check(left.length === 0, `${LAST_RUNS} navigations from a page that repaints all the time to a still one, a stream at ${LAST_RATE} frames a second asking 2: `
    + `the stream ended on the still page's picture within ${LAST_WITHIN_MS / 1000} s after ${took.length}, on the picture of the page before after ${before}`
    + `${left.length > before ? ` (and: ${left.filter((l) => l !== "the page before").join(", ")})` : ""}; the still page's came ${middle(took)} after the navigation was asked; `
    + `the screencast was started again ${runOf(sent) - run} times`);
}

/** `runs` bursts of `BURST_FRAMES` animation frames, each started by a tap: the stream ends on the bar at its full
 *  length. */
async function animations(p: Probe, tab: string, stream: Stream, sent: Sent, measuring: Page, runs: number, asks: string): Promise<void> {
  const run = runOf(sent);
  const took: number[] = [];
  const short: string[] = [];
  for (let i = 0; i < runs; i++) {
    await sleep(300 + (i * 37) % 120);
    const was = await burstPage(p, tab);
    const scale = stream.frames.at(-1)?.scale ?? 1;
    const tapped = await input(p, tab, [{ type: "mouse", action: "click", x: 640 * scale, y: 400 * scale }]);
    const done = was ? await until(async () => { const now = await burstPage(p, tab); return now && now.bursts === was.bursts + 1 ? now : null; }, 8_000, 20) : null;
    if (!done) { short.push(`no burst (status ${tapped.status})`); continue; }
    let bar = -1;
    const ms = await endsOn(stream, done.at, async (f) => { bar = (await look(measuring, f)).bar; return bar === BURST_FRAMES; });
    if (ms === null) short.push(String(bar)); else took.push(ms);
  }
  p.check(short.length === 0, `${runs} bursts of ${BURST_FRAMES} animation frames, a stream at ${asks}: the stream ended on the bar at its full ${BURST_FRAMES} steps `
    + `within ${LAST_WITHIN_MS / 1000} s after ${took.length}${short.length ? ` (it was left at ${short.join(", ")})` : ""}; that picture came ${middle(took)} after the last step; `
    + `the screencast was started again ${runOf(sent) - run} times`);
}

/** `LAST_RUNS` scrolls of `BURST_FRAMES` wheel events each: the stream ends on a frame at the page's own scroll
 *  position (a tap aimed at an earlier one would land that many pixels off). */
async function wheels(p: Probe, tab: string, stream: Stream, sent: Sent): Promise<void> {
  const run = runOf(sent);
  const took: number[] = [];
  const behind: string[] = [];
  for (let i = 0; i < LAST_RUNS; i++) {
    await sleep(300 + (i * 37) % 120);
    const was = await burstPage(p, tab);
    const scale = stream.frames.at(-1)?.scale ?? 1;
    const target = (was?.y ?? 0) + (BURST_FRAMES * WHEEL) / scale;
    const turned = await input(p, tab, Array.from({ length: BURST_FRAMES }, () => ({ type: "wheel", x: 640 * scale, y: 400 * scale, deltaY: WHEEL })));
    const done = await until(async () => { const now = await burstPage(p, tab); return now && now.y === target ? now : null; }, 8_000, 20);
    if (!done) { behind.push(`the page is at ${(await burstPage(p, tab))?.y}, not ${target} (status ${turned.status})`); continue; }
    let at = NaN;
    const ms = await endsOn(stream, done.at, (f) => { at = f.scrollY; return Math.abs(f.scrollY - target) < 1; });
    if (ms === null) behind.push(`${Math.round(target - at)} px`); else took.push(ms);
  }
  p.check(behind.length === 0, `${LAST_RUNS} scrolls of ${BURST_FRAMES} wheel events (${(BURST_FRAMES * WHEEL) / 2} CSS pixels), a stream at ${LAST_RATE} frames a second: the stream ended on a frame at the page's own `
    + `scroll position within ${LAST_WITHIN_MS / 1000} s after ${took.length}${behind.length ? ` (its last frame was behind the page by ${behind.join(", ")})` : ""}; `
    + `that frame came ${middle(took)} after the last scroll; the screencast was started again ${runOf(sent) - run} times`);
}

/** What the last picture costs where there is none to bring: a still page, and a page that repaints all the time. */
async function cost(p: Probe, tab: string, sent: Sent): Promise<void> {
  // The still page, once what the navigation to it brought is over.
  await goTo(p, tab, "quiet.html");
  await titled(p, tab, "Quiet");
  await sleep(2_500);
  const still = { frames: sent.at.length, run: runOf(sent) };
  await sleep(COST_STILL_MS);
  p.check(sent.at.length === still.frames && runOf(sent) === still.run, `a still page, ${COST_STILL_MS / 1000} s: Chrome sent ${sent.at.length - still.frames} frames, `
    + `the screencast was started again ${runOf(sent) - still.run} times`);
  await goTo(p, tab, "repaint.html");
  await titled(p, tab, "Repaint");
  await sleep(1_500);
  const pids = p.chromePids();
  const from = { frames: sent.at.length, run: runOf(sent), cpu: cpuSeconds(pids), at: Date.now() };
  await sleep(COST_MS);
  const seconds = (Date.now() - from.at) / 1000;
  const rate = (sent.at.length - from.frames) / seconds;
  const again = runOf(sent) - from.run;
  const busy = Math.round(((cpuSeconds(pids) - from.cpu) / seconds) * 100);
  p.check(rate <= LAST_RATE * COST_OVER && rate >= LAST_RATE * COST_UNDER && again === 0, `a page that repaints all the time, ${seconds.toFixed(1)} s, a stream at ${LAST_RATE} frames a second asking 2: `
    + `Chrome sent ${rate.toFixed(2)} frames a second, the screencast was started again ${again} times; Chrome's CPU ${busy}%`);
}

/** Streams that take over from another on the page that repaints all the time, the one before ended 3 ms or 300 ms
 *  earlier (the Mac ends its stream and follows again at every zoom step; a screen leaves a tab and comes back): the
 *  longest the new stream waits for a frame in its first `TAKEOVER_MS`, from its asking on. Answers the stream left
 *  running. */
async function takeovers(p: Probe, tab: string, stream: Stream): Promise<Stream> {
  let running = stream;
  const longest: number[] = [];
  for (let i = 0; i < TAKEOVERS; i++) {
    await running.stop();
    await sleep(i % 2 ? 300 : 3);
    const since = Date.now();
    running = await p.watch(tab, lastStream(LAST_RATE));
    await sleep(TAKEOVER_MS);
    const came = [since, ...running.cameAt.filter((at) => at <= since + TAKEOVER_MS), since + TAKEOVER_MS];
    longest.push(Math.max(...came.slice(1).map((at, k) => at - came[k]!)));
  }
  const still = longest.filter((ms) => ms >= TAKEOVER_STILL_MS);
  p.check(still.length === 0, `${TAKEOVERS} streams that took over from another on a page that repaints all the time (the one before ended 3 or 300 ms earlier), `
    + `${LAST_RATE} frames a second asking 2: in its first ${TAKEOVER_MS / 1000} s the stream went ${TAKEOVER_STILL_MS} ms or more without a frame after ${still.length}`
    + `${still.length ? ` (${still.join(", ")} ms)` : ""}; its longest wait for a frame was ${middle(longest)}`);
  return running;
}

/** The bursts again at a slow phone's rate (an ack every 200 ms, longer than the quiet time), at the most, and at the
 *  most on the largest view. Answers the stream left running. */
async function otherStreams(p: Probe, tab: string, stream: Stream, sent: Sent, measuring: Page): Promise<Stream> {
  await goTo(p, tab, "burst.html");
  await until(() => burstPage(p, tab));
  let running = stream;
  for (const [fps, scale] of OTHER_STREAMS) {
    const next = await p.watch(tab, lastStream(fps, scale));
    await running.stop();
    running = next;
    await sleep(1_500);
    const frame = running.frames.at(-1);
    await animations(p, tab, running, sent, measuring, LAST_RUNS_OTHER, `${fps} frames a second asking ${scale} (frames ${frame?.width}x${frame?.height})`);
  }
  return running;
}

/** The last picture of a burst reaches the screens (see the header). `measuring`: a blank tab to look at frames in. */
export async function lastPicture(p: Probe, measuring: Page): Promise<void> {
  const opened = await p.call("POST", "/browser/tabs", { path: "~/site/quiet.html" });
  const tab = (opened.json.tab as TabInfo | undefined)?.id;
  if (!tab || !await titled(p, tab, "Quiet")) { p.check(false, `the still page opens for the last picture (status ${opened.status})`); return; }
  const sent = sentBy(p, tab);
  const stream = await p.watch(tab, lastStream(LAST_RATE));
  const first = await until(async () => stream.frames.at(-1));
  // Starts are read off Chrome's numbering of the runs: a stream asking a better quality starts the screencast again
  // when it comes and when it leaves.
  await sleep(500);
  const run = runOf(sent);
  const better = await p.watch(tab, lastStream(LAST_RATE).replace("quality=80", "quality=90"));
  await sleep(400);
  await better.stop();
  await sleep(400);
  p.check(first?.width === 2560 && first.height === 1600 && first.scale === 2 && runOf(sent) === run + 2, `a stream at ${LAST_RATE} frames a second asking 2 gets frames 2560x1600 of the still page (${says(first)}); `
    + `Chrome numbers the screencast's runs: a stream asking a better quality came and left, two starts, and the frames' run went from ${run} to ${runOf(sent)}`);
  await navigations(p, tab, stream, sent, measuring);
  await goTo(p, tab, "burst.html");
  if (!await until(() => burstPage(p, tab))) { p.check(false, "the page that changes in bursts opens"); return; }
  await sleep(1_000);
  await animations(p, tab, stream, sent, measuring, LAST_RUNS, `${LAST_RATE} frames a second`);
  await wheels(p, tab, stream, sent);
  await cost(p, tab, sent);
  const running = await otherStreams(p, tab, await takeovers(p, tab, stream), sent, measuring);
  // The tab first: a stream that leaves has the view redrawn, which a closing tab cannot be.
  await p.call("DELETE", `/browser/tabs/${tab}`);
  await running.stop();
}
