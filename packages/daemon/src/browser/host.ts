/** The browser the service holds (docs/browser-v0.md §2): one Chrome on this Mac, on the persistent `main` profile,
 *  started on first use, stopped after a long while without tabs, started again when it died. The screens (the Mac app,
 *  the phone) see its tabs through screencast streams and drive them with input, and fill a ciphertext in through the
 *  gate (`fill`); agents get tabs of their own through the agent bridge (agents.ts, which follows the tabs with `watch`)
 *  and fill in what they are doing (`setStatus`, `setAction`).
 *
 *  Holding a tab (§1 接手): a screen takes a tab over and hands it back, or the hold ends after two minutes without input.
 *  While a tab is held only its holder drives it; an agent's tab is driven by people only while held. The holder alone
 *  sets the tab's size (one size, one owner, as the terminals); the size goes back to the default when the hold ends. */

import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { fileURLToPath } from "node:url";
import type { BrowserDriver, DriverBrowser, DriverPage, FocusedField, GuardDecision, GuardRequest } from "./driver.js";
import { FillRefused, type FillResolver } from "./fill.js";
import { inputCalls, NOTHING_PRESSED, type InputEvent, type Pressed } from "./input.js";
import { AGENT_FILE_REFUSAL, checkLocalFile, checkUrl, isLoopbackAddress, isLoopbackHost, normalHost, OWN_PORT_REFUSAL, placeOf, portOf, type FileRules } from "./rules.js";
import { Screencast, type StreamOptions } from "./screencast.js";
import { BrowserError, DEFAULT_VIEWPORT, YOU, type AgentAction, type BrowserEvent, type ClosedReason, type HeldReason, type TabGroup, type TabInfo,
  type TabOwner, type TabOwnerKind, type TabStatus, type Viewport } from "./types.js";

/** A person's fill on an agent's tab (browser-v0 §6): the value would stay in the page, which the agent reads after the
 *  hand-back. */
export const AGENT_TAB_FILL = "Agent 的标签不可填入密文：填入的值会留在页面中，交还后 agent 可能读到。请在你自己打开的标签中填入。";
/** A person's fill into a field the screens would show as typed (browser-v0 §6). */
export const SECRET_FIELDS_ONLY = "只能填入密码或验证码输入框。";

/** A host name's lookup (for AgentSwitch's own ports) is given this long. */
const LOOKUP_TIMEOUT_MS = 2_000;

/** Every address `hostname` resolves to. */
const lookupAll = async (hostname: string): Promise<readonly string[]> => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** The URL patterns Chrome blocks itself for AgentSwitch's own ports on this Mac's loopback names (redirects too). */
export function ownPortPatterns(ports: readonly number[]): string[] {
  return ports.flatMap((port) => ["127.*", "localhost", "*.localhost", "[::1]", "0.0.0.0"].map((host) => `*://${host}:${port}/*`));
}

/** A hold ends after this long without input from the holder (browser-v0 §1). */
export const HOLD_IDLE_MS = 2 * 60_000;
/** Chrome is stopped after this long without a tab. */
export const IDLE_CLOSE_MS = 10 * 60_000;
/** Shut-down waits this long for Chrome to quit, closing a tab this long for its page, before going on. */
const CLOSE_TIMEOUT_MS = 5_000;
/** The list's order: the agents' tabs first (terminals, then tasks), then the user's own. */
const KIND_ORDER: readonly TabOwnerKind[] = ["terminal", "task", "you"];

export type BrowserHostOptions = {
  readonly driver: BrowserDriver;
  readonly profileDir: string;
  readonly files: FileRules;
  /** AgentSwitch's own ports (local API, remote, gate proxy, OpenCode): never opened in the browser. */
  readonly ownPorts?: () => readonly number[];
  readonly holdIdleMs?: number;
  readonly idleCloseMs?: number;
  readonly defaultViewport?: Viewport;
  /** Before each launch: the profile made ready (folder, password manager off, a stale Chrome on it stopped). */
  readonly prepareProfile?: (dir: string) => void;
  /** After Chrome went away, by request or not. */
  readonly afterExit?: () => void;
  /** A hold that ran out (for the audit). */
  readonly onIdleRelease?: (tabId: string, holder: string) => void;
  /** Send the macOS editing commands with keys (Chrome on the Mac needs them). */
  readonly mac?: boolean;
  /** The addresses a host name resolves to (default `dns.lookup`), for AgentSwitch's own ports under other names. */
  readonly lookup?: (hostname: string) => Promise<readonly string[]>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
};

type TabState = {
  readonly id: string;
  readonly owner: TabOwner;
  readonly openedAt: number;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly status: TabStatus;
  readonly heldBy: string | null;
  readonly action: AgentAction | null;
  readonly viewport: Viewport;
  readonly viewportBy: string | null;
};

/** What the agent bridge follows across all tabs (agents.ts): a tab opened (a popup too), a hold that began or ended, a
 *  tab gone. */
export type HostEvent =
  | { readonly type: "opened"; readonly id: string; readonly owner: TabOwner }
  | { readonly type: "held"; readonly id: string; readonly heldBy: string | null }
  | { readonly type: "closed"; readonly id: string };

/** What a fill typed, for the audit: the ciphertext's label and the page's host:port. Never the value. */
export type FillDone = { readonly label: string; readonly host: string };

/** What a tab holds besides its state: the page, its screencast, the streams, the hold timer, the buttons held. */
type TabRuntime = {
  readonly page: DriverPage;
  readonly screencast: Screencast;
  readonly listeners: Set<(ev: BrowserEvent) => void>;
  holdTimer: NodeJS.Timeout | null;
  pressed: Pressed;
};

const ownerKey = (o: TabOwner): string => `${o.kind}:${o.id}`;
const firstLine = (err: unknown): string => String((err as Error)?.message ?? err).split("\n")[0]!.trim();
const isHttp = (raw: string): boolean => { try { return /^https?:$/.test(new URL(raw).protocol); } catch { return false; } };
/** `host:port` of an http(s) URL, as the gate names a page's place (`page_host`). */
const hostOf = (raw: string): string => { const url = new URL(raw); return `${url.hostname}:${portOf(url)}`; };

/** Why Chrome did not start, in the user's words. */
export function launchFailure(err: unknown): string {
  const text = String((err as Error)?.message ?? err);
  if (/distribution 'chrome' is not found|executable doesn't exist|ENOENT/i.test(text)) return "未找到 Google Chrome。请在 Mac 上安装 Google Chrome。";
  return `浏览器未能启动：${firstLine(err)}`;
}

export class BrowserHost {
  private browser: DriverBrowser | null = null;
  private launching: Promise<DriverBrowser> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly states = new Map<string, TabState>();
  private readonly runtimes = new Map<string, TabRuntime>();
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly watchers = new Set<(ev: HostEvent) => void>();
  private shutDown = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly defaultViewport: Viewport;

  constructor(private readonly opts: BrowserHostOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.error;
    this.defaultViewport = opts.defaultViewport ?? DEFAULT_VIEWPORT;
  }

  /** Chrome is up. */
  get running(): boolean { return this.browser !== null; }

  list(): TabInfo[] {
    return [...this.states.values()].sort((a, b) => a.openedAt - b.openedAt).map((s) => this.info(s));
  }

  /** The tabs by owner: terminals' agents, tasks, then the user's; each group in the order its first tab opened. */
  groups(): TabGroup[] {
    const groups = new Map<string, { owner: TabOwner; tabs: TabInfo[] }>();
    for (const tab of this.list()) {
      const key = ownerKey(tab.owner);
      const group = groups.get(key) ?? { owner: tab.owner, tabs: [] };
      groups.set(key, { ...group, tabs: [...group.tabs, tab] });
    }
    return [...groups.values()].sort((a, b) => KIND_ORDER.indexOf(a.owner.kind) - KIND_ORDER.indexOf(b.owner.kind));
  }

  get(id: string): TabInfo | null {
    const s = this.states.get(id);
    return s ? this.info(s) : null;
  }

  /** A new tab of `owner`'s at `url` (checked against the owner's rules first). Returns once the tab exists; the page
   *  loads on, and its stream shows it. */
  async open(owner: TabOwner, url: string): Promise<TabInfo> {
    if (this.shutDown) throw new BrowserError("unavailable", "浏览器已关闭。");
    const target = checkUrl(owner, url, this.opts.files, this.ownPorts());
    const browser = await this.ensure();
    let page: DriverPage;
    try { page = await browser.newPage(); } catch (err) { throw new BrowserError("unavailable", `无法打开新标签：${firstLine(err)}`); }
    const id = this.register(page, owner);
    await this.applyViewport(id);
    this.go(id, target);
    return this.get(id)!;
  }

  /** Sends a tab elsewhere, under the rules of its owner (people's tabs may go to `file:`, agents' never). */
  navigate(id: string, holder: string, url: string): TabInfo {
    const state = this.mayDrive(id, holder);
    const target = checkUrl(state.owner, url, this.opts.files, this.ownPorts());
    this.go(id, target);
    this.touch(id, holder);
    return this.get(id)!;
  }

  async history(id: string, holder: string, action: "back" | "forward" | "reload"): Promise<TabInfo> {
    this.mayDrive(id, holder);
    const rt = this.runtimes.get(id)!;
    await rt.page.history(action).catch((err: unknown) => this.log(`browser: tab ${id} ${action}: ${firstLine(err)}`));
    this.touch(id, holder);
    return this.get(id)!;
  }

  async close(id: string): Promise<void> {
    this.must(id);
    const rt = this.runtimes.get(id)!;
    const closing = rt.page.close().then(() => "closed" as const, (err: unknown) => { this.log(`browser: tab ${id} close: ${firstLine(err)}`); return "closed" as const; });
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), CLOSE_TIMEOUT_MS); timer.unref(); });
    if (await Promise.race([closing, late]) === "late") this.log(`browser: tab ${id} did not close within ${CLOSE_TIMEOUT_MS} ms; forgotten`);
    clearTimeout(timer);
    this.drop(id, "closed");
  }

  /** `holder` takes the tab over (from whoever held it). A size the previous holder set goes back to the default. */
  take(id: string, holder: string): TabInfo {
    const state = this.must(id);
    const resize = state.viewportBy !== null && state.viewportBy !== holder;
    this.update(id, { heldBy: holder, ...(resize ? { viewport: this.defaultViewport, viewportBy: null } : {}) });
    this.runtimes.get(id)!.pressed = NOTHING_PRESSED;
    this.emit(id, { type: "held", heldBy: holder, reason: "take" });
    this.announce({ type: "held", id, heldBy: holder });
    if (resize) {
      void this.applyViewport(id);
      this.viewportChanged(id);
    }
    this.armHold(id, holder);
    return this.get(id)!;
  }

  /** The holder hands the tab back; a tab nobody holds stays as it is. */
  release(id: string, holder: string): TabInfo {
    const state = this.must(id);
    if (state.heldBy === null) return this.info(state);
    if (state.heldBy !== holder) throw new BrowserError("conflict", "此标签由其他屏幕接手，无法从这里交还。");
    this.unhold(id, "hand-back");
    return this.get(id)!;
  }

  /** The holding screen's size for the tab (phone: its viewport and the mobile layout). */
  async setViewport(id: string, holder: string, viewport: Viewport): Promise<TabInfo> {
    const state = this.must(id);
    if (state.heldBy !== holder) throw new BrowserError("conflict", "请先接手此标签，再设置尺寸。");
    this.update(id, { viewport, viewportBy: holder });
    await this.applyViewport(id);
    this.viewportChanged(id);
    this.armHold(id, holder);
    return this.get(id)!;
  }

  /** A screen's input, in order. Points are on the frame `seq` names (default the latest one). */
  async input(id: string, holder: string, events: readonly InputEvent[]): Promise<void> {
    const state = this.mayDrive(id, holder);
    const rt = this.runtimes.get(id)!;
    for (const ev of events) {
      const geometry = (ev.type === "mouse" || ev.type === "wheel" ? rt.screencast.geometry(ev.seq) : null)
        ?? { scale: 1, width: state.viewport.width, height: state.viewport.height };
      const { calls, pressed } = inputCalls(ev, geometry, rt.pressed, this.opts.mac ?? process.platform === "darwin");
      rt.pressed = pressed;
      try {
        for (const call of calls) await rt.page.input(call.method, call.params);
      } catch (err) {
        if (!this.states.has(id)) throw new BrowserError("not_found", "not found");
        throw new BrowserError("unavailable", `页面未接受输入：${firstLine(err)}`);
      }
    }
    this.touch(id, holder);
  }

  /** A screen's stream: the tab now, then frames (at the stream's own rate) and every change, until the returned
   *  function is called or the tab closes (`closed`). */
  subscribe(id: string, opts: StreamOptions, listener: (ev: BrowserEvent) => void): () => void {
    const state = this.must(id);
    const rt = this.runtimes.get(id)!;
    listener({ type: "tab", tab: this.info(state) });
    rt.listeners.add(listener);
    const stopFrames = rt.screencast.add(opts, listener);
    return () => { rt.listeners.delete(listener); stopFrames(); };
  }

  /** The agent bridge: busy, waiting for the user, idle. */
  setStatus(id: string, status: TabStatus): void {
    if (this.must(id).status === status) return;
    this.update(id, { status });
    this.emit(id, { type: "status", status });
  }

  /** The agent bridge: what the agent just did (the screens' overlay); null clears it. */
  setAction(id: string, action: Omit<AgentAction, "at"> | null): void {
    this.must(id);
    const next = action ? { ...action, at: this.now() } : null;
    this.update(id, { action: next });
    this.emit(id, { type: "action", action: next });
  }

  /** The agent bridge: every tab opened, held or released, and closed, from now on, until the returned function is
   *  called. */
  watch(listener: (ev: HostEvent) => void): () => void {
    this.watchers.add(listener);
    return () => { this.watchers.delete(listener); };
  }

  /** The agent bridge: the page behind a tab (its Playwright page for Playwright MCP). */
  page(id: string): DriverPage | null {
    return this.runtimes.get(id)?.page ?? null;
  }

  /** The tabs of one owner, in the order they opened. */
  tabsOf(owner: Pick<TabOwner, "kind" | "id">): TabInfo[] {
    return this.list().filter((t) => t.owner.kind === owner.kind && t.owner.id === owner.id);
  }

  /** Where `owner`'s tab may go (the same rules as `open` and `navigate`): the URL normalized, or a refusal. */
  allowed(owner: TabOwner, url: string): string {
    return checkUrl(owner, url, this.opts.files, this.ownPorts());
  }

  /** A person's Fill Ciphertext (browser-v0 §1, §6): `token` resolved by the gate for the focused field's frame and
   *  every frame above it, then typed into that very field. Only on the person's own tabs (an agent's tab would hand
   *  what the page does with the value to the agent after the hand-back), only by the screen that may drive it (its
   *  holder, or anyone while nobody holds it), only on http(s), only into a password or one-time-code field (the
   *  screens show any other as typed), and only while focus stays on the field that was checked. The value goes into
   *  the page and nowhere else: not returned, not logged, not quoted in an error. */
  async fill(id: string, holder: string, token: string, resolve: FillResolver): Promise<FillDone> {
    if (this.must(id).owner.kind !== "you") throw new BrowserError("conflict", AGENT_TAB_FILL);
    this.mayDrive(id, holder);
    const field = await this.focusOf(id);
    try {
      let resolved: { readonly value: string; readonly label: string };
      try { resolved = await resolve(token, field.frames); }
      catch (err) { throw new BrowserError("forbidden", err instanceof FillRefused ? err.message : "凭据网关未能处理此密文。"); }
      // The gate took a moment: the tab and the hold must still be as checked; the field checks its own focus.
      this.mayDrive(id, holder);
      let typed: boolean;
      try { typed = await field.insert(resolved.value); }
      catch {
        if (!this.states.has(id)) throw new BrowserError("not_found", "not found");
        throw new BrowserError("unavailable", "页面未接受输入。");
      }
      if (!typed) throw new BrowserError("conflict", "输入焦点已改变，未填入。请重新点选输入框后再试。");
      this.touch(id, holder);
      return { label: resolved.label, host: hostOf(field.frames.at(-1)!) };
    } finally {
      await field.release().catch(() => undefined);
    }
  }

  /** The daemon is stopping: every stream ends, Chrome quits. */
  async shutdown(): Promise<void> {
    this.shutDown = true;
    this.cancelIdleClose();
    for (const id of [...this.states.keys()]) this.drop(id, "shutdown");
    await this.launching?.catch(() => undefined);
    await this.stopBrowser();
  }

  // ---- Chrome

  private ownPorts(): readonly number[] { return this.opts.ownPorts?.() ?? []; }

  private async ensure(): Promise<DriverBrowser> {
    if (this.browser) return this.browser;
    this.launching ??= this.launch().finally(() => { this.launching = null; });
    return this.launching;
  }

  private async launch(): Promise<DriverBrowser> {
    await this.stopping;
    const dir = this.opts.profileDir;
    let browser: DriverBrowser;
    try {
      this.opts.prepareProfile?.(dir);
      browser = await this.opts.driver.launch({ profileDir: dir, guard: (req) => this.guard(req), routed: (url) => this.routed(url), blocked: () => ownPortPatterns(this.ownPorts()) });
    } catch (err) {
      this.log(`browser: Chrome did not start: ${String((err as Error)?.message ?? err)}`);
      throw new BrowserError("unavailable", launchFailure(err));
    }
    if (this.shutDown) {
      await browser.close().catch(() => undefined);
      throw new BrowserError("unavailable", "浏览器已关闭。");
    }
    browser.onExit((expected) => this.exited(browser, expected));
    this.browser = browser;
    this.scheduleIdleClose();
    return browser;
  }

  private exited(browser: DriverBrowser, expected: boolean): void {
    if (this.browser !== browser) return;
    this.browser = null;
    this.cancelIdleClose();
    const reason: ClosedReason = this.shutDown ? "shutdown" : expected ? "closed" : "browser-exited";
    for (const id of [...this.states.keys()]) this.drop(id, reason);
    if (!expected) this.log("browser: Chrome exited unexpectedly; it starts again when a tab is opened");
    this.opts.afterExit?.();
  }

  private async stopBrowser(): Promise<void> {
    const browser = this.browser;
    if (!browser) { await this.stopping; return; }
    this.browser = null;
    const closing = browser.close().catch((err: unknown) => this.log(`browser: Chrome did not close cleanly: ${firstLine(err)}`));
    this.stopping = Promise.race([closing, new Promise<void>((r) => setTimeout(r, CLOSE_TIMEOUT_MS).unref())])
      .finally(() => { this.stopping = null; this.opts.afterExit?.(); });
    await this.stopping;
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer || !this.browser || this.states.size || this.shutDown) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.states.size) void this.stopBrowser();
    }, this.opts.idleCloseMs ?? IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** The requests the guard sees: every `file:` one, every one to this Mac's loopback names, and every one to a port of
   *  AgentSwitch's under any name (it may resolve to this Mac). */
  private routed(url: URL): boolean {
    if (url.protocol === "file:") return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isLoopbackHost(url.hostname) || this.ownPorts().includes(portOf(url));
  }

  /** Every `file:` request and every request to this Mac, from any tab: own ports never, however the host is named
   *  (`localhost.`, a name that resolves to this Mac); `file:` only for a person's tab, and only where a person may open
   *  it. A page not known yet goes by its opener. A popup's first navigation comes before its page exists (no page at
   *  all): to a `file:` URL it can only come from a `file:` page, since Chrome lets no http(s) or blank page open one,
   *  and only a person's tab holds a `file:` page; so it is checked as a person's. Defense in depth: Chrome resolves
   *  names itself, so a name that resolves differently for it (DNS rebinding) is not caught here; AgentSwitch's own
   *  servers ask for their own credentials. */
  private async guard(req: GuardRequest): Promise<GuardDecision> {
    let url: URL;
    try { url = new URL(req.url); } catch { return { action: "block", reason: "无法识别的地址。" }; }
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (!this.ownPorts().includes(portOf(url))) return { action: "continue" };
      return isLoopbackHost(url.hostname) || await this.resolvesHere(url.hostname) ? { action: "block", reason: OWN_PORT_REFUSAL } : { action: "continue" };
    }
    if (url.protocol !== "file:") return { action: "continue" };
    const owner = req.page ? await this.ownerOf(req.page) : req.navigation ? YOU : null;
    if (owner?.kind !== "you") return { action: "block", reason: AGENT_FILE_REFUSAL };
    try {
      checkLocalFile(fileURLToPath(url), this.opts.files);
      return { action: "continue" };
    } catch (err) {
      return { action: "block", reason: err instanceof BrowserError ? err.message : "无法打开此文件。" };
    }
  }

  /** True when `hostname` resolves to an address of this Mac (any of them). A failed lookup is not this Mac. */
  private async resolvesHere(hostname: string): Promise<boolean> {
    const lookup = this.opts.lookup ?? lookupAll;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<readonly string[]>((r) => { timer = setTimeout(() => r([]), LOOKUP_TIMEOUT_MS); timer.unref?.(); });
    const addresses = await Promise.race([lookup(normalHost(hostname)).catch(() => [] as readonly string[]), late]);
    clearTimeout(timer);
    return addresses.some(isLoopbackAddress);
  }

  private async ownerOf(page: DriverPage | null): Promise<TabOwner | null> {
    if (!page) return null;
    const own = this.idOf(page);
    if (own) return this.states.get(own)!.owner;
    const opener = await page.opener().catch(() => null);
    const parent = opener ? this.idOf(opener) : null;
    return parent ? this.states.get(parent)!.owner : null;
  }

  // ---- tabs

  private idOf(page: DriverPage): string | null {
    for (const [id, rt] of this.runtimes) if (rt.page === page) return id;
    return null;
  }

  private register(page: DriverPage, owner: TabOwner): string {
    let id = randomBytes(4).toString("hex");
    while (this.states.has(id)) id = randomBytes(4).toString("hex");
    this.states.set(id, {
      id, owner, openedAt: this.now(), url: page.url() || "about:blank", title: page.title(), loading: false,
      status: "idle", heldBy: null, action: null, viewport: this.defaultViewport, viewportBy: null,
    });
    this.runtimes.set(id, { page, screencast: new Screencast(page, this.now, this.log), listeners: new Set(), holdTimer: null, pressed: NOTHING_PRESSED });
    this.cancelIdleClose();
    page.on("changed", ({ url, title }) => this.changed(id, url, title));
    page.on("loading", (loading) => {
      if (!this.states.has(id) || this.states.get(id)!.loading === loading) return;
      this.update(id, { loading });
      this.emit(id, { type: "loading", loading });
    });
    // A page's popup is a tab of the same owner's.
    page.on("popup", (popup) => {
      if (!this.states.has(id) || this.idOf(popup)) return;
      const child = this.register(popup, owner);
      void this.applyViewport(child);
    });
    page.on("closed", () => this.drop(id, "closed"));
    this.announce({ type: "opened", id, owner });
    return id;
  }

  private changed(id: string, url: string, title: string): void {
    const state = this.states.get(id);
    if (!state) return;
    this.update(id, { url, title });
    if (url !== state.url) this.emit(id, { type: "url", url, ...placeOf(url, this.opts.files.home) });
    if (title !== state.title) this.emit(id, { type: "title", title });
  }

  /** Navigation runs on: the API answers at once, the stream shows the page coming. A failed navigation leaves
   *  Chrome's error page, as any browser would. */
  private go(id: string, url: string): void {
    const rt = this.runtimes.get(id)!;
    // The address shows at once; the page's own events correct it (a redirect, an error page).
    if (this.states.get(id)!.url !== url) {
      this.update(id, { url });
      this.emit(id, { type: "url", url, ...placeOf(url, this.opts.files.home) });
    }
    void rt.page.navigate(url).catch((err: unknown) => this.log(`browser: tab ${id} navigation: ${firstLine(err)}`));
  }

  private drop(id: string, reason: ClosedReason): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    this.states.delete(id);
    this.runtimes.delete(id);
    if (rt.holdTimer) clearTimeout(rt.holdTimer);
    rt.screencast.close();
    for (const listener of rt.listeners) this.safely(listener, { type: "closed", reason });
    rt.listeners.clear();
    this.announce({ type: "closed", id });
    this.scheduleIdleClose();
  }

  private must(id: string): TabState {
    const state = this.states.get(id);
    if (!state) throw new BrowserError("not_found", "not found");
    return state;
  }

  /** The focused editable field of a tab: on http(s) pages only (every frame up to the top), a password or
   *  one-time-code field only. Refused fields are let go of. */
  private async focusOf(id: string): Promise<FocusedField> {
    const page = this.runtimes.get(id)?.page;
    if (!page) throw new BrowserError("not_found", "not found");
    if (!page.focusedField) throw new BrowserError("unavailable", "此浏览器不支持填入密文。");
    const field = await page.focusedField().catch(() => null);
    if (!field || !field.frames.length) {
      await field?.release().catch(() => undefined);
      throw new BrowserError("invalid", "请先点选要填入的输入框。");
    }
    const refusal = !field.frames.every(isHttp) ? new BrowserError("forbidden", "只能在 http(s) 页面中填入密文。")
      : !field.secret ? new BrowserError("invalid", SECRET_FIELDS_ONLY) : null;
    if (refusal) {
      await field.release().catch(() => undefined);
      throw refusal;
    }
    return field;
  }

  private announce(ev: HostEvent): void {
    for (const watcher of [...this.watchers]) {
      try { watcher(ev); } catch (err) { this.log(`browser: watcher failed: ${firstLine(err)}`); }
    }
  }

  /** May `holder` drive this tab? A held tab only by its holder; an agent's tab only once taken over. */
  private mayDrive(id: string, holder: string): TabState {
    const state = this.must(id);
    if (state.heldBy !== null && state.heldBy !== holder) throw new BrowserError("conflict", "此标签已由其他屏幕接手。");
    if (state.heldBy === null && state.owner.kind !== "you") throw new BrowserError("conflict", "此标签由 agent 使用，请先接手。");
    return state;
  }

  private update(id: string, change: Partial<Omit<TabState, "id" | "owner" | "openedAt">>): void {
    const state = this.states.get(id);
    if (state) this.states.set(id, { ...state, ...change });
  }

  private info(s: TabState): TabInfo {
    return {
      id: s.id, owner: s.owner, title: s.title, url: s.url, ...placeOf(s.url, this.opts.files.home), status: s.status, loading: s.loading,
      heldBy: s.heldBy, action: s.action, viewport: { ...s.viewport, by: s.viewportBy }, openedAt: s.openedAt,
    };
  }

  private emit(id: string, ev: BrowserEvent): void {
    for (const listener of this.runtimes.get(id)?.listeners ?? []) this.safely(listener, ev);
  }

  private safely(listener: (ev: BrowserEvent) => void, ev: BrowserEvent): void {
    try { listener(ev); } catch (err) { this.log(`browser: stream listener failed: ${firstLine(err)}`); }
  }

  // ---- holds and sizes

  /** Input from the holder keeps the hold. */
  private touch(id: string, holder: string): void {
    if (this.states.get(id)?.heldBy === holder) this.armHold(id, holder);
  }

  private armHold(id: string, holder: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    if (rt.holdTimer) clearTimeout(rt.holdTimer);
    rt.holdTimer = setTimeout(() => {
      rt.holdTimer = null;
      if (this.states.get(id)?.heldBy !== holder) return;
      this.unhold(id, "idle");
      this.opts.onIdleRelease?.(id, holder);
    }, this.opts.holdIdleMs ?? HOLD_IDLE_MS);
    rt.holdTimer.unref();
  }

  private unhold(id: string, reason: HeldReason): void {
    const state = this.states.get(id)!;
    const rt = this.runtimes.get(id)!;
    if (rt.holdTimer) clearTimeout(rt.holdTimer);
    rt.holdTimer = null;
    rt.pressed = NOTHING_PRESSED;
    const resize = state.viewportBy !== null;
    this.update(id, { heldBy: null, ...(resize ? { viewport: this.defaultViewport, viewportBy: null } : {}) });
    this.emit(id, { type: "held", heldBy: null, reason });
    if (resize) {
      void this.applyViewport(id);
      this.viewportChanged(id);
    }
    this.announce({ type: "held", id, heldBy: null });
  }

  private viewportChanged(id: string): void {
    const state = this.states.get(id);
    if (state) this.emit(id, { type: "viewport", viewport: { ...state.viewport, by: state.viewportBy } });
  }

  private async applyViewport(id: string): Promise<void> {
    const state = this.states.get(id);
    const rt = this.runtimes.get(id);
    if (!state || !rt) return;
    await rt.page.setViewport(state.viewport).catch((err: unknown) => this.log(`browser: tab ${id} viewport: ${firstLine(err)}`));
    rt.screencast.restart();
  }
}
