/** Camoufox behind the host's driver interface (docs/browser-v0.md §7.3 驱动), through Playwright's public API only:
 *  Firefox has no CDP. What Chrome's driver does over its own protocol is done here another way —
 *
 *  - input: the host's calls become steps for Playwright's mouse and keyboard (camoufoxInput.ts), one call after another;
 *  - a page's size: `setViewportSize`. The page's pixel ratio is the browser's, one for every page, so nothing is drawn
 *    at a scale behind the page's back: the answer is always 1 and the host sends points in CSS pixels;
 *  - pictures: `page.screencast`, whose `onFrame` promise is the acknowledgement — the next picture comes once the
 *    host acknowledged this one, as with Chrome;
 *  - AgentSwitch's own ports: the routes see the first request to one; a redirect that lands on one is refused by the
 *    forwarder the browser's traffic goes through (§7.3 转发层), not here.
 *
 *  Measured 2026-10-05 (Camoufox 156.0.1-beta.34, playwright-core 1.64 alpha): 17 pictures a second headless, a
 *  picture within 16 ms of starting; a build of another Firefox fails at the first resize (the engine's own check). */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Frame, Page, Request, Route } from "playwright-core";
import { camoufoxEnv, camoufoxSteps, frameSize, releaseAll, type InputStep } from "./camoufoxInput.js";
import type { BrowserDriver, DriverBrowser, DriverCookie, DriverPage, FocusedField, GuardDecision, InputMethod, LaunchOptions, PageEvents, RequestGuard, ScreencastParams } from "./driver.js";
import { notePlaywrightInUse, type PlaywrightCopy } from "./engine/loader.js";
import type { ForwarderAddress } from "./forwarder.js";
import type { Modifier } from "./input.js";
import { focusedFieldOf, refusalPage } from "./playwrightDriver.js";
import { isLoopbackHost } from "./rules.js";
import { DEFAULT_VIEWPORT, type Viewport } from "./types.js";

/** Camoufox 156 takes about eight seconds to start on this Mac (152 took under one). */
const LAUNCH_TIMEOUT_MS = 60_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const TITLE_SETTLE_MS = 50;
const TITLE_POLL_MS = 2_000;
/** Modifier keys still down this long after the last input are let go (the screen stopped mid-gesture). */
const MODIFIER_RELEASE_MS = 250;
const PICTURE_QUALITY = 55;
const TOUCH_POLL_MS = 500;
/** How long after a page appears it is asked whether the driver made it or a page opened it. */
const ADOPT_AFTER_MS = 80;
/** Counts the input that reaches a document, where the page's own scripts cannot see it (Camoufox runs init scripts in
 *  a world of their own: measured 2026-10-05, the page reads `undefined`). */
const TOUCH_SCRIPT = `(() => { let n = 0; const seen = (e) => { if (e.isTrusted) n++; };
  for (const type of ["pointerdown", "keydown", "wheel", "input"]) addEventListener(type, seen, true);
  globalThis.__agentswitchTouches = () => n; })()`;
const TOUCH_COUNT = "globalThis.__agentswitchTouches ? globalThis.__agentswitchTouches() : 0";

/** The profile's sign-in and form memory are off, as in the Chrome profile (browser-v0 §2): values reach a page only
 *  through the gate or a person's own typing. The rest keeps a profile started by a program quiet. */
const PREFS: Readonly<Record<string, string | number | boolean>> = {
  "signon.rememberSignons": false,
  "signon.autofillForms": false,
  "signon.generation.enabled": false,
  "browser.formfill.enable": false,
  "extensions.formautofill.addresses.enabled": false,
  "extensions.formautofill.creditCards.enabled": false,
  "browser.shell.checkDefaultBrowser": false,
  "browser.aboutwelcome.enabled": false,
  "browser.tabs.warnOnClose": false,
  "browser.sessionstore.resume_from_crash": false,
  "datareporting.policy.dataSubmissionEnabled": false,
};

type Picture = { readonly data: Buffer; readonly timestamp?: number; readonly viewportWidth: number; readonly viewportHeight: number };
type Screencast = { start(opts: { quality: number; size: { width: number; height: number }; onFrame: (frame: Picture) => Promise<void> }): Promise<unknown>; stop(): Promise<void> };

class CamoufoxPage implements DriverPage {
  private currentUrl: string;
  private currentTitle = "";
  private titleTimer: NodeJS.Timeout | null = null;
  private readonly titlePoll: NodeJS.Timeout;
  private readingTitle = false;
  private held: ReadonlySet<Modifier> = new Set();
  /** Input calls play one after another, in the order they came. */
  private inputs: Promise<void> = Promise.resolve();
  private releaseTimer: NodeJS.Timeout | null = null;
  private view = { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height };
  /** The page's pixel ratio, read once (the browser's, the same for every page). */
  private ratio: number | null = null;
  private frameId = 0;
  /** Pictures the host has not acknowledged: Playwright holds the next one until its promise resolves. */
  private readonly unacked = new Map<number, () => void>();
  private readonly listeners: { [K in keyof PageEvents]: PageEvents[K][] } = { changed: [], loading: [], popup: [], frame: [], closed: [], touched: [] };
  /** The window's own size from before a holder gave the page one (windows only). */
  private own: { width: number; height: number } | null = null;
  /** What the pictures under way were asked with, to ask again at another size. */
  private casting: ScreencastParams | null = null;
  private touchTimer: NodeJS.Timeout | null = null;
  private touches: number | null = null;

  constructor(private readonly page: Page, private readonly browser: CamoufoxBrowser) {
    this.currentUrl = page.url();
    this.titlePoll = setInterval(() => this.titleSoon(), TITLE_POLL_MS);
    this.titlePoll.unref();
    const main = (req: Request): boolean => { try { return req.isNavigationRequest() && req.frame() === page.mainFrame(); } catch { return false; } };
    page.on("close", () => {
      if (this.titleTimer) clearTimeout(this.titleTimer);
      if (this.releaseTimer) clearTimeout(this.releaseTimer);
      if (this.touchTimer) clearInterval(this.touchTimer);
      clearInterval(this.titlePoll);
      this.ackAll();
      for (const l of this.listeners.closed) l();
    });
    page.on("popup", (popup) => { const child = browser.wrap(popup); for (const l of this.listeners.popup) l(child); });
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) { this.setUrl(frame.url()); this.titleSoon(); } });
    page.on("request", (req) => { if (main(req)) for (const l of this.listeners.loading) l(true); });
    page.on("requestfailed", (req) => { if (main(req)) for (const l of this.listeners.loading) l(false); });
    page.on("domcontentloaded", () => this.titleSoon());
    page.on("load", () => { for (const l of this.listeners.loading) l(false); this.titleSoon(); });
  }

  /** A navigation of this page that a redirect brought to a refused place: the reason shown instead. */
  async refuse(reason: string): Promise<void> {
    await this.page.setContent(refusalPage(reason)).catch(() => undefined);
  }

  private setUrl(url: string): void {
    if (url === this.currentUrl) return;
    this.currentUrl = url;
    for (const l of this.listeners.changed) l({ url, title: this.currentTitle });
  }

  private titleSoon(): void {
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

  /** The page's size in CSS pixels; with a window of its own, the window follows. Its pixel ratio and whether it takes
   *  touch are the browser's (§7.1): `scale` and `mobile` are not for a page here, and nothing is drawn at a scale. */
  async setViewport(v: Viewport): Promise<number> {
    if (this.browser.windows && !this.own) this.own = await this.innerSize().catch(() => null);
    await this.page.setViewportSize({ width: v.width, height: v.height });
    this.view = { width: v.width, height: v.height };
    return 1;
  }

  windowed(): boolean { return this.browser.windows; }

  /** The window as the person had it, after a holder's size. */
  async restoreSize(): Promise<void> {
    const size = this.own;
    if (!size) return;
    this.own = null;
    await this.page.setViewportSize(size);
    this.view = size;
  }

  private async innerSize(): Promise<{ width: number; height: number }> {
    const [width, height] = await this.page.evaluate("[innerWidth, innerHeight]") as [number, number];
    return { width, height };
  }

  /** Its window before the browser's other windows; bringing the browser before other apps is the Mac app's to do. */
  async show(): Promise<void> { await this.page.bringToFront(); }

  async picture(): Promise<Buffer> {
    return this.page.screenshot({ type: "jpeg", quality: PICTURE_QUALITY, scale: "css" });
  }

  /** The page counts the input that reaches it (the browser's init script, in a world the page cannot see); the count
   *  is read twice a second, and a higher one is said as `touched`. A new document starts at none. */
  watchTouches(on: boolean): void {
    if (this.touchTimer) clearInterval(this.touchTimer);
    this.touchTimer = null;
    this.touches = null;
    if (!on) return;
    this.touchTimer = setInterval(() => {
      if (this.page.isClosed()) return;
      void this.page.evaluate(TOUCH_COUNT).then((count) => {
        const now = Number(count) || 0;
        const before = this.touches;
        this.touches = now;
        if (before !== null && now !== before && now > 0) for (const l of this.listeners.touched) l();
      }, () => undefined);
    }, TOUCH_POLL_MS);
    this.touchTimer.unref();
  }

  input(method: InputMethod, params: Record<string, unknown>): Promise<void> {
    const run = this.inputs.then(async () => {
      const { steps, held } = camoufoxSteps(method, params, this.held);
      this.held = held;
      for (const step of steps) await this.play(step);
      this.releaseSoon();
    });
    this.inputs = run.catch(() => undefined);
    return run;
  }

  private async play(step: InputStep): Promise<void> {
    const { mouse, keyboard } = this.page;
    switch (step.do) {
      case "modifier": return step.down ? keyboard.down(step.key) : keyboard.up(step.key);
      case "key": return step.down ? keyboard.down(step.key) : keyboard.up(step.key);
      case "text": return keyboard.insertText(step.text);
      case "move": return mouse.move(step.x, step.y);
      case "press": return mouse.down({ button: step.button, clickCount: step.clickCount });
      case "release": return mouse.up({ button: step.button, clickCount: step.clickCount });
      case "wheel": return mouse.wheel(step.dx, step.dy);
    }
  }

  private releaseSoon(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    if (!this.held.size) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      this.inputs = this.inputs.then(async () => {
        const steps = releaseAll(this.held);
        this.held = new Set();
        for (const step of steps) await this.play(step);
      }).catch(() => undefined);
    }, MODIFIER_RELEASE_MS);
    this.releaseTimer.unref();
  }

  async startScreencast(p: ScreencastParams): Promise<void> {
    this.ratio ??= Number(await this.page.evaluate("devicePixelRatio").catch(() => 1)) || 1;
    // A window nobody sized for a screen is as large as the person made it.
    if (this.browser.windows && !this.own) this.view = await this.innerSize().catch(() => this.view);
    this.casting = p;
    const screencast = (this.page as unknown as { screencast: Screencast }).screencast;
    await screencast.start({ quality: p.quality, size: frameSize(this.view, this.ratio, p), onFrame: (frame) => this.onFrame(frame) });
  }

  /** One picture to the host; the promise is what Playwright waits on before it asks the browser for the next. */
  private onFrame(frame: Picture): Promise<void> {
    // The person resized the window: pictures are asked for again at its new size.
    if (this.browser.windows && !this.own && this.casting && (frame.viewportWidth !== this.view.width || frame.viewportHeight !== this.view.height)) {
      const again = this.casting;
      this.view = { width: frame.viewportWidth, height: frame.viewportHeight };
      void this.stopScreencast().then(() => this.startScreencast(again)).catch(() => undefined);
    }
    const ackId = ++this.frameId;
    const acknowledged = new Promise<void>((resolve) => this.unacked.set(ackId, resolve));
    const metadata = {
      deviceWidth: frame.viewportWidth, deviceHeight: frame.viewportHeight, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0,
      // Chrome stamps in seconds, Juggler in milliseconds.
      ...(frame.timestamp ? { timestamp: frame.timestamp / 1000 } : {}),
    };
    for (const l of this.listeners.frame) l({ data: frame.data.toString("base64"), ackId, metadata });
    this.titleSoon();
    return acknowledged;
  }

  private ackAll(): void {
    for (const resolve of this.unacked.values()) resolve();
    this.unacked.clear();
  }

  async stopScreencast(): Promise<void> {
    this.casting = null;
    this.ackAll();
    await (this.page as unknown as { screencast: Screencast }).screencast.stop().catch(() => undefined);
  }

  async ackFrame(ackId: number): Promise<void> {
    const resolve = this.unacked.get(ackId);
    this.unacked.delete(ackId);
    resolve?.();
  }

  on<K extends keyof PageEvents>(event: K, listener: PageEvents[K]): void { this.listeners[event].push(listener); }

  async focusedField(): Promise<FocusedField | null> {
    return focusedFieldOf(this.page);
  }

  playwright(): Page { return this.page; }
}

const ROUTED_BY_DEFAULT = (url: URL): boolean => url.protocol === "file:" || isLoopbackHost(url.hostname);

class CamoufoxBrowser implements DriverBrowser {
  private readonly wrappers = new WeakMap<Page, CamoufoxPage>();
  /** The blank page the browser starts with: the first tab, rather than a second page. */
  private readonly spare: Page[];
  private readonly exitListeners: ((expected: boolean) => void)[] = [];
  private closing = false;
  private gone = false;
  /** The file a frame was last refused, so that showing the refusal is not taken for coming to it again. */
  private readonly refusedFile = new WeakMap<Frame, string>();
  /** Pages this driver asked for (the ones the browser started with among them). */
  private readonly ours = new WeakSet<Page>();
  private readonly pageListeners: ((page: DriverPage) => void)[] = [];

  /** `windows`: every page has a window of its own (not headless). */
  constructor(private readonly context: BrowserContext, private readonly guard: RequestGuard, private readonly log: (line: string) => void,
              private readonly routed: (url: URL) => boolean = ROUTED_BY_DEFAULT, readonly windows = false) {
    this.spare = context.pages();
    for (const page of this.spare) this.ours.add(page);
    context.on("close", () => this.exit());
    context.browser()?.on("disconnected", () => this.exit());
  }

  async init(): Promise<void> {
    await this.context.route((url) => this.routed(url), (route) => this.onRoute(route));
    // The routes are not asked about a redirect's next hop: a navigation that a redirect brings to a refused place is
    // answered here as soon as it is seen. What may never be reached at all (AgentSwitch's own ports) is refused by the
    // forwarder before the request leaves.
    this.context.on("request", (req) => { if (req.redirectedFrom() && req.isNavigationRequest()) void this.onRedirect(req); });
    if (!this.windows) return;
    await this.context.addInitScript(TOUCH_SCRIPT);
    // A page that is neither ours nor another page's popup is a tab the person opened in a window. Asked a moment after
    // it appears: a page of ours is known as such only once `newPage` has answered.
    this.context.on("page", (page) => { setTimeout(() => void this.adopt(page), ADOPT_AFTER_MS).unref(); });
  }

  private async adopt(page: Page): Promise<void> {
    if (this.ours.has(page) || page.isClosed()) return;
    if (await page.opener().catch(() => null)) return;
    this.ours.add(page);
    const wrapped = this.wrap(page);
    for (const l of this.pageListeners) l(wrapped);
  }

  onPage(listener: (page: DriverPage) => void): void { this.pageListeners.push(listener); }

  wrap(page: Page): CamoufoxPage {
    let wrapper = this.wrappers.get(page);
    if (!wrapper) {
      const made = new CamoufoxPage(page, this);
      wrapper = made;
      this.wrappers.set(page, made);
      page.on("framenavigated", (frame) => { void this.onFile(frame, made); });
    }
    return wrapper;
  }

  /** A `file:` document a frame has come to. Firefox does not put local files past the routes (measured 2026-10-05:
   *  a link from a local page to another file is followed, an `iframe` of one is loaded, with no route asked), so the
   *  guard is asked once the frame is there, and a refused file is replaced by the refusal at once. The host's own
   *  navigations are refused before they start; this is for what a local page links to or embeds. */
  private async onFile(frame: Frame, page: CamoufoxPage): Promise<void> {
    const url = frame.url();
    if (!url.startsWith("file:") || this.refusedFile.get(frame) === url) return;
    const decision = await this.decide(url, page, true);
    if (decision.action === "continue" || frame.isDetached() || frame.url() !== url) return;
    this.refusedFile.set(frame, url);
    this.log("browser: a local file a page went to was refused");
    await frame.setContent(refusalPage(decision.reason)).catch(() => undefined);
  }

  private async decide(url: string, page: DriverPage | null, navigation: boolean): Promise<GuardDecision> {
    try { return await this.guard({ url, page, navigation }); }
    catch { return { action: "block", reason: "无法打开此地址。" }; }
  }

  private async onRedirect(req: Request): Promise<void> {
    let url: URL;
    try { url = new URL(req.url()); } catch { return; }
    if (!this.routed(url)) return;
    let page: CamoufoxPage | null = null;
    let main = false;
    try { const frame = req.frame(); page = this.wrap(frame.page()); main = frame === frame.page().mainFrame(); } catch { page = null; }
    const decision = await this.decide(req.url(), page, true);
    if (decision.action === "continue") return;
    this.log(`browser: a redirect to a refused place was stopped (${url.protocol}//${url.host})`);
    if (page && main) await page.refuse(decision.reason);
  }

  private async onRoute(route: Route): Promise<void> {
    const req = route.request();
    let page: DriverPage | null = null;
    try { page = this.wrap(req.frame().page()); } catch { page = null; }   // a service worker's request has no frame
    const decision = await this.decide(req.url(), page, req.isNavigationRequest());
    try {
      if (decision.action === "continue") await route.continue();
      else if (req.isNavigationRequest()) await route.fulfill({ status: 403, contentType: "text/html; charset=utf-8", body: refusalPage(decision.reason) });
      else await route.abort("accessdenied");
    } catch { /* the page went away meanwhile */ }
  }

  async newPage(): Promise<DriverPage> {
    let page = this.spare.shift();
    while (page?.isClosed()) page = this.spare.shift();
    page ??= await this.context.newPage();
    this.ours.add(page);
    return this.wrap(page);
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
    for (const l of this.exitListeners) l(this.closing);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.context.close();
  }
}

export type CamoufoxDriverOptions = {
  /** The Camoufox to start (the engine's). */
  readonly executable: string;
  /** The Playwright that drives it. */
  readonly playwright: PlaywrightCopy;
  /** Without a window: a host with no display, and until the page of the Mac app shows windows (§7.4 第 3 步). */
  readonly headless: boolean;
  /** The fingerprint as Camoufox takes it (§7.2 第 5 条); absent: its own defaults. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Where the browser's traffic goes first (§7.3 转发层), with the name and password the forwarder asks of it. */
  readonly proxy?: ForwarderAddress;
  readonly log?: (line: string) => void;
};

/** A browser still running on `profileDir` (the service died without closing it) is stopped, and its lock removed:
 *  Firefox will not start on a profile another one holds. Matched by the profile's own path on its command line. */
export function closeCamoufoxOf(profileDir: string): void {
  spawnSync("pkill", ["-f", "--", `-profile ${profileDir}`], { stdio: "ignore" });
  for (const lock of [".parentlock", "parent.lock", "lock"]) rmSync(join(profileDir, lock), { force: true });
}

/** What `launchPersistentContext` is given. */
export function camoufoxLaunchOptions(opts: CamoufoxDriverOptions, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  return {
    executablePath: opts.executable,
    headless: opts.headless,
    // The host gives every page its size itself.
    viewport: null,
    acceptDownloads: false,
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    timeout: LAUNCH_TIMEOUT_MS,
    // Playwright would otherwise tell every page the system is in light mode, without reduced motion, and so on: the
    // page is to see what the Mac is set to, as a browser a person started would.
    colorScheme: "no-override", reducedMotion: "no-override", forcedColors: "no-override", contrast: "no-override",
    env: { ...env, ...camoufoxEnv(opts.config ?? {}) },
    firefoxUserPrefs: { ...PREFS, ...(opts.proxy ? { "network.proxy.allow_hijacking_localhost": true } : {}) },
    ...(opts.proxy ? { proxy: { server: opts.proxy.server, username: opts.proxy.username, password: opts.proxy.password } } : {}),
  };
}

type Firefox = { launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<BrowserContext> };

export function camoufoxDriver(opts: CamoufoxDriverOptions): BrowserDriver {
  const log = opts.log ?? console.error;
  return {
    async launch({ profileDir, guard, routed }: LaunchOptions): Promise<DriverBrowser> {
      closeCamoufoxOf(profileDir);
      notePlaywrightInUse(opts.playwright);
      const { firefox } = opts.playwright.require("playwright-core") as { firefox: Firefox };
      const context = await firefox.launchPersistentContext(profileDir, camoufoxLaunchOptions(opts));
      const browser = new CamoufoxBrowser(context, guard, log, routed, !opts.headless);
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
