/** A browser for the shared-browser tests (docs/browser-v0.md): pages that record what the host asks of them and emit
 *  what Chrome would (navigations, titles, popups, screencast frames), without Chrome. */

import type { BrowserDriver, DriverBrowser, DriverPage, FocusedField, InputMethod, LaunchOptions, PageEvents, RawFrame, RequestGuard, ScreencastParams } from "../src/browser/driver.js";
import type { Viewport } from "../src/browser/types.js";

/** The smallest JPEG header `jpegSize` reads: SOI, a JFIF APP0 segment, a baseline frame header. */
export function fakeJpeg(width: number, height: number): string {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]).toString("base64");
}

/** A focused field as a test sets it up. */
export type FakeField = { readonly frames: readonly string[]; readonly secret?: boolean };

export class FakePage implements DriverPage {
  currentUrl = "about:blank";
  currentTitle = "";
  openerPage: FakePage | null = null;
  closed = false;
  navigateError: Error | null = null;
  inputError: Error | null = null;
  readonly navigations: string[] = [];
  readonly histories: string[] = [];
  readonly inputs: { method: InputMethod; params: Record<string, unknown> }[] = [];
  readonly viewports: Viewport[] = [];
  /** The scale each `setViewport` asked to draw the view at. */
  readonly renders: number[] = [];
  /** Chrome draws a view at a scale (`Emulation.setVisibleSize`); false: it answers 1. */
  scaledViews = true;
  readonly screencasts: ScreencastParams[] = [];
  stops = 0;
  readonly acks: number[] = [];
  /** The focused editable field (frame URLs, innermost first; a password or one-time-code field unless `secret` is
   *  false), or null (fill). */
  focused: FakeField | null = null;
  /** Focus has moved to another field by the time the value is typed (a tap while the gate answers). */
  focusLater: FakeField | null | undefined = undefined;
  /** What a fill typed into the focused field, and how many fields were let go of. */
  readonly fills: string[] = [];
  released = 0;
  /** What Playwright MCP would get as this page (the agent context's tests). */
  readonly raw = { fakePage: this };
  private readonly listeners: { [K in keyof PageEvents]: PageEvents[K][] } = { changed: [], loading: [], popup: [], frame: [], closed: [], touched: [] };
  /** The page has a window of its own (Camoufox with windows, docs/browser-v0.md §7.3 窗口). */
  hasWindow = false;
  /** How often the window was given back its own size, was brought to the front, and was pictured. */
  restores = 0;
  fronts = 0;
  pictures = 0;
  /** Whether the host asked to hear of input in this page. */
  watched: boolean | null = null;

  windowed(): boolean { return this.hasWindow; }
  async restoreSize(): Promise<void> { this.restores++; }
  async show(): Promise<void> { this.fronts++; }
  async picture(): Promise<Buffer> { this.pictures++; return Buffer.from(`picture ${this.pictures}`); }
  watchTouches(on: boolean): void { this.watched = on; }
  /** Input reached the page. */
  touch(): void { for (const l of this.listeners.touched) l(); }

  url(): string { return this.currentUrl; }
  title(): string { return this.currentTitle; }
  async opener(): Promise<DriverPage | null> { return this.openerPage; }
  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
    if (this.navigateError) throw this.navigateError;
  }
  async history(action: "back" | "forward" | "reload"): Promise<void> { this.histories.push(action); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.listeners.closed) l();
  }
  async setViewport(v: Viewport, render = 1): Promise<number> {
    this.viewports.push(v);
    this.renders.push(render);
    return this.scaledViews ? render : 1;
  }
  async input(method: InputMethod, params: Record<string, unknown>): Promise<void> {
    if (this.inputError) throw this.inputError;
    this.inputs.push({ method, params });
  }
  async startScreencast(p: ScreencastParams): Promise<void> { this.screencasts.push(p); }
  async stopScreencast(): Promise<void> { this.stops += 1; }
  async ackFrame(ackId: number): Promise<void> { this.acks.push(ackId); }
  on<K extends keyof PageEvents>(event: K, listener: PageEvents[K]): void { (this.listeners[event] as PageEvents[K][]).push(listener); }
  async focusedField(): Promise<FocusedField | null> {
    const spec = this.focused;
    if (!spec) return null;
    return {
      frames: spec.frames,
      secret: spec.secret ?? true,
      insert: async (text) => {
        if (this.inputError) throw this.inputError;
        if (this.focusLater !== undefined) return false;
        this.fills.push(text);
        return true;
      },
      release: async () => { this.released += 1; },
    };
  }
  playwright(): unknown { return this.raw; }

  /** Chrome committed a navigation or the title changed. */
  change(url: string, title = this.currentTitle): void {
    this.currentUrl = url;
    this.currentTitle = title;
    for (const l of this.listeners.changed) l({ url, title });
  }
  loading(loading: boolean): void { for (const l of this.listeners.loading) l(loading); }
  /** A screencast frame of a `width`×`height` image for a `deviceWidth`×`deviceHeight` view (Chrome's metadata: the
   *  view's size, which is the viewport's times the scale the view is drawn at). `timestamp`: when Chrome sent it, in
   *  seconds, as Chrome says it; none: a Chrome that does not say. */
  frame(width: number, height: number, deviceWidth = width, deviceHeight = height, ackId = 1, timestamp?: number): void {
    const metadata = { deviceWidth, deviceHeight, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0, ...(timestamp !== undefined ? { timestamp } : {}) };
    const raw: RawFrame = { data: fakeJpeg(width, height), ackId, metadata };
    for (const l of this.listeners.frame) l(raw);
  }
  /** The page opens another (window.open, a link with a target). */
  popup(): FakePage {
    const child = new FakePage();
    child.openerPage = this;
    for (const l of this.listeners.popup) l(child);
    return child;
  }
}

/** Chrome draws `p`'s view as soon as it is asked; its answer to a view at `render` waits for the returned function. */
export function slowAnswer(p: FakePage, render: number): () => void {
  let answer: () => void = () => undefined;
  const answered = new Promise<void>((r) => { answer = r; });
  const set = p.setViewport.bind(p);
  p.setViewport = async (v, r) => { const drawn = await set(v, r); if (r === render) await answered; return drawn; };
  return answer;
}

export class FakeBrowser implements DriverBrowser {
  readonly pages: FakePage[] = [];
  closed = false;
  /** Pages have windows of their own. */
  windows = false;
  private readonly exitListeners: ((expected: boolean) => void)[] = [];
  private readonly pageListeners: ((page: DriverPage) => void)[] = [];

  constructor(readonly guard: RequestGuard) {}

  async newPage(): Promise<DriverPage> {
    const page = new FakePage();
    page.hasWindow = this.windows;
    this.pages.push(page);
    return page;
  }
  onPage(listener: (page: DriverPage) => void): void { this.pageListeners.push(listener); }
  /** A tab the person opened in a window. */
  appear(url: string): FakePage {
    const page = new FakePage();
    page.hasWindow = this.windows;
    page.currentUrl = url;
    this.pages.push(page);
    for (const l of this.pageListeners) l(page);
    return page;
  }
  onExit(listener: (expected: boolean) => void): void { this.exitListeners.push(listener); }
  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.pages) await p.close();
    for (const l of this.exitListeners) l(true);
  }
  /** Chrome died. */
  crash(): void { for (const l of this.exitListeners) l(false); }
}

export class FakeDriver implements BrowserDriver {
  readonly browsers: FakeBrowser[] = [];
  readonly launches: LaunchOptions[] = [];
  failure: Error | null = null;
  /** The browsers it starts give every page a window of its own. */
  windows = false;

  async launch(opts: LaunchOptions): Promise<DriverBrowser> {
    this.launches.push(opts);
    if (this.failure) throw this.failure;
    const browser = new FakeBrowser(opts.guard);
    browser.windows = this.windows;
    this.browsers.push(browser);
    return browser;
  }

  get browser(): FakeBrowser { return this.browsers[this.browsers.length - 1]!; }
  /** The page behind tab number `i` of the current browser. */
  page(i = 0): FakePage { return this.browser.pages[i]!; }
}
