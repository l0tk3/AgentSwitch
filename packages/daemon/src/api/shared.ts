/** Shared by every route module: dependencies, body parsing, error text. */

import type { Assistant } from "../assistant/assistant.js";
import type { Sealer } from "../secrets/sealer.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import type { z } from "zod";
import type { Bus } from "../engine/bus.js";
import type { Engine } from "../engine/engine.js";
import type { Store } from "../engine/store.js";
import type { Extensions } from "../extensions/index.js";
import type { Uploads } from "../files/uploads.js";
import type { QuotaService } from "../quota/index.js";
import type { RoutingLog } from "../router/log.js";
import type { RouteDeps } from "../router/route.js";
import type { Targets } from "../router/targets.js";
import { zodIssues } from "../util/zod.js";
import type { CwdRules } from "./cwdPolicy.js";
import type { SessionMonitor } from "../sessions/monitor.js";
import type { SharedBrowser } from "../browser/setup.js";
import type { Terminals } from "./terminals.js";

/** The most rows a `?limit=` may ask for. */
const MAX_LIST_LIMIT = 500;

export type ApiDeps = {
  /** Turns plaintext credentials in a submission into tokens before anything is stored (router-v0 §9); absent in echo mode. */
  readonly sealer?: Sealer;
  readonly store: Store;
  readonly bus: Bus;
  readonly engine: Engine;
  readonly targets: Targets;
  readonly quota: QuotaService;
  readonly routingLog: RoutingLog;
  readonly routeDeps: () => RouteDeps;
  readonly contextPath: string;
  readonly memoryPath: string;
  readonly platformMemoryPath?: string;
  readonly policyPath: string;
  readonly workRoot: string;
  /** The default work folder in force (docs/control-v0.md §2); absent = throw-away folders under `workRoot`. */
  readonly taskFolderRoot?: () => string;
  /** The Mac's coding sessions (docs/control-v0.md §3); absent = not watched. */
  readonly sessions?: SessionMonitor;
  /** AgentSwitch's own terminals, the manual entry (docs/terminal-v0.md); absent = off. */
  readonly terminals?: Terminals;
  /** The shared browser (docs/browser-v0.md); absent = off. */
  readonly browser?: SharedBrowser;
  readonly uploads: Uploads;
  readonly artifactsDir: string;
  readonly extensions: Extensions;
  readonly version: string;
  readonly cwdRules: CwdRules;
  /** `$AGENTSWITCH_HOME`: where the update request and result files are (assistant-v0 §5). */
  readonly home?: string;
  /** The AgentSwitch.app this daemon runs from (the Mac app passes it); absent outside the app: no updates. */
  readonly appBundle?: string;
  /** Model settings (app-v0 §2): the overlay file and the catalog it applies to (targets.yaml after discovery). */
  readonly models?: { readonly path: string; readonly base: Targets };
  /** Tests: the SSE heartbeat period (default SSE_HEARTBEAT_MS). */
  readonly sseHeartbeatMs?: number;
  /** How often a record's stream looks at the session's file (tests: sooner). */
  readonly recordWatchMs?: number;
  /** The router as the user's assistant (assistant-v0 §1.1). */
  readonly assistant?: Assistant;
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

export function newWorkDir(root: string): string {
  const dir = join(root, randomUUID().slice(0, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}
