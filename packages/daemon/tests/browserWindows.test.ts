/** The browser with windows of its own (docs/browser-v0.md §7.2, §7.3 窗口), on a fake one: a window keeps the size the
 *  person gave it until a screen takes the tab, and has it back after; the person's own new tabs are tabs of theirs;
 *  input in an agent's window is the person taking it over; a window is brought to the front and pictured; the browser
 *  restarted comes back with its tabs. */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserHost, HOLD_IDLE_MS, type BrowserHostOptions } from "../src/browser/host.js";
import { BrowserError, WINDOW_HOLDER, YOU, type BrowserEvent, type TabOwner } from "../src/browser/types.js";
import { defaultProtected } from "../src/executors/protected.js";
import { FakeDriver } from "./fakeBrowser.js";

const CODEX: TabOwner = { kind: "terminal", id: "t1", label: "codex · AgentSwitch" };
const home = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-browser-windows-")));
const rules = { protected: defaultProtected({ HOME: home, AGENTSWITCH_HOME: join(home, ".agentswitch"), SECRET_GATE_HOME: join(home, ".secret-gate") }), home };

const hosts: BrowserHost[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const h of hosts.splice(0)) await h.shutdown();
});

function make(windows: boolean, over: Partial<BrowserHostOptions> = {}): { host: BrowserHost; driver: FakeDriver } {
  const driver = new FakeDriver();
  driver.windows = windows;
  const host = new BrowserHost({ driver, profileDir: join(home, "profile"), files: rules, ownPorts: () => [4711], log: () => undefined, mac: true, ...over });
  hosts.push(host);
  return { host, driver };
}

describe("a tab in a window of its own", () => {
  it("is not given a size: the window is the person's to size; without windows the default size as before", async () => {
    const { host, driver } = make(true);
    await host.open(YOU, "https://example.com/");
    expect(driver.page().viewports).toEqual([]);
    const plain = make(false);
    await plain.host.open(YOU, "https://example.com/");
    expect(plain.driver.page().viewports).toHaveLength(1);
  });

  it("takes the size of the screen that holds it, and its own size again on hand-back", async () => {
    const { host, driver } = make(true);
    const tab = await host.open(YOU, "https://example.com/");
    const before = driver.page().restores;
    host.take(tab.id, "phone-1");
    await host.setViewport(tab.id, "phone-1", { width: 390, height: 844, scale: 3, mobile: true });
    expect(driver.page().viewports.map((v) => [v.width, v.height])).toEqual([[390, 844]]);
    expect(driver.page().restores).toBe(before);
    host.release(tab.id, "phone-1");
    await vi.waitFor(() => expect(driver.page().restores).toBe(before + 1));
    // Nothing set in its place.
    expect(driver.page().viewports).toHaveLength(1);
  });

  it("is brought to the front when asked, and pictured (a picture serves a moment)", async () => {
    let now = 1_000;
    const { host, driver } = make(true, { now: () => now });
    const tab = await host.open(YOU, "https://example.com/");
    await host.show(tab.id);
    expect(driver.page().fronts).toBe(1);
    expect((await host.picture(tab.id)).toString()).toBe("picture 1");
    expect((await host.picture(tab.id)).toString()).toBe("picture 1");
    now += 5_000;
    expect((await host.picture(tab.id)).toString()).toBe("picture 2");
    await expect(host.show("nope")).rejects.toBeInstanceOf(BrowserError);
  });

  it("without windows there is nothing to bring forward or picture", async () => {
    const { host, driver } = make(false);
    const tab = await host.open(YOU, "https://example.com/");
    driver.page().show = undefined as never;
    driver.page().picture = undefined as never;
    await expect(host.show(tab.id)).rejects.toMatchObject({ code: "unavailable" });
    await expect(host.picture(tab.id)).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("tabs the person opens in a window themselves", () => {
  it("are tabs of theirs", async () => {
    const { host, driver } = make(true);
    await host.open(CODEX, "https://example.com/a");
    const events: unknown[] = [];
    host.watch((e) => events.push(e));
    driver.browser.appear("https://example.org/mine");
    const mine = host.list().find((t) => t.url === "https://example.org/mine");
    expect(mine?.owner).toEqual(YOU);
    expect(events).toContainEqual({ type: "opened", id: mine!.id, owner: YOU });
  });
});

describe("input in an agent's window (§7.2 第 4 条)", () => {
  it("is the person taking the tab over: the agent waits; two minutes without input hand it back", async () => {
    vi.useFakeTimers();
    const { host, driver } = make(true);
    const tab = await host.open(CODEX, "https://example.com/");
    expect(driver.page().watched).toBe(true);
    const events: BrowserEvent[] = [];
    host.subscribe(tab.id, { quality: 60, fps: 10 }, (e) => events.push(e));
    driver.page().touch();
    expect(host.get(tab.id)?.heldBy).toBe(WINDOW_HOLDER);
    expect(events.some((e) => e.type === "held" && e.heldBy === WINDOW_HOLDER)).toBe(true);
    // More input keeps it; none for two minutes hands it back.
    await vi.advanceTimersByTimeAsync(HOLD_IDLE_MS - 1_000);
    driver.page().touch();
    await vi.advanceTimersByTimeAsync(HOLD_IDLE_MS - 1_000);
    expect(host.get(tab.id)?.heldBy).toBe(WINDOW_HOLDER);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.get(tab.id)?.heldBy).toBeNull();
  });

  it("is not the person's while the agent itself is at the page, nor right after a screen sent input", async () => {
    const { host, driver } = make(true);
    const tab = await host.open(CODEX, "https://example.com/");
    await host.agentActing(CODEX);
    driver.page().touch();
    expect(host.get(tab.id)?.heldBy).toBeNull();
    host.agentDone(CODEX);
    // A phone holds it and sends a click: the input seen in the page is the phone's.
    host.take(tab.id, "phone-1");
    await host.input(tab.id, "phone-1", [{ type: "text", text: "x" }]);
    driver.page().touch();
    expect(host.get(tab.id)?.heldBy).toBe("phone-1");
  });

  it("means nothing in the person's own tab, and nothing where pages have no windows", async () => {
    const { host, driver } = make(true);
    const mine = await host.open(YOU, "https://example.com/");
    expect(driver.page().watched).not.toBe(true);
    driver.page().touch();
    expect(host.get(mine.id)?.heldBy).toBeNull();
    const plain = make(false);
    const theirs = await plain.host.open(CODEX, "https://example.com/");
    plain.driver.page().touch();
    expect(plain.host.get(theirs.id)?.heldBy).toBeNull();
  });

  it("the person hands it back themselves", async () => {
    const { host, driver } = make(true);
    const tab = await host.open(CODEX, "https://example.com/");
    driver.page().touch();
    host.release(tab.id, WINDOW_HOLDER);
    expect(host.get(tab.id)?.heldBy).toBeNull();
  });
});

describe("the browser restarted (an engine switched to, another fingerprint)", () => {
  it("comes back with its tabs, each its owner's, at the address it was at; what is to happen in between happens while it is down", async () => {
    const { host, driver } = make(true);
    await host.open(YOU, "https://example.com/mine");
    await host.open(CODEX, "https://example.com/theirs");
    driver.page(0).change("https://example.com/mine/later", "Mine");
    const order: string[] = [];
    await host.restart(async () => { order.push(`between: ${driver.browsers[0]!.closed ? "down" : "up"}, ${host.list().length} tabs`); });
    expect(order).toEqual(["between: down, 0 tabs"]);
    expect(driver.launches).toHaveLength(2);
    expect(host.list().map((t) => t.owner.kind).sort()).toEqual(["terminal", "you"]);
    expect(driver.browsers[1]!.pages.map((p) => p.navigations)).toEqual([["https://example.com/mine/later"], ["https://example.com/theirs"]]);
  });

  it("with no tabs it only stops, to start afresh at the next tab", async () => {
    const { host, driver } = make(true);
    const tab = await host.open(YOU, "https://example.com/");
    await host.close(tab.id);
    let ran = false;
    await host.restart(async () => { ran = true; });
    expect(ran).toBe(true);
    expect(driver.launches).toHaveLength(1);
    await host.open(YOU, "https://example.com/");
    expect(driver.launches).toHaveLength(2);
  });
});

// ---- over the API ----
import { Hono } from "hono";
import { mountBrowser } from "../src/api/browser.js";
import type { ApiDeps } from "../src/api/shared.js";
import { sharedBrowser } from "../src/browser/setup.js";
import { markRemote } from "../src/core/caller.js";

describe("windows over the API", () => {
  function setup() {
    const driver = new FakeDriver();
    driver.windows = true;
    const api = sharedBrowser({ home: mkdtempSync(join(home, "api-")), userHome: home, driver, ownPorts: () => [4711], protected: rules.protected });
    hosts.push(api.host);
    const app = new Hono();
    mountBrowser(app, { browser: api, sseHeartbeatMs: 20 } as unknown as ApiDeps);
    return { app, api, driver };
  }

  it("the list says which browser it is and whether its tabs have windows", async () => {
    const { app } = setup();
    expect(await (await app.request("/browser/tabs")).json()).toMatchObject({ running: false, groups: [], engine: "chrome", windows: false });
  });

  it("a tab's window is brought forward and pictured for this Mac, not for a paired phone", async () => {
    const { app, api, driver } = setup();
    const tab = await api.host.open(YOU, "https://example.com/");
    expect((await app.request(`/browser/tabs/${tab.id}/show`, { method: "POST" })).status).toBe(200);
    expect(driver.page().fronts).toBe(1);
    const preview = await app.request(`/browser/tabs/${tab.id}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await preview.arrayBuffer()).toString()).toBe("picture 1");
    expect((await app.request("/browser/tabs/nope/show", { method: "POST" })).status).toBe(404);
    const phone = markRemote({}, { deviceId: "dev-phone" });
    expect((await app.request(`/browser/tabs/${tab.id}/show`, { method: "POST" }, phone)).status).toBe(403);
    expect((await app.request(`/browser/tabs/${tab.id}/preview`, {}, phone)).status).toBe(403);
  });

  it("the person hands a tab they stepped into back as the window", async () => {
    const { app, api, driver } = setup();
    const tab = await api.host.open(CODEX, "https://example.com/");
    driver.page().touch();
    expect((await (await app.request("/browser/tabs")).json() as { groups: { tabs: { heldBy: string }[] }[] }).groups[0]!.tabs[0]!.heldBy).toBe(WINDOW_HOLDER);
    const back = await app.request(`/browser/tabs/${tab.id}/release`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ screen: WINDOW_HOLDER }) });
    expect(back.status).toBe(200);
    expect(api.host.get(tab.id)?.heldBy).toBeNull();
  });
});
