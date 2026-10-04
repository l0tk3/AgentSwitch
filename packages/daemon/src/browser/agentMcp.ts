/** Playwright MCP in the daemon, behind the agent bridge (agents.ts; docs/browser-v0.md §2 给 agent). Its library
 *  interface, `createConnection(config, contextGetter)` (what `@playwright/mcp` 0.0.82 exports: playwright-core's
 *  `tools.createConnection`, the same build the host drives Chrome with), runs on an `AgentContext`: a stand-in for the
 *  `BrowserContext` that holds only the agent's own tabs.
 *
 *  Why a stand-in over the shared context rather than a second context seeded from the `main` profile: decision 3 is
 *  that the terminals' agents share the user's logins, and in one context they share everything as it changes (cookies
 *  both ways, local storage, IndexedDB, service workers), with nothing to copy back and forth and no second login state
 *  to drift. What Playwright MCP may see of the context is exactly what this class offers: the agent's pages (its tabs
 *  and their popups), new pages (opened as the agent's tabs through the host), and the `page` event for those alone.
 *  Everything that acts on the whole context (routes, init scripts, cookies, storage, permissions, CDP) throws, so a
 *  newer Playwright MCP that reaches for more fails rather than touches the user's tabs.
 *
 *  Each Playwright MCP tab of an agent's page is guarded as it is made, before any call uses it (heldTraffic.ts): what
 *  a person did in the tab while holding it stays out of its network and console logs, for a reconnecting bridge too.
 *
 *  Each connection talks MCP over an in-memory transport; its workspace root and output folder are the private folder
 *  agents.ts gives it. Playwright MCP's per-connection listener for unhandled rejections (it would hand the daemon's own
 *  to the agent, and keep a real one from stopping the daemon) is taken off as it is added; rejections from Playwright's
 *  code (a refused download it tries to save) are logged instead. */

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Page } from "playwright-core";
import type { AgentEngine, EngineConnection, JsonRpcMessage } from "./agents.js";
import { HeldTraffic } from "./heldTraffic.js";
import type { BrowserHost } from "./host.js";
import type { Box, TabOwner } from "./types.js";

/** How long the box of the element a call acts on may take. */
const BOX_TIMEOUT_MS = 500;
/** How long asking a page what kind of document it holds may take. */
const KIND_TIMEOUT_MS = 500;

/** Runs in every document of an agent's tab before the page's own scripts. A document without a `body` — an SVG file
 *  opened as a page — never gets a snapshot: Playwright's (`ariaSnapshotJSONForFrame`) looks for `body,frameset` and
 *  tries again until the call's 30 s are up, so `browser_navigate` and `browser_snapshot` timed out on a page that had
 *  opened fine (2026-10-03, user: 怎么还能超时的？… 但是确实成功打开浏览器了). Such a document is given an empty body to
 *  find (an XHTML element under an SVG root is not drawn); the bridge then says what the page is. As text, not a
 *  function: a function's source carries the helpers of whatever compiled it (tsx's `__name`), which no page has. */
const STAND_IN_BODY = `(() => {
  const ensure = () => {
    const root = document.documentElement;
    if (!root || document.querySelector("body,frameset")) return;
    const body = document.createElementNS("http://www.w3.org/1999/xhtml", "body");
    body.setAttribute("data-agentswitch-stand-in", "");
    root.appendChild(body);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensure, { once: true });
  else ensure();
})();`;
/** The content type of a document that has the stand-in body, else null. */
const BODILESS_TYPE = `document.querySelector("body[data-agentswitch-stand-in]") ? document.contentType : null`;
/** Pages that have the stand-in script (one page may be in several connections' contexts). */
const prepared = new WeakSet<object>();

type McpLocator = { boundingBox(options: { timeout: number }): Promise<Box | null> };
/** What is read of Playwright MCP's own tab and context objects (public members of `tools.Tab` and its `context`). */
export type McpTab = {
  readonly page: unknown;
  readonly context: McpContext;
  targetLocator(params: { target: string }): Promise<{ readonly locator: McpLocator }>;
};
export type McpContext = { currentTab(): McpTab | undefined; tabs(): readonly McpTab[] };
type McpServer = { connect(transport: MemoryTransport): Promise<void>; close(): Promise<void> };
type McpTools = {
  createConnection(config: object, contextGetter: () => Promise<unknown>): Promise<McpServer>;
  Tab: { forPage(page: unknown): McpTab | undefined };
};

/** What an agent's context needs of the host. */
export type AgentContextHost = Pick<BrowserHost, "tabsOf" | "watch" | "page" | "open" | "close" | "list">;

let tools: McpTools | null = null;
/** playwright-core's bundle (CommonJS), loaded with the first agent connection. */
function mcpTools(): McpTools {
  tools ??= (createRequire(import.meta.url)("playwright-core/lib/coreBundle") as { tools: McpTools }).tools;
  return tools;
}

const refused = (what: string): Error => new Error(`${what} is not available to agents in AgentSwitch's shared browser`);

/** The `BrowserContext` an agent's Playwright MCP gets: its own tabs only. */
export class AgentContext extends EventEmitter {
  /** The agent's pages by tab id, in the order they opened. */
  private readonly byTab = new Map<string, unknown>();
  /** Playwright MCP's context object of this connection, once it made a tab of one of these pages. */
  private mcp: McpContext | null = null;
  /** Pages whose Playwright MCP tab could not be guarded (heldTraffic.ts): their logs are refused after a hold. */
  private readonly unguarded = new WeakSet<object>();
  private readonly stopWatching: () => void;
  /** Read by Playwright MCP's responses (is a debugger paused?): never here; nothing else of the real one is offered. */
  readonly debugger = { pausedDetails: (): null => null };

  constructor(private readonly host: AgentContextHost, private readonly owner: Pick<TabOwner, "kind" | "id" | "label">, private readonly tabOf: (page: unknown) => McpTab | undefined,
              private readonly traffic: HeldTraffic | null = null) {
    super();
    for (const tab of host.tabsOf(owner)) this.add(tab.id);
    this.stopWatching = host.watch((ev) => {
      if (ev.type === "opened" && ev.owner.kind === owner.kind && ev.owner.id === owner.id) this.add(ev.id);
      else if (ev.type === "closed") this.byTab.delete(ev.id);
    });
  }

  // ---- what Playwright MCP calls

  browser(): null { return null; }

  pages(): unknown[] { return [...this.byTab.values()]; }

  /** A new tab of the agent's (about:blank), through the host: it shows up in the app under the agent's name. */
  async newPage(): Promise<unknown> {
    const tab = await this.host.open(this.owner as TabOwner, "about:blank");
    const page = this.byTab.get(tab.id);
    if (!page) throw new Error("the new tab closed before it could be used");
    return page;
  }

  /** Playwright MCP's context subscribes right after it made tabs of the pages there are: those tabs are its own, and
   *  are guarded before any call uses them. */
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    if (event === "page") for (const page of this.byTab.values()) { this.learn(page); this.guard(page); }
    return this;
  }

  override addListener(event: string | symbol, listener: (...args: unknown[]) => void): this { return this.on(event, listener); }

  /** Closes the agent's own tabs (never another's). */
  async close(): Promise<void> {
    for (const id of [...this.byTab.keys()]) await this.host.close(id).catch(() => undefined);
  }

  async route(): Promise<never> { throw refused("context.route"); }
  async unroute(): Promise<never> { throw refused("context.unroute"); }
  async routeFromHAR(): Promise<never> { throw refused("context.routeFromHAR"); }
  async routeWebSocket(): Promise<never> { throw refused("context.routeWebSocket"); }
  async addInitScript(): Promise<never> { throw refused("context.addInitScript"); }
  async exposeBinding(): Promise<never> { throw refused("context.exposeBinding"); }
  async exposeFunction(): Promise<never> { throw refused("context.exposeFunction"); }
  async cookies(): Promise<never> { throw refused("context.cookies"); }
  async addCookies(): Promise<never> { throw refused("context.addCookies"); }
  async clearCookies(): Promise<never> { throw refused("context.clearCookies"); }
  async storageState(): Promise<never> { throw refused("context.storageState"); }
  async setStorageState(): Promise<never> { throw refused("context.setStorageState"); }
  async grantPermissions(): Promise<never> { throw refused("context.grantPermissions"); }
  async clearPermissions(): Promise<never> { throw refused("context.clearPermissions"); }
  async setGeolocation(): Promise<never> { throw refused("context.setGeolocation"); }
  async setExtraHTTPHeaders(): Promise<never> { throw refused("context.setExtraHTTPHeaders"); }
  async setOffline(): Promise<never> { throw refused("context.setOffline"); }
  async setHTTPCredentials(): Promise<never> { throw refused("context.setHTTPCredentials"); }
  async newCDPSession(): Promise<never> { throw refused("context.newCDPSession"); }

  // ---- what the bridge asks

  /** The tab the agent's next call acts on, or null when it has none. Before Playwright MCP set up its context (a new
   *  connection, before its first call) it has no current tab yet, but will take the first of `pages()`: that one. */
  currentTabId(): string | null {
    if (this.mcp) return this.idOf(this.mcp.currentTab()?.page);
    return this.byTab.keys().next().value ?? null;
  }

  /** The tab at `index` of the agent's own list (in `pages()` order until Playwright MCP has its own). */
  tabIdAt(index: number): string | null {
    if (this.mcp) return this.idOf(this.mcp.tabs()[index]?.page);
    return [...this.byTab.keys()][index] ?? null;
  }

  /** Before a call: the grace after a hand-back has passed (heldTraffic.ts). Returns the tabs, held before, whose logs
   *  could not be guarded. */
  async settle(): Promise<readonly string[]> {
    if (!this.traffic) return [];
    const traffic = this.traffic;
    await Promise.all([...this.byTab.values()].map((page) => traffic.settled(page)));
    return [...this.byTab].filter(([, page]) => this.unguarded.has(page as object) && traffic.everHeld(page)).map(([id]) => id);
  }

  /** Where `target` is on the current tab (Playwright MCP's own resolution of a ref or selector), in CSS pixels. */
  async box(target: string): Promise<Box | null> {
    const tab = this.mcp?.currentTab();
    if (!tab) return null;
    const { locator } = await tab.targetLocator({ target });
    const box = await locator.boundingBox({ timeout: BOX_TIMEOUT_MS });
    return box ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } : null;
  }

  /** The content type of tab `id`'s document when it has no body of its own (`image/svg+xml`): its snapshot is empty.
   *  Null for an HTML page, an unknown tab, or a page that does not answer in time. */
  async bodiless(id: string): Promise<string | null> {
    const page = this.byTab.get(id) as Page | undefined;
    if (!page) return null;
    if (typeof page.evaluate !== "function") return null;
    const asked = page.evaluate<string | null>(BODILESS_TYPE).catch(() => null);
    return Promise.race([asked, new Promise<null>((resolve) => setTimeout(() => resolve(null), KIND_TIMEOUT_MS))]);
  }

  dispose(): void {
    this.stopWatching();
    this.removeAllListeners();
  }

  private add(id: string): void {
    const page = (this.host.page(id)?.playwright?.() ?? null) as Page | null;
    if (!page || this.byTab.has(id)) return;
    this.byTab.set(id, page);
    if (!prepared.has(page)) {
      prepared.add(page);
      // Every document from now on, and the one it holds already (a stand-in page in the tests takes no scripts).
      try {
        void page.addInitScript?.({ content: STAND_IN_BODY })?.catch(() => undefined);
        void page.evaluate?.(STAND_IN_BODY)?.catch(() => undefined);
      } catch { /* not a page that runs scripts */ }
    }
    // A tab opened now (new, a popup, another connection of the same agent): Playwright MCP's listener makes a tab of
    // it at once, which tells this connection's context object.
    if (this.listenerCount("page") === 0) return;
    this.emit("page", page);
    this.learn(page);
    this.guard(page);
  }

  private learn(page: unknown): void {
    if (this.mcp || this.listenerCount("page") === 0) return;
    this.mcp = this.tabOf(page)?.context ?? null;
  }

  /** This connection's Playwright MCP tab of `page`, guarded against what a hold left behind. */
  private guard(page: unknown): void {
    if (!this.traffic || !page || typeof page !== "object") return;
    const tab = this.tabOf(page);
    // Only this connection's own tab (the newest tagger); another connection guards its own.
    if (!tab || (this.mcp && tab.context !== this.mcp)) return;
    if (!this.traffic.guardTab(tab, page)) this.unguarded.add(page);
  }

  private idOf(page: unknown): string | null {
    if (!page) return null;
    for (const [id, p] of this.byTab) if (p === page) return id;
    return null;
  }
}

/** MCP between the bridge and Playwright MCP's server, in memory (the SDK's Transport shape). */
class MemoryTransport {
  onmessage?: ((message: unknown, extra?: unknown) => void) | undefined;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;

  constructor(private readonly out: (message: JsonRpcMessage) => void) {}

  async start(): Promise<void> { /* nothing to open */ }
  async send(message: unknown): Promise<void> { this.out(message as JsonRpcMessage); }
  async close(): Promise<void> {
    const closed = this.onclose;
    this.onclose = undefined;
    closed?.();
  }
  deliver(message: JsonRpcMessage): void { this.onmessage?.(message); }
}

// ---- unhandled rejections while agents are connected

let connections = 0;
let logRejection: (line: string) => void = console.error;
/** Playwright MCP's context listener (it collects every unhandled rejection of the process for its next answer). */
const isMcpListener = (listener: unknown): boolean => typeof listener === "function" && String(listener).includes("_pendingUnhandledRejections");
let playwrightError: (abstract new (...args: never[]) => Error) | null | undefined;
/** Playwright's own error class (what a refused download's `saveAs` rejects with; its stack points at the caller). */
function playwrightErrorClass(): (abstract new (...args: never[]) => Error) | null {
  if (playwrightError !== undefined) return playwrightError;
  try {
    const { errors } = createRequire(import.meta.url)("playwright-core") as { errors: { TimeoutError: { prototype: object } } };
    playwrightError = (Object.getPrototypeOf(errors.TimeoutError.prototype) as { constructor: abstract new (...args: never[]) => Error }).constructor;
  } catch { playwrightError = null; }
  return playwrightError;
}
const fromPlaywright = (reason: unknown): boolean => {
  if (!(reason instanceof Error)) return false;
  const known = playwrightErrorClass();
  return (known !== null && reason instanceof known) || /[\\/]playwright-core[\\/]/.test(reason.stack ?? "");
};

function onNewListener(event: string | symbol, listener: unknown): void {
  // Added right after this event: taken off before any rejection is reported (that happens after the microtasks).
  if (event === "unhandledRejection" && isMcpListener(listener)) queueMicrotask(() => process.removeListener("unhandledRejection", listener as () => void));
}

function onRejection(reason: unknown): void {
  if (fromPlaywright(reason)) { logRejection(`browser: Playwright MCP: ${String((reason as Error).message).split("\n")[0]}`); return; }
  // Not Playwright's: as Node does when nobody listens.
  process.nextTick(() => { throw reason; });
}

function guardRejections(log: (line: string) => void): () => void {
  logRejection = log;
  if (connections++ === 0) {
    process.on("newListener", onNewListener);
    process.on("unhandledRejection", onRejection);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--connections === 0) {
      process.removeListener("newListener", onNewListener);
      process.removeListener("unhandledRejection", onRejection);
    }
  };
}

/** The engine agents.ts runs each agent connection on. Holds are followed from now on, for every agent tab, whether
 *  or not an agent is connected (heldTraffic.ts). */
export function playwrightEngine(host: AgentContextHost, log: (line: string) => void = console.error, traffic: HeldTraffic = new HeldTraffic(host, { log })): AgentEngine {
  return async ({ owner, outputDir, send }): Promise<EngineConnection> => {
    const mcp = mcpTools();
    const release = guardRejections(log);
    const context = new AgentContext(host, owner, (page) => mcp.Tab.forPage(page), traffic);
    let server: McpServer;
    const transport = new MemoryTransport(send);
    try {
      server = await mcp.createConnection({ outputDir }, async () => context);
      await server.connect(transport);
    } catch (err) {
      context.dispose();
      release();
      throw err;
    }
    return {
      receive: (message) => transport.deliver(message),
      currentTab: () => context.currentTabId(),
      tabAt: (index) => context.tabIdAt(index),
      box: (target) => context.box(target),
      settle: () => context.settle(),
      bodiless: (tab) => context.bodiless(tab),
      close: async () => {
        try { await server.close(); } finally { context.dispose(); release(); }
      },
    };
  };
}
