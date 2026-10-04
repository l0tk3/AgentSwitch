/** The last picture of a burst (docs/browser-v0.md §5 回执, 2026-10-03), on a fake Chrome. Chrome sends nothing it
 *  captures while three frames wait for their acknowledgement, and does not send that capture later. With the acks
 *  paced (browserScreencast.test.ts), a page that changed fast and then stopped left the screens on an earlier picture:
 *  with Chrome 154, a stream at 15 frames a second, a scroll of 30 animation frames ended 14 to 28 px short of the page
 *  on the last frame in 22 of 24 runs, and a stop and start then brought the page as it was, as one frame, in 24 of 24
 *  (40 of 40 starts on a still page sent exactly one frame). So a frame that Chrome sent while another's ack was
 *  waiting may not be the page's last capture, and once the acks have gone and no frame has come for a moment, the
 *  screencast is run again: once, in its turn among the screencast's other changes, never for a page that keeps
 *  changing, never after a run's first two frames, never once the tab or its last stream is gone. */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserHost } from "../src/browser/host.js";
import type { FileRules } from "../src/browser/rules.js";
import { Screencast, viewAt } from "../src/browser/screencast.js";
import { YOU, type FrameEvent } from "../src/browser/types.js";
import { defaultProtected } from "../src/executors/protected.js";
import { FakeDriver, FakePage } from "./fakeBrowser.js";

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("the last picture of a burst", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  /** One stream at `fps` frames a second (10: an ack every 100 ms) on a running screencast. */
  const watched = async (fps = 10) => {
    const page = new FakePage();
    const lines: string[] = [];
    const cast = new Screencast(page, Date.now, (l) => lines.push(l));
    const leave = cast.add({ quality: 60, fps }, () => undefined);
    await settle();
    return { page, cast, leave, lines };
  };
  /** How often the page's screencast was stopped, and how often started. */
  const runs = (page: FakePage): [number, number] => [page.stops, page.screencasts.length];
  /** Three frames at once, acknowledged as `from`, `from + 1`, `from + 2`: the first at once (no ack is waiting), the
   *  second an interval later, and the third came while the second's ack was waiting. */
  const burst = (page: FakePage, from: number): void => { for (let i = 0; i < 3; i++) page.frame(100, 100, 100, 100, from + i); };

  it("frames that came while an ack was waiting, then stillness: run again once, after the acks have gone and the quiet time has passed", async () => {
    const { page, lines } = await watched();
    burst(page, 1);
    await vi.advanceTimersByTimeAsync(200);
    expect(page.acks).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(149);
    expect(runs(page)).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs(page)).toEqual([1, 2]);
    expect(page.screencasts[1]).toEqual({ quality: 60 });
    // Chrome sends the picture as it is when a screencast starts, as one frame: it comes alone, and nothing follows.
    page.frame(100, 100, 100, 100, 4);
    expect(page.acks).toEqual([1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs(page)).toEqual([1, 2]);
    expect(lines).toEqual([]);
  });

  it("a frame within the quiet time puts it off: for good when it came alone, until the acks have gone and the page is quiet again when more came with it", async () => {
    const { page } = await watched();
    burst(page, 1);
    await vi.advanceTimersByTimeAsync(300);   // the acks went at 200: 50 ms of the quiet time are left
    // Chrome's own frame, captured after the last ack reached it: the picture is the page's again.
    page.frame(100, 100, 100, 100, 4);
    expect(page.acks).toEqual([1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs(page)).toEqual([0, 1]);
    // The same, and two more frames with it: the last of them came while an ack was waiting.
    burst(page, 5);
    await vi.advanceTimersByTimeAsync(300);
    burst(page, 8);
    await vi.advanceTimersByTimeAsync(50);    // where the first quiet time would have ended
    expect(runs(page)).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(150);
    expect(page.acks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await vi.advanceTimersByTimeAsync(149);
    expect(runs(page)).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs(page)).toEqual([1, 2]);
  });

  it("frames that never came while an ack was waiting: never", async () => {
    const { page } = await watched();
    // One every interval, each acknowledged at once.
    for (let id = 1; id <= 20; id++) {
      page.frame(100, 100, 100, 100, id);
      expect(page.acks).toHaveLength(id);
      await vi.advanceTimersByTimeAsync(100);
    }
    // Two at once: the second's ack waits its interval, and nothing came while it did. Chrome has sent every capture.
    page.frame(100, 100, 100, 100, 21);
    page.frame(100, 100, 100, 100, 22);
    expect(page.acks).toHaveLength(21);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.acks).toHaveLength(22);
    expect(runs(page)).toEqual([0, 1]);
  });

  it("a page that keeps changing: never while its frames keep coming, once when it stops", async () => {
    const { page } = await watched();
    // Chrome on a page that repaints all the time: a capture every 16 ms, sent unless three frames wait for their
    // acks, dropped for good otherwise.
    let sent = 0;
    for (let t = 0; t < 2_000; t += 16) {
      if (sent - page.acks.length < 3) page.frame(100, 100, 100, 100, ++sent);
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(sent).toBeGreaterThanOrEqual(20);   // an ack, and so a frame, every 100 ms
    expect(sent).toBeLessThanOrEqual(24);
    expect(runs(page)).toEqual([0, 1]);
    // The page stops. Its last capture may be one of those dropped.
    while (page.acks.length < sent) await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(149);
    expect(runs(page)).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs(page)).toEqual([1, 2]);
    page.frame(100, 100, 100, 100, ++sent);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs(page)).toEqual([1, 2]);
  });

  it("a run begun meanwhile counts from zero, as Chrome does: the acks of the run before are sent and not counted", async () => {
    const { page, cast } = await watched();
    burst(page, 1);
    await vi.advanceTimersByTimeAsync(10);
    cast.restart();
    await cast.idle();
    expect(runs(page)).toEqual([1, 2]);
    // Three frames of the new run, the third while the acks of the first two were waiting. Their acks take their
    // turns after the two of the run before that are still to go: at 300, 400 and 500.
    burst(page, 4);
    await vi.advanceTimersByTimeAsync(190);
    expect(page.acks).toEqual([1, 2, 3]);
    // Counted against the new run, the acks that went at 100 and 200 would have left none waiting at 300, and the
    // quiet time would have ended at 450.
    await vi.advanceTimersByTimeAsync(299);
    expect(page.acks).toEqual([1, 2, 3, 4, 5]);
    expect(runs(page)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.acks).toEqual([1, 2, 3, 4, 5, 6]);
    await vi.advanceTimersByTimeAsync(149);
    expect(runs(page)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs(page)).toEqual([2, 3]);
  });

  it("a run's first two frames are behind nothing: Chrome counts from zero and sends a third before it holds any back", async () => {
    const { page, cast } = await watched();
    // Started again while a burst's acks are waiting: the new run's frames wait their turn behind those.
    burst(page, 1);
    await vi.advanceTimersByTimeAsync(10);
    cast.restart();
    await cast.idle();
    page.frame(100, 100, 100, 100, 4);
    page.frame(100, 100, 100, 100, 5);   // while the ack of 4 was waiting, and the run's second
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.acks).toEqual([1, 2, 3, 4, 5]);
    expect(runs(page)).toEqual([1, 2]);
    // The third is the first after which Chrome may have dropped something.
    const other = await watched();
    burst(other.page, 1);
    await vi.advanceTimersByTimeAsync(10);
    other.cast.restart();
    await other.cast.idle();
    burst(other.page, 4);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs(other.page)).toEqual([2, 3]);
  });

  it("a start brings the picture itself: nothing is due after one", async () => {
    const { page, cast } = await watched();
    // Run again by hand within the burst's acks, and redrawn within its quiet time.
    burst(page, 1);
    await vi.advanceTimersByTimeAsync(10);
    cast.restart();
    await cast.idle();
    page.frame(100, 100, 100, 100, 4);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.acks).toEqual([1, 2, 3, 4]);
    expect(runs(page)).toEqual([1, 2]);
    burst(page, 5);
    await vi.advanceTimersByTimeAsync(300);
    await cast.reconfigure(async () => viewAt({ width: 100, height: 100 }, 1));
    expect(runs(page)).toEqual([2, 3]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs(page)).toEqual([2, 3]);
  });

  it("captures of the view before a change, acknowledged at once, are not counted", async () => {
    const { page, cast } = await watched();
    await cast.reconfigure(async () => viewAt({ width: 200, height: 200 }, 1));
    burst(page, 1);                          // the 100×100 view before, sent late
    expect(page.acks).toEqual([1, 2, 3]);
    page.frame(200, 200, 200, 200, 4);       // the new view's first frame
    page.frame(200, 200, 200, 200, 5);       // and one more: its ack waits, nothing came while it did
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.acks).toEqual([1, 2, 3, 4, 5]);
    expect(runs(page)).toEqual([1, 2]);
  });

  it("nothing after the tab closed", async () => {
    const { page, cast } = await watched();
    burst(page, 1);
    await vi.advanceTimersByTimeAsync(300);
    cast.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs(page)).toEqual([0, 1]);
    // Closed while the acks were still waiting.
    const other = await watched();
    burst(other.page, 1);
    other.cast.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(other.page.acks).toEqual([1]);
    expect(runs(other.page)).toEqual([0, 1]);
    // Closed while it is being run again: stopped, and not started on a page that is gone.
    const late = await watched();
    burst(late.page, 1);
    late.page.stopScreencast = async () => { late.page.stops += 1; late.cast.close(); };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs(late.page)).toEqual([1, 1]);
    expect(late.lines).toEqual([]);
  });

  it("nothing once the last stream left", async () => {
    // Within the quiet time: the screencast is stopped for want of a stream, and stays so.
    const { page, cast, leave } = await watched();
    burst(page, 1);
    await vi.advanceTimersByTimeAsync(300);
    leave();
    await cast.idle();
    expect(runs(page)).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs(page)).toEqual([1, 1]);
    // While the acks were still waiting: they are sent, and that is all.
    const other = await watched();
    burst(other.page, 1);
    other.leave();
    await other.cast.idle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(other.page.acks).toEqual([1, 2, 3]);
    expect(runs(other.page)).toEqual([1, 1]);
    // A stream that comes later starts the screencast, which brings the picture.
    other.cast.add({ quality: 60, fps: 10 }, () => undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs(other.page)).toEqual([1, 2]);
  });

  it("it takes its turn among the screencast's changes: whoever waits for them waits for it, a change asked meanwhile comes after it", async () => {
    const { page, cast } = await watched();
    burst(page, 1);
    const steps: string[] = [];
    let stopped: () => void = () => undefined;
    page.stopScreencast = () => { steps.push("stop"); return new Promise<void>((r) => { stopped = r; }); };
    page.startScreencast = async () => { steps.push("start"); };
    await vi.advanceTimersByTimeAsync(350);
    expect(steps).toEqual(["stop"]);
    // A point of input waits for `idle` (host.ts); a redraw is queued.
    void cast.idle().then(() => steps.push("idle"));
    const redraw = cast.reconfigure(async () => { steps.push("view"); return null; });
    await settle();
    expect(steps).toEqual(["stop"]);
    stopped();
    await settle();
    expect(steps).toEqual(["stop", "start", "idle", "stop"]);
    stopped();
    await redraw;
    expect(steps).toEqual(["stop", "start", "idle", "stop", "view", "start"]);
  });

  it("a change under way when the quiet time ends starts the screencast itself: no second start", async () => {
    const { page, cast } = await watched();
    let drawn: () => void = () => undefined;
    const redraw = cast.reconfigure(() => new Promise((r) => { drawn = () => r(null); }));
    await settle();
    expect(runs(page)).toEqual([1, 1]);
    // What Chrome still had to send when it was stopped; the view is a while in the drawing.
    burst(page, 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.acks).toEqual([1, 2, 3]);
    expect(runs(page)).toEqual([1, 1]);
    drawn();
    await redraw;
    expect(runs(page)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs(page)).toEqual([1, 2]);
  });

  it("a failing stop or start is logged, and nothing is tried again", async () => {
    const { page, lines } = await watched();
    burst(page, 1);
    page.stopScreencast = async () => { page.stops += 1; throw new Error("not attached"); };
    page.startScreencast = async () => { throw new Error("target closed"); };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.stops).toBe(1);
    expect(lines).toEqual(["browser: screencast: target closed"]);
  });

  // Where a frame takes longer to come than the acks are apart, a frame Chrome sent while two acks were out comes
  // after they have gone. Taken as it came, alone, the last picture stayed lost: with Chrome 154, after 5 of 16
  // bursts at 30 frames a second on a 3840×2400 view (a frame came 67 ms after Chrome sent it in the middle, the acks
  // are 33 ms apart), 1 of 16 at 30 on a 2560×1600 view, 1 of 16 at 15 on a 3840×2400 view (that frame took 143 ms).
  // Chrome stamps a frame when it sends it: whether another's ack was waiting is asked of that moment.
  describe("by the moment Chrome sent a frame", () => {
    /** Chrome's stamp of a frame it sent `ms` ago: seconds since 1970. */
    const sent = (ms: number): number => (Date.now() - ms) / 1000;

    it("a frame that came after the last ack had gone, sent before it went: the picture may be behind", async () => {
      const { page } = await watched();
      burst(page, 1);
      await vi.advanceTimersByTimeAsync(240);          // the acks went at 0, 100 and 200
      page.frame(100, 100, 100, 100, 4, sent(60));     // sent at 180, 60 ms in coming: no ack is waiting by then
      await vi.advanceTimersByTimeAsync(60);
      expect(page.acks).toEqual([1, 2, 3, 4]);         // its turn was at 300
      await vi.advanceTimersByTimeAsync(149);
      expect(runs(page)).toEqual([0, 1]);
      await vi.advanceTimersByTimeAsync(1);
      expect(runs(page)).toEqual([1, 2]);
      // Sent in the very millisecond the last ack went (Chrome's stamp is to the microsecond, this clock to the
      // millisecond): the ack had not reached Chrome.
      for (const ago of [40, 39.6]) {
        const other = await watched();
        burst(other.page, 1);
        await vi.advanceTimersByTimeAsync(240);
        other.page.frame(100, 100, 100, 100, 4, sent(ago));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(runs(other.page), String(ago)).toEqual([1, 2]);
      }
    });

    it("a frame sent after the last ack went is the page's picture then: nothing is due", async () => {
      const { page } = await watched();
      burst(page, 1);
      await vi.advanceTimersByTimeAsync(240);
      page.frame(100, 100, 100, 100, 4, sent(30));     // sent at 210
      await vi.advanceTimersByTimeAsync(5_000);
      expect(page.acks).toEqual([1, 2, 3, 4]);
      expect(runs(page)).toEqual([0, 1]);
    });

    it("frames one by one, each longer in coming than the acks are apart: never while they keep coming, once when they stop", async () => {
      const { page } = await watched();
      // One every 100 ms, 130 ms in coming: Chrome sent each before the ack of the one before went.
      for (let id = 1; id <= 10; id++) {
        page.frame(100, 100, 100, 100, id, sent(130));
        expect(page.acks).toHaveLength(id);            // acknowledged as it came: none was waiting
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(49);
      expect(runs(page)).toEqual([0, 1]);
      await vi.advanceTimersByTimeAsync(1);
      expect(runs(page)).toEqual([1, 2]);
      // The same frames 30 ms in coming: each was sent after the ack of the one before went.
      const quick = await watched();
      for (let id = 1; id <= 10; id++) {
        quick.page.frame(100, 100, 100, 100, id, sent(30));
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runs(quick.page)).toEqual([0, 1]);
    });

    it("a run's first two frames are behind nothing, whenever they were sent: running it again cannot lead to running it again", async () => {
      const { page } = await watched();
      burst(page, 1);
      await vi.advanceTimersByTimeAsync(350);
      expect(runs(page)).toEqual([1, 2]);
      // A capture from before the start, 170 ms in coming (sent before the last ack of the run before went, which
      // Chrome does not count against this run), and the start's own frame, sent before the ack of that one went.
      await vi.advanceTimersByTimeAsync(10);
      page.frame(100, 100, 100, 100, 4, sent(170));
      await vi.advanceTimersByTimeAsync(10);
      page.frame(100, 100, 100, 100, 5, sent(15));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(page.acks).toEqual([1, 2, 3, 4, 5]);
      expect(runs(page)).toEqual([1, 2]);
    });

    it("a capture of the view before a change is a frame of the run too", async () => {
      // Two of them, 30 ms after the view was drawn, acknowledged at once and not shown; the new view's first frame, the
      // run's third, was sent 15 ms before those acks went (and 15 ms after the view was drawn: it is the new view's).
      const { page, cast } = await watched();
      await cast.reconfigure(async () => viewAt({ width: 200, height: 200 }, 1));
      await vi.advanceTimersByTimeAsync(30);
      page.frame(100, 100, 100, 100, 1, sent(50));
      page.frame(100, 100, 100, 100, 2, sent(50));
      await vi.advanceTimersByTimeAsync(10);
      page.frame(200, 200, 200, 200, 3, sent(25));
      expect(page.acks).toEqual([1, 2, 3]);
      await vi.advanceTimersByTimeAsync(149);
      expect(runs(page)).toEqual([1, 2]);
      await vi.advanceTimersByTimeAsync(1);
      expect(runs(page)).toEqual([2, 3]);
      // One of them: the new view's first frame is the run's second.
      const other = await watched();
      const shown: number[] = [];
      other.cast.add({ quality: 60, fps: 10 }, (f) => shown.push(f.width));
      await other.cast.reconfigure(async () => viewAt({ width: 200, height: 200 }, 1));
      await vi.advanceTimersByTimeAsync(30);
      other.page.frame(100, 100, 100, 100, 1, sent(50));
      await vi.advanceTimersByTimeAsync(10);
      other.page.frame(200, 200, 200, 200, 2, sent(25));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(shown).toEqual([200]);
      expect(runs(other.page)).toEqual([1, 2]);
    });

    it("a stamp that cannot be the frame's own is not believed: the frame is taken as it came", async () => {
      // Seconds old, of another clock, ahead of this one, not a number.
      const stamps = [() => sent(5_000), () => 5, () => sent(-60_000), () => Number.NaN];
      for (const stamp of stamps) {
        const { page } = await watched();
        burst(page, 1);
        await vi.advanceTimersByTimeAsync(240);
        page.frame(100, 100, 100, 100, 4, stamp());
        await vi.advanceTimersByTimeAsync(5_000);
        expect(runs(page), String(stamp())).toEqual([0, 1]);
      }
    });
  });

  // A phone on a slow connection asks 5 frames a second: an ack every 200 ms, longer than the quiet time.
  it("at a rate slower than the quiet time: the picture it brings waits for its ack's turn, and nothing follows", async () => {
    const { page } = await watched(5);
    burst(page, 1);
    // The quiet time is counted from the last ack: 150 ms after the second went (at 200) the third is still waiting,
    // and Chrome may be holding back what a page that keeps changing has to show.
    await vi.advanceTimersByTimeAsync(399);
    expect(page.acks).toEqual([1, 2]);
    expect(runs(page)).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.acks).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(149);
    expect(runs(page)).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs(page)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(10);
    page.frame(100, 100, 100, 100, 4);
    expect(page.acks).toEqual([1, 2, 3]);   // its turn is at 600
    // Were Chrome to send a second frame at a start, it would come while that ack is waiting: the run's second.
    await vi.advanceTimersByTimeAsync(10);
    page.frame(100, 100, 100, 100, 5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.acks).toEqual([1, 2, 3, 4, 5]);
    expect(runs(page)).toEqual([1, 2]);
  });
});

// On a tab of the host: the same, as one of the tab's screencast's changes, which a point of input waits for as for a
// redraw (host.ts `input`). Real timers: the acks go within 67 ms, the quiet time is 150 ms.
describe("the last picture of a burst, on a tab", () => {
  const hosts: BrowserHost[] = [];
  afterEach(async () => { for (const h of hosts.splice(0)) await h.shutdown(); });

  it("the tab's screencast is run again once the page is still, and a tap sent meanwhile waits for that", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-browser-last-")));
    const files: FileRules = { protected: defaultProtected({ HOME: home, AGENTSWITCH_HOME: join(home, ".agentswitch"), SECRET_GATE_HOME: join(home, ".secret-gate") }), home };
    const driver = new FakeDriver();
    const host = new BrowserHost({ driver, profileDir: join(home, "profile"), files, ownPorts: () => [], log: () => undefined, mac: true });
    hosts.push(host);
    const tab = await host.open(YOU, "https://a.example/");
    const p = driver.page(0);
    const frames: FrameEvent[] = [];
    host.subscribe(tab.id, { quality: 80, fps: 30 }, (e) => { if (e.type === "frame") frames.push(e); });
    await vi.waitFor(() => expect(p.screencasts).toHaveLength(1));
    // Chrome takes a while to stop a screencast.
    let asked = false;
    let stopped: () => void = () => undefined;
    const stop = p.stopScreencast.bind(p);
    p.stopScreencast = async () => { asked = true; await new Promise<void>((r) => { stopped = r; }); return stop(); };
    // Three frames at once: the third came while the second's ack was waiting.
    for (let id = 1; id <= 3; id++) p.frame(1280, 800, 1280, 800, id);
    expect(frames).toHaveLength(1);
    await vi.waitFor(() => expect(asked).toBe(true));
    expect(p.acks).toEqual([1, 2, 3]);
    const sent = host.input(tab.id, "mac-1", [{ type: "mouse", action: "click", x: 100, y: 60, button: "left", clickCount: 1, modifiers: [] }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(p.inputs).toEqual([]);
    stopped();
    await sent;
    expect(p.inputs.map((c) => c.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect([p.stops, p.screencasts.length]).toEqual([1, 2]);
    // What the start brings comes alone: nothing follows.
    p.frame(1280, 800, 1280, 800, 4);
    await new Promise((r) => setTimeout(r, 300));
    expect([p.stops, p.screencasts.length]).toEqual([1, 2]);
    expect(frames.at(-1)!.seq).toBe(4);
  });
});
