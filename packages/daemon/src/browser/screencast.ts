/** One tab's picture for every screen watching it (browser-v0 §2 给 App): a single CDP screencast shared by all of the
 *  tab's streams, started with the first and stopped with the last; restarted when a new stream asks for better quality
 *  or larger frames. Each stream gets at most its own rate: a frame that comes too soon waits, and a newer one replaces
 *  it (the phone over a relay asks for less and always ends on the latest picture). A stream joining a running
 *  screencast gets the last frame at once.
 *
 *  Acks (browser-v0 §5 回执). Chrome sends a frame when the page changed, and counts the frames of a run of the
 *  screencast that were not acknowledged: while three are, it sends nothing it captures, and it does not send that
 *  capture later (Chrome 154). Acks are paced, each one an interval of the fastest stream after the one before,
 *  however many frames wait (spaced from the last one sent only, Chrome made about three times that rate), so the
 *  fastest stream's rate is the most Chrome produces. What that cost was the last picture of a burst: on a page that
 *  changes fast and then stops, what Chrome captured last while the acks were held back never came, and the screens
 *  kept an earlier picture until something repainted (a stream at 15 frames a second asking 2, two runs of
 *  scripts/browser_zoom_probe.ts: left on the page before after 12 and 13 of 24 navigations from a page that repaints
 *  all the time to a still one, 2 to 4 steps short of an animation of 30 after 16 and 23 of 24, 120 px behind a scroll
 *  of 30 wheel events after 16 and 23 of 24, where the next tap lands on something else than what is seen). So the
 *  frames whose ack has not gone are counted, and a frame that Chrome sent while another's ack was waiting may not be
 *  the page's last capture (`behind`, `overlapped`); once the last ack has gone and no frame has come for `QUIET_MS`,
 *  the screencast is run again, once: Chrome sends the picture as it is when a screencast starts, as one frame
 *  (`settled`, `rerun`). A page that keeps changing keeps sending frames and is not run again. The last picture so
 *  comes up to three of the fastest stream's intervals and `QUIET_MS` after the page stopped: about 0.3 s later at 15
 *  frames a second, 0.25 s at 30, 0.7 s at 5 (measured).
 *
 *  Device pixels (browser-v0 §5, 2026-10-03): Chrome's frames are the tab's view, which is the viewport's CSS size unless
 *  the host draws the view at a scale (`render`, see host.ts): then each CSS pixel is `render` pixels of the view and of
 *  the frame, and Chrome's metadata gives the view's size. A stream says how many frame pixels per CSS pixel its screen
 *  can show (`scale`, its device pixels; bounded by `maxWidth` / `maxHeight`), `renderScale` picks the tab's from all of
 *  them, and the host redraws the view between a stop and a start of the screencast (`reconfigure`). A run's frames
 *  are of one view but for the first few, which Chrome may have captured before the change: a frame says its view's
 *  size and when Chrome sent it, and until the first one of the view the host drew, one of another size or from before
 *  the change is not shown (`shows`). Chrome also changes a tab's view itself (a tab that becomes its window's front
 *  tab is set to the window's size): a frame of another size than the view drawn is not shown either, and the host is
 *  asked to draw the view again (`onStray`).
 *
 *  Page zoom (browser-v0 §1 页面缩放, 2026-10-03, user: 然后我发现agentswitch的浏览器页没有放大缩小的选项，加上
 *  用来调节大小) is the screens' doing, and nothing here knows of it: the screen that sizes a tab makes the page smaller
 *  to zoom in and asks for its device pixels times the zoom, so `scale` goes up to 8 (`MAX_SCALE`), falls between
 *  quarters at most steps (`SCALE_STEP`), and the view is redrawn at every step. */

import type { DriverPage, RawFrame, ScreencastParams } from "./driver.js";
import type { Geometry } from "./input.js";
import type { FrameEvent } from "./types.js";

export type StreamOptions = {
  readonly quality: number;
  readonly fps: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  /** Frame pixels per CSS pixel the screen can show (its device pixels, times the zoom of a page it zoomed in); 1 when
   *  not given. */
  readonly scale?: number;
};
export const DEFAULT_STREAM: StreamOptions = { quality: 70, fps: 15 };
export const MAX_FPS = 30;
/** The most frame pixels per CSS pixel a stream may ask for: a screen's device pixels times the zoom of a page it zoomed
 *  in (browser-v0 §1 页面缩放, 2026-10-03). A 3x phone at 200% asks 6, a 2x Mac at 400% asks 8; it was 3, a phone's 3x
 *  screen, which left a zoomed page drawn at half its screen's pixels or fewer. Chrome's own emulation takes a scale up
 *  to 10. What is drawn stays within the view's limits below, as before. */
export const MAX_SCALE = 8;
/** The view drawn at a scale stays within this many pixels a side and in all (a 4K screen's worth): a larger window
 *  gets a little less than its device pixels. */
export const MAX_VIEW_SIDE = 4096;
export const MAX_VIEW_PIXELS = 3840 * 2400;
/** Scales are kept to a thousandth, rounded down (a fit of 1206 / 322 draws at 3.745: the frame is never larger than
 *  the screen asked for, and its `scale` is the view's to the digit). They went in quarter steps until the page zoom
 *  (browser-v0 §1 页面缩放, 2026-10-03), most of whose steps fall between quarters: a 2x Mac at 110% asks 2.2 and was
 *  drawn at 2, a 3x phone at 125% at 3.5, each stretched to its screen and soft (review; with Chrome 154 the frame at
 *  the screen's pixels is about 1.6 and 1.5 times as sharp, scripts/browser_zoom_probe.ts). */
const SCALE_STEP = 1000;
/** After the view was drawn anew, a frame of another size is taken for a capture of the view before (`shows`) for at
 *  most this long. Chrome's first frame of the new view came within 60 ms; where none has come by then, the view is
 *  not what the host drew, and the host draws it again, once; where none has come this long after that either (not
 *  seen with Chrome 154), frames are taken as they come, as they were before. */
const STALE_MS = 2_000;
/** After the last waiting ack went, no frame for this long means the page is still (`settled`). Where it keeps changing,
 *  Chrome has a capture to send as soon as an ack reaches it, and a frame comes within a few tens of milliseconds (a
 *  start's own frame took 6 to 11 ms at 1280×800, 15 to 37 ms at 2560×1600, with Chrome 154). */
const QUIET_MS = 150;
/** Chrome's stamp of a frame (when it sent it, `RawFrame.metadata.timestamp`) is believed where it can be the frame's
 *  own: not ahead of this clock, and less than this old. A frame came 27 to 67 ms after its stamp in the middle, 317 ms
 *  at most (2560×1600 and 3840×2400 frames, Chrome 154). */
const STAMP_MS = 2_000;
/** Chrome sends nothing it captures while this many frames of the run wait for their ack (Chrome 154: with the acks
 *  held back, never more than three were out). It counts from zero at a start, so nothing was dropped after a run's
 *  first two frames: they are never `behind`, whatever a start brings of itself (one frame on a still page, 40 of 40
 *  starts), and running the screencast again cannot lead to running it again. */
const CHROME_HOLDS = 3;
/** Frames whose geometry is kept for input that names its frame (`seq`). */
const GEOMETRIES_KEPT = 64;
/** Base64 characters decoded to find a JPEG's size: the frame header sits in the first few hundred bytes. */
const HEADER_CHARS = 8192;

type Subscriber = {
  readonly opts: StreamOptions;
  readonly deliver: (frame: FrameEvent) => void;
  lastAt: number;
  pending: FrameEvent | null;
  timer: NodeJS.Timeout | null;
};

/** A JPEG's pixel size from its frame header (SOFn), or null when there is none. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** A tab's view as it is drawn: `scale` view pixels per CSS pixel, and its size in pixels, which is what Chrome's
 *  metadata says of a frame of it. */
export type DrawnView = { readonly scale: number; readonly width: number; readonly height: number };

/** The view of `viewport` drawn at `scale`: whole pixels, as the driver sets them (`Emulation.setVisibleSize`); at 1 the
 *  CSS size, Chrome's own. */
export function viewAt(viewport: { readonly width: number; readonly height: number }, scale: number): DrawnView {
  return { scale, width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
}

/** The scale to draw a tab's view at for the streams watching it: the most any of them can show — its `scale`, as far
 *  as its `maxWidth` / `maxHeight` hold that many pixels — within `MAX_SCALE` and the view's pixel limits, to a
 *  thousandth (`SCALE_STEP`), never under 1 (CSS size, as without any stream). */
export function renderScale(viewport: { readonly width: number; readonly height: number }, asks: readonly StreamOptions[]): number {
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  let best = 1;
  for (const ask of asks) {
    let s = Math.min(ask.scale ?? 1, MAX_SCALE);
    if (ask.maxWidth !== undefined) s = Math.min(s, ask.maxWidth / viewport.width);
    if (ask.maxHeight !== undefined) s = Math.min(s, ask.maxHeight / viewport.height);
    best = Math.max(best, s);
  }
  best = Math.min(best, MAX_VIEW_SIDE / viewport.width, MAX_VIEW_SIDE / viewport.height, Math.sqrt(MAX_VIEW_PIXELS / (viewport.width * viewport.height)));
  let steps = Math.floor(best * SCALE_STEP + 1e-9);
  // The view is whole pixels, which may carry it a little past the limit in all (2578×3576 for 1250×1734 at 2.062).
  const over = (scale: number): boolean => { const view = viewAt(viewport, scale); return view.width * view.height > MAX_VIEW_PIXELS; };
  while (steps > SCALE_STEP && over(steps / SCALE_STEP)) steps -= 1;
  return Math.max(1, steps / SCALE_STEP);
}

const sameParams = (a: ScreencastParams | null, b: ScreencastParams | null): boolean =>
  a === b || (!!a && !!b && a.quality === b.quality && a.maxWidth === b.maxWidth && a.maxHeight === b.maxHeight);

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export class Screencast {
  private readonly subs = new Map<number, Subscriber>();
  private nextId = 0;
  private seq = 0;
  private last: FrameEvent | null = null;
  private readonly geometries = new Map<number, Geometry>();
  private desired: ScreencastParams | null = null;
  private applied: ScreencastParams | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** When the next ack may go: one per interval of the fastest stream, however many frames are in flight. */
  private nextAckAt = 0;
  /** The run of the screencast, one more at every stop and every start: Chrome counts unacknowledged frames from each
   *  start anew, and so does `unacked`. */
  private runNo = 0;
  /** Frames of this run so far, those not shown too (`onFrame`). */
  private came = 0;
  /** Frames of this run whose ack has not been sent yet. */
  private unacked = 0;
  /** When the latest ack of this run was sent; before the first, never. */
  private lastAckAt = -Infinity;
  /** Chrome sent the latest frame while another's ack was waiting (`overlapped`): it may have reached its limit since,
   *  and what it captured last may never have been sent. */
  private behind = false;
  /** Runs out `QUIET_MS` after the last waiting ack went, unless a frame comes first (`settled`). */
  private quiet: NodeJS.Timeout | null = null;
  private closed = false;
  /** View pixels per CSS pixel of the frames Chrome sends now (`reconfigure`). */
  private render = 1;
  /** The view the host drew last: its size in pixels, which Chrome's metadata says of a frame of it, and when it was
   *  drawn: what Chrome sent before that, the screencast still stopped, is not of this view. Null where nobody could
   *  say what the view is: frames are then taken as they come. */
  private drawn: { readonly width: number; readonly height: number; readonly since: number } | null = null;
  /** Until when a frame of another size is taken for a capture of the view before; null once the first frame of the
   *  view drawn has come. */
  private awaited: number | null = null;
  /** Chrome's view is not the one drawn, and the host has been asked to draw it again (`onStray`): not asked again
   *  until a frame of the view drawn has come. */
  private strayed = false;

  /** `onDemand`: the streams changed (one came or went), so the scale they ask for may have (the host redraws).
   *  `onStray`: Chrome's view is not the one the host drew (the host draws it again). */
  constructor(private readonly page: DriverPage, private readonly now: () => number = Date.now, private readonly log: (line: string) => void = console.error,
              private readonly onDemand: () => void = () => undefined, private readonly onStray: () => void = () => undefined) {
    page.on("frame", (f) => this.onFrame(f));
  }

  /** A stream's frames until the returned function is called. */
  add(opts: StreamOptions, deliver: (frame: FrameEvent) => void): () => void {
    const id = ++this.nextId;
    const sub: Subscriber = { opts, deliver, lastAt: 0, pending: null, timer: null };
    this.subs.set(id, sub);
    if (this.last) this.offer(sub, this.last);
    // The view first (it may be redrawn for this stream), then the screencast's settings.
    this.onDemand();
    this.reconcile();
    return () => {
      if (!this.subs.delete(id)) return;
      if (sub.timer) clearTimeout(sub.timer);
      this.reconcile();
      this.onDemand();
    };
  }

  /** What the streams watching now ask for. */
  wants(): StreamOptions[] { return [...this.subs.values()].map((s) => s.opts); }

  /** View pixels per CSS pixel of the current frames. */
  get view(): number { return this.render; }

  /** How frame `seq` (default the latest) sits on the page, with the view as it is drawn now; null before the first
   *  frame. Chrome takes a point of input in the view it has, which may have been redrawn since that frame: when a
   *  stream came or went, and at every step of a page zoom (browser-v0 §1 页面缩放, 2026-10-03: the size, then the
   *  stream asked again at another scale), where a tap aimed at a frame of the view before would land elsewhere. */
  geometry(seq?: number): Geometry | null {
    const last = this.last;
    const latest = last ? this.geometries.get(last.seq) ?? { scale: last.scale, width: last.viewport.width, height: last.viewport.height } : undefined;
    const frame = (seq !== undefined ? this.geometries.get(seq) : undefined) ?? latest;
    return frame ? { ...frame, view: this.render } : null;
  }

  get watching(): number { return this.subs.size; }

  /** The view changes (`apply` sets the size and the scale, and answers the view it drew, or null where it cannot say:
   *  the scale then stays as recorded) while the screencast is stopped, then the screencast runs again: Chrome sends no
   *  frame of a new size after a navigation until it is restarted (seen with Chrome 154), and no frame of the change
   *  itself (half applied) reaches a screen. Frames of the view before may still come first (`shows`). */
  reconfigure(apply: () => Promise<DrawnView | null>): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.closed) return;
      if (this.applied) await this.stop();
      let view: DrawnView | null = null;
      try {
        view = await apply();
      } finally {
        const now = this.now();
        if (view) this.render = view.scale;
        this.drawn = view ? { width: view.width, height: view.height, since: now } : null;
        this.awaited = view ? now + STALE_MS : null;
        // Whatever became of the view, the streams get frames again.
        if (!this.closed) await this.apply();
      }
    });
    this.chain = run.catch((err: unknown) => this.log(`browser: screencast: ${(err as Error).message}`));
    return this.chain;
  }

  /** Resolves once every change asked for so far is done. */
  idle(): Promise<void> { return this.chain; }

  /** Starts the running screencast again with the view as it is. */
  restart(): void {
    if (!this.applied && !this.desired) return;
    void this.reconfigure(async () => null);
  }

  /** The tab is gone: no more frames, no calls to the page. */
  close(): void {
    this.closed = true;
    for (const sub of this.subs.values()) if (sub.timer) clearTimeout(sub.timer);
    this.subs.clear();
    this.last = null;
    this.unquiet();
  }

  private wanted(): ScreencastParams | null {
    const subs = this.wants();
    if (!subs.length) return null;
    // A bound only when every stream asked for one: one without a bound wants full size.
    const bound = (k: "maxWidth" | "maxHeight") => (subs.every((o) => o[k] !== undefined) ? Math.max(...subs.map((o) => o[k]!)) : undefined);
    const maxWidth = bound("maxWidth");
    const maxHeight = bound("maxHeight");
    return { quality: Math.max(...subs.map((o) => o.quality)), ...(maxWidth !== undefined ? { maxWidth } : {}), ...(maxHeight !== undefined ? { maxHeight } : {}) };
  }

  private reconcile(): void {
    this.desired = this.wanted();
    this.chain = this.chain.then(() => this.apply()).catch((err: unknown) => this.log(`browser: screencast: ${(err as Error).message}`));
  }

  /** The screencast as the streams want it now: stopped and started where its settings differ from the running one's,
   *  or, `again`, with the same ones too. */
  private async apply(again = false): Promise<void> {
    if (this.closed) return;
    const want = this.desired;
    if (!again && sameParams(want, this.applied)) return;
    if (this.applied) {
      await this.stop();
      if (!want) this.last = null;
    }
    if (want && !this.closed) {
      this.newRun();
      await this.page.startScreencast(want);
      this.applied = want;
    }
  }

  private async stop(): Promise<void> {
    this.applied = null;
    this.newRun();
    await this.page.stopScreencast().catch(() => undefined);
  }

  /** A run of the screencast ends, or one begins. Chrome counts the unacknowledged frames of a run, from zero at its
   *  start, and the start sends the picture as it is: nothing waits to be counted, nothing is behind. The acks of the
   *  run before still go in their turn (`ack`), uncounted, as Chrome leaves them. */
  private newRun(): void {
    this.runNo += 1;
    this.came = 0;
    this.unacked = 0;
    this.lastAckAt = -Infinity;
    this.behind = false;
    this.unquiet();
  }

  private unquiet(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
  }

  /** Whether a frame is of the view the host drew, as far as that can be told: by the view's size, which Chrome's
   *  metadata says, and by Chrome's stamp of when it sent the frame.
   *
   *  After the screencast runs again, Chrome may first send what it captured of the view before the change (seen with
   *  Chrome 154 on a page that repaints all the time, 2026-10-03: up to 17 such frames over 150 zoom steps, 0 to 6 ms
   *  after the start, always before the first frame of the new view; none on a still page). Taken for the new view's,
   *  such a frame said a page size that never was, which a screen takes for a change of the page's size, and a point
   *  on it would be mapped by the wrong scale. So until the first frame of the view drawn (`awaited`), a frame of
   *  another size is not shown.
   *
   *  Where the view before had the same size in pixels, such a capture has the new view's size (a 3x phone's page at
   *  90% and at 80% are both 1206×2069), and it was shown as the new page with the one before in it (review,
   *  2026-10-03). Chrome stamps a frame when it sends it: one stamped before the view was drawn (`drawn.since`: the
   *  screencast was stopped then or before) is not shown, whenever it comes (the order frames come in is not relied
   *  on: one of before may come after the new view's first). Measured with Chrome 154 between a 1280×800 page at 3
   *  and a 1920×1200 page at 2, both 3840×2400, whose frames take longest to come: 49 of 587 frames at 30 frames a
   *  second said one page and showed the other and were stamped before the step was asked, 6 of 275 at 15; none of
   *  591 and of 282 with this. Between the phone's 90% and 80% there was none in 120 steps, before or after (9 over
   *  60 steps in the review). What Chrome captures of the new view before the page is laid out for it says the new
   *  page too and cannot be told: about one frame a step at 30 frames a second, stamped 4 to 38 ms after Chrome's
   *  answer (a stream at 15 mostly gets the frame after it instead).
   *
   *  A frame of another size with no change to be left over from: Chrome changed the view itself. It sets the view of
   *  a tab that becomes its window's front tab (a tab opened after it closed, `bringToFront`) back to the window's
   *  size, and the emulated page keeps its size: a tab watched at 2 as 2560×1600 sent 1280×713 frames, which labelled
   *  with the scale drawn said the top left 640×357 of the page was all of it (review, 2026-10-03, Chrome 154). Such a
   *  frame is not shown and the host is asked to draw the view again, once: where no frame of the view comes within
   *  `STALE_MS` of that either, frames are taken as they come, until one of the view drawn has come. (Chrome 154 took
   *  the view back each time: also for a popup that had resized its own window.) */
  private shows(meta: RawFrame["metadata"]): boolean {
    const drawn = this.drawn;
    if (!drawn) return true;
    const now = this.now();
    if (Math.round(meta.deviceWidth) === drawn.width && Math.round(meta.deviceHeight) === drawn.height) {
      const sent = this.sentAt(meta.timestamp);
      if (sent !== null && sent < drawn.since) return false;
      this.awaited = null;
      this.strayed = false;
      return true;
    }
    if (this.awaited !== null && now < this.awaited) return false;
    if (!this.strayed) {
      this.strayed = true;
      this.awaited = now + STALE_MS;
      this.onStray();
      return false;
    }
    if (this.awaited !== null) {
      this.log(`browser: screencast: no frame of the ${drawn.width}×${drawn.height} view within ${STALE_MS} ms of drawing it; `
        + `frames of ${meta.deviceWidth}×${meta.deviceHeight} are taken as they come`);
      this.awaited = null;
    }
    return true;
  }

  /** When Chrome sent a frame, in this clock's milliseconds, by its stamp (seconds); null where the stamp cannot be the
   *  frame's own: none (a Chrome that does not stamp its frames), ahead of this clock, or `STAMP_MS` old. */
  private sentAt(stamp: number | undefined): number | null {
    if (stamp === undefined) return null;
    const sent = stamp * 1000;
    const now = this.now();
    return sent <= now && now - sent < STAMP_MS ? sent : null;
  }

  /** A frame of the view at `render`: Chrome's metadata gives the view's size; the page's is that over `render`, and the
   *  frame has `scale` pixels per CSS pixel (less than `render` when `maxWidth` / `maxHeight` made it smaller). A frame
   *  that is not of the view drawn (`shows`) is acknowledged at once: nobody takes it, and Chrome sends nothing it
   *  captures while too many frames wait for their acknowledgement, the view's first frame included. */
  private onFrame(raw: RawFrame): void {
    if (this.closed) return;
    const meta = raw.metadata;
    this.came += 1;
    if (!this.shows(meta)) {
      void this.page.ackFrame(raw.ackId).catch(() => undefined);
      this.lastAckAt = this.now();
      return;
    }
    // The page changed, so it is not still; and this frame is its last capture so far unless Chrome may have been at
    // its limit after sending it.
    this.unquiet();
    this.behind = this.overlapped(meta.timestamp);
    const head = Buffer.from(raw.data.slice(0, HEADER_CHARS), "base64");
    const size = jpegSize(head) ?? jpegSize(Buffer.from(raw.data, "base64")) ?? { width: meta.deviceWidth, height: meta.deviceHeight };
    const render = this.render;
    const scale = meta.deviceWidth > 0 ? round4((size.width / meta.deviceWidth) * render) : 1;
    const viewport = { width: Math.round(meta.deviceWidth / render), height: Math.round(meta.deviceHeight / render) };
    const frame: FrameEvent = {
      type: "frame", seq: ++this.seq, data: raw.data, format: "jpeg", width: size.width, height: size.height, scale,
      viewport, pageScale: meta.pageScaleFactor, scrollX: meta.scrollOffsetX, scrollY: meta.scrollOffsetY,
    };
    this.last = frame;
    this.geometries.set(frame.seq, { scale, width: viewport.width, height: viewport.height });
    if (this.geometries.size > GEOMETRIES_KEPT) this.geometries.delete(this.geometries.keys().next().value!);
    for (const sub of this.subs.values()) this.offer(sub, frame);
    this.ack(raw.ackId);
  }

  /** The ack in its turn: each one an interval of the fastest stream after the one before (sent or still waiting, of
   *  this run or the one before), so Chrome makes no more frames than anyone takes. While acks wait Chrome may reach its
   *  limit and drop what it captures, the page's last picture among it: the frames of this run whose ack has not gone
   *  are counted, and when the last one has, `settled` sees to that picture.
   *
   *  A frame that comes while nobody watches (the last stream left, and the stop has not reached Chrome yet) has no
   *  rate to be paced at: its ack goes at once and takes no turn. Paced at one a second, as it was, its turn stayed in
   *  the queue, and the acks of the stream that came next waited behind it: on a page that repaints, a stream replaced
   *  (the Mac at every zoom step) stood still for a second for each such frame (review, 2026-10-03). */
  private ack(ackId: number): void {
    const rates = this.wants().map((o) => o.fps);
    const now = this.now();
    const at = rates.length ? Math.max(now, this.nextAckAt) : now;
    if (rates.length) this.nextAckAt = at + 1000 / Math.max(1, ...rates);
    const runNo = this.runNo;
    this.unacked += 1;
    const send = () => {
      if (this.closed) return;
      void this.page.ackFrame(ackId).catch(() => undefined);
      // The screencast was stopped or started since: Chrome does not count this ack against the new run, nor is it
      // counted here.
      if (runNo !== this.runNo) return;
      this.unacked -= 1;
      this.lastAckAt = this.now();
      if (this.unacked === 0) this.settled();
    };
    if (at <= now) send();
    else setTimeout(send, at - now).unref();
  }

  /** Whether Chrome may have dropped a capture after the frame that just came (stamped `stamp`, in seconds, where
   *  Chrome says when it sent it). It drops them while `CHROME_HOLDS` frames of the run wait for their ack: so never
   *  after a run's first two, and after another one when Chrome sent it while the ack of another frame of the run was
   *  waiting. That is two unacknowledged frames, one short of the limit measured: an ack that has gone may not have
   *  reached Chrome. An ack is waiting until it is sent: when one still is as the frame comes, and also when the latest
   *  went after Chrome had sent the frame. Without the stamp that second case is missed where a frame takes longer to
   *  come than the acks are apart: it comes when the acks have gone, looks alone, and the last picture stayed lost after
   *  5 of 16 bursts at 30 frames a second on a 3840×2400 view, after 1 of 16 at 15 (Chrome 154). A Chrome that does
   *  not stamp its frames gets the first case only. */
  private overlapped(stamp: number | undefined): boolean {
    if (this.came < CHROME_HOLDS) return false;
    if (this.unacked > 0) return true;
    const sent = this.sentAt(stamp);
    return sent !== null && this.lastAckAt >= Math.floor(sent);
  }

  /** The last waiting ack has gone, so Chrome sends what it captures next: a page that keeps changing brings a frame
   *  within `QUIET_MS`, its picture then (`onFrame` calls this off). Where none comes and the latest frame may not be
   *  the page's last capture, the screencast is run again. */
  private settled(): void {
    if (!this.behind) return;
    const runNo = this.runNo;
    this.unquiet();
    this.quiet = setTimeout(() => {
      this.quiet = null;
      this.rerun(runNo);
    }, QUIET_MS);
    this.quiet.unref();
  }

  /** Runs the screencast again for the picture a burst may have left behind, once, in its turn among the screencast's
   *  other changes: one made meanwhile has started the screencast itself and brought the picture, and whoever waits
   *  for `idle` (a point of input) waits for this too. The view is as it was: what `onFrame` holds back of a view
   *  before a change stays held back. */
  private rerun(runNo: number): void {
    if (this.closed || runNo !== this.runNo || !this.applied) return;
    this.chain = this.chain
      .then(async () => { if (runNo === this.runNo && this.applied) await this.apply(true); })
      .catch((err: unknown) => this.log(`browser: screencast: ${(err as Error).message}`));
  }

  private offer(sub: Subscriber, frame: FrameEvent): void {
    const gap = 1000 / sub.opts.fps;
    const now = this.now();
    if (!sub.timer && now - sub.lastAt >= gap) {
      sub.lastAt = now;
      sub.deliver(frame);
      return;
    }
    sub.pending = frame;
    if (sub.timer) return;
    sub.timer = setTimeout(() => {
      sub.timer = null;
      const next = sub.pending;
      sub.pending = null;
      if (!next || this.closed) return;
      sub.lastAt = this.now();
      sub.deliver(next);
    }, Math.max(0, sub.lastAt + gap - now));
    sub.timer.unref();
  }
}
