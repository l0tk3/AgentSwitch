/** The remote listener's request pipeline (app-v0 §2): source check again per request, the route allowlist (else 404),
 *  GET /healthz and POST /pair without a token, then a device token for everything else. GET /me and GET /gate/pubkey
 *  are answered here; every other allowed route goes to the local API unchanged, SSE included, with the device marked in
 *  the env (core/caller.ts).
 *
 *  A paired device may be a phone or another node (docs/mesh-v0.md): the rules are the same for both. A node that pairs
 *  can offer itself in return (`back` in POST /pair), `GET /node` says what this node is and has, and `DELETE /me` is
 *  a device removing itself. */

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
import { PairPayloadSchema, type PairingDesk, type PairPayload } from "./pairing.js";
import { RemoteRequestLog } from "./requestLog.js";
import { remoteAllowed } from "./routes.js";

/** POST /pair bodies are three short strings and, from a node, its own payload for the way back. */
const PAIR_BODY_BYTES = 8192;
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
  back: PairPayloadSchema.optional(),
});

/** What the remote side needs of this node's place among the others (nodes/nodes.ts). */
export type RemoteNodes = {
  /** What this node is and has (`GET /node`). */
  info(): object;
  /** Take the way back a pairing node offers; `inbound` is the device it just became here. */
  pairBack(payload: PairPayload, source: string | null, inbound: string): Promise<"paired" | "failed">;
  /** A ticket this node sent with its own pairing was redeemed by `deviceId`. */
  ticketUsed(code: string, deviceId: string): void;
  /** A device here removed itself. */
  inboundGone(deviceId: string): void;
};

export type RemoteAppDeps = {
  readonly store: Store;
  readonly pairing: PairingDesk;
  readonly presence: Presence;
  readonly gateKey: GateKeyReader;
  /** The Mac's addresses now (LAN, Tailscale): a phone keeps its copy from pairing up to date with them. */
  readonly addresses?: () => Promise<{ readonly lan: readonly string[]; readonly tailnet: readonly string[] }>;
  /** The local API (without its local-only management routes); allowed routes not answered here go to it. */
  readonly local: { readonly fetch: (request: Request, env?: HttpBindings) => Response | Promise<Response> };
  /** Source predicate, the same one the connection hook uses; tests may narrow it. */
  readonly allowSource?: (address: string | undefined) => boolean;
  /** Absent: this node keeps no other nodes (tests); a way back is not taken and `GET /node` is not answered. */
  readonly nodes?: RemoteNodes;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
};

type Env = { Bindings: HttpBindings; Variables: { device: Device } };

export function createRemoteApp(deps: RemoteAppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const now = deps.now ?? Date.now;
  const allow = deps.allowSource ?? isAllowedSource;
  const log = deps.log ?? console.error;
  const writes = new RemoteRequestLog(log);
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
    const taken = body.success ? deps.pairing.take(body.data.code) : null;
    if (!body.success || !taken) return c.json(PAIR_FAILED, 401);
    const { device, token } = registerDevice(deps.store, { name: body.data.name, platform: body.data.platform });
    log(`remote: paired device ${device.id} "${device.name}" (${device.platform}) from ${source}`);
    // A ticket is this node's own way back being taken: nothing more to offer. The code on the screen, redeemed by a
    // node that offers itself in return, makes the pair go both ways unless the code was issued one-way.
    if (taken.kind === "ticket") { deps.nodes?.ticketUsed(body.data.code, device.id); return c.json({ deviceId: device.id, token }); }
    const offered = body.data.back;
    if (!offered) return c.json({ deviceId: device.id, token });
    const back = taken.back && deps.nodes ? await deps.nodes.pairBack(offered, source === "unknown" ? null : source, device.id).catch(() => "failed" as const) : "declined";
    return c.json({ deviceId: device.id, token, back });
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

  /** A device removing itself (docs/mesh-v0.md §2.4): what "remove this node" on the other side ends with, so no device
   *  that will never come back stays in this node's list. Its other open requests are cut once this one is answered. */
  app.delete("/me", (c) => {
    const d = c.get("device");
    deps.store.revokeDevice(d.id);
    deps.nodes?.inboundGone(d.id);
    log(`remote: device ${d.id} "${d.name}" removed itself`);
    const out = c.env?.outgoing;
    if (out) out.once("finish", () => deps.presence.disconnect(d.id));
    // The connection ends with the device: a node keeps its sockets open between requests and must not send the next
    // one down this one.
    return c.json({ ok: true }, 200, { connection: "close" });
  });

  app.get("/node", (c) => (deps.nodes ? c.json(deps.nodes.info()) : c.json({ error: "not found" }, 404)));

  /** Where the Mac can be reached now (2026-09-26: a phone paired before Tailscale was detected had no tailnet address
   *  and could not connect off the LAN). Separate from /me, which every probe calls: the Tailscale CLI takes seconds. */
  app.get("/addresses", async (c) => {
    const found = deps.addresses ? await deps.addresses().catch(() => null) : null;
    return found ? c.json({ lan: found.lan, tailnet: found.tailnet }) : c.json({ error: "addresses unavailable" }, 503);
  });

  app.get("/gate/pubkey", async (c) => {
    const key = await deps.gateKey();
    return key ? c.json(key) : c.json({ error: "secret-gate public key unavailable" }, 503);
  });

  // The mark lets the API hold a phone to the Mac's decisions (no approval override, no cwd; see api/tasks.ts, api/threads.ts).
  // Every write from a phone leaves a line in the daemon log, deletes and CONTEXT.md saves included (app-v0 §6).
  // Typing, scrolling and resizing are a line a minute each (requestLog.ts).
  app.all("*", async (c) => {
    const device = c.get("device");
    const res = await deps.local.fetch(c.req.raw, markRemote(c.env, { deviceId: device.id }));
    if (c.req.method !== "GET") {
      // A refusal with what the service said of it (its own words: no request body, no credential): "→ 409" alone
      // did not say which of the half-dozen refusals of a resume it was (2026-11-22).
      let why: string | undefined;
      if (res.status >= 400 && (res.headers.get("content-type") ?? "").includes("json")) {
        try { const said = (await res.clone().json() as { error?: unknown }).error; if (typeof said === "string") why = said; } catch { /* no reason to tell */ }
      }
      writes.write(device.id, c.req.method, c.req.path, res.status, why);
    }
    return res;
  });
  return app;
}
