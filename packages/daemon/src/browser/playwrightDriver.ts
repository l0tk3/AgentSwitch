/** The real browser behind the host (browser-v0 §2 结构): the user's installed Google Chrome (`channel: "chrome"`, as the
 *  executors' browser), launched by playwright-core as a persistent context on the `main` profile, new headless, over
 *  Playwright's pipe (`--remote-debugging-pipe`): Chrome opens no debugging port, so nothing else on this Mac (an
 *  agent's shell included) can attach to it. Chrome's sandbox stays on, downloads are refused.
 *
 *  Each page gets a CDP session of its own for the screencast, input and size. A title is read (in Playwright's utility
 *  world, out of the page's reach) on load, after the page repaints and every two seconds: Chrome's target list reports
 *  a title change late or not at all (seen with Chrome 154). Every `file:` request, every request to this Mac and every
 *  one to a port of AgentSwitch's goes past the host's guard first: a refused navigation shows the reason as the page, a
 *  refused subresource is not loaded. Playwright's routes never see a redirect hop, so Chrome itself refuses
 *  AgentSwitch's own ports on every page (`Network.setBlockedURLs`, which also holds for redirected subresources), and a
 *  navigation a redirect brings to a refused place is stopped as soon as it is seen (the hop has reached the server by
 *  then). A person's fill types into the very field that was checked (its element handle). playwright-core is loaded on
 *  first use only, so a daemon that never opens a tab never loads it. */

import type { BrowserContext, CDPSession, ElementHandle, Frame, Page, Request, Route } from "playwright-core";
import type { BrowserDriver, DriverBrowser, DriverCookie, DriverPage, FocusedField, GuardDecision, LaunchOptions, PageEvents, RequestGuard, ScreencastParams } from "./driver.js";
import type { InputMethod } from "./driver.js";
import { bundledPlaywright, notePlaywrightInUse, type PlaywrightCopy } from "./engine/loader.js";
import { isLoopbackHost } from "./rules.js";
import { viewAt } from "./screencast.js";
import { DEFAULT_VIEWPORT, type Viewport } from "./types.js";

const LAUNCH_TIMEOUT_MS = 30_000;
/** A navigation the API started is given this long to commit before Playwright gives up on it (the page stays). */
const NAVIGATION_TIMEOUT_MS = 30_000;
/** Title changes come in bursts (a page setting it while loading): one read after the burst. */
const TITLE_SETTLE_MS = 50;
/** A title set without a repaint (a background tab, a timer) is read at most this late. */
const TITLE_POLL_MS = 2_000;
/** How long one frame's focused element is given to answer whether it is editable. */
const FOCUS_CHECK_MS = 1_000;
/** The focused element of a frame's document that takes typed text: not the frame element holding a focused child
 *  frame, not a select. Matched by Playwright's selector engine in its utility world, out of the page's reach. */
const FOCUSED_FIELD = ":focus:not(iframe):not(frame):not(select)";
/** A field for a secret (browser-v0 §6): a password field, or one marked for a password or a one-time code. A person's
 *  fill goes into these only: the screens show the rest as typed. */
export const SECRET_FIELD = ':is(input[type="password" i], input[autocomplete~="current-password" i], input[autocomplete~="new-password" i], input[autocomplete~="one-time-code" i])';
/** How long typing a filled value into its field may take. */
const FILL_TIMEOUT_MS = 5_000;

/** The URLs of `frame` and every frame above it, innermost first. */
function frameChain(frame: Frame): string[] {
  const urls: string[] = [];
  for (let f: Frame | null = frame; f; f = f.parentFrame()) urls.push(f.url());
  return urls;
}

type Send = (method: string, params?: object) => Promise<unknown>;

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What a refused navigation shows instead of the page (the demo's "Not Viewable" box). */
export function refusalPage(reason: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Not Viewable</title></head>`
    + `<body style="margin:0;padding:32px;background:#000;color:#e9e6df;font:14px/1.6 -apple-system,'PingFang SC',sans-serif">`
    + `<div style="border:1px solid #e9e6df;padding:14px;max-width:560px"><h1 style="margin:0 0 8px;font:600 13px ui-monospace,Menlo,monospace;color:#ffb000">[!] Not Viewable</h1>`
    + `<p style="margin:0;color:#8d8a84">${escapeHtml(reason)}</p></div></body></html>`;
}

class PlaywrightPage implements DriverPage {
  readonly ready: Promise<void>;
  private session: CDPSession | null = null;
  private targetId: string | null = null;
  private currentUrl: string;
  private currentTitle = "";
  private titleTimer: NodeJS.Timeout | null = null;
  private networkOn = false;
  private readonly titlePoll: NodeJS.Timeout;
  private readingTitle = false;
  /** The size and the layout the page was last given (`setViewport`). */
  private sized: { readonly width: number; readonly height: number; readonly mobile: boolean } | null = null;
  private readonly listeners: { [K in keyof PageEvents]: PageEvents[K][] } = { changed: [], loading: [], popup: [], frame: [], closed: [], touched: [] };

  constructor(private readonly page: Page, private readonly browser: PlaywrightBrowser) {
    this.currentUrl = page.url();
    this.ready = this.init();
    // A page that closed while it was being set up: whoever waits on `ready` hears it; nobody else has to.
    this.ready.catch(() => undefined);
    this.titlePoll = setInterval(() => this.titleSoon(), TITLE_POLL_MS);
    this.titlePoll.unref();
    page.on("close", () => {
      if (this.titleTimer) clearTimeout(this.titleTimer);
      clearInterval(this.titlePoll);
      for (const l of this.listeners.closed) l();
    });
    page.on("popup", (popup) => {
      const child = browser.wrap(popup);
      void child.ready.then(() => { for (const l of this.listeners.popup) l(child); }, () => undefined);
    });
    page.on("domcontentloaded", () => this.titleSoon());
    page.on("load", () => this.titleSoon());
  }

  private async init(): Promise<void> {
    const session = await this.page.context().newCDPSession(this.page);
    this.session = session;
    session.on("Page.screencastFrame", (f) => {
      for (const l of this.listeners.frame) l({ data: f.data, ackId: f.sessionId, metadata: f.metadata });
      this.titleSoon();
    });
    session.on("Page.frameStartedLoading", ({ frameId }) => { if (frameId === this.targetId) for (const l of this.listeners.loading) l(true); });
    session.on("Page.frameStoppedLoading", ({ frameId }) => { if (frameId === this.targetId) for (const l of this.listeners.loading) l(false); });
    // An error page's URL is chrome-error://; the address the user asked for is `unreachableUrl`.
    session.on("Page.frameNavigated", ({ frame }) => { if (!frame.parentId) this.setUrl(frame.unreachableUrl ?? `${frame.url}${frame.urlFragment ?? ""}`); });
    session.on("Page.navigatedWithinDocument", ({ frameId, url }) => { if (frameId === this.targetId) this.setUrl(url); });
    const { targetInfo } = await session.send("Target.getTargetInfo");
    this.targetId = targetInfo.targetId;
    this.browser.track(targetInfo.targetId, this);
    await session.send("Page.enable");
    await this.block(this.browser.blockedNow());
  }

  /** Chrome refuses `patterns` on this page itself, redirect hops included (which Playwright's routes never see); the
   *  session's Network domain must be on for that. */
  async block(patterns: readonly string[]): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      if (!this.networkOn) { await session.send("Network.enable", {}); this.networkOn = true; }
      await session.send("Network.setBlockedURLs", { urls: [...patterns] });
    } catch { /* the page went away; a new one is set up afresh */ }
  }

  /** A navigation of this page that went past the guard as a redirect, refused: stopped, the reason shown instead. The
   *  request itself has reached the server by then (Chrome sends a redirect hop before anyone can stop it). */
  async refuse(reason: string): Promise<void> {
    await this.send("Page.stopLoading").catch(() => undefined);
    await this.page.setContent(refusalPage(reason)).catch(() => undefined);
  }

  private send: Send = async (method, params) => {
    await this.ready;
    return (this.session!.send as unknown as Send)(method, params);
  };

  private setUrl(url: string): void {
    if (url === this.currentUrl) return;
    this.currentUrl = url;
    for (const l of this.listeners.changed) l({ url, title: this.currentTitle });
  }

  /** Reads the title shortly (one read for a burst of reasons, one read at a time). */
  titleSoon(): void {
    if (this.titleTimer || this.readingTitle || this.page.isClosed()) return;
    this.titleTimer = setTimeout(() => {
      this.titleTimer = null;
      this.readingTitle = true;
      void this.page.title().then((title) => {
        if (title === this.currentTitle) return;
        this.currentTitle = title;
        for (const l of this.listeners.changed) l({ url: this.currentUrl, title });
      }, () => undefined).finally(() => { this.readingTitle = false; });
    }, TITLE_SETTLE_MS);
    this.titleTimer.unref();
  }

  url(): string { return this.currentUrl; }
  title(): string { return this.currentTitle; }

  async opener(): Promise<DriverPage | null> {
    const opener = await this.page.opener();
    return opener ? this.browser.wrap(opener) : null;
  }

  async navigate(url: string): Promise<void> {
    // A blank page sent to about:blank never commits, and a page waiting on that cannot be closed (Playwright 1.64).
    if (url === "about:blank" && (this.page.url() === "about:blank" || this.page.url() === "")) return;
    await this.page.goto(url, { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS });
  }

  async history(action: "back" | "forward" | "reload"): Promise<void> {
    const opts = { waitUntil: "commit" as const, timeout: NAVIGATION_TIMEOUT_MS };
    if (action === "back") await this.page.goBack(opts);
    else if (action === "forward") await this.page.goForward(opts);
    else await this.page.reload(opts);
  }

  async close(): Promise<void> { await this.page.close(); }

  /** At `render` > 1 the emulation scales the page's image (`scale`) and the tab's own view is that many times the CSS
   *  size (`Emulation.setVisibleSize`, which `dontSetVisibleSize` leaves to us; whole pixels, `viewAt`, the size the
   *  host then expects of the view's frames): the screencast then sends the view's pixels (browser-v0 §5, measured
   *  with Chrome 154: 1280×800 at 2 gives 2560×1600 frames, the page still sees 1280×800, no resize event; 900×655 at
   *  2.2 gives 1980×1441). The view's size is per tab (the tabs share one window). At 1 Chrome sets the view to
   *  the CSS size itself, as before. `setVisibleSize` is deprecated in the protocol: a Chrome without it gets CSS-size
   *  frames, said once.
   *
   *  A phone's layout (`mobile`) at another size than the page has is entered by way of the desktop layout at that
   *  size (browser-v0 §1 页面缩放, 2026-10-04). A page that does not follow the device's width (no viewport tag: laid
   *  out 980 wide and fitted to the screen; or `width=1024`) is fitted by Chrome when the phone's layout begins, and
   *  not again when only its size changes: set from 402 to 804 wide (a phone's 50%) it kept its scale and filled half
   *  the screen, from 402 to 201 it showed half its width, and its scroll position was lost; after a Mac had sized it,
   *  a phone's take could leave it at twice the fit. By way of the desktop layout it is fitted at every size, and
   *  stays scrolled where it was (Chrome 154: 16 sizes in turn, 2 and 4 of them wrong before on the two kinds of
   *  page, none after). A page that follows the device's width sees no difference, nor one more resize. The same
   *  size again (the view redrawn at another scale) is set as it is: the page is not laid out twice for it. */
  async setViewport(v: Viewport, render = 1): Promise<number> {
    const metrics = { width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: v.mobile, screenWidth: v.width, screenHeight: v.height };
    const anew = v.mobile && !(this.sized?.mobile && this.sized.width === v.width && this.sized.height === v.height);
    const set = async (drawing: Record<string, unknown>): Promise<void> => {
      if (anew) await this.send("Emulation.setDeviceMetricsOverride", { ...metrics, ...drawing, mobile: false });
      await this.send("Emulation.setDeviceMetricsOverride", { ...metrics, ...drawing });
    };
    let drawn = 1;
    if (render > 1 && this.browser.scaledViews) {
      try {
        const view = viewAt(v, render);
        await set({ scale: render, dontSetVisibleSize: true });
        await this.send("Emulation.setVisibleSize", { width: view.width, height: view.height });
        drawn = render;
      } catch (err) {
        if (this.page.isClosed()) throw err;
        this.browser.noScaledViews(err);
      }
    }
    if (drawn === 1) await set({ scale: 1 });
    await this.send("Emulation.setTouchEmulationEnabled", v.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    this.sized = { width: v.width, height: v.height, mobile: v.mobile };
    return drawn;
  }

  async input(method: InputMethod, params: Record<string, unknown>): Promise<void> {
    await this.send(method, params);
  }

  async startScreencast(p: ScreencastParams): Promise<void> {
    await this.send("Page.startScreencast", { format: "jpeg", quality: p.quality, everyNthFrame: 1, ...(p.maxWidth ? { maxWidth: p.maxWidth } : {}), ...(p.maxHeight ? { maxHeight: p.maxHeight } : {}) });
  }

  async stopScreencast(): Promise<void> { await this.send("Page.stopScreencast"); }

  async ackFrame(ackId: number): Promise<void> { await this.send("Page.screencastFrameAck", { sessionId: ackId }); }

  on<K extends keyof PageEvents>(event: K, listener: PageEvents[K]): void {
    (this.listeners[event] as PageEvents[K][]).push(listener);
  }

  async focusedField(): Promise<FocusedField | null> {
    return focusedFieldOf(this.page);
  }

  playwright(): Page { return this.page; }
}

/** The one frame whose document has an editable field in focus, and the frames above it (URLs as Playwright tracks
 *  them from the browser). A frame holding a focused child frame matches `iframe:focus`, which is left out, so only
 *  the innermost document counts. The field is held (an element handle) and typed into itself: if focus moved to
 *  another field meanwhile (a tap on the phone while the gate answered), nothing is typed. */
export async function focusedFieldOf(page: Page): Promise<FocusedField | null> {
  const found: Frame[] = [];
  for (const frame of page.frames()) {
    const field = frame.locator(FOCUSED_FIELD);
    try {
      if (await field.count() === 1 && await field.isEditable({ timeout: FOCUS_CHECK_MS })) found.push(frame);
    } catch { /* not editable (isEditable throws for other elements), or the frame went away */ }
  }
  if (found.length !== 1) return null;
  const frame = found[0]!;
  const frames = frameChain(frame);
  const handle = await frame.locator(FOCUSED_FIELD).elementHandle({ timeout: FOCUS_CHECK_MS }).catch(() => null);
  if (!handle) return null;
  const secret = await frame.locator(`${FOCUSED_FIELD}${SECRET_FIELD}`).count().then((n) => n === 1, () => false);
  return {
    frames, secret,
    insert: (text) => insertInto(frame, frames, handle, text),
    release: async () => { await handle.dispose().catch(() => undefined); },
  };
}

/** `text` into `handle`, if it is still the focused field of `frame` and the frame chain is still `frames`. */
async function insertInto(frame: Frame, frames: readonly string[], handle: ElementHandle, text: string): Promise<boolean> {
  if (frame.isDetached() || frameChain(frame).join("\n") !== frames.join("\n")) return false;
  const now = await frame.locator(FOCUSED_FIELD).elementHandle({ timeout: FOCUS_CHECK_MS }).catch(() => null);
  if (!now) return false;
  try {
    // `===` of the two handles' elements: the page cannot redefine it.
    const same = await frame.evaluate(([a, b]) => a === b, [handle, now] as const).catch(() => false);
    if (!same) return false;
    await handle.fill(text, { timeout: FILL_TIMEOUT_MS });
    return true;
  } finally {
    await now.dispose().catch(() => undefined);
  }
}

/** How often the patterns Chrome blocks are compared with AgentSwitch's ports now (servers come and go). */
const BLOCKED_REFRESH_MS = 2_000;

/** What goes past the guard when the host does not say: `file:` and this Mac's loopback names. */
const ROUTED_BY_DEFAULT = (url: URL): boolean => url.protocol === "file:" || isLoopbackHost(url.hostname);

class PlaywrightBrowser implements DriverBrowser {
  private readonly wrappers = new WeakMap<Page, PlaywrightPage>();
  private readonly byTarget = new Map<string, PlaywrightPage>();
  /** The blank page Chrome starts with: the first tab, rather than a second page. */
  private readonly spare: Page[];
  private readonly exitListeners: ((expected: boolean) => void)[] = [];
  private closing = false;
  private gone = false;
  private blockedKey = "";
  private blockedTimer: NodeJS.Timeout | null = null;
  /** This Chrome draws a tab's view at a scale (`Emulation.setVisibleSize`); false once it refused. */
  scaledViews = true;

  constructor(private readonly context: BrowserContext, private readonly guard: RequestGuard, private readonly log: (line: string) => void,
              private readonly routed: (url: URL) => boolean = ROUTED_BY_DEFAULT, private readonly blocked: () => readonly string[] = () => []) {
    this.spare = context.pages();
    context.on("close", () => this.exit());
    context.browser()?.on("disconnected", () => this.exit());
  }

  /** The patterns Chrome blocks now. */
  blockedNow(): readonly string[] {
    try { return this.blocked(); } catch { return []; }
  }

  async init(): Promise<void> {
    await this.context.route((url) => this.routed(url), (route) => this.onRoute(route));
    // Playwright continues a redirect hop without asking the routes: a navigation that a redirect brings to a refused
    // place is stopped here as soon as it is seen (subresources are blocked by Chrome itself, `block`).
    this.context.on("request", (req) => { if (req.redirectedFrom() && req.isNavigationRequest()) void this.onRedirect(req); });
    this.blockedKey = this.blockedNow().join("\n");
    this.blockedTimer = setInterval(() => this.refreshBlocked(), BLOCKED_REFRESH_MS);
    this.blockedTimer.unref();
    const browser = this.context.browser();
    if (!browser) return;
    try {
      const cdp = await browser.newBrowserCDPSession();
      cdp.on("Target.targetInfoChanged", ({ targetInfo }) => this.byTarget.get(targetInfo.targetId)?.titleSoon());
      cdp.on("Target.targetDestroyed", ({ targetId }) => this.byTarget.delete(targetId));
      await cdp.send("Target.setDiscoverTargets", { discover: true });
    } catch (err) {
      this.log(`browser: title changes are read on page load only (${(err as Error).message})`);
    }
  }

  wrap(page: Page): PlaywrightPage {
    let wrapper = this.wrappers.get(page);
    if (!wrapper) {
      wrapper = new PlaywrightPage(page, this);
      this.wrappers.set(page, wrapper);
    }
    return wrapper;
  }

  track(targetId: string, page: PlaywrightPage): void { this.byTarget.set(targetId, page); }

  /** The view could not be drawn at a scale: CSS-size frames from now on. */
  noScaledViews(err: unknown): void {
    if (!this.scaledViews) return;
    this.scaledViews = false;
    this.log(`browser: Chrome does not draw a tab's view at a scale; frames stay at the CSS size (${(err as Error)?.message?.split("\n")[0] ?? err})`);
  }

  private refreshBlocked(): void {
    const patterns = this.blockedNow();
    const key = patterns.join("\n");
    if (key === this.blockedKey) return;
    this.blockedKey = key;
    for (const page of this.byTarget.values()) void page.block(patterns);
  }

  private async onRedirect(req: Request): Promise<void> {
    let url: URL;
    try { url = new URL(req.url()); } catch { return; }
    if (!this.routed(url)) return;
    let page: PlaywrightPage | null = null;
    let main = false;
    try { const frame = req.frame(); page = this.wrap(frame.page()); main = frame === frame.page().mainFrame(); } catch { page = null; }
    let decision: GuardDecision;
    try { decision = await this.guard({ url: req.url(), page, navigation: true }); }
    catch { decision = { action: "block", reason: "无法打开此地址。" }; }
    if (decision.action === "continue") return;
    this.log(`browser: a redirect to a refused place was stopped (${url.protocol}//${url.host})`);
    if (page && main) await page.refuse(decision.reason);
  }

  private async onRoute(route: Route): Promise<void> {
    const req = route.request();
    let page: DriverPage | null = null;
    try { page = this.wrap(req.frame().page()); } catch { page = null; }   // a service worker's request has no frame
    let decision: GuardDecision;
    try { decision = await this.guard({ url: req.url(), page, navigation: req.isNavigationRequest() }); }
    catch { decision = { action: "block", reason: "无法打开此地址。" }; }
    try {
      if (decision.action === "continue") await route.continue();
      else if (req.isNavigationRequest()) await route.fulfill({ status: 403, contentType: "text/html; charset=utf-8", body: refusalPage(decision.reason) });
      else await route.abort("accessdenied");
    } catch { /* the page went away meanwhile */ }
  }

  async newPage(): Promise<DriverPage> {
    let page = this.spare.shift();
    while (page?.isClosed()) page = this.spare.shift();
    const wrapper = this.wrap(page ?? await this.context.newPage());
    await wrapper.ready;
    return wrapper;
  }

  async setCookie(cookie: DriverCookie, site: string, keep: boolean): Promise<boolean> {
    if (keep && (await this.context.cookies(site)).some((c) => c.name === cookie.name)) return false;
    await this.context.addCookies([cookie]);
    return true;
  }

  onExit(listener: (expected: boolean) => void): void { this.exitListeners.push(listener); }

  private exit(): void {
    if (this.gone) return;
    this.gone = true;
    if (this.blockedTimer) clearInterval(this.blockedTimer);
    for (const l of this.exitListeners) l(this.closing);
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.blockedTimer) clearInterval(this.blockedTimer);
    await this.context.close();
  }
}

export type PlaywrightDriverOptions = {
  readonly viewport?: Viewport;
  readonly log?: (line: string) => void;
  /** The Playwright to start Chrome with (docs/browser-v0.md §7.3): the engine's, else the bundled one. */
  readonly playwright?: () => PlaywrightCopy;
  /** The proxy everything this Chrome sends goes through — a profile's forwarder (docs/profiles-v0.md §5.1); asked
   *  at every launch. Absent: this Mac's own way out. */
  readonly proxy?: () => Promise<{ readonly server: string; readonly username: string; readonly password: string }>;
  /** With a window of its own on this Mac (a profile's browser, where a sign-in is done by hand); default: none. */
  readonly window?: boolean;
};

export function playwrightDriver(opts: PlaywrightDriverOptions = {}): BrowserDriver {
  const log = opts.log ?? console.error;
  const size = opts.viewport ?? DEFAULT_VIEWPORT;
  return {
    async launch({ profileDir, guard, routed, blocked }: LaunchOptions): Promise<DriverBrowser> {
      const copy = (opts.playwright ?? bundledPlaywright)();
      notePlaywrightInUse(copy);
      const { chromium } = copy.require("playwright-core") as typeof import("playwright-core");
      const proxy = await opts.proxy?.();
      const context = await chromium.launchPersistentContext(profileDir, {
        channel: "chrome",
        headless: !opts.window,
        ...(proxy ? { proxy: { server: proxy.server, username: proxy.username, password: proxy.password, bypass: "<-loopback>" } } : {}),
        // The host sets every page's size itself (Emulation on its own session); Playwright leaves it alone.
        viewport: null,
        args: [`--window-size=${size.width},${size.height}`],
        chromiumSandbox: true,
        acceptDownloads: false,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        timeout: LAUNCH_TIMEOUT_MS,
      });
      const browser = new PlaywrightBrowser(context, guard, log, routed, blocked);
      try {
        await browser.init();
      } catch (err) {
        await context.close().catch(() => undefined);
        throw err;
      }
      return browser;
    },
  };
}
