/** One screencast shared by a tab's streams (docs/browser-v0.md §2 给 App): started with the first stream, restarted for
 *  better quality, stopped with the last; frames sized from the JPEG; acks paced by the fastest stream; each stream at
 *  its own rate, ending on the latest frame; a late stream gets the last frame at once. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jpegSize, Screencast } from "../src/browser/screencast.js";
import type { FrameEvent } from "../src/browser/types.js";
import { FakePage, fakeJpeg } from "./fakeBrowser.js";

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("JPEG size", () => {
  it("reads the frame header, skipping other segments", () => {
    expect(jpegSize(Buffer.from(fakeJpeg(1280, 800), "base64"))).toEqual({ width: 1280, height: 800 });
    expect(jpegSize(Buffer.from(fakeJpeg(390, 844), "base64"))).toEqual({ width: 390, height: 844 });
    expect(jpegSize(Buffer.from("not a jpeg"))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

describe("shared screencast", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts with the first stream, restarts for a better one, stops with the last", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    const a = cast.add({ quality: 40, fps: 5 }, () => undefined);
    await settle();
    expect(page.screencasts).toEqual([{ quality: 40 }]);
    const b = cast.add({ quality: 80, fps: 30, maxWidth: 800 }, () => undefined);
    await settle();
    expect(page.stops).toBe(1);
    expect(page.screencasts[1]).toEqual({ quality: 80 });   // one stream wants full size: no bound
    a();
    await settle();
    expect(page.screencasts[2]).toEqual({ quality: 80, maxWidth: 800 });
    expect(cast.watching).toBe(1);
    b();
    await settle();
    expect(page.stops).toBe(3);
    expect(page.screencasts).toHaveLength(3);
    b();   // twice is harmless
    expect(cast.watching).toBe(0);
  });

  it("frames carry their size, scale and viewport; each is acknowledged", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    const got: FrameEvent[] = [];
    cast.add({ quality: 60, fps: 30 }, (f) => got.push(f));
    await settle();
    page.frame(2560, 1600, 1280, 800, 7);
    expect(got[0]).toMatchObject({ type: "frame", seq: 1, format: "jpeg", width: 2560, height: 1600, scale: 2, viewport: { width: 1280, height: 800 }, pageScale: 1 });
    expect(page.acks).toEqual([7]);
    expect(cast.geometry()).toEqual({ scale: 2, width: 1280, height: 800 });
    page.frame(1280, 800, 1280, 800, 8);
    expect(cast.geometry(1)).toEqual({ scale: 2, width: 1280, height: 800 });
    expect(cast.geometry(2)).toEqual({ scale: 1, width: 1280, height: 800 });
    expect(cast.geometry(99)).toEqual({ scale: 1, width: 1280, height: 800 });
  });

  it("paces acks by the fastest stream", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    cast.add({ quality: 60, fps: 10 }, () => undefined);
    await settle();
    page.frame(100, 100, 100, 100, 1);
    expect(page.acks).toEqual([1]);
    page.frame(100, 100, 100, 100, 2);
    expect(page.acks).toEqual([1]);
    await vi.advanceTimersByTimeAsync(99);
    expect(page.acks).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.acks).toEqual([1, 2]);
  });

  it("each stream gets at most its own rate and always the latest frame", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    const slow: number[] = [];
    const fast: number[] = [];
    cast.add({ quality: 40, fps: 5 }, (f) => slow.push(f.seq));
    cast.add({ quality: 40, fps: 30 }, (f) => fast.push(f.seq));
    await settle();
    page.frame(10, 10);
    await vi.advanceTimersByTimeAsync(50);
    page.frame(10, 10);
    await vi.advanceTimersByTimeAsync(50);
    page.frame(10, 10);
    expect(slow).toEqual([1]);
    expect(fast).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(100);
    expect(slow).toEqual([1, 3]);   // frame 2 was replaced by 3 while waiting
  });

  it("a late stream gets the last frame at once; a stopped screencast forgets it", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    const stop = cast.add({ quality: 60, fps: 15 }, () => undefined);
    await settle();
    page.frame(20, 10);
    const late: number[] = [];
    cast.add({ quality: 60, fps: 15 }, (f) => late.push(f.seq))();
    expect(late).toEqual([1]);
    stop();
    await settle();
    const after: number[] = [];
    cast.add({ quality: 60, fps: 15 }, (f) => after.push(f.seq));
    expect(after).toEqual([]);
  });

  it("restart runs the screencast again with the same settings; a closed one does nothing", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    cast.restart();
    await settle();
    expect(page.screencasts).toEqual([]);
    cast.add({ quality: 50, fps: 10, maxWidth: 400, maxHeight: 300 }, () => undefined);
    await settle();
    cast.restart();
    await settle();
    expect(page.stops).toBe(1);
    expect(page.screencasts).toEqual([{ quality: 50, maxWidth: 400, maxHeight: 300 }, { quality: 50, maxWidth: 400, maxHeight: 300 }]);
    cast.close();
    page.frame(10, 10);
    cast.restart();
    await settle();
    expect(page.screencasts).toHaveLength(2);
    expect(page.acks).toEqual([]);
  });

  it("a frame without a readable header falls back to the viewport's size", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    const got: FrameEvent[] = [];
    cast.add({ quality: 60, fps: 30 }, (f) => got.push(f));
    await settle();
    (page as unknown as { listeners: { frame: ((f: unknown) => void)[] } }).listeners.frame.forEach((l) => l({ data: "AAAA", ackId: 1, metadata: { deviceWidth: 0, deviceHeight: 0, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 } }));
    expect(got[0]).toMatchObject({ width: 0, height: 0, scale: 1 });
  });

  it("a failing start is logged, not thrown", async () => {
    const page = new FakePage();
    page.startScreencast = async () => { throw new Error("target closed"); };
    const lines: string[] = [];
    const cast = new Screencast(page, Date.now, (l) => lines.push(l));
    cast.add({ quality: 60, fps: 30 }, () => undefined);
    await settle();
    expect(lines).toEqual(["browser: screencast: target closed"]);
  });
});
