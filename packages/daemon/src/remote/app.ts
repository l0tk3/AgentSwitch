/** The remote listener's request pipeline (app-v0 §2): source check again per request, the route allowlist (else 404),
 *  GET /healthz and POST /pair without a token, then a device token for everything else. GET /me and GET /gate/pubkey
 *  are answered here; every other allowed route goes to the local API unchanged, SSE included, with the device marked in
 *  the env (core/caller.ts). */

import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { markRemote } from "../core/caller.js";
import type { Store } from "../engine/store.js";
import type { Device } from "../engine/types.js";
import { isAllowedSource, normalizeAddress } from "./address.js";
import { authenticate, registerDevice, type Presence } from "./devices.js";
import type { GateKeyReader } from "./gateKey.js";
import type { PairingDesk } from "./pairing.js";
import { remoteAllowed } from "./routes.js";

/** POST /pair bodies are three short strings. */
const PAIR_BODY_BYTES = 4096;
const MAX_NAME_CHARS = 64;
const MAX_PLATFORM_CHARS = 32;
const MAX_CODE_CHARS = 32;

/** Every failed pairing looks the same: wrong code, expired, already used, voided, malformed body. */
export const PAIR_FAILED = { error: "pairing failed" } as const;
export const UNAUTHORIZED = { error: "unauthorized" } as const;

const NO_CONTROL = /^[^\p{Cc}\p{Cf}]*$/u;
const PairBody = z.object({
  code: z.string().min(1).max(MAX_CODE_CHARS),
  name: z.string().trim().min(1).max(MAX_NAME_CHARS).regex(NO_CONTROL),
  platform: z.string().trim().min(1).max(MAX_PLATFORM_CHARS).regex(NO_CONTROL),
});

export type RemoteAppDeps = {
  readonly store: Store;
  readonly pairing: PairingDesk;
  readonly presence: Presence;
  readonly gateKey: GateKeyReader;
  /** The local API (without its local-only management routes); allowed routes not answered here go to it. */
  readonly local: { readonly fetch: (request: Request, env?: HttpBindings) => Response | Promise<Response> };
  /** Source predicate, the same one the connection hook uses; tests may narrow it. */
  readonly allowSource?: (address: string | undefined) => boolean;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
};

type Env = { Bindings: HttpBindings; Variables: { device: Device } };

export function createRemoteApp(deps: RemoteAppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const now = deps.now ?? Date.now;
  const allow = deps.allowSource ?? isAllowedSource;
  const log = deps.log ?? console.error;
  const peer = (env: HttpBindings | undefined): string | undefined => env?.incoming?.socket?.remoteAddress;

  app.onError((err, c) => {
    log(`remote ${c.req.method} ${c.req.path}: ${err.message}`);
    return c.json({ error: "internal error" }, 500);
  });

  app.use("*", async (c, next) => {
    if (!allow(peer(c.env))) return c.json({ error: "forbidden" }, 403);
    if (!remoteAllowed(c.req.method, c.req.path)) return c.json({ error: "not found" }, 404);
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post("/pair", bodyLimit({ maxSize: PAIR_BODY_BYTES, onError: (c) => c.json(PAIR_FAILED, 401) }), async (c) => {
    const source = normalizeAddress(peer(c.env))?.address ?? "unknown";
    if (deps.pairing.limited(source)) return c.json({ error: "too many pairing attempts; wait a minute" }, 429, { "Retry-After": "60" });
    const body = PairBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success || deps.pairing.redeem(body.data.code) !== "ok") return c.json(PAIR_FAILED, 401);
    const { device, token } = registerDevice(deps.store, { name: body.data.name, platform: body.data.platform });
    log(`remote: paired device ${device.id} "${device.name}" (${device.platform}) from ${source}`);
    return c.json({ deviceId: device.id, token });
  });

  app.use("*", async (c, next) => {
    const device = authenticate(deps.store, c.req.header("authorization"), now());
    if (!device) return c.json(UNAUTHORIZED, 401, { "WWW-Authenticate": 'Bearer realm="agentswitch"' });
    c.set("device", device);
    const out = c.env?.outgoing;
    const leave = deps.presence.enter(device.id, () => out?.destroy());
    if (out) out.once("close", leave);
    else leave();
    await next();
  });

  app.get("/me", (c) => {
    const d = c.get("device");
    return c.json({ deviceId: d.id, name: d.name, platform: d.platform });
  });

  app.get("/gate/pubkey", async (c) => {
    const key = await deps.gateKey();
    return key ? c.json(key) : c.json({ error: "secret-gate public key unavailable" }, 503);
  });

  // The mark lets the API hold a phone to the Mac's decisions (no approval override, no cwd; see api/tasks.ts, api/threads.ts).
  // Every write from a phone leaves a line in the daemon log, deletes and CONTEXT.md saves included (app-v0 §6).
  app.all("*", async (c) => {
    const device = c.get("device");
    const res = await deps.local.fetch(c.req.raw, markRemote(c.env, { deviceId: device.id }));
    if (c.req.method !== "GET") log(`remote: device ${device.id} ${c.req.method} ${c.req.path} → ${res.status}`);
    return res;
  });
  return app;
}
