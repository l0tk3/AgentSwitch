/** Shared by every route module: dependencies, body parsing, error text. */

import { randomUUID } from "node:crypto";
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

export type ApiDeps = {
  readonly store: Store;
  readonly bus: Bus;
  readonly engine: Engine;
  readonly targets: Targets;
  readonly quota: QuotaService;
  readonly routingLog: RoutingLog;
  readonly routeDeps: () => RouteDeps;
  readonly contextPath: string;
  readonly memoryPath: string;
  readonly policyPath: string;
  readonly workRoot: string;
  readonly uploads: Uploads;
  readonly artifactsDir: string;
  readonly extensions: Extensions;
  readonly version: string;
};

export const issues = (err: z.ZodError): string => err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

/** Parse a JSON body against a schema; a missing or malformed body validates as `{}`. */
export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const raw = await c.req.json().catch(() => ({}));
  const r = schema.safeParse(raw);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: issues(r.error) };
}

export function newWorkDir(root: string): string {
  const dir = join(root, randomUUID().slice(0, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}
