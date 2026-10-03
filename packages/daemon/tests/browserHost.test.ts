/** The browser host on a fake Chrome (docs/browser-v0.md §2): Chrome started on first use and once, tabs by owner,
 *  popups, holds that end on hand-back or after two minutes, the holder's size, input mapped from the frame, the
 *  request guard, a dead Chrome and a Chrome with no tabs left, shut-down. */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HOLD_IDLE_MS, BrowserHost, launchFailure, ownPortPatterns, type BrowserHostOptions } from "../src/browser/host.js";
import { AGENT_FILE_REFUSAL, OWN_PORT_REFUSAL, type FileRules } from "../src/browser/rules.js";
import { BrowserError, DEFAULT_VIEWPORT, YOU, type BrowserEvent, type TabOwner } from "../src/browser/types.js";
import { defaultProtected } from "../src/executors/protected.js";
import { FakeDriver, FakePage } from "./fakeBrowser.js";

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
