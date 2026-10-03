/** The shared browser's vocabulary (docs/browser-v0.md): who a tab belongs to, what the screens see of it, the events a
 *  screen's stream carries and the errors the API turns into statuses. */

/** `you`: opened by a person (the Mac app, the phone, the web page); `terminal` / `task`: an agent's (browser-v0 §2). */
export type TabOwnerKind = "you" | "terminal" | "task";
export type TabOwner = { readonly kind: TabOwnerKind; readonly id: string; readonly label: string };

export const YOU: TabOwner = { kind: "you", id: "you", label: "You" };

/** `busy`: an agent is operating it; `waiting`: an agent waits for the user (a code, a login, a confirmation). */
export const TAB_STATUSES = ["idle", "busy", "waiting"] as const;
export type TabStatus = (typeof TAB_STATUSES)[number];

/** A rectangle in the page's CSS pixels (the viewport's, not the frame's). */
export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** What an agent just did, for the overlay on the screens (`codex · click "Merge"`); set by the agent bridge. */
export type AgentAction = { readonly tool: string; readonly description: string; readonly box?: Box; readonly at: number };

/** The page's size: CSS pixels, device pixel ratio, and whether it is emulated as a phone (touch, mobile layout). */
export type Viewport = { readonly width: number; readonly height: number; readonly scale: number; readonly mobile: boolean };

/** Every tab's size until a screen that holds it sets its own (browser-v0 §1 尺寸). */
export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800, scale: 1, mobile: false };

/** What kind of place a tab shows, for the list's second line: a site, a file of the Mac's, a local server, nothing. */
export type PlaceKind = "web" | "file" | "local" | "blank";

export type TabInfo = {
  readonly id: string;
  readonly owner: TabOwner;
  readonly title: string;
  readonly url: string;
  /** The list's second line: the host (`github.com`), the path (`~/x/mesh.html`) or `localhost:5173`. */
  readonly site: string;
  readonly kind: PlaceKind;
  readonly status: TabStatus;
  readonly loading: boolean;
  /** The screen (or paired device) that has taken the tab over; null while nobody holds it. */
  readonly heldBy: string | null;
  readonly action: AgentAction | null;
  /** The size in force; `by` is the holding screen that set it, null for the default. */
  readonly viewport: Viewport & { readonly by: string | null };
  readonly openedAt: number;
};

export type TabGroup = { readonly owner: TabOwner; readonly tabs: readonly TabInfo[] };

/** One screencast frame as a screen gets it: a JPEG (base64), its pixel size, and how many of its pixels make one CSS
 *  pixel of the page (`scale`), so a point on the frame maps to the page as `x / scale`. */
export type FrameEvent = {
  readonly type: "frame";
  readonly seq: number;
  readonly data: string;
  readonly format: "jpeg";
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  /** The page's viewport in CSS pixels when the frame was drawn. */
  readonly viewport: { readonly width: number; readonly height: number };
  readonly pageScale: number;
  readonly scrollX: number;
  readonly scrollY: number;
};

/** Why a hold ended: handed back, two minutes without input, or another screen took it. */
export type HeldReason = "take" | "hand-back" | "idle";
/** Why a stream ends. */
export type ClosedReason = "closed" | "browser-exited" | "shutdown";

export type BrowserEvent =
  | { readonly type: "tab"; readonly tab: TabInfo }
  | FrameEvent
  | { readonly type: "title"; readonly title: string }
  | { readonly type: "url"; readonly url: string; readonly site: string; readonly kind: PlaceKind }
  | { readonly type: "loading"; readonly loading: boolean }
  | { readonly type: "status"; readonly status: TabStatus }
  | { readonly type: "held"; readonly heldBy: string | null; readonly reason: HeldReason }
  | { readonly type: "action"; readonly action: AgentAction | null }
  | { readonly type: "viewport"; readonly viewport: TabInfo["viewport"] }
  | { readonly type: "closed"; readonly reason: ClosedReason };

export type BrowserErrorCode = "not_found" | "forbidden" | "conflict" | "invalid" | "unavailable";

/** A refusal or failure the API answers with a status; `message` is shown to the user as it is. */
export class BrowserError extends Error {
  constructor(readonly code: BrowserErrorCode, message: string) {
    super(message);
    this.name = "BrowserError";
  }
}
