/** One tab's picture for every screen watching it (browser-v0 §2 给 App): a single CDP screencast shared by all of the
 *  tab's streams, started with the first and stopped with the last; restarted when a new stream asks for better quality
 *  or larger frames. Chrome sends a frame only when the page changed and waits for each to be acknowledged; the ack is
 *  held back so the fastest stream's rate is the most Chrome produces. Each stream gets at most its own rate: a frame
 *  that comes too soon waits, and a newer one replaces it (the phone over a relay asks for less and always ends on the
 *  latest picture). A stream joining a running screencast gets the last frame at once. */

import type { DriverPage, RawFrame, ScreencastParams } from "./driver.js";
import type { Geometry } from "./input.js";
import type { FrameEvent } from "./types.js";

export type StreamOptions = { readonly quality: number; readonly fps: number; readonly maxWidth?: number; readonly maxHeight?: number };
export const DEFAULT_STREAM: StreamOptions = { quality: 70, fps: 15 };
export const MAX_FPS = 30;
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

const sameParams = (a: ScreencastParams | null, b: ScreencastParams | null): boolean =>
  a === b || (!!a && !!b && a.quality === b.quality && a.maxWidth === b.maxWidth && a.maxHeight === b.maxHeight);

export class Screencast {
  private readonly subs = new Map<number, Subscriber>();
  private nextId = 0;
  private seq = 0;
  private last: FrameEvent | null = null;
  private readonly geometries = new Map<number, Geometry>();
  private desired: ScreencastParams | null = null;
  private applied: ScreencastParams | null = null;
  private chain: Promise<void> = Promise.resolve();
  private lastAckAt = 0;
  private closed = false;

  constructor(private readonly page: DriverPage, private readonly now: () => number = Date.now, private readonly log: (line: string) => void = console.error) {
    page.on("frame", (f) => this.onFrame(f));
  }

  /** A stream's frames until the returned function is called. */
  add(opts: StreamOptions, deliver: (frame: FrameEvent) => void): () => void {
    const id = ++this.nextId;
    const sub: Subscriber = { opts, deliver, lastAt: 0, pending: null, timer: null };
    this.subs.set(id, sub);
    if (this.last) this.offer(sub, this.last);
    this.reconcile();
    return () => {
      if (!this.subs.delete(id)) return;
      if (sub.timer) clearTimeout(sub.timer);
      this.reconcile();
    };
  }

  /** How frame `seq` (default the latest) sits on the page; null before the first frame. */
  geometry(seq?: number): Geometry | null {
    if (seq !== undefined && this.geometries.has(seq)) return this.geometries.get(seq)!;
    if (!this.last) return null;
    return { scale: this.last.scale, width: this.last.viewport.width, height: this.last.viewport.height };
  }

  get watching(): number { return this.subs.size; }

  /** Starts the running screencast again: after a size change that followed a navigation Chrome sends no frame of the
   *  new size until it is (seen with Chrome 154). */
  restart(): void {
    this.chain = this.chain.then(async () => {
      const params = this.applied;
      if (this.closed || !params) return;
      await this.page.stopScreencast().catch(() => undefined);
      await this.page.startScreencast(params);
    }).catch((err: unknown) => this.log(`browser: screencast: ${(err as Error).message}`));
  }

  /** The tab is gone: no more frames, no calls to the page. */
  close(): void {
    this.closed = true;
    for (const sub of this.subs.values()) if (sub.timer) clearTimeout(sub.timer);
    this.subs.clear();
    this.last = null;
  }

  private wanted(): ScreencastParams | null {
    const subs = [...this.subs.values()].map((s) => s.opts);
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

  private async apply(): Promise<void> {
    if (this.closed) return;
    const want = this.desired;
    if (sameParams(want, this.applied)) return;
    if (this.applied) {
      this.applied = null;
      await this.page.stopScreencast().catch(() => undefined);
      if (!want) this.last = null;
    }
    if (want) {
      await this.page.startScreencast(want);
      this.applied = want;
    }
  }

  private onFrame(raw: RawFrame): void {
    if (this.closed) return;
    const meta = raw.metadata;
    const head = Buffer.from(raw.data.slice(0, HEADER_CHARS), "base64");
    const size = jpegSize(head) ?? jpegSize(Buffer.from(raw.data, "base64")) ?? { width: meta.deviceWidth, height: meta.deviceHeight };
    const scale = meta.deviceWidth > 0 ? Math.round((size.width / meta.deviceWidth) * 10_000) / 10_000 : 1;
    const frame: FrameEvent = {
      type: "frame", seq: ++this.seq, data: raw.data, format: "jpeg", width: size.width, height: size.height, scale,
      viewport: { width: meta.deviceWidth, height: meta.deviceHeight }, pageScale: meta.pageScaleFactor,
      scrollX: meta.scrollOffsetX, scrollY: meta.scrollOffsetY,
    };
    this.last = frame;
    this.geometries.set(frame.seq, { scale, width: meta.deviceWidth, height: meta.deviceHeight });
    if (this.geometries.size > GEOMETRIES_KEPT) this.geometries.delete(this.geometries.keys().next().value!);
    for (const sub of this.subs.values()) this.offer(sub, frame);
    this.ack(raw.ackId);
  }

  /** The ack after the fastest stream's interval, so Chrome makes no more frames than anyone takes. */
  private ack(ackId: number): void {
    const fps = Math.max(1, ...[...this.subs.values()].map((s) => s.opts.fps));
    const wait = Math.max(0, this.lastAckAt + 1000 / fps - this.now());
    const send = () => {
      this.lastAckAt = this.now();
      if (!this.closed) void this.page.ackFrame(ackId).catch(() => undefined);
    };
    if (wait === 0) send();
    else setTimeout(send, wait).unref();
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
