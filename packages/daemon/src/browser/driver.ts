/** What the browser host needs from a browser, and nothing more: Playwright stays behind this (playwrightDriver.ts), and
 *  the tests drive a fake. */

import type { Viewport } from "./types.js";

/** One request the browser is about to make for a page: a navigation (of any frame) or a subresource. */
export type GuardRequest = {
  readonly url: string;
  /** The page asking; null when it cannot be told: a popup's first navigation (its page does not exist yet), a
   *  service worker's request. */
  readonly page: DriverPage | null;
  readonly navigation: boolean;
};

/** `block` with a navigation shows `reason` as the page; a subresource is just not loaded. */
export type GuardDecision = { readonly action: "continue" } | { readonly action: "block"; readonly reason: string };

/** Asked for every `file:` request and every request to this Mac (loopback). Throwing blocks the request. */
export type RequestGuard = (req: GuardRequest) => Promise<GuardDecision>;

/** `Page.screencastFrame` as Chrome sends it: the JPEG, its metadata, and the id to acknowledge it with. */
export type RawFrame = {
  readonly data: string;
  readonly ackId: number;
  readonly metadata: {
    readonly deviceWidth: number;
    readonly deviceHeight: number;
    readonly pageScaleFactor: number;
    readonly offsetTop: number;
    readonly scrollOffsetX: number;
    readonly scrollOffsetY: number;
  };
};

export type ScreencastParams = { readonly quality: number; readonly maxWidth?: number; readonly maxHeight?: number };

export type PageEvents = {
  /** The main frame's URL or the title changed. */
  readonly changed: (state: { readonly url: string; readonly title: string }) => void;
  readonly loading: (loading: boolean) => void;
  /** The page opened another one (`window.open`, a link with a target). */
  readonly popup: (page: DriverPage) => void;
  readonly frame: (frame: RawFrame) => void;
  readonly closed: () => void;
};

/** Where the caret is, for a person's Fill Ciphertext (browser-v0 §1, §6): the field itself, held until `release`. */
export type FocusedField = {
  /** The URLs of the frame holding the focused editable field and of every frame above it, innermost first, as the
   *  browser reports them (not the page). */
  readonly frames: readonly string[];
  /** A field for a secret, whose text the screen does not show: a password field (`type=password`), or one the page
   *  marks for a password or a one-time code (`autocomplete` `current-password`, `new-password`, `one-time-code`). */
  readonly secret: boolean;
  /** Types `text` into this very field (its content replaced), if it still has focus in the same frame chain; false,
   *  with nothing typed, when focus moved or the field is gone. */
  insert(text: string): Promise<boolean>;
  /** Lets go of the field. */
  release(): Promise<void>;
};

export interface DriverPage {
  url(): string;
  title(): string;
  /** The page that opened this one, if any. */
  opener(): Promise<DriverPage | null>;
  /** Resolves once the navigation is committed (not loaded); a failed navigation (no such host) rejects. */
  navigate(url: string): Promise<void>;
  history(action: "back" | "forward" | "reload"): Promise<void>;
  close(): Promise<void>;
  setViewport(viewport: Viewport): Promise<void>;
  /** `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText` on the page's own CDP session. */
  input(method: InputMethod, params: Record<string, unknown>): Promise<void>;
  startScreencast(params: ScreencastParams): Promise<void>;
  stopScreencast(): Promise<void>;
  ackFrame(ackId: number): Promise<void>;
  on<K extends keyof PageEvents>(event: K, listener: PageEvents[K]): void;
  /** The editable field that has focus now (not a select, not a frame element), or null when none or more than one
   *  frame claims it. Absent: fill is not offered. */
  focusedField?(): Promise<FocusedField | null>;
  /** The Playwright page behind this one, for the agents' Playwright MCP in the daemon (agentMcp.ts); absent on a fake. */
  playwright?(): unknown;
}

export type InputMethod = "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText";

export interface DriverBrowser {
  /** A new page (the launch's own blank page first). */
  newPage(): Promise<DriverPage>;
  /** Called once when the browser goes away; `expected` when `close()` asked for it. */
  onExit(listener: (expected: boolean) => void): void;
  close(): Promise<void>;
}

export type LaunchOptions = {
  /** The persistent profile (`$AGENTSWITCH_HOME/browser-profiles/main`). */
  readonly profileDir: string;
  readonly guard: RequestGuard;
  /** Which requests go past the guard (default: `file:` and this Mac's loopback names). */
  readonly routed?: (url: URL) => boolean;
  /** URL patterns Chrome itself refuses on every page, redirects included (CDP `Network.setBlockedURLs`): AgentSwitch's
   *  own ports on this Mac's loopback names. Read again as they change. */
  readonly blocked?: () => readonly string[];
};

export interface BrowserDriver {
  launch(opts: LaunchOptions): Promise<DriverBrowser>;
}
