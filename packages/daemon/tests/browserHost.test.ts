/** The browser host on a fake Chrome (docs/browser-v0.md §2): Chrome started on first use and once, tabs by owner,
 *  popups, holds that end on hand-back or after two minutes, the holder's size, input mapped from the frame, the
 *  request guard, a dead Chrome and a Chrome with no tabs left, shut-down. What else waits for a redraw of a tab's
 *  view, and the view Chrome changes itself, are in browserHostView.test.ts. */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HOLD_IDLE_MS, BrowserHost, launchFailure, ownPortPatterns, type BrowserHostOptions } from "../src/browser/host.js";
import { AGENT_FILE_REFUSAL, OWN_PORT_REFUSAL, type FileRules } from "../src/browser/rules.js";
import { BrowserError, DEFAULT_VIEWPORT, YOU, type BrowserEvent, type FrameEvent, type TabOwner } from "../src/browser/types.js";
import { defaultProtected } from "../src/executors/protected.js";
import { FakeDriver, FakePage, slowAnswer } from "./fakeBrowser.js";

const CODEX: TabOwner = { kind: "terminal", id: "t1", label: "codex · AgentSwitch" };
const TASK: TabOwner = { kind: "task", id: "k1", label: "登录财务平台下载对账单" };
let home: string;
let rules: FileRules;
let page: string;

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-browser-host-")));
  mkdirSync(join(home, "site"), { recursive: true });
  writeFileSync(join(home, "site", "index.html"), "<p>hi</p>");
  writeFileSync(join(home, "site", ".env"), "X=1");
  page = pathToFileURL(join(home, "site", "index.html")).href;
  rules = { protected: defaultProtected({ HOME: home, AGENTSWITCH_HOME: join(home, ".agentswitch"), SECRET_GATE_HOME: join(home, ".secret-gate") }), home };
});

const hosts: BrowserHost[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const h of hosts.splice(0)) await h.shutdown();
});

function make(over: Partial<BrowserHostOptions> = {}): { host: BrowserHost; driver: FakeDriver } {
  const driver = new FakeDriver();
  const host = new BrowserHost({ driver, profileDir: join(home, "profile"), files: rules, ownPorts: () => [4711], log: () => undefined, mac: true, ...over });
  hosts.push(host);
  return { host, driver };
}

async function refused(p: Promise<unknown> | (() => unknown)): Promise<BrowserError> {
  try { await (typeof p === "function" ? p() : p); } catch (err) { if (err instanceof BrowserError) return err; throw err; }
  throw new Error("not refused");
}

describe("Chrome on demand", () => {
  it("starts on the first tab, once for tabs opened together, and not for a list", async () => {
    const prepared: string[] = [];
    const { host, driver } = make({ prepareProfile: (dir) => prepared.push(dir) });
    expect(host.running).toBe(false);
    expect(host.groups()).toEqual([]);
    expect(driver.launches).toHaveLength(0);
    const [a, b] = await Promise.all([host.open(YOU, "https://a.example/"), host.open(YOU, "https://b.example/")]);
    expect(driver.launches).toHaveLength(1);
    expect(driver.launches[0]!.profileDir).toBe(join(home, "profile"));
    expect(prepared).toEqual([join(home, "profile")]);
    expect(host.running).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ owner: YOU, url: "https://a.example/", site: "a.example", kind: "web", status: "idle", heldBy: null, action: null, viewport: { ...DEFAULT_VIEWPORT, by: null } });
    expect(driver.page(0).navigations).toEqual(["https://a.example/"]);
    expect(driver.page(0).viewports).toEqual([DEFAULT_VIEWPORT]);
  });

  it("a refused target never starts Chrome", async () => {
    const { host, driver } = make();
    expect((await refused(host.open(YOU, pathToFileURL(join(home, "site", ".env")).href))).code).toBe("forbidden");
    expect((await refused(host.open(YOU, "http://localhost:4711/"))).message).toBe(OWN_PORT_REFUSAL);
    expect((await refused(host.open(CODEX, page))).message).toBe(AGENT_FILE_REFUSAL);
    expect(driver.launches).toHaveLength(0);
  });

  it("a Chrome that will not start is reported in words", async () => {
    const { host, driver } = make();
    driver.failure = new Error("browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app\nRun npx playwright install chrome");
    const err = await refused(host.open(YOU, "https://a.example/"));
    expect(err).toMatchObject({ code: "unavailable", message: "未找到 Google Chrome。请在 Mac 上安装 Google Chrome。" });
    expect(launchFailure(new Error("Timeout 30000ms exceeded.\nmore"))).toBe("浏览器未能启动：Timeout 30000ms exceeded.");
    driver.failure = null;
    await host.open(YOU, "https://a.example/");
    expect(driver.launches).toHaveLength(2);
  });

  it("a dead Chrome ends every stream and starts again on the next tab", async () => {
    let exits = 0;
    const { host, driver } = make({ afterExit: () => { exits += 1; } });
    const tab = await host.open(YOU, "https://a.example/");
    const events: BrowserEvent[] = [];
    host.subscribe(tab.id, { quality: 50, fps: 10 }, (e) => events.push(e));
    driver.browser.crash();
    expect(events.at(-1)).toEqual({ type: "closed", reason: "browser-exited" });
    expect(host.running).toBe(false);
    expect(host.list()).toEqual([]);
    expect(exits).toBe(1);
    await host.open(YOU, "https://b.example/");
    expect(driver.launches).toHaveLength(2);
  });

  it("stops Chrome after a while with no tabs", async () => {
    vi.useFakeTimers();
    const { host, driver } = make({ idleCloseMs: 60_000 });
    const tab = await host.open(YOU, "https://a.example/");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(driver.browser.closed).toBe(false);
    await host.close(tab.id);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(driver.browser.closed).toBe(false);
    await host.open(YOU, "https://b.example/");   // a tab in time keeps it
    await host.close(host.list()[0]!.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(driver.browser.closed).toBe(true);
    expect(host.running).toBe(false);
  });

  it("shut-down ends the streams and refuses new tabs", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    const events: BrowserEvent[] = [];
    host.subscribe(tab.id, { quality: 50, fps: 10 }, (e) => events.push(e));
    await host.shutdown();
    expect(events.at(-1)).toEqual({ type: "closed", reason: "shutdown" });
    expect(driver.browser.closed).toBe(true);
    expect((await refused(host.open(YOU, "https://b.example/"))).code).toBe("unavailable");
  });
});

describe("tabs", () => {
  it("are grouped by owner: terminals' agents, tasks, then the user's", async () => {
    const { host } = make();
    const mine = await host.open(YOU, "https://mine.example/");
    const c1 = await host.open(CODEX, "https://github.com/acme/app/pull/128");
    const t1 = await host.open(TASK, "https://portal.example.com/login");
    const c2 = await host.open(CODEX, "https://github.com/acme/app/issues");
    const groups = host.groups();
    expect(groups.map((g) => g.owner.kind)).toEqual(["terminal", "task", "you"]);
    expect(groups[0]!.tabs.map((t) => t.id)).toEqual([c1.id, c2.id]);
    expect(groups[1]!.tabs.map((t) => t.id)).toEqual([t1.id]);
    expect(groups[2]!.tabs.map((t) => t.id)).toEqual([mine.id]);
    expect(host.get("nope")).toBeNull();
  });

  it("a page's popup is a tab of the same owner, at the default size", async () => {
    const { host, driver } = make();
    await host.open(CODEX, "https://a.example/");
    const child = driver.page(0).popup();
    const tabs = host.list();
    expect(tabs).toHaveLength(2);
    expect(tabs[1]!.owner).toEqual(CODEX);
    await vi.waitFor(() => expect(child.viewports).toEqual([DEFAULT_VIEWPORT]));
    driver.page(0).popup();
    child.closed = true;
  });

  it("follow the page: URL, title and loading, as events to the streams", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    const events: BrowserEvent[] = [];
    host.subscribe(tab.id, { quality: 50, fps: 10 }, (e) => events.push(e));
    expect(events[0]).toEqual({ type: "tab", tab: host.get(tab.id) });
    driver.page(0).loading(true);
    driver.page(0).loading(true);
    driver.page(0).change("https://a.example/x", "");
    driver.page(0).change("https://a.example/x", "Hello");
    driver.page(0).loading(false);
    expect(events.slice(1)).toEqual([
      { type: "loading", loading: true },
      { type: "url", url: "https://a.example/x", kind: "web", site: "a.example" },
      { type: "title", title: "Hello" },
      { type: "loading", loading: false },
    ]);
    expect(host.get(tab.id)).toMatchObject({ url: "https://a.example/x", title: "Hello", loading: false });
  });

  it("close: the page goes, the streams hear it", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const { host, driver } = make({ log: (l) => lines.push(l) });
    const tab = await host.open(YOU, "https://a.example/");
    const events: BrowserEvent[] = [];
    host.subscribe(tab.id, { quality: 50, fps: 10 }, (e) => events.push(e));
    await host.close(tab.id);
    expect(driver.page(0).closed).toBe(true);
    expect(events.at(-1)).toEqual({ type: "closed", reason: "closed" });
    expect(lines).toEqual([]);   // closed in time: no word about it
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines).toEqual([]);
    expect(host.get(tab.id)).toBeNull();
    expect((await refused(host.close(tab.id))).code).toBe("not_found");
    expect(() => host.subscribe(tab.id, { quality: 1, fps: 1 }, () => undefined)).toThrow(BrowserError);
  });

  it("a page that will not close is forgotten after a few seconds", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const { host, driver } = make({ log: (l) => lines.push(l) });
    const tab = await host.open(YOU, "https://a.example/");
    driver.page(0).close = () => new Promise(() => undefined);
    const closing = host.close(tab.id);
    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
    expect(host.get(tab.id)).toBeNull();
    expect(lines).toEqual([`browser: tab ${tab.id} did not close within 5000 ms; forgotten`]);
    driver.page(0).close = async () => undefined;   // shut-down closes it for good
  });

  it("navigation and history under the owner's rules; a failed navigation leaves the tab", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, page);
    expect(host.get(tab.id)).toMatchObject({ kind: "file", site: "~/site/index.html" });
    host.navigate(tab.id, "mac-1", "https://b.example/");
    await host.history(tab.id, "mac-1", "back");
    expect(driver.page(0).navigations).toEqual([page, "https://b.example/"]);
    expect(driver.page(0).histories).toEqual(["back"]);
    expect((await refused(() => host.navigate(tab.id, "mac-1", pathToFileURL(join(home, "site", ".env")).href))).code).toBe("forbidden");
    driver.page(0).navigateError = new Error("net::ERR_NAME_NOT_RESOLVED");
    host.navigate(tab.id, "mac-1", "https://nowhere.invalid/");
    expect(host.get(tab.id)!.url).toBe("https://nowhere.invalid/");
  });

  it("status and the agent's last action, for the screens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const { host } = make();
    const tab = await host.open(CODEX, "https://github.com/");
    const events: BrowserEvent[] = [];
    host.subscribe(tab.id, { quality: 50, fps: 10 }, (e) => events.push(e));
    host.setStatus(tab.id, "busy");
    host.setStatus(tab.id, "busy");
    host.setAction(tab.id, { tool: "browser_click", description: 'click "Merge"', box: { x: 10, y: 20, width: 100, height: 30 } });
    host.setAction(tab.id, null);
    expect(events.slice(1)).toEqual([
      { type: "status", status: "busy" },
      { type: "action", action: { tool: "browser_click", description: 'click "Merge"', box: { x: 10, y: 20, width: 100, height: 30 }, at: 5_000 } },
      { type: "action", action: null },
    ]);
    expect(host.get(tab.id)!.status).toBe("busy");
  });
});

describe("holding a tab", () => {
  it("only the holder drives a held tab; an agent's tab only once taken over", async () => {
    const { host, driver } = make();
    const mine = await host.open(YOU, "https://a.example/");
    const theirs = await host.open(CODEX, "https://b.example/");
    const text = [{ type: "text" as const, text: "hi" }];
    await host.input(mine.id, "phone-1", text);   // nobody holds the user's tab: anyone may type
    expect((await refused(host.input(theirs.id, "phone-1", text))).message).toBe("此标签由 agent 使用，请先接手。");
    expect((await refused(() => host.navigate(theirs.id, "phone-1", "https://c.example/"))).code).toBe("conflict");
    host.take(theirs.id, "phone-1");
    await host.input(theirs.id, "phone-1", text);
    expect((await refused(host.input(theirs.id, "mac-1", text))).message).toBe("此标签已由其他屏幕接手。");
    // A person driving an agent's tab still may not put a file in it.
    expect((await refused(() => host.navigate(theirs.id, "phone-1", page))).message).toBe(AGENT_FILE_REFUSAL);
    expect(driver.page(1).inputs).toEqual([{ method: "Input.insertText", params: { text: "hi" } }]);
  });

  it("take and hand back, by the holder only; the streams hear both", async () => {
    const { host } = make();
    const tab = await host.open(CODEX, "https://b.example/");
    const events: BrowserEvent[] = [];
    host.subscribe(tab.id, { quality: 50, fps: 10 }, (e) => events.push(e));
    expect(host.take(tab.id, "phone-1").heldBy).toBe("phone-1");
    expect((await refused(() => host.release(tab.id, "mac-1"))).code).toBe("conflict");
    expect(host.take(tab.id, "mac-1").heldBy).toBe("mac-1");   // another screen takes it over
    expect(host.release(tab.id, "mac-1").heldBy).toBeNull();
    expect(host.release(tab.id, "mac-1").heldBy).toBeNull();   // nobody holds it: nothing to do
    expect(events.filter((e) => e.type === "held")).toEqual([
      { type: "held", heldBy: "phone-1", reason: "take" },
      { type: "held", heldBy: "mac-1", reason: "take" },
      { type: "held", heldBy: null, reason: "hand-back" },
    ]);
  });

  it("ends two minutes after the holder's last input", async () => {
    vi.useFakeTimers();
    const idle: string[] = [];
    const { host } = make({ onIdleRelease: (id, holder) => idle.push(`${id}:${holder}`) });
    const tab = await host.open(CODEX, "https://b.example/");
    host.take(tab.id, "phone-1");
    await vi.advanceTimersByTimeAsync(HOLD_IDLE_MS - 1_000);
    await host.input(tab.id, "phone-1", [{ type: "key", key: "Tab", modifiers: [] }]);
    await vi.advanceTimersByTimeAsync(HOLD_IDLE_MS - 1_000);
    expect(host.get(tab.id)!.heldBy).toBe("phone-1");
    const events: BrowserEvent[] = [];
    host.subscribe(tab.id, { quality: 50, fps: 10 }, (e) => events.push(e));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.get(tab.id)!.heldBy).toBeNull();
    expect(events).toContainEqual({ type: "held", heldBy: null, reason: "idle" });
    expect(idle).toEqual([`${tab.id}:phone-1`]);
  });

  it("one size, one owner: the holder sets it, it goes back on release or when another screen takes over", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    const phone = { width: 390, height: 844, scale: 3, mobile: true };
    expect((await refused(host.setViewport(tab.id, "phone-1", phone))).message).toBe("请先接手此标签，再设置尺寸。");
    host.take(tab.id, "phone-1");
    const events: BrowserEvent[] = [];
    host.subscribe(tab.id, { quality: 50, fps: 10 }, (e) => events.push(e));
    expect((await host.setViewport(tab.id, "phone-1", phone)).viewport).toEqual({ ...phone, by: "phone-1" });
    expect(driver.page(0).viewports.at(-1)).toEqual(phone);
    host.take(tab.id, "mac-1");
    expect(host.get(tab.id)!.viewport).toEqual({ ...DEFAULT_VIEWPORT, by: null });
    await host.setViewport(tab.id, "mac-1", { width: 1440, height: 900, scale: 2, mobile: false });
    host.take(tab.id, "mac-1");   // the same screen again keeps its size
    expect(host.get(tab.id)!.viewport.by).toBe("mac-1");
    host.release(tab.id, "mac-1");
    await vi.waitFor(() => expect(driver.page(0).viewports.at(-1)).toEqual(DEFAULT_VIEWPORT));
    expect(events.filter((e) => e.type === "viewport").map((e) => (e as { viewport: { by: string | null } }).viewport.by)).toEqual(["phone-1", null, "mac-1", null]);
  });

  it("the size the holder set already keeps the hold and changes nothing else", async () => {
    vi.useFakeTimers();
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    const mac = { width: 1013, height: 700, scale: 2, mobile: false };
    host.take(tab.id, "mac-1");
    await host.setViewport(tab.id, "mac-1", mac);
    const events: BrowserEvent[] = [];
    host.subscribe(tab.id, { quality: 50, fps: 10 }, (e) => events.push(e));
    const set = driver.page(0).viewports.length;
    await vi.advanceTimersByTimeAsync(HOLD_IDLE_MS - 1_000);
    expect((await host.setViewport(tab.id, "mac-1", { ...mac })).viewport).toEqual({ ...mac, by: "mac-1" });
    expect(driver.page(0).viewports).toHaveLength(set);
    await vi.advanceTimersByTimeAsync(HOLD_IDLE_MS - 1_000);
    expect(host.get(tab.id)!.heldBy).toBe("mac-1");
    expect(events.filter((e) => e.type === "viewport")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.get(tab.id)!.heldBy).toBeNull();
  });
});

describe("device pixels", () => {
  const settled = () => new Promise((r) => setTimeout(r, 20));

  it("a stream that asks for 2 draws the tab's view at 2, the page's size unchanged; with the last such stream gone, at the CSS size", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    const p = driver.page(0);
    expect(p.renders).toEqual([1]);
    const mac = host.subscribe(tab.id, { quality: 80, fps: 15, scale: 2, maxWidth: 3024, maxHeight: 1964 }, () => undefined);
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(2));
    expect(p.viewports.at(-1)).toEqual(DEFAULT_VIEWPORT);
    // The view drawn before the screencast's first start: no frame of the CSS size first.
    expect(p.stops).toBe(0);
    expect(p.screencasts).toHaveLength(1);
    const asks = p.renders.length;
    const old = host.subscribe(tab.id, { quality: 50, fps: 5 }, () => undefined);
    await settled();
    expect(p.renders).toHaveLength(asks);
    mac();
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(1));
    old();
  });

  it("follows the size: a phone's own at 3, a desktop page it shows smaller than its screen at 1", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    const p = driver.page(0);
    host.subscribe(tab.id, { quality: 70, fps: 15, scale: 3, maxWidth: 1170, maxHeight: 2532 }, () => undefined);
    await settled();
    expect(p.renders.at(-1)).toBe(1);
    host.take(tab.id, "phone-1");
    await host.setViewport(tab.id, "phone-1", { width: 390, height: 844, scale: 3, mobile: true });
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(3));
    host.release(tab.id, "phone-1");
    await vi.waitFor(() => expect(p.viewports.at(-1)).toEqual(DEFAULT_VIEWPORT));
    expect(p.renders.at(-1)).toBe(1);
  });

  it("frames of a view at 2 are the page at 2; input goes in the view's pixels", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    const p = driver.page(0);
    const frames: BrowserEvent[] = [];
    host.subscribe(tab.id, { quality: 80, fps: 30, scale: 2 }, (e) => { if (e.type === "frame") frames.push(e); });
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(2));
    await settled();
    p.frame(2560, 1600, 2560, 1600);
    expect(frames.at(-1)).toMatchObject({ width: 2560, height: 1600, scale: 2, viewport: { width: 1280, height: 800 } });
    await host.input(tab.id, "mac-1", [
      { type: "mouse", action: "click", x: 200, y: 120, button: "left", clickCount: 1, modifiers: [] },
      { type: "wheel", x: 200, y: 120, deltaX: 0, deltaY: 80, modifiers: [] },
    ]);
    expect(p.inputs.at(-2)!.params).toMatchObject({ type: "mouseReleased", x: 200, y: 120 });
    expect(p.inputs.at(-1)!.params).toMatchObject({ type: "mouseWheel", x: 200, y: 120, deltaY: 40 });
  });

  it("an agent's tabs are at the CSS size while its call may point at the page, and a moment after; your own tabs never", async () => {
    const { host, driver } = make({ agentQuietMs: 60 });
    const tab = await host.open(CODEX, "https://a.example/");
    const mine = await host.open(YOU, "https://b.example/");
    const p = driver.page(0);
    const q = driver.page(1);
    host.subscribe(tab.id, { quality: 80, fps: 15, scale: 2 }, () => undefined);
    host.subscribe(mine.id, { quality: 80, fps: 15, scale: 2 }, () => undefined);
    await vi.waitFor(() => { expect(p.renders.at(-1)).toBe(2); expect(q.renders.at(-1)).toBe(2); });
    await host.agentActing(CODEX);
    expect(p.renders.at(-1)).toBe(1);
    await host.agentActing(CODEX);   // a second call (another bridge of the session)
    // A screen coming meanwhile does not draw it at a scale.
    host.subscribe(tab.id, { quality: 80, fps: 15, scale: 2 }, () => undefined);
    host.agentDone(CODEX);
    await new Promise((r) => setTimeout(r, 100));
    expect(p.renders.at(-1)).toBe(1);
    host.agentDone(CODEX);
    await new Promise((r) => setTimeout(r, 20));
    expect(p.renders.at(-1)).toBe(1);   // the quiet moment
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(2));
    expect(q.renders.every((r, i) => i === 0 || r === 2)).toBe(true);
    await host.agentActing(YOU);
    expect(q.renders.at(-1)).toBe(2);
    host.agentDone(YOU);
  });

  it("a Chrome that cannot draw a view at a scale gets CSS-size frames and is not asked again", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    const p = driver.page(0);
    p.scaledViews = false;
    host.subscribe(tab.id, { quality: 80, fps: 15, scale: 2 }, () => undefined);
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(2));
    await settled();
    const asks = p.renders.length;
    host.subscribe(tab.id, { quality: 80, fps: 15, scale: 3 }, () => undefined)();
    await settled();
    expect(p.renders).toHaveLength(asks);
    p.frame(1280, 800, 1280, 800);
    await host.input(tab.id, "mac-1", [{ type: "mouse", action: "click", x: 100, y: 60, button: "left", clickCount: 1, modifiers: [] }]);
    expect(p.inputs.at(-1)!.params).toMatchObject({ x: 100, y: 60 });
  });

  it("a size Chrome refuses is said in the log; the stream runs on and takes frames as they come", async () => {
    const lines: string[] = [];
    const { host, driver } = make({ log: (l) => lines.push(l) });
    const tab = await host.open(YOU, "https://a.example/");
    const p = driver.page(0);
    const frames: FrameEvent[] = [];
    host.subscribe(tab.id, { quality: 80, fps: 30, scale: 2 }, (e) => { if (e.type === "frame") frames.push(e); });
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(2));
    await settled();
    p.setViewport = async () => { throw new Error("Protocol error (Emulation.setDeviceMetricsOverride): Invalid parameters\n    at CRSession.send"); };
    host.take(tab.id, "phone-1");
    await host.setViewport(tab.id, "phone-1", { width: 390, height: 844, scale: 3, mobile: true });
    expect(lines).toEqual([`browser: tab ${tab.id} viewport: Protocol error (Emulation.setDeviceMetricsOverride): Invalid parameters`]);
    // What the view is now, nobody can say: a frame is shown whatever its size, at the scale recorded.
    p.frame(2560, 1600, 2560, 1600);
    expect(frames.at(-1)).toMatchObject({ width: 2560, scale: 2, viewport: { width: 1280, height: 800 } });
    expect(p.screencasts).toHaveLength(2);
  });
});

// Page zoom (browser-v0 §1 页面缩放, 2026-10-03): the host knows no zoom. The screen that holds a tab sets a smaller or a
// larger size and asks its stream for its device pixels times the zoom (up to 8). Here a 3x phone with 402×690 points of
// browser area: 1206×2070 pixels.
describe("page zoom, as the holding screen's size and its stream's scale", () => {
  const settled = () => new Promise((r) => setTimeout(r, 20));
  const screen = { quality: 70, fps: 30, maxWidth: 1206, maxHeight: 2070 };
  const click = (x: number, y: number, seq?: number) =>
    ({ type: "mouse" as const, action: "click" as const, x, y, button: "left" as const, clickCount: 1, modifiers: [], ...(seq !== undefined ? { seq } : {}) });

  it("the view follows the size: at 6 for 201×345 (200%), 1.5 for 804×1380 (50%), the CSS size for 1608×2760 (25%) and after the hand-back", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    const p = driver.page(0);
    host.take(tab.id, "phone-1");
    host.subscribe(tab.id, { ...screen, scale: 6 }, () => undefined);
    const at200 = { width: 201, height: 345, scale: 4, mobile: true };
    expect((await host.setViewport(tab.id, "phone-1", at200)).viewport).toEqual({ ...at200, by: "phone-1" });
    expect([p.viewports.at(-1), p.renders.at(-1)]).toEqual([at200, 6]);
    await host.setViewport(tab.id, "phone-1", { width: 804, height: 1380, scale: 1.5, mobile: true });
    expect(p.renders.at(-1)).toBe(1.5);
    const at25 = { width: 1608, height: 2760, scale: 0.75, mobile: true };
    await host.setViewport(tab.id, "phone-1", at25);
    expect([p.viewports.at(-1), p.renders.at(-1)]).toEqual([at25, 1]);
    // The screencast keeps the frame within the screen's pixels.
    expect(p.screencasts.at(-1)).toEqual({ quality: 70, maxWidth: 1206, maxHeight: 2070 });
    host.release(tab.id, "phone-1");
    await vi.waitFor(() => expect(p.viewports.at(-1)).toEqual(DEFAULT_VIEWPORT));
    expect(p.renders.at(-1)).toBe(1);
  });

  it("zooming in: the size first, then the stream asked again at the larger scale; frames, taps and drags at each", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    const p = driver.page(0);
    host.take(tab.id, "phone-1");
    await host.setViewport(tab.id, "phone-1", { width: 402, height: 690, scale: 3, mobile: true });
    const frames: FrameEvent[] = [];
    const before = host.subscribe(tab.id, { ...screen, scale: 3 }, (e) => { if (e.type === "frame") frames.push(e); });
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(3));
    // 200%: the page is half the size; the stream still asks 3 until the phone asks again.
    await host.setViewport(tab.id, "phone-1", { width: 201, height: 345, scale: 4, mobile: true });
    expect(p.renders.at(-1)).toBe(3);
    // A capture of the 402×690 page that Chrome sends late is not of this view (603×1035) and reaches nobody.
    p.frame(1206, 2070, 1206, 2070);
    expect(frames).toEqual([]);
    p.frame(603, 1035, 603, 1035);
    expect(frames.at(-1)).toMatchObject({ width: 603, height: 1035, scale: 3, viewport: { width: 201, height: 345 } });
    const early = frames.at(-1)!.seq;
    const after = host.subscribe(tab.id, { ...screen, scale: 6 }, () => undefined);
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(6));
    await settled();
    before();
    await settled();
    expect(p.renders.at(-1)).toBe(6);
    // A tap aimed at the earlier frame (CSS 100, 140) after the view was redrawn: Chrome takes it in the view as it is now.
    await host.input(tab.id, "phone-1", [click(300, 420, early)]);
    expect(p.inputs.at(-1)!.params).toMatchObject({ type: "mouseReleased", x: 600, y: 840 });
    // And with no frame of the new view yet, a tap that names none.
    await host.input(tab.id, "phone-1", [click(300, 420)]);
    expect(p.inputs.at(-1)!.params).toMatchObject({ type: "mouseReleased", x: 600, y: 840 });
    p.frame(1206, 2070, 1206, 2070);
    await host.input(tab.id, "phone-1", [click(603, 840), { type: "wheel", x: 603, y: 840, deltaX: 0, deltaY: 600, modifiers: [] }]);
    expect(p.inputs.at(-2)!.params).toMatchObject({ type: "mouseReleased", x: 603, y: 840 });
    expect(p.inputs.at(-1)!.params).toMatchObject({ type: "mouseWheel", x: 603, y: 840, deltaY: 100 });
    after();
  });

  it("the most: a 2x Mac at 400% asks 8 for a 320×200 page; a point on its frame is a point of the view", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    const p = driver.page(0);
    host.take(tab.id, "mac-1");
    await host.setViewport(tab.id, "mac-1", { width: 320, height: 200, scale: 4, mobile: false });
    const frames: FrameEvent[] = [];
    host.subscribe(tab.id, { quality: 80, fps: 30, scale: 8, maxWidth: 3024, maxHeight: 1964 }, (e) => { if (e.type === "frame") frames.push(e); });
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(8));
    await settled();
    p.frame(2560, 1600, 2560, 1600);
    expect(frames.at(-1)).toMatchObject({ width: 2560, height: 1600, scale: 8, viewport: { width: 320, height: 200 } });
    await host.input(tab.id, "mac-1", [click(804, 1120), { type: "wheel", x: 804, y: 1120, deltaX: 0, deltaY: -160, modifiers: [] }]);
    expect(p.inputs.at(-2)!.params).toMatchObject({ type: "mouseReleased", x: 804, y: 1120 });
    expect(p.inputs.at(-1)!.params).toMatchObject({ type: "mouseWheel", x: 804, y: 1120, deltaY: -20 });
  });

  it("a zoomed agent's tab is at the CSS size while the agent points at another of its tabs; a tap aimed at the frame from before still lands", async () => {
    const { host, driver } = make({ agentQuietMs: 60 });
    const tab = await host.open(CODEX, "https://a.example/");
    await host.open(CODEX, "https://b.example/");
    const p = driver.page(0);
    host.take(tab.id, "phone-1");
    await host.setViewport(tab.id, "phone-1", { width: 201, height: 345, scale: 4, mobile: true });
    const frames: FrameEvent[] = [];
    host.subscribe(tab.id, { ...screen, scale: 6 }, (e) => { if (e.type === "frame") frames.push(e); });
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(6));
    await settled();
    p.frame(1206, 2070, 1206, 2070);
    const sharp = frames.at(-1)!;
    expect(sharp).toMatchObject({ width: 1206, scale: 6 });
    await host.agentActing(CODEX);
    expect(p.renders.at(-1)).toBe(1);
    // Frame (603, 840) at 6 is CSS (100.5, 140), which is what Chrome takes now.
    await host.input(tab.id, "phone-1", [click(603, 840, sharp.seq)]);
    expect(p.inputs.at(-1)!.params).toMatchObject({ type: "mouseReleased", x: 100.5, y: 140 });
    p.frame(201, 345, 201, 345);
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ width: 201, height: 345, scale: 1, viewport: { width: 201, height: 345 } }));
    host.agentDone(CODEX);
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(6));
  });

  /** A phone holding its page at 200% (201×345), its stream asking 3, the last frame it has at 3. */
  async function heldAt3(): Promise<{ host: BrowserHost; tab: string; p: FakePage }> {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    const p = driver.page(0);
    host.take(tab.id, "phone-1");
    await host.setViewport(tab.id, "phone-1", { width: 201, height: 345, scale: 4, mobile: true });
    host.subscribe(tab.id, { ...screen, scale: 3 }, () => undefined);
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(3));
    await settled();
    p.frame(603, 1035, 603, 1035);
    return { host, tab: tab.id, p };
  }

  // Review, 2026-10-03, measured with Chrome 154: of 40 taps sent 0 to 7 ms after a stream asking 6 came to a view at 3,
  // 14 landed at half their coordinates, on another element: Chrome had the new scale, the host's record still the old.
  it("a tap sent while the view is being redrawn waits for that, and goes in the view Chrome has by then", async () => {
    const { host, tab, p } = await heldAt3();
    const answer = slowAnswer(p, 6);
    host.subscribe(tab, { ...screen, scale: 6 }, () => undefined);
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(6));
    // CSS (100, 140) on the frame at 3; a key meanwhile is not held up (it points nowhere).
    const sent = host.input(tab, "phone-1", [click(300, 420)]);
    await host.input(tab, "phone-1", [{ type: "key", key: "Tab", modifiers: [] }]);
    await settled();
    expect(p.inputs.map((c) => c.params.type)).toEqual(["rawKeyDown", "keyUp"]);
    answer();
    await sent;
    expect(p.inputs.slice(2).map((c) => [c.params.type, c.params.x, c.params.y])).toEqual([["mouseMoved", 600, 840], ["mousePressed", 600, 840], ["mouseReleased", 600, 840]]);
  });

  // The same review: of 40 taps sent 0 to 2 ms before such a stream came, 8 landed elsewhere: the click's three calls
  // were sent one by one, each after Chrome's answer to the one before, and the redraw began between them.
  it("a click's calls go to Chrome together: a redraw that begins meanwhile comes after all of them", async () => {
    const { host, tab, p } = await heldAt3();
    // What Chrome is asked, in order; it takes a few milliseconds to answer a call of input.
    const asked: string[] = [];
    const input = p.input.bind(p);
    p.input = async (method, params) => { asked.push(String(params.type)); await new Promise((r) => setTimeout(r, 5)); return input(method, params); };
    const set = p.setViewport.bind(p);
    p.setViewport = async (v, render) => { asked.push(`view at ${render}`); return set(v, render); };
    const sent = host.input(tab, "phone-1", [click(300, 420), { type: "wheel", x: 300, y: 420, deltaX: 0, deltaY: 300, modifiers: [] }]);
    await new Promise((r) => setTimeout(r, 1));
    host.subscribe(tab, { ...screen, scale: 6 }, () => undefined);
    await sent;
    expect(asked).toEqual(["mouseMoved", "mousePressed", "mouseReleased", "view at 6", "mouseWheel"]);
    // The click in the view at 3, the drag after it in the view at 6: each as Chrome has it when it gets them.
    expect(p.inputs.map((c) => [c.params.type, c.params.x, c.params.y])).toEqual([["mouseMoved", 300, 420], ["mousePressed", 300, 420], ["mouseReleased", 300, 420], ["mouseWheel", 600, 840]]);
    expect(p.inputs.at(-1)!.params).toMatchObject({ deltaY: 100 });
  });

  it("a page that refuses a click's calls is reported once", async () => {
    const { host, tab, p } = await heldAt3();
    p.inputError = new Error("Target closed");
    expect(await refused(host.input(tab, "phone-1", [click(300, 420)]))).toMatchObject({ code: "unavailable", message: "页面未接受输入：Target closed" });
    expect(p.inputs).toEqual([]);
  });

  /** A tap of the phone's sent while the view is being redrawn for a stream asking 6; `answer` lets the redraw end. */
  async function tapWaiting(): Promise<{ host: BrowserHost; tab: string; p: FakePage; sent: Promise<BrowserError>; answer: () => void }> {
    const { host, tab, p } = await heldAt3();
    const answer = slowAnswer(p, 6);
    host.subscribe(tab, { ...screen, scale: 6 }, () => undefined);
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(6));
    return { host, tab, p, answer, sent: refused(host.input(tab, "phone-1", [click(300, 420)])) };
  }

  it("a tap that waited for a redraw is not sent once another screen holds the tab, or the tab is gone", async () => {
    const taken = await tapWaiting();
    taken.host.take(taken.tab, "mac-1");
    taken.answer();
    expect(await taken.sent).toMatchObject({ code: "conflict", message: "此标签已由其他屏幕接手。" });
    expect(taken.p.inputs).toEqual([]);
    const gone = await tapWaiting();
    await gone.host.close(gone.tab);
    gone.answer();
    expect((await gone.sent).code).toBe("not_found");
    expect(gone.p.inputs).toEqual([]);
  });

  // The same review: a stream asking 6 that came and went within a redraw left the view at 6 (16 of 40 with Chrome 154):
  // when it left, the view as recorded was still 3, which is what the streams left ask, so nothing was done.
  it("a stream that asks for more and leaves while the view is redrawn for it does not leave the view at its scale", async () => {
    const { host, tab, p } = await heldAt3();
    const answer = slowAnswer(p, 6);
    const more = host.subscribe(tab, { ...screen, scale: 6 }, () => undefined);
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(6));
    more();
    answer();
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(3));
    // Once more for a stream that stays, and not again after that.
    host.subscribe(tab, { ...screen, scale: 6 }, () => undefined);
    await vi.waitFor(() => expect(p.renders.at(-1)).toBe(6));
    const asks = p.renders.length;
    await settled();
    expect(p.renders).toHaveLength(asks);
  });
});

describe("input", () => {
  it("maps frame points through the frame they were on", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    host.subscribe(tab.id, { quality: 50, fps: 30 }, () => undefined);
    const p = driver.page(0);
    await host.input(tab.id, "mac-1", [{ type: "mouse", action: "move", x: 40, y: 40, button: "left", clickCount: 1, modifiers: [] }]);
    expect(p.inputs.at(-1)!.params).toMatchObject({ x: 40, y: 40 });   // no frame yet: CSS pixels
    p.frame(2560, 1600, 1280, 800);
    p.frame(640, 400, 1280, 800);
    await host.input(tab.id, "mac-1", [
      { type: "mouse", action: "click", x: 200, y: 100, button: "left", clickCount: 1, modifiers: [], seq: 1 },
      { type: "wheel", x: 100, y: 100, deltaX: 0, deltaY: 50, modifiers: [] },
    ]);
    expect(p.inputs.slice(1, 4).map((c) => [c.params.type, c.params.x, c.params.y])).toEqual([["mouseMoved", 100, 50], ["mousePressed", 100, 50], ["mouseReleased", 100, 50]]);
    expect(p.inputs[4]!.params).toMatchObject({ type: "mouseWheel", x: 200, y: 200, deltaY: 100 });
  });

  it("a page that refuses input is reported", async () => {
    const { host, driver } = make();
    const tab = await host.open(YOU, "https://a.example/");
    driver.page(0).inputError = new Error("Target closed");
    expect(await refused(host.input(tab.id, "mac-1", [{ type: "text", text: "x" }]))).toMatchObject({ code: "unavailable", message: "页面未接受输入：Target closed" });
    expect((await refused(host.input("nope", "mac-1", [{ type: "text", text: "x" }]))).code).toBe("not_found");
  });
});

describe("the request guard", () => {
  it("files: a person's tab where allowed, never an agent's; own ports never; the rest passes", async () => {
    const { host, driver } = make();
    const mine = await host.open(YOU, page);
    await host.open(CODEX, "https://a.example/");
    const guard = driver.browser.guard;
    const minePage = driver.page(0);
    const agentPage = driver.page(1);
    const env = pathToFileURL(join(home, "site", ".env")).href;
    expect(await guard({ url: page, page: minePage, navigation: true })).toEqual({ action: "continue" });
    expect(await guard({ url: env, page: minePage, navigation: false })).toMatchObject({ action: "block", reason: expect.stringContaining("属于凭据文件") });
    expect(await guard({ url: page, page: agentPage, navigation: true })).toEqual({ action: "block", reason: AGENT_FILE_REFUSAL });
    expect(await guard({ url: "http://127.0.0.1:4711/api", page: minePage, navigation: false })).toEqual({ action: "block", reason: OWN_PORT_REFUSAL });
    expect(await guard({ url: "http://localhost:5173/", page: agentPage, navigation: true })).toEqual({ action: "continue" });
    expect(await guard({ url: "https://x.com/", page: agentPage, navigation: true })).toEqual({ action: "continue" });
    expect(await guard({ url: "data:text/html,x", page: agentPage, navigation: true })).toEqual({ action: "continue" });
    expect(await guard({ url: "::nonsense", page: agentPage, navigation: true })).toMatchObject({ action: "block" });
    expect(mine.kind).toBe("file");
  });

  it("a page not known yet goes by its opener; a popup's first navigation by a person's rules; a worker's file request is refused", async () => {
    const { host, driver } = make();
    await host.open(YOU, page);
    await host.open(CODEX, "https://a.example/");
    const guard = driver.browser.guard;
    const ofMine = new FakePage();
    ofMine.openerPage = driver.page(0);
    const ofAgent = new FakePage();
    ofAgent.openerPage = driver.page(1);
    expect(await guard({ url: page, page: ofMine, navigation: true })).toEqual({ action: "continue" });
    expect(await guard({ url: page, page: ofAgent, navigation: true })).toEqual({ action: "block", reason: AGENT_FILE_REFUSAL });
    expect(await guard({ url: page, page: new FakePage(), navigation: true })).toEqual({ action: "block", reason: AGENT_FILE_REFUSAL });
    expect(await guard({ url: page, page: null, navigation: true })).toEqual({ action: "continue" });
    expect(await guard({ url: pathToFileURL(join(home, "site", ".env")).href, page: null, navigation: true })).toMatchObject({ action: "block" });
    expect(await guard({ url: page, page: null, navigation: false })).toEqual({ action: "block", reason: AGENT_FILE_REFUSAL });
  });

  // Defense in depth (review, 2026-10-02): AgentSwitch's own ports under names that reach this Mac, and redirect hops.
  it("own ports under any name that reaches this Mac: a trailing dot, a name that resolves here; other names and ports pass", async () => {
    const asked: string[] = [];
    const addresses: Record<string, string[]> = { "alias.test": ["127.0.0.1"], "v6.test": ["::1"], "mapped.test": ["::ffff:127.0.0.1"], "public.test": ["93.184.216.34"] };
    const { host, driver } = make({ lookup: async (name) => { asked.push(name); if (!(name in addresses)) throw new Error("ENOTFOUND"); return addresses[name]!; } });
    await host.open(YOU, "https://a.example/");
    const guard = driver.browser.guard;
    for (const url of ["http://localhost.:4711/", "http://LOCALHOST..:4711/x", "http://app.localhost.:4711/", "http://alias.test:4711/api", "http://alias.test.:4711/", "https://v6.test:4711/", "http://mapped.test:4711/"]) {
      expect(await guard({ url, page: driver.page(0), navigation: true }), url).toEqual({ action: "block", reason: OWN_PORT_REFUSAL });
    }
    for (const url of ["http://public.test:4711/", "http://nowhere.test:4711/", "http://alias.test:5173/", "https://x.com/"]) {
      expect(await guard({ url, page: driver.page(0), navigation: true }), url).toEqual({ action: "continue" });
    }
    expect(asked).not.toContain("x.com");   // a name is looked up only on one of AgentSwitch's ports
    expect(asked).toContain("alias.test");  // looked up without its trailing dot
  });

  it("tells Chrome what goes past the guard and what Chrome refuses itself (redirect hops included)", async () => {
    let ports = [4711];
    const { host, driver } = make({ ownPorts: () => ports });
    await host.open(YOU, "https://a.example/");
    const { routed, blocked } = driver.launches[0]!;
    expect(routed!(new URL("http://example.com:4711/"))).toBe(true);
    expect(routed!(new URL("http://localhost:5173/"))).toBe(true);
    expect(routed!(new URL("file:///tmp/x.html"))).toBe(true);
    expect(routed!(new URL("https://example.com/"))).toBe(false);
    expect(routed!(new URL("data:text/html,x"))).toBe(false);
    expect(blocked!()).toEqual(ownPortPatterns([4711]));
    expect(ownPortPatterns([4711])).toEqual(["*://127.*:4711/*", "*://localhost:4711/*", "*://*.localhost:4711/*", "*://[::1]:4711/*", "*://0.0.0.0:4711/*"]);
    ports = [4711, 52000];   // an OpenCode companion started
    expect(blocked!()).toHaveLength(10);
  });
});
