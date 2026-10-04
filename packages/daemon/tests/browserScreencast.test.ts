/** One screencast shared by a tab's streams (docs/browser-v0.md §2 给 App): started with the first stream, restarted for
 *  better quality, stopped with the last; frames sized from the JPEG; acks paced by the fastest stream, however many
 *  frames are in flight; each stream at its own rate, ending on the latest frame; a late stream gets the last frame at
 *  once. Device pixels (§5): the scale a tab's view is drawn at for its streams, frames of a view drawn at a scale, a
 *  frame of the view before a change, which is not shown (told by its size, and by Chrome's stamp where the sizes are
 *  the same), and a frame of a view Chrome changed itself, which is not shown either and has the view drawn again.
 *  Page zoom (§1 页面缩放): the larger scales a screen asks for a page it zoomed in, up to 8, within the same limits,
 *  and the scales between quarters its steps fall on. The last picture of a burst (§5 回执: the screencast run again
 *  once the page is still) is in browserLastPicture.test.ts. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jpegSize, MAX_SCALE, MAX_VIEW_PIXELS, MAX_VIEW_SIDE, renderScale, Screencast, viewAt } from "../src/browser/screencast.js";
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
    expect(cast.geometry()).toEqual({ scale: 2, width: 1280, height: 800, view: 1 });
    page.frame(1280, 800, 1280, 800, 8);
    expect(cast.geometry(1)).toEqual({ scale: 2, width: 1280, height: 800, view: 1 });
    expect(cast.geometry(2)).toEqual({ scale: 1, width: 1280, height: 800, view: 1 });
    expect(cast.geometry(99)).toEqual({ scale: 1, width: 1280, height: 800, view: 1 });
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

  it("spaces acks by the fastest stream's interval when several frames are in flight", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    cast.add({ quality: 60, fps: 10 }, () => undefined);
    await settle();
    page.frame(100, 100, 100, 100, 1);
    page.frame(100, 100, 100, 100, 2);
    page.frame(100, 100, 100, 100, 3);
    expect(page.acks).toEqual([1]);
    await vi.advanceTimersByTimeAsync(100);
    expect(page.acks).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(99);
    expect(page.acks).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.acks).toEqual([1, 2, 3]);
    // Quiet for a while: the next frame is acknowledged at once.
    await vi.advanceTimersByTimeAsync(1_000);
    page.frame(100, 100, 100, 100, 4);
    expect(page.acks).toEqual([1, 2, 3, 4]);
  });

  // Review, 2026-10-03: with no stream there is no rate, and such a frame was paced at one a second, its turn left in
  // the queue. The Mac ends its stream and follows again at every zoom step: on a page that repaints, the stream that
  // came next had its acks wait a second for each such frame, and the picture stood still that long (Chrome 154:
  // 799 to 833 ms without a frame after 6 of 50 replacements, 68 to 72 ms after the others).
  it("a frame that comes while nobody watches is acknowledged at once and takes no turn: the next stream's acks do not wait behind it", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    const leave = cast.add({ quality: 60, fps: 10 }, () => undefined);
    await settle();
    page.frame(100, 100, 100, 100, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    // The last stream leaves; two frames Chrome had sent come before the stop has reached it.
    leave();
    page.frame(100, 100, 100, 100, 2);
    page.frame(100, 100, 100, 100, 3);
    expect(page.acks).toEqual([1, 2, 3]);
    await settle();
    // A stream 5 ms later: its first frame is acknowledged as it comes, the next an interval after it.
    await vi.advanceTimersByTimeAsync(5);
    cast.add({ quality: 60, fps: 10 }, () => undefined);
    await settle();
    page.frame(100, 100, 100, 100, 4);
    expect(page.acks).toEqual([1, 2, 3, 4]);
    page.frame(100, 100, 100, 100, 5);
    await vi.advanceTimersByTimeAsync(99);
    expect(page.acks).toEqual([1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.acks).toEqual([1, 2, 3, 4, 5]);
  });

  it("acks that wait their turn when the last stream leaves are not held up by a frame that comes after it", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    const leave = cast.add({ quality: 60, fps: 10 }, () => undefined);
    await settle();
    page.frame(100, 100, 100, 100, 1);
    page.frame(100, 100, 100, 100, 2);   // its turn is in 100 ms
    leave();
    page.frame(100, 100, 100, 100, 3);   // nobody watches: at once, before the one that waits
    expect(page.acks).toEqual([1, 3]);
    await vi.advanceTimersByTimeAsync(100);
    expect(page.acks).toEqual([1, 3, 2]);
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

  it("a view drawn at a scale: the screencast stops, the view changes, the screencast runs again; its frames are of the page at that scale", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    const got: FrameEvent[] = [];
    cast.add({ quality: 80, fps: 30 }, (f) => got.push(f));
    await settle();
    expect(cast.view).toBe(1);
    const steps: string[] = [];
    page.stopScreencast = async () => { steps.push("stop"); };
    page.startScreencast = async () => { steps.push("start"); };
    await cast.reconfigure(async () => { steps.push("view"); return { scale: 2, width: 2560, height: 1600 }; });
    expect(steps).toEqual(["stop", "view", "start"]);
    expect(cast.view).toBe(2);
    // Chrome's metadata is the view's size; the page's is half of it.
    page.frame(2560, 1600, 2560, 1600, 9);
    expect(got.at(-1)).toMatchObject({ width: 2560, height: 1600, scale: 2, viewport: { width: 1280, height: 800 } });
    expect(cast.geometry()).toEqual({ scale: 2, width: 1280, height: 800, view: 2 });
    // A frame made smaller (maxWidth): fewer pixels per CSS pixel, the same view.
    page.frame(1280, 800, 2560, 1600, 10);
    await vi.advanceTimersByTimeAsync(40);
    expect(got.at(-1)).toMatchObject({ seq: 2, scale: 1, viewport: { width: 1280, height: 800 } });
    expect(cast.geometry(got.at(-1)!.seq)).toEqual({ scale: 1, width: 1280, height: 800, view: 2 });
    // Back to the CSS size. The older frames keep their scale and size; a point on one goes in the view as it is now,
    // which is what Chrome takes it in (every step of a page zoom redraws the view, browser-v0 §1 页面缩放).
    await cast.reconfigure(async () => ({ scale: 1, width: 1280, height: 800 }));
    expect(cast.geometry()).toEqual({ scale: 1, width: 1280, height: 800, view: 1 });   // no frame of the new view yet
    page.frame(1280, 800, 1280, 800, 11);
    expect(cast.geometry()).toEqual({ scale: 1, width: 1280, height: 800, view: 1 });
    expect(cast.geometry(got.at(-2)!.seq)).toEqual({ scale: 2, width: 1280, height: 800, view: 1 });
  });

  // Page zoom (browser-v0 §1 页面缩放, 2026-10-03): a 3x phone with 402×690 points of browser area shows its page at 200%
  // as a 201×345 page drawn at 6, at 110% as a 365×627 page drawn at 3.304, at 125% as a 322×552 page drawn at 3.745.
  it("a page zoomed in: frames at the screen's pixels, the page's own size from the view's, whole or not", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    const got: FrameEvent[] = [];
    cast.add({ quality: 70, fps: 30, scale: 6.02, maxWidth: 1206, maxHeight: 2622 }, (f) => got.push(f));
    await settle();
    await cast.reconfigure(async () => viewAt({ width: 201, height: 345 }, 6));
    page.frame(1206, 2070, 1206, 2070, 3);
    expect(got.at(-1)).toMatchObject({ width: 1206, height: 2070, scale: 6, viewport: { width: 201, height: 345 } });
    expect(cast.geometry()).toEqual({ scale: 6, width: 201, height: 345, view: 6 });
    // 365×627 at 3.304 is a view of 1205.96×2071.6, drawn as 1206×2072.
    await cast.reconfigure(async () => viewAt({ width: 365, height: 627 }, 3.304));
    page.frame(1206, 2072, 1206, 2072, 4);
    await vi.advanceTimersByTimeAsync(40);
    expect(got.at(-1)).toMatchObject({ width: 1206, height: 2072, scale: 3.304, viewport: { width: 365, height: 627 } });
    expect(cast.geometry()).toEqual({ scale: 3.304, width: 365, height: 627, view: 3.304 });
    // 322×552 at 3.745 is 1205.89×2067.24, drawn as 1206×2067.
    await cast.reconfigure(async () => viewAt({ width: 322, height: 552 }, 3.745));
    page.frame(1206, 2067, 1206, 2067, 5);
    await vi.advanceTimersByTimeAsync(40);
    expect(got.at(-1)).toMatchObject({ width: 1206, height: 2067, scale: 3.745, viewport: { width: 322, height: 552 } });
  });

  it("the view of a viewport drawn at a scale is whole pixels, the CSS size at 1", () => {
    expect(viewAt({ width: 1280, height: 800 }, 1)).toEqual({ scale: 1, width: 1280, height: 800 });
    expect(viewAt({ width: 1280, height: 800 }, 2)).toEqual({ scale: 2, width: 2560, height: 1600 });
    expect(viewAt({ width: 365, height: 627 }, 3.3)).toEqual({ scale: 3.3, width: 1205, height: 2069 });
    expect(viewAt({ width: 900, height: 655 }, 2.2)).toEqual({ scale: 2.2, width: 1980, height: 1441 });
  });

  // Seen with Chrome 154 (2026-10-03) on a page that repaints all the time: after the screencast runs again, the first
  // frames may be ones Chrome captured before the view changed. Labelled with the new scale they would say a page
  // size that never was (the 402×690 page at 3, taken for a view at 3.745: "322×553"), and a screen would take that
  // for a change of the page's size.
  it("frames Chrome captured of the view before a change are acknowledged and never shown", async () => {
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    const got: FrameEvent[] = [];
    cast.add({ quality: 70, fps: 30, scale: 3.75, maxWidth: 1206, maxHeight: 2070 }, (f) => got.push(f));
    await settle();
    await cast.reconfigure(async () => viewAt({ width: 402, height: 690 }, 3));
    page.frame(1206, 2070, 1206, 2070, 1);
    expect(got).toHaveLength(1);
    await cast.reconfigure(async () => viewAt({ width: 322, height: 552 }, 3.745));
    page.frame(1206, 2070, 1206, 2070, 2);   // the 402×690 page at 3, sent late
    page.frame(1206, 2070, 1206, 2070, 3);
    expect(got).toHaveLength(1);
    // Not held back as the ack of a frame that was shown is: Chrome sends the new view's first frame the sooner.
    expect(page.acks).toEqual([1, 2, 3]);
    expect(cast.geometry()).toEqual({ scale: 3, width: 402, height: 690, view: 3.745 });
    page.frame(1206, 2067, 1206, 2067, 4);
    expect(page.acks).toEqual([1, 2, 3]);   // this one in its turn, an interval after the first
    await vi.advanceTimersByTimeAsync(40);
    expect(got).toHaveLength(2);
    expect(got.at(-1)).toMatchObject({ seq: 2, width: 1206, height: 2067, scale: 3.745, viewport: { width: 322, height: 552 } });
    expect(page.acks).toEqual([1, 2, 3, 4]);
    // A frame the screencast made smaller (maxWidth) is this view's too: the metadata says the view, not the JPEG.
    page.frame(603, 1034, 1206, 2067, 5);
    await vi.advanceTimersByTimeAsync(40);
    expect(got.at(-1)).toMatchObject({ seq: 3, width: 603, scale: 1.8725, viewport: { width: 322, height: 552 } });
  });

  // The same capture where the view before had the same size in pixels (review, 2026-10-03): a 3x phone's page at 90%
  // is 447×767 drawn at 2.697, at 80% 503×863 at 2.397, both 1206×2069. By its size it is the new view's, and it was
  // shown as the 503-wide page with the 447-wide one in it (Chrome 154: 9 such frames over 60 steps between the two).
  // Chrome stamps a frame when it sends it: one stamped before the change began is of the view before.
  it("a capture of the view before a change that has the new view's size is told by Chrome's stamp", async () => {
    const sent = (ms: number): number => (Date.now() - ms) / 1000;
    const page = new FakePage();
    const cast = new Screencast(page, Date.now, () => undefined);
    const got: FrameEvent[] = [];
    cast.add({ quality: 70, fps: 30, scale: 2.72, maxWidth: 1206, maxHeight: 2622 }, (f) => got.push(f));
    await settle();
    await cast.reconfigure(async () => viewAt({ width: 447, height: 767 }, 2.697));
    await vi.advanceTimersByTimeAsync(40);
    page.frame(1206, 2069, 1206, 2069, 1, sent(30));
    expect(got.at(-1)).toMatchObject({ seq: 1, scale: 2.697, viewport: { width: 447, height: 767 } });
    await vi.advanceTimersByTimeAsync(100);
    // Chrome takes 20 ms to draw the view.
    const redrawn = cast.reconfigure(async () => { await new Promise((r) => setTimeout(r, 20)); return viewAt({ width: 503, height: 863 }, 2.397); });
    await vi.advanceTimersByTimeAsync(20);
    await redrawn;
    await vi.advanceTimersByTimeAsync(5);
    page.frame(1206, 2069, 1206, 2069, 2, sent(60));   // sent 35 ms before the change began
    page.frame(1206, 2069, 1206, 2069, 3, sent(5.5));  // and half a millisecond before the view was drawn
    expect(got).toHaveLength(1);
    expect(page.acks).toEqual([1, 2, 3]);              // nobody takes them: acknowledged at once
    page.frame(1206, 2069, 1206, 2069, 4, sent(2));    // sent after it: the new view's
    await vi.advanceTimersByTimeAsync(40);
    expect(got.at(-1)).toMatchObject({ seq: 2, scale: 2.397, viewport: { width: 503, height: 863 } });
    // One more of the view before, later in coming than the new view's first frame: the order frames come in is not
    // relied on.
    page.frame(1206, 2069, 1206, 2069, 5, sent(50));
    await vi.advanceTimersByTimeAsync(40);
    expect(got).toHaveLength(2);
    expect(page.acks).toEqual([1, 2, 3, 4, 5]);
    page.frame(1206, 2069, 1206, 2069, 6, sent(10));
    await vi.advanceTimersByTimeAsync(40);
    expect(got.at(-1)).toMatchObject({ seq: 3, scale: 2.397, viewport: { width: 503, height: 863 } });
    // A Chrome that does not stamp its frames, and a stamp that cannot be the frame's own: by the size, as before.
    for (const stamp of [undefined, sent(5_000), sent(-60_000), Number.NaN]) {
      await cast.reconfigure(async () => viewAt({ width: 447, height: 767 }, 2.697));
      const before = got.length;
      page.frame(1206, 2069, 1206, 2069, 7, stamp);
      await vi.advanceTimersByTimeAsync(40);
      expect(got.length, String(stamp)).toBe(before + 1);
    }
  });

  // Chrome sets the view of a tab that becomes its window's front tab back to the window's size (review, 2026-10-03,
  // Chrome 154: a tab watched at 2 as 2560×1600 sent 1280×713 frames once a tab opened after it had closed, or after
  // `bringToFront`). Labelled with the scale drawn, such a frame said the top left 640×357 of the page was all of it.
  it("a frame of another size once the view's own have come: Chrome changed the view itself; not shown, and the view is drawn again", async () => {
    const page = new FakePage();
    const lines: string[] = [];
    let strays = 0;
    const cast = new Screencast(page, Date.now, (l) => lines.push(l), () => undefined, () => { strays += 1; });
    const got: FrameEvent[] = [];
    cast.add({ quality: 70, fps: 30, scale: 2 }, (f) => got.push(f));
    await settle();
    await cast.reconfigure(async () => viewAt({ width: 1280, height: 800 }, 2));
    page.frame(2560, 1600, 2560, 1600, 1);
    expect([got.length, strays]).toEqual([1, 0]);
    page.frame(1280, 713, 1280, 713, 2);
    page.frame(1280, 713, 1280, 713, 3);
    expect([got.length, strays]).toEqual([1, 1]);   // asked once
    expect(page.acks).toEqual([1, 2, 3]);           // nobody takes them: acknowledged at once
    // The host draws the view again (host.ts). What Chrome captured before that may still come first.
    await cast.reconfigure(async () => viewAt({ width: 1280, height: 800 }, 2));
    page.frame(1280, 713, 1280, 713, 4);
    page.frame(2560, 1600, 2560, 1600, 5);
    await vi.advanceTimersByTimeAsync(40);
    expect(got.map((f) => [f.seq, f.width, f.scale, f.viewport.width])).toEqual([[1, 2560, 2, 1280], [2, 2560, 2, 1280]]);
    expect(strays).toBe(1);
    // And again when Chrome changes it again.
    page.frame(1280, 713, 1280, 713, 6);
    expect([got.length, strays]).toEqual([2, 2]);
    expect(lines).toEqual([]);
  });

  // Seen with Chrome 154: a popup that resizes its own window (`resizeTo`) sends frames of the window's size from then
  // on. Where drawing the view again does not bring it back, they are shown as they come, as before.
  it("a view Chrome does not keep is drawn again once; with no frame of it in two seconds, frames are taken as they come", async () => {
    const page = new FakePage();
    const lines: string[] = [];
    let strays = 0;
    const cast = new Screencast(page, Date.now, (l) => lines.push(l), () => undefined, () => { strays += 1; });
    const got: FrameEvent[] = [];
    cast.add({ quality: 70, fps: 30, scale: 2 }, (f) => got.push(f));
    await settle();
    await cast.reconfigure(async () => viewAt({ width: 1280, height: 800 }, 2));
    page.frame(2560, 1600, 2560, 1600, 1);
    page.frame(600, 433, 600, 433, 2);
    expect([got.length, strays]).toEqual([1, 1]);
    await cast.reconfigure(async () => viewAt({ width: 1280, height: 800 }, 2));
    page.frame(600, 433, 600, 433, 3);
    await vi.advanceTimersByTimeAsync(1_999);
    page.frame(600, 433, 600, 433, 4);
    expect(got).toHaveLength(1);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    page.frame(600, 433, 600, 433, 5);
    page.frame(600, 433, 600, 433, 6);
    await vi.advanceTimersByTimeAsync(100);
    expect(got.map((f) => [f.seq, f.width, f.scale, f.viewport.width])).toEqual([[1, 2560, 2, 1280], [2, 600, 2, 300], [3, 600, 2, 300]]);
    expect(lines).toEqual(["browser: screencast: no frame of the 2560×1600 view within 2000 ms of drawing it; frames of 600×433 are taken as they come"]);
    expect(strays).toBe(1);   // not asked again: it was no use
    expect(page.acks).toHaveLength(6);
    // Drawn anew for another reason (a stream came): held back for the two seconds again, then as they come.
    await cast.reconfigure(async () => viewAt({ width: 1280, height: 800 }, 3));
    page.frame(600, 433, 600, 433, 7);
    await vi.advanceTimersByTimeAsync(2_000);
    page.frame(600, 433, 600, 433, 8);
    expect([got.length, strays, lines.length]).toEqual([4, 1, 2]);
    // A frame of the view drawn after all: from then on Chrome's own changes are looked for again.
    page.frame(3840, 2400, 3840, 2400, 9);
    page.frame(600, 433, 600, 433, 10);
    expect(strays).toBe(2);
  });

  it("a view drawn while nobody watched, and changed by Chrome since: the first frame of a stream that comes later says so", async () => {
    const page = new FakePage();
    const lines: string[] = [];
    let strays = 0;
    const cast = new Screencast(page, Date.now, (l) => lines.push(l), () => undefined, () => { strays += 1; });
    await cast.reconfigure(async () => viewAt({ width: 1280, height: 800 }, 1));
    await vi.advanceTimersByTimeAsync(60_000);
    const got: FrameEvent[] = [];
    cast.add({ quality: 70, fps: 30 }, (f) => got.push(f));
    await settle();
    page.frame(1280, 713, 1280, 713, 1);
    expect([got.length, strays]).toEqual([0, 1]);
    await cast.reconfigure(async () => viewAt({ width: 1280, height: 800 }, 1));
    page.frame(1280, 800, 1280, 800, 2);
    expect(got.map((f) => [f.width, f.height, f.viewport.height])).toEqual([[1280, 800, 800]]);
    expect(lines).toEqual([]);
  });

  it("where nobody could say what the view is, frames are taken as they come", async () => {
    const page = new FakePage();
    const lines: string[] = [];
    const cast = new Screencast(page, Date.now, (l) => lines.push(l));
    const got: FrameEvent[] = [];
    cast.add({ quality: 70, fps: 30 }, (f) => got.push(f));
    await settle();
    await cast.reconfigure(async () => viewAt({ width: 1280, height: 800 }, 2));
    page.frame(1280, 800, 1280, 800, 1);
    expect(got).toHaveLength(0);
    // A change that could not say what became of the view (null), and one that failed: the scale stays, any size goes.
    await cast.reconfigure(async () => null);
    page.frame(1280, 800, 1280, 800, 2);
    expect(got.at(-1)).toMatchObject({ seq: 1, width: 1280, scale: 2, viewport: { width: 640, height: 400 } });
    await cast.reconfigure(async () => viewAt({ width: 1280, height: 800 }, 2));
    await cast.reconfigure(async () => { throw new Error("target closed"); });
    page.frame(390, 844, 390, 844, 3);
    await vi.advanceTimersByTimeAsync(40);
    expect(got.at(-1)).toMatchObject({ seq: 2, width: 390, scale: 2 });
    expect(lines).toEqual(["browser: screencast: target closed"]);
    // Started again as it is: nothing is waited for either.
    await cast.reconfigure(async () => viewAt({ width: 1280, height: 800 }, 2));
    cast.restart();
    await cast.idle();
    page.frame(1280, 800, 1280, 800, 4);
    await vi.advanceTimersByTimeAsync(40);
    expect(got.at(-1)).toMatchObject({ seq: 3, width: 1280, scale: 2 });
    expect(cast.view).toBe(2);
  });

  it("a reconfigure with nobody watching only changes the view; streams coming and going are told", async () => {
    const page = new FakePage();
    let told = 0;
    const cast = new Screencast(page, Date.now, () => undefined, () => { told += 1; });
    await cast.reconfigure(async () => viewAt({ width: 1280, height: 800 }, 2));
    expect(page.screencasts).toEqual([]);
    expect(page.stops).toBe(0);
    expect(cast.view).toBe(2);
    const stop = cast.add({ quality: 60, fps: 15, scale: 2 }, () => undefined);
    expect(told).toBe(1);
    expect(cast.wants()).toEqual([{ quality: 60, fps: 15, scale: 2 }]);
    stop();
    expect(told).toBe(2);
    expect(cast.wants()).toEqual([]);
    await cast.idle();
  });

  it("a view that cannot change is logged; the screencast runs on", async () => {
    const page = new FakePage();
    const lines: string[] = [];
    const cast = new Screencast(page, Date.now, (l) => lines.push(l));
    cast.add({ quality: 60, fps: 30 }, () => undefined);
    await settle();
    await cast.reconfigure(async () => { throw new Error("target closed"); });
    expect(lines).toEqual(["browser: screencast: target closed"]);
    expect(cast.view).toBe(1);
    expect(page.stops).toBe(1);
    expect(page.screencasts).toHaveLength(2);
  });
});

describe("the scale a tab's view is drawn at", () => {
  const desk = { width: 1280, height: 800 };
  const phone = { width: 390, height: 844 };

  it("is what the streams' screens show, bounded by their frame size, the most of them, never under 1", () => {
    expect(renderScale(desk, [])).toBe(1);
    expect(renderScale(desk, [{ quality: 70, fps: 15 }])).toBe(1);
    expect(renderScale(desk, [{ quality: 80, fps: 15, scale: 2 }])).toBe(2);
    expect(renderScale(desk, [{ quality: 80, fps: 15, scale: 2, maxWidth: 3024, maxHeight: 1964 }])).toBe(2);
    // A phone on the local network: 3 for its own size, 1 for a desktop page it shows smaller than its screen.
    const lan = { quality: 70, fps: 15, scale: 3, maxWidth: 1170, maxHeight: 2532 };
    expect(renderScale(phone, [lan])).toBe(3);
    expect(renderScale(desk, [lan])).toBe(1);
    expect(renderScale(desk, [lan, { quality: 80, fps: 15, scale: 2 }])).toBe(2);
    // To a thousandth, rounded down: never more pixels than a screen asked for (2532 / 1280 is 1.978125).
    expect(renderScale(desk, [{ quality: 80, fps: 15, scale: 3, maxWidth: 2532 }])).toBe(1.978);
  });

  // Page zoom (browser-v0 §1 页面缩放, 2026-10-03): the screen that sizes a tab makes the page smaller to zoom in and asks
  // for its device pixels times the zoom. A 3x phone with 402×690 points of browser area (1206×2070 pixels) asks 6 at
  // 200%; the limit was 3 before.
  it("goes up to 8 for a page its screen zoomed in, as far as the screen's pixels hold it", () => {
    const zoomed = { quality: 70, fps: 15, scale: 6, maxWidth: 1206, maxHeight: 2070 };
    expect(renderScale({ width: 201, height: 345 }, [zoomed])).toBe(6);      // 200%
    expect(renderScale({ width: 804, height: 1380 }, [zoomed])).toBe(1.5);   // the same ask at 50%: the screen has no more
    expect(renderScale({ width: 1608, height: 2760 }, [zoomed])).toBe(1);    // at 25%: the CSS size, the frame made smaller
    // A 2x Mac at 400% asks 8; more than that is 8.
    const mac = { width: 320, height: 200 };
    expect(renderScale(mac, [{ quality: 80, fps: 15, scale: 8, maxWidth: 3024, maxHeight: 1964 }])).toBe(8);
    expect(renderScale(mac, [{ quality: 80, fps: 15, scale: 12 }])).toBe(8);
    expect(MAX_SCALE).toBe(8);
    // The most of several screens, as before: the phone at 200% and a Mac looking on at 2.
    expect(renderScale({ width: 201, height: 345 }, [zoomed, { quality: 80, fps: 15, scale: 2, maxWidth: 3024, maxHeight: 1964 }])).toBe(6);
  });

  // Most steps of the zoom fall between quarters, where the scale went in quarter steps until 2026-10-03: a 2x Mac at
  // 110% asked 2.2 and was drawn at 2, a 3x phone at 125% at 3.5, each stretched to its screen (a tenth, a
  // fourteenth) and soft. The view is drawn at what the screen holds, to a thousandth.
  // The asks are the phone's own (the Kit's BrowserPageZoom.streamScale and BrowserStreamPolicy, on the local network):
  // its 3 pixels a point times the zoom, 0.02 more where the page is zoomed and that is over 1, to the hundredth, within
  // the whole screen's 1206×2622 pixels. The 0.02 leaves the view to the screen's width: 1206 wide at every step.
  it("a zoom step between quarters is drawn at the screen's pixels, never more", () => {
    const screen = { quality: 70, fps: 15, maxWidth: 1206, maxHeight: 2622 };
    const steps: readonly (readonly [number, number, number, number, number])[] = [
      [201, 345, 6.02, 6, 2070],        // 200%
      [230, 394, 5.27, 5.243, 2066],    // 175%
      [268, 460, 4.52, 4.5, 2070],      // 150%
      [322, 552, 3.77, 3.745, 2067],    // 125%: 402 / 1.25 rounds up to 322, and the screen holds 1206 / 322 of that
      [365, 627, 3.32, 3.304, 2072],    // 110%: at 3.3 itself the view was 1205 wide
      [402, 690, 3, 3, 2070],           // 100%
      [447, 767, 2.72, 2.697, 2069],    // 90%
      [503, 863, 2.42, 2.397, 2069],    // 80%
      [536, 920, 2.27, 2.25, 2070],     // 75%
      [600, 1030, 2.03, 2.01, 2070],    // 67%: 1206 / 600 is 2.01, which times 1000 is 2009.9999999999998
      [804, 1380, 1.52, 1.5, 2070],     // 50%
    ];
    for (const [width, height, ask, drawn, high] of steps) {
      expect(renderScale({ width, height }, [{ ...screen, scale: ask }]), `${width}x${height}`).toBe(drawn);
      expect(viewAt({ width, height }, drawn), `${width}x${height}`).toEqual({ scale: drawn, width: 1206, height: high });
    }
    // At 33% and 25% the product is under 1 and no scale is asked: the CSS size, the frame made smaller.
    for (const [width, height] of [[1218, 2091], [1608, 2760]] as const) expect(renderScale({ width, height }, [screen])).toBe(1);
    // A 2x Mac at 110%: a 990×721 area holds a 900×655 page at 2.2, 1980×1441 of its 1980×1442 pixels; at 90% of a
    // 945×726 area a 1050×807 page at 1.8, 1890×1453.
    const mac = { quality: 80, fps: 15, maxWidth: 3024, maxHeight: 1964 };
    expect(renderScale({ width: 900, height: 655 }, [{ ...mac, scale: 2.2 }])).toBe(2.2);
    expect(viewAt({ width: 900, height: 655 }, 2.2)).toMatchObject({ width: 1980, height: 1441 });
    expect(renderScale({ width: 1050, height: 807 }, [{ ...mac, scale: 2 * 0.9 }])).toBe(1.8);
    expect(viewAt({ width: 1050, height: 807 }, 1.8)).toMatchObject({ width: 1890, height: 1453 });
    // What the Mac sends is a product (2 × 1.1 is 2.2, 3 × 1.1 would be 3.3000000000000003): the same.
    expect(renderScale({ width: 365, height: 627 }, [{ ...screen, maxWidth: 1206, maxHeight: 2070, scale: 3 * 1.1 }])).toBe(3.3);
    expect(renderScale({ width: 900, height: 655 }, [{ quality: 80, fps: 15, scale: 2 * 1.1 }])).toBe(2.2);
  });

  // A hundredth that is a little under itself as a number (2.01 × 1000 is 2009.9999999999998) is not drawn a
  // thousandth short of what was asked.
  it("an ask to the hundredth is drawn at that hundredth", () => {
    for (const ask of [2.01, 2.03, 4.02, 4.06, 1.1, 2.2, 3.3, 5.27, 6.02]) {
      expect(renderScale({ width: 300, height: 400 }, [{ quality: 70, fps: 15, scale: ask }]), String(ask)).toBe(ask);
    }
  });

  it("keeps the view within its pixel limits", () => {
    expect(renderScale({ width: 2560, height: 1440 }, [{ quality: 80, fps: 15, scale: 2 }])).toBe(1.581);   // 3840×2400 pixels in all
    const s = renderScale({ width: 1800, height: 1100 }, [{ quality: 80, fps: 15, scale: 2 }]);
    expect(1800 * s * 1100 * s).toBeLessThanOrEqual(MAX_VIEW_PIXELS);
    expect(renderScale({ width: 3000, height: 300 }, [{ quality: 80, fps: 15, scale: 2 }])).toBe(1.365);    // 4095 wide
    expect(renderScale({ width: 0, height: 0 }, [{ quality: 80, fps: 15, scale: 2 }])).toBe(1);
    // A page larger than the limits at its CSS size is drawn at that size, not smaller: 4096×4096 is 16.8 million pixels.
    expect(renderScale({ width: 4096, height: 4096 }, [{ quality: 80, fps: 15, scale: 2 }])).toBe(1);
    expect(renderScale({ width: 4096, height: 4096 }, [])).toBe(1);
  });

  it("the pixel limits bound the larger asks too: 4096 a side, 3840×2400 in all", () => {
    const most = [{ quality: 80, fps: 15, scale: 8 }];
    expect(renderScale(desk, most)).toBe(3);                                // 3840×2400
    expect(renderScale(desk, [{ quality: 80, fps: 15, scale: 9 }])).toBe(3);
    expect(renderScale({ width: 1000, height: 200 }, most)).toBe(4.096);    // 4096 wide
    expect(renderScale({ width: 600, height: 400 }, most)).toBe(6.196);     // 3718×2478: 9.2 million pixels
    // The view as it is drawn, in whole pixels: 1250×1734 at 2.062 would be 2578×3576, 2928 pixels too many.
    expect(renderScale({ width: 1250, height: 1734 }, most)).toBe(2.061);
    const sizes = [desk, phone, { width: 201, height: 345 }, { width: 520, height: 300 }, { width: 4096, height: 200 }, { width: 200, height: 4096 }, { width: 2048, height: 2048 },
      { width: 1250, height: 1734 }];
    for (const viewport of sizes) {
      const drawn = renderScale(viewport, most);
      const view = viewAt(viewport, drawn);
      expect(Math.round(drawn * 1000) / 1000, JSON.stringify(viewport)).toBe(drawn);
      expect([view.width <= MAX_VIEW_SIDE, view.height <= MAX_VIEW_SIDE, view.width * view.height <= MAX_VIEW_PIXELS], JSON.stringify(viewport)).toEqual([true, true, true]);
      expect(viewport.width * drawn, JSON.stringify(viewport)).toBeLessThanOrEqual(MAX_VIEW_SIDE);
      expect(viewport.height * drawn, JSON.stringify(viewport)).toBeLessThanOrEqual(MAX_VIEW_SIDE);
      expect(viewport.width * drawn * viewport.height * drawn, JSON.stringify(viewport)).toBeLessThanOrEqual(MAX_VIEW_PIXELS);
    }
    // A small page gets all 8: 1608×2760.
    expect(renderScale({ width: 201, height: 345 }, most)).toBe(8);
  });
});
