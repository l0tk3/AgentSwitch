/** What a person does in an agent's tab while holding it stays out of the agent's logs (docs/browser-v0.md §6 接手).
 *
 *  Playwright MCP keeps, per tab, the network requests (with their bodies: a login form's POST holds the password the
 *  person typed) and reads the page's console; `browser_network_request(s)` and `browser_console_messages` hand them to
 *  the agent after the hand-back. A connection made later (a bridge that reconnects) builds its tabs from the page's own
 *  records (`page.requests()`, `page.consoleMessages()`), so clearing one connection's lists is not enough. Instead:
 *
 *  - here, for every agent tab, from its opening and whether or not an agent is connected: when holds begin and end,
 *    and every request the page makes while held or within a short grace after (a submit just before the hand-back
 *    reaches Playwright a moment later). The agent's next call waits out the grace; page errors (which carry no time)
 *    are cleared from the page once it has passed;
 *  - on every Playwright MCP tab of an agent's page (agentMcp.ts calls `guardTab` as each is made, before it is used):
 *    its request list leaves out those requests (and any whose start falls in a hold), its console leaves out messages
 *    from a hold, and while a hold lasts nothing new is recorded or written to its console log file.
 *
 *  What stays visible: the page itself. After the hand-back the agent's snapshots show the page as the person left it:
 *  text typed into fields that are not password fields, and anything the page shows or stores (BOUNDARY.md). Requests a
 *  page sends later on its own (a delayed submit) are not a hold's. Playwright MCP's `Tab` internals are what this
 *  relies on (0.0.82 in playwright-core 1.64): a tab that is not as expected is reported, and the bridge refuses its
 *  logs (fail closed). */

import type { BrowserHost } from "./host.js";

/** A request still counts as the hold's this long after the hand-back. */
export const HOLD_GRACE_MS = 1_500;

type Window = { readonly start: number; readonly end: number | null };

type PageTraffic = {
  readonly windows: Window[];
  readonly tainted: WeakSet<object>;
  /** Resolves once the grace after the last hold has passed and the page's errors are cleared. */
  settled: Promise<void>;
  detach: () => void;
};

/** What is read of a Playwright page: its request events, and its page errors to clear. */
type PageLike = {
  on?(event: "request", listener: (request: object) => void): unknown;
  off?(event: "request", listener: (request: object) => void): unknown;
  clearPageErrors?(): Promise<void>;
};

/** What is read of a Playwright request. */
type RequestLike = { timing?(): { readonly startTime?: number } };

/** What is read of a console message as Playwright MCP's tab hands it on. */
type MessageLike = { readonly timestamp?: number; readonly type?: string };

/** The members of Playwright MCP's `Tab` (tools/backend/tab.ts) that are guarded. */
type TabInternals = {
  requests(): Promise<object[]>;
  consoleMessages(level?: string, all?: boolean): Promise<MessageLike[]>;
  consoleMessageCount(): Promise<{ total: number; errors: number; warnings: number }>;
  _handleRequest(request: object): void;
  _handleConsoleMessage(message: MessageLike): void;
};

export type HeldTrafficOptions = { readonly graceMs?: number; readonly now?: () => number; readonly log?: (line: string) => void };

export type TrafficHost = Pick<BrowserHost, "watch" | "page" | "list">;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); });
const isFunction = (v: unknown): boolean => typeof v === "function";

export class HeldTraffic {
  private readonly byTab = new Map<string, PageTraffic>();
  private readonly pages = new WeakMap<object, PageTraffic>();
  private readonly guarded = new WeakSet<object>();
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly host: TrafficHost, opts: HeldTrafficOptions = {}) {
    this.graceMs = opts.graceMs ?? HOLD_GRACE_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.error;
    for (const tab of host.list()) if (tab.owner.kind !== "you") this.follow(tab.id);
    host.watch((ev) => {
      if (ev.type === "opened" && ev.owner.kind !== "you") this.follow(ev.id);
      else if (ev.type === "held") this.held(ev.id, ev.heldBy !== null);
      else if (ev.type === "closed") this.forget(ev.id);
    });
  }

  /** Was the page ever held (its logs need guarding)? */
  everHeld(page: unknown): boolean {
    return (this.of(page)?.windows.length ?? 0) > 0;
  }

  /** Resolves once the page is past its last hold's grace (at once when it has none). */
  settled(page: unknown): Promise<void> {
    return this.of(page)?.settled ?? Promise.resolve();
  }

  /** True for a request made while the page was held, or within the grace after. */
  hides(page: unknown, request: object): boolean {
    const traffic = this.of(page);
    if (!traffic) return false;
    if (traffic.tainted.has(request)) return true;
    const start = (request as RequestLike).timing?.().startTime ?? 0;
    return start > 0 && this.within(traffic, start);
  }

  /** True for a time (ms) within one of the page's holds or the grace after it. */
  during(page: unknown, at: number | undefined): boolean {
    const traffic = this.of(page);
    return traffic !== undefined && typeof at === "number" && this.within(traffic, at);
  }

  /** Playwright MCP's tab of an agent's page, guarded before it is used: its lists leave out what a hold left behind.
   *  False when the tab is not as expected (its logs are then refused by the bridge). */
  guardTab(tab: unknown, page: unknown): boolean {
    if (!tab || typeof tab !== "object") return false;
    if (this.guarded.has(tab)) return true;
    const t = tab as TabInternals;
    if (![t.requests, t.consoleMessages, t.consoleMessageCount, t._handleRequest, t._handleConsoleMessage].every(isFunction)) {
      this.log("browser: Playwright MCP's tab is not as expected; its logs are refused after a hold");
      return false;
    }
    const requests = t.requests.bind(tab);
    const consoleMessages = t.consoleMessages.bind(tab);
    const handleRequest = t._handleRequest.bind(tab);
    const handleConsoleMessage = t._handleConsoleMessage.bind(tab);
    // Methods of this one tab object (Playwright MCP calls them on `this`); the class is untouched.
    Object.assign(tab, {
      requests: async () => (await requests()).filter((r) => !this.hides(page, r)),
      consoleMessages: async (level?: string, all?: boolean) => (await consoleMessages(level, all)).filter((m) => !this.during(page, m.timestamp)),
      consoleMessageCount: async () => {
        const shown = await t.consoleMessages("debug", false);
        return { total: shown.length, errors: shown.filter((m) => m.type === "error").length, warnings: shown.filter((m) => m.type === "warning").length };
      },
      _handleRequest: (request: object) => { if (!this.hides(page, request) && !this.quiet(page)) handleRequest(request); },
      _handleConsoleMessage: (message: MessageLike) => { if (!this.during(page, message.timestamp) && !this.quiet(page)) handleConsoleMessage(message); },
    });
    this.guarded.add(tab);
    return true;
  }

  // ---- holds

  private of(page: unknown): PageTraffic | undefined {
    return page && typeof page === "object" ? this.pages.get(page) : undefined;
  }

  private pageOf(id: string): PageLike | null {
    const page = this.host.page(id)?.playwright?.();
    return page && typeof page === "object" ? page as PageLike : null;
  }

  private follow(id: string): void {
    if (this.byTab.has(id)) return;
    const page = this.pageOf(id);
    const traffic: PageTraffic = { windows: [], tainted: new WeakSet(), settled: Promise.resolve(), detach: () => undefined };
    this.byTab.set(id, traffic);
    if (!page) return;
    this.pages.set(page, traffic);
    if (!page.on) return;
    const onRequest = (request: object) => { if (this.quiet(page)) traffic.tainted.add(request); };
    page.on("request", onRequest);
    traffic.detach = () => { page.off?.("request", onRequest); };
  }

  private held(id: string, held: boolean): void {
    const traffic = this.byTab.get(id);
    if (!traffic) return;
    const last = traffic.windows.at(-1);
    const open = last !== undefined && last.end === null;
    if (held) {
      if (!open) traffic.windows.push({ start: this.now(), end: null });
      return;
    }
    if (!open) return;
    traffic.windows[traffic.windows.length - 1] = { start: last.start, end: this.now() };
    const page = this.pageOf(id);
    // After the grace: the page errors of the hold go (they carry no time to tell them by).
    traffic.settled = sleep(this.graceMs).then(async () => {
      if (traffic.windows.at(-1)?.end === null) return;
      await page?.clearPageErrors?.().catch((err: unknown) => this.log(`browser: page errors not cleared: ${String((err as Error)?.message ?? err).split("\n")[0]}`));
    });
  }

  private forget(id: string): void {
    this.byTab.get(id)?.detach();
    this.byTab.delete(id);
  }

  /** Held now, or within the grace after the last hold. */
  private quiet(page: unknown): boolean {
    const last = this.of(page)?.windows.at(-1);
    return last !== undefined && (last.end === null || this.now() <= last.end + this.graceMs);
  }

  /** After the take (what the agent did up to it is its own) and up to the grace after the hand-back. */
  private within(traffic: PageTraffic, at: number): boolean {
    return traffic.windows.some((w) => at > w.start && (w.end === null || at <= w.end + this.graceMs));
  }
}
