/** A tab's view as the host drew it and as Chrome has it (docs/browser-v0.md §5 页面缩放之后), on a fake Chrome. What
 *  waits for a redraw under way besides a tap (browserHost.test.ts): a wheel, and an agent's call that may point at the
 *  page; where a point goes before any frame has come. And the view Chrome changed itself (a tab that became its
 *  window's front tab is set back to the window's size), which the host draws again: at once on a tab no agent's call
 *  is running on, after the call on one where it is. */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserHost, type BrowserHostOptions } from "../src/browser/host.js";
import type { FileRules } from "../src/browser/rules.js";
import { DEFAULT_VIEWPORT, YOU, type FrameEvent, type TabOwner } from "../src/browser/types.js";
import { defaultProtected } from "../src/executors/protected.js";
import { FakeDriver, slowAnswer, type FakePage } from "./fakeBrowser.js";

const CODEX: TabOwner = { kind: "terminal", id: "t1", label: "codex · AgentSwitch" };
/** A 3x phone's stream: within its screen's 1206×2622 pixels. */
const PHONE = { quality: 70, fps: 30, maxWidth: 1206, maxHeight: 2622 };

const hosts: BrowserHost[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.shutdown(); });

const settled = () => new Promise((r) => setTimeout(r, 20));
const click = (x: number, y: number) => ({ type: "mouse" as const, action: "click" as const, x, y, button: "left" as const, clickCount: 1, modifiers: [] });

/** A tab of `owner`'s on a fake Chrome, its page, and the frames that reach a stream asking `ask`. */
async function watched(owner: TabOwner, ask: { quality: number; fps: number; scale?: number }, over: Partial<BrowserHostOptions> = {}): Promise<{ host: BrowserHost; driver: FakeDriver; tab: string; p: FakePage; frames: FrameEvent[] }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-browser-view-")));
  const files: FileRules = { protected: defaultProtected({ HOME: home, AGENTSWITCH_HOME: join(home, ".agentswitch"), SECRET_GATE_HOME: join(home, ".secret-gate") }), home };
  const driver = new FakeDriver();
  const host = new BrowserHost({ driver, profileDir: join(home, "profile"), files, ownPorts: () => [], log: () => undefined, mac: true, ...over });
  hosts.push(host);
  const tab = await host.open(owner, "https://a.example/");
  const p = driver.page(0);
  const frames: FrameEvent[] = [];
  host.subscribe(tab.id, ask, (e) => { if (e.type === "frame") frames.push(e); });
  await vi.waitFor(() => expect(p.renders.at(-1)).toBe(ask.scale ?? 1));
  await settled();
  return { host, driver, tab: tab.id, p, frames };
}

describe("what waits for a redraw of the view, and what goes by the view as drawn", () => {
  // Review, 2026-10-03: a wheel sent during a redraw was mapped by the view before it where only a tap waited.
  it("a wheel sent while the view is being redrawn waits for that, and goes in the view Chrome has by then", async () => {
    // A phone holding its page at 200% (201×345), its stream asking 3, the last frame it has at 3.
    const { host, tab, p } = await watched(YOU, { quality: 80, fps: 30 });
    host.take(tab, "phone-1");
    await host.setViewport(tab, "phone-1", { width: 201, height: 345, scale: 4, mobile: true });
    host.subscribe(tab, { ...PHONE, scale: 3 }, () => undefined);
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(3));
    await settled();
    p.frame(603, 1035, 603, 1035);
    const answer = slowAnswer(p, 6);
    host.subscribe(tab, { ...PHONE, scale: 6.02 }, () => undefined);
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(6));
    // CSS (100, 140) on the frame at 3, a drag of 300 frame pixels.
    const sent = host.input(tab, "phone-1", [{ type: "wheel", x: 300, y: 420, deltaX: 0, deltaY: 300, modifiers: [] }]);
    await settled();
    expect(p.inputs).toEqual([]);
    answer();
    await sent;
    expect(p.inputs.map((c) => [c.params.type, c.params.x, c.params.y, c.params.deltaY])).toEqual([["mouseWheel", 600, 840, 100]]);
  });

  // The same review: an agent's call that began during a redraw at a scale looked at the view as recorded, still the
  // CSS size, and ran while Chrome drew the tab at 2, where Playwright's points miss.
  it("an agent's call that begins while its tab is being redrawn at a scale waits for that, and has the tab at the CSS size", async () => {
    const { host, tab, p } = await watched(CODEX, { quality: 80, fps: 15 });
    const answer = slowAnswer(p, 2);
    host.subscribe(tab, { quality: 80, fps: 15, scale: 2 }, () => undefined);
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(2));
    let begun = false;
    const call = host.agentActing(CODEX).then(() => { begun = true; });
    await settled();
    expect([begun, p.renders.at(-1)]).toEqual([false, 2]);
    answer();
    await call;
    expect(p.renders.at(-1)).toBe(1);
    host.agentDone(CODEX);
  });

  it("a point sent before any frame has come goes in the view as it is drawn", async () => {
    const { host, tab, p } = await watched(YOU, { quality: 80, fps: 15, scale: 2 });
    await host.input(tab, "mac-1", [click(100, 60), { type: "wheel", x: 100, y: 60, deltaX: 0, deltaY: 30, modifiers: [] }]);
    expect(p.inputs.at(-2)!.params).toMatchObject({ type: "mouseReleased", x: 200, y: 120 });
    expect(p.inputs.at(-1)!.params).toMatchObject({ type: "mouseWheel", x: 200, y: 120, deltaY: 30 });
  });
});

// Review, 2026-10-03, Chrome 154: a tab that becomes its window's front tab (a tab opened after it closed, a popup of
// its own, `bringToFront`) has its view set to the window's 1280×713 by Chrome; the page keeps its size. A tab watched
// at 2 then sent 1280×713 frames, which said the top left 640×357 of the page was all of it, until something had the
// view drawn again.
describe("a view Chrome changed itself", () => {
  it("is drawn again when a frame of another size says so; that frame reaches nobody", async () => {
    const { tab, p, frames, host } = await watched(YOU, { quality: 80, fps: 30, scale: 2 });
    p.frame(2560, 1600, 2560, 1600);
    expect(frames).toHaveLength(1);
    const drawn = p.renders.length;
    p.frame(1280, 713, 1280, 713);
    p.frame(1280, 713, 1280, 713);
    await vi.waitFor(() => expect(p.renders).toHaveLength(drawn + 1));
    expect([p.viewports.at(-1), p.renders.at(-1)]).toEqual([DEFAULT_VIEWPORT, 2]);
    await settled();
    p.frame(1280, 713, 1280, 713);   // captured before the view was drawn again, sent late
    p.frame(2560, 1600, 2560, 1600);
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames.map((f) => [f.width, f.height, f.scale, f.viewport.width, f.viewport.height])).toEqual([[2560, 1600, 2, 1280, 800], [2560, 1600, 2, 1280, 800]]);
    await settled();
    expect(p.renders).toHaveLength(drawn + 1);   // once
    expect(host.get(tab)!.viewport).toMatchObject(DEFAULT_VIEWPORT);
  });

  // Playwright's picture of an element has Chrome set the view to the element's size for the capture and back (Chrome
  // 154: one 240×30 frame during it). Drawing the view under it would spoil the picture.
  it("is not drawn again under a call of its agent's, but when the agent's calls are over", async () => {
    const { host, p, frames } = await watched(CODEX, { quality: 80, fps: 30 }, { agentQuietMs: 60_000 });
    p.frame(1280, 800, 1280, 800);
    await host.agentActing(CODEX);
    await host.agentActing(CODEX);   // a second call (another bridge of the session)
    const drawn = p.renders.length;
    // The capture's view, then the tab's own again: the first reaches nobody.
    p.frame(240, 30, 240, 30);
    await settled();
    p.frame(1280, 800, 1280, 800);
    host.agentDone(CODEX);
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    await settled();
    expect(frames.map((f) => f.width)).toEqual([1280, 1280]);
    expect(p.renders).toHaveLength(drawn);       // the other call is still running
    host.agentDone(CODEX);
    await vi.waitFor(() => expect(p.renders).toHaveLength(drawn + 1));
    expect(p.renders.at(-1)).toBe(1);            // the size the agent's tabs have just after a call
    await settled();
    expect(p.renders).toHaveLength(drawn + 1);
    // With no call under way, at once.
    p.frame(1280, 800, 1280, 800);
    await settled();
    p.frame(1280, 713, 1280, 713);
    await vi.waitFor(() => expect(p.renders).toHaveLength(drawn + 2));
  });

  // Measured with Chrome 154: a still tab watched at 2 sent no frame of itself after 6 of 12 such changes, and then
  // none for what changed outside the part of the page still in view. So a tab that closes is reason enough.
  it("may have happened when a tab closed, with no frame to say so: the watched tabs left are drawn again, those nobody watches are not", async () => {
    const { host, driver, p } = await watched(YOU, { quality: 80, fps: 30, scale: 2 });
    const later = await host.open(YOU, "https://b.example/");
    await host.open(YOU, "https://c.example/");
    const q = driver.page(2);
    const [drawn, idle] = [p.renders.length, q.renders.length];
    await host.close(later.id);
    await vi.waitFor(() => expect(p.renders).toHaveLength(drawn + 1));
    expect([p.viewports.at(-1), p.renders.at(-1)]).toEqual([DEFAULT_VIEWPORT, 2]);
    await settled();
    expect([p.renders.length, q.renders.length]).toEqual([drawn + 1, idle]);
    // A tab that closes itself (a popup, `window.close`) too.
    await driver.page(2).close();
    await vi.waitFor(() => expect(p.renders).toHaveLength(drawn + 2));
  });

  it("when its agent's call closed another tab: after the call; nothing when Chrome is gone or the service stops", async () => {
    const { host, driver, p } = await watched(CODEX, { quality: 80, fps: 30 }, { agentQuietMs: 60_000 });
    const other = await host.open(CODEX, "https://b.example/");
    await host.agentActing(CODEX);
    const drawn = p.renders.length;
    await host.close(other.id);
    await settled();
    expect(p.renders).toHaveLength(drawn);
    host.agentDone(CODEX);
    await vi.waitFor(() => expect(p.renders).toHaveLength(drawn + 1));
    await settled();
    // Chrome died: its tabs go together.
    await host.open(YOU, "https://c.example/");
    driver.browser.crash();
    await settled();
    expect(p.renders).toHaveLength(drawn + 1);
    // The service stops: two watched tabs, dropped one after the other.
    const stopping = await watched(YOU, { quality: 80, fps: 30, scale: 2 });
    const second = await stopping.host.open(YOU, "https://d.example/");
    stopping.host.subscribe(second.id, { quality: 80, fps: 30, scale: 2 }, () => undefined);
    await vi.waitFor(() => expect(stopping.driver.page(1).renders.at(-1)).toBe(2));
    await settled();
    const asks = [stopping.p.renders.length, stopping.driver.page(1).renders.length];
    await stopping.host.shutdown();
    await settled();
    expect([stopping.p.renders.length, stopping.driver.page(1).renders.length]).toEqual(asks);
  });

  it("a tab that went while its view was being drawn again leaves no word in the log; one that stays and cannot be drawn does", async () => {
    const lines: string[] = [];
    const { host, driver, tab, p } = await watched(YOU, { quality: 80, fps: 30, scale: 2 }, { log: (l) => lines.push(l) });
    const later = await host.open(YOU, "https://b.example/");
    // Chrome answers the redraw once the tab is gone too (tabs closed together, Chrome quitting).
    let fail: () => void = () => undefined;
    p.setViewport = () => new Promise((_, reject) => { fail = () => reject(new Error("Target page, context or browser has been closed")); });
    await host.close(later.id);
    await settled();
    await host.close(tab);
    fail();
    await settled();
    expect(lines).toEqual([]);
    const stays = await host.open(YOU, "https://c.example/");
    driver.page(2).setViewport = async () => { throw new Error("Protocol error (Emulation.setDeviceMetricsOverride): Invalid parameters"); };
    host.subscribe(stays.id, { quality: 80, fps: 30, scale: 2 }, () => undefined);
    await vi.waitFor(() => expect(lines).toEqual([`browser: tab ${stays.id} viewport: Protocol error (Emulation.setDeviceMetricsOverride): Invalid parameters`]));
  });
});
