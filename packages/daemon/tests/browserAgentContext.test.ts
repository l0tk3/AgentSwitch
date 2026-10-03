/** The BrowserContext an agent's Playwright MCP gets (agentMcp.ts `AgentContext`), on the host with a fake Chrome and a
 *  stand-in for Playwright MCP's own context object (which makes a tab of every page it is given and tags the page with
 *  it, as `tools.Tab` does): only the agent's own tabs are listed and announced, new pages become the agent's tabs,
 *  context-wide calls are refused, and each connection follows its own MCP context. */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentContext, type McpContext, type McpTab } from "../src/browser/agentMcp.js";
import { HeldTraffic } from "../src/browser/heldTraffic.js";
import { BrowserHost } from "../src/browser/host.js";
import { YOU, type TabOwner } from "../src/browser/types.js";
import { FakeDriver, type FakePage } from "./fakeBrowser.js";

const CODEX: TabOwner = { kind: "terminal", id: "t1", label: "codex · AgentSwitch" };
const CLAUDE: TabOwner = { kind: "terminal", id: "t2", label: "claude · site" };

/** Playwright MCP's context object, as far as the agent context meets it: it lists the pages once, makes a tab of each
 *  and of every page announced after, and tags each page with its tab (the newest tagger wins, as `page[tabSymbol]`). */
class FakeMcp implements McpContext {
  static readonly TAG = Symbol("tab");
  readonly made: McpTab[] = [];
  current: McpTab | undefined;

  constructor(readonly context: AgentContext) {
    for (const page of context.pages()) this.make(page);
    context.on("page", (page: unknown) => this.make(page));
  }

  private make(page: unknown): void {
    const tab: McpTab = { page, context: this, targetLocator: async () => ({ locator: { boundingBox: async () => ({ x: 10.4, y: 20.6, width: 99.5, height: 30 }) } }) };
    (page as Record<symbol, McpTab>)[FakeMcp.TAG] = tab;
    this.made.push(tab);
    this.current ??= tab;
  }

  currentTab(): McpTab | undefined { return this.current; }
  tabs(): readonly McpTab[] { return this.made; }
}
const tabOf = (page: unknown): McpTab | undefined => (page as Record<symbol, McpTab>)[FakeMcp.TAG];

const hosts: BrowserHost[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.shutdown(); });

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-agent-context-")));
  const driver = new FakeDriver();
  const host = new BrowserHost({ driver, profileDir: join(root, "profile"), files: { protected: { roots: [], exempt: [] }, home: root }, ownPorts: () => [], log: () => undefined, mac: true });
  hosts.push(host);
  const pageOf = (id: string): FakePage => host.page(id) as FakePage;
  return { host, driver, pageOf };
}

const raw = (page: FakePage) => page.raw;

describe("an agent's context", () => {
  it("lists and announces the agent's own tabs only, never a person's or another agent's", async () => {
    const { host, pageOf } = setup();
    const mine = await host.open(YOU, "https://mine.example/");
    const theirs = await host.open(CLAUDE, "https://theirs.example/");
    const own = await host.open(CODEX, "https://own.example/");
    const context = new AgentContext(host, CODEX, tabOf);
    expect(context.pages()).toEqual([raw(pageOf(own.id))]);
    const announced: unknown[] = [];
    context.on("page", (p: unknown) => announced.push(p));
    await host.open(YOU, "https://another-mine.example/");
    await host.open(CLAUDE, "https://another-theirs.example/");
    const second = await host.open(CODEX, "https://second.example/");
    expect(announced).toEqual([raw(pageOf(second.id))]);
    // Popups follow their opener's owner.
    const popup = pageOf(own.id).popup();
    pageOf(mine.id).popup();
    pageOf(theirs.id).popup();
    await new Promise((r) => setTimeout(r, 0));
    expect(announced).toEqual([raw(pageOf(second.id)), popup.raw]);
    expect(context.pages()).toEqual([raw(pageOf(own.id)), raw(pageOf(second.id)), popup.raw]);
    // A closed tab leaves the list.
    await host.close(second.id);
    expect(context.pages()).toEqual([raw(pageOf(own.id)), popup.raw]);
    context.dispose();
  });

  it("a new page is a new tab of the agent's, announced before it is handed over", async () => {
    const { host } = setup();
    const context = new AgentContext(host, CODEX, tabOf);
    const mcp = new FakeMcp(context);
    const page = await context.newPage();
    expect(mcp.tabs().map((t) => t.page)).toEqual([page]);
    const [tab] = host.tabsOf(CODEX);
    expect(tab).toMatchObject({ owner: CODEX, url: "about:blank" });
    expect(context.currentTabId()).toBe(tab!.id);
    expect(context.tabIdAt(0)).toBe(tab!.id);
    expect(context.tabIdAt(3)).toBeNull();
    expect(await context.box("e12")).toEqual({ x: 10, y: 21, width: 100, height: 30 });
  });

  it("refuses what reaches the whole context; closes only its own tabs", async () => {
    const { host } = setup();
    const mine = await host.open(YOU, "https://mine.example/");
    const theirs = await host.open(CLAUDE, "https://theirs.example/");
    const context = new AgentContext(host, CODEX, tabOf);
    await context.newPage();
    await context.newPage();
    for (const call of [() => context.route(), () => context.unroute(), () => context.addInitScript(), () => context.cookies(), () => context.addCookies(),
      () => context.clearCookies(), () => context.storageState(), () => context.setStorageState(), () => context.grantPermissions(), () => context.exposeBinding(),
      () => context.setExtraHTTPHeaders(), () => context.setOffline(), () => context.newCDPSession()]) {
      await expect(call()).rejects.toThrow(/not available to agents/);
    }
    expect(context.browser()).toBeNull();
    expect(context.debugger.pausedDetails()).toBeNull();
    expect((context as unknown as Record<string, unknown>).tracing).toBeUndefined();
    await context.close();
    expect(host.list().map((t) => t.id).sort()).toEqual([mine.id, theirs.id].sort());
  });

  it("each connection follows its own Playwright MCP context, though both tag the same pages", async () => {
    const { host } = setup();
    const a = new AgentContext(host, CODEX, tabOf);
    const mcpA = new FakeMcp(a);
    await a.newPage();
    const b = new AgentContext(host, CODEX, tabOf);
    const mcpB = new FakeMcp(b);   // tags the first page now
    await b.newPage();
    const [first, second] = host.tabsOf(CODEX);
    mcpA.current = mcpA.tabs()[1];
    mcpB.current = mcpB.tabs()[0];
    expect(a.currentTabId()).toBe(second!.id);
    expect(b.currentTabId()).toBe(first!.id);
    expect(mcpA.tabs()).toHaveLength(2);
    expect(mcpB.tabs()).toHaveLength(2);
  });

  it("before Playwright MCP set up its context: the tab it will take first (the first page), or none", async () => {
    const { host } = setup();
    await host.open(YOU, "https://mine.example/");
    const empty = new AgentContext(host, CODEX, tabOf);
    expect(empty.currentTabId()).toBeNull();
    expect(empty.tabIdAt(0)).toBeNull();
    expect(await empty.box("e1")).toBeNull();
    empty.dispose();
    // A new connection of an agent that has tabs (review 2026-10-02: the bridge then knew no target, and skipped holds).
    const first = await host.open(CODEX, "https://own.example/");
    const second = await host.open(CODEX, "https://second.example/");
    const context = new AgentContext(host, CODEX, tabOf);
    expect(context.currentTabId()).toBe(first.id);
    expect(context.tabIdAt(1)).toBe(second.id);
    const mcp = new FakeMcp(context);   // as Playwright MCP sets up: the first page is its current tab
    expect(mcp.currentTab()!.page).toBe(context.pages()[0]);
    expect(context.currentTabId()).toBe(first.id);
    context.dispose();
  });

  it("guards each tab Playwright MCP makes; after a hold, waits out the grace and names the tabs it could not guard", async () => {
    const { host } = setup();
    const traffic = new HeldTraffic(host, { graceMs: 40, log: () => undefined });
    const own = await host.open(CODEX, "https://own.example/");
    const guarded: unknown[] = [];
    const spy = traffic.guardTab.bind(traffic);
    traffic.guardTab = (tab: unknown, page: unknown) => { guarded.push(page); return spy(tab, page); };
    const context = new AgentContext(host, CODEX, tabOf, traffic);
    new FakeMcp(context);   // its tabs are not Playwright MCP's own: they cannot be guarded
    expect(guarded).toEqual(context.pages());
    expect(await context.settle()).toEqual([]);   // never held: nothing to keep out
    host.take(own.id, "phone-1");
    host.release(own.id, "phone-1");
    const started = Date.now();
    expect(await context.settle()).toEqual([own.id]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);   // the grace after the hand-back
    const second = await context.newPage();
    expect(guarded.at(-1)).toBe(second);
    context.dispose();
  });
});
