/** Shared by every route module: dependencies, body parsing, error text. */

import type { ShownFoldersStore } from "../sessions/shownFolders.js";
import { createHash } from "node:crypto";
import type { EngineKit } from "../browser/engine/kit.js";
import type { Context } from "hono";
import type { z } from "zod";
import type { Uploads } from "../files/uploads.js";
import type { Targets } from "../models/targets.js";
import { zodIssues } from "../util/zod.js";
import type { CwdRules } from "./cwdPolicy.js";
import type { SessionMonitor } from "../sessions/monitor.js";
import type { SharedBrowser } from "../browser/setup.js";
import type { Terminals } from "./terminals.js";

/** The most rows a `?limit=` may ask for. */
const MAX_LIST_LIMIT = 500;

export type ApiDeps = {
  /** What the nodes this one uses last said of their own Live Activity (docs/mesh-v0.md §5.2 跨节点的提醒): listed
   *  beside this node's own for its own screens. Never waits for a node. */
  readonly liveElsewhere?: () => readonly { readonly id: string; readonly name: string; readonly body: Record<string, unknown>; readonly ahead?: number }[];
  /** Chat Room's rooms (docs/chatroom-v0.md); absent = off. */
  readonly rooms?: import("../rooms/store.js").RoomStore;
  /** Chatroom Kit: what a session in a room can do there (docs/chatroom-v0.md §6). */
  readonly roomKit?: import("../rooms/kit.js").RoomKit;
  /** How a room's messages reach the sessions they are for (§5). */
  readonly roomDelivery?: import("../rooms/delivery.js").RoomDelivery;
  /** Taking a member back to before a room's message (撤回, a safeguard's refusal; api/roomRewind.ts). */
  readonly seatRewind?: import("./roomRewind.js").SeatRewind;
  /** The words the model never sees, and the gateway that replaces them (vault/; api/redaction.ts). */
  /** A value sealed under the vault's key (vault/seal.ts): what a screen sends of a profile's API key, a proxy's
   *  password or a session key, in place of a gate's ciphertext. */
  readonly seal?: (value: string, use?: string) => string;
  /** What `seal` made for `use`, opened again: a word another node sends for this one's replacement comes sealed
   *  for `redaction` (api/redaction.ts). Throws when it is not this vault's, or was sealed for something else. */
  readonly unseal?: (token: string, use: string) => string;
  /** The password book (vault/passwords.ts; api/passwords.ts). */
  readonly passwords?: import("../vault/passwords.js").PasswordBook;
  readonly redaction?: { readonly store: import("../vault/words.js").RedactionStore; readonly gate: import("../vault/modelGate.js").ModelGate };
  /** Tests: how long a watch of the Kit's tools is held. */
  readonly roomWatchMs?: number;
  /** Something a room's seats may be waiting for changed (a message, a seat, a pause): what is to be given is looked
   *  at again. */
  readonly roomsChanged?: (roomId: string) => void;
  /** Which models a session may start a session on, per profile (rooms/policy.ts). */
  readonly roomPolicy?: import("../rooms/policy.js").RoomPolicy;
  /** This service's own routes, asked in process like a screen's (used to resume the session behind a room seat,
   *  docs/chatroom-v0.md §6.2). Absent: resuming from a room is not available. */
  readonly callLocal?: import("./roomOrg.js").Ask;
  /** The new dispatch: a session at the 调度台 room (api/dispatchDesk.ts); absent = off. */
  readonly dispatchDesk?: import("./dispatchDesk.js").DispatchDesk;
  /** Clash Integration (docs/clash-v0.md). */
  readonly clash?: import("../clash/integration.js").ClashIntegration;
  /** The browsers of profiles that have a proxy of their own (docs/profiles-v0.md §5.1). */
  readonly profileBrowsers?: import("../browser/fleet.js").ProfileBrowsers;
  /** The exits of profiles that have a proxy of their own (docs/profiles-v0.md §4). */
  readonly exits?: import("../browser/exits.js").ExitPool;
  /** Each agent's profiles (docs/profiles-v0.md). */
  readonly profiles?: import("../profiles/store.js").ProfileStore;
  /** Profiles' claude.ai session keys (docs/profiles-v0.md §3.4). */
  readonly sessionKeys?: import("../browser/sessionKey.js").SessionKeys;
  /** The keys profiles pay by (docs/profiles-v0.md §3.6). */
  readonly apiKeys?: import("../profiles/apiKeys.js").ApiKeys;
  /** What each profile has installed (profiles/addons.ts). */
  readonly addons?: import("../profiles/addons.js").Addons;
  /** Puts a Claude config folder's sign-in away (profiles/claudeLogin.ts; null: the user's own). Absent: nothing is
   *  done — a daemon built by a test must never reach this Mac's keychain. */
  readonly forgetClaudeLogin?: (configDir: string | null) => Promise<void>;
  readonly profileHealth?: import("../profiles/health.js").ProfileHealthChecks;
  /** The catalog of models (models/targets.ts): what the terminals' model menus list of an agent that has not said
   *  what it offers. */
  readonly targets: Targets;
  /** The Mac's coding sessions (docs/control-v0.md §3); absent = not watched. */
  readonly sessions?: SessionMonitor;
  /** The folders the user shows or hides in the list of sessions (sessions/shownFolders.ts). */
  readonly sessionFolders?: ShownFoldersStore;
  /** AgentSwitch's own terminals, the manual entry (docs/terminal-v0.md); absent = off. */
  readonly terminals?: Terminals;
  /** The shared browser (docs/browser-v0.md); absent = off. */
  readonly browser?: SharedBrowser;
  /** The browser engine — Camoufox and its Playwright — on disk and its updates (docs/browser-v0.md §7); absent = off. */
  readonly engineKit?: EngineKit;
  readonly uploads: Uploads;
  readonly version: string;
  readonly cwdRules: CwdRules;
  /** `$AGENTSWITCH_HOME`: where the settings and the update request and result files are. */
  readonly home?: string;
  /** The AgentSwitch.app this daemon runs from (the Mac app passes it); absent outside the app: no updates. */
  readonly appBundle?: string;
  /** Tests: the SSE heartbeat period (default SSE_HEARTBEAT_MS). */
  readonly sseHeartbeatMs?: number;
  /** How often a record's stream looks at the session's file (tests: sooner). */
  readonly recordWatchMs?: number;
  /** Whether a paired node may send keystrokes as they are (docs/mesh-v0.md §10); absent = no. */
  readonly remoteKeyboard?: () => boolean;
  /** The Files column's reads of this node's disk (docs/files-v0.md §7); absent = no `/files…`, and a reply's `{path}`
   *  is this node's own screens' alone. */
  readonly fileAccess?: import("./browse.js").FileAccess;
};

/** A request body's issues; an issue on the body itself reads "body: ...". */
export const issues = (err: z.ZodError): string => zodIssues(err, { root: "body" });

/** Parse a JSON body against a schema; a missing or malformed body validates as `{}`. */
export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const raw = await c.req.json().catch(() => ({}));
  const r = schema.safeParse(raw);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: issues(r.error) };
}

/** `?limit=` clamped to a sane range; garbage → the default. */
export function limitParam(c: Context, fallback: number, max = MAX_LIST_LIMIT): number {
  const n = Number(c.req.query("limit") ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
}

/** Characters of the content's hash that make a list's version. */
const VERSION_CHARS = 27;

/** A list a screen asks for again and again, under a version of its content (`ETag`): asked for with the version it
 *  already has (`If-None-Match`), an unchanged list is a 304 with no body, so it is not sent, decoded and compared for
 *  nothing. Without the header the answer is what `c.json` gives, plus the version. */
export function versionedJson(c: Context, value: unknown): Response {
  const body = JSON.stringify(value);
  const version = `"${createHash("sha256").update(body).digest("base64url").slice(0, VERSION_CHARS)}"`;
  if (c.req.header("if-none-match") === version) return c.body(null, 304, { ETag: version });
  return c.body(body, 200, { "Content-Type": "application/json", ETag: version });
}
