/** Local-only management of remote access (app-v0 §2): POST /pairing, GET /devices, DELETE /devices/:id,
 *  GET /remote/info. Mounted on the 127.0.0.1 listener only; the remote allowlist never lists them. */

import type { Hono } from "hono";
import type { Store } from "../engine/store.js";
import { pairPayload, bonjourName } from "./pairing.js";
import type { RemoteRuntime } from "./runtime.js";

export type RemoteAdminDeps = {
  readonly store: Store;
  /** Null when AGENTSWITCH_REMOTE is off: devices can still be listed and revoked, but nothing can pair. */
  readonly remote: RemoteRuntime | null;
  readonly now?: () => number;
};

export function mountRemoteAdmin<A extends Hono>(app: A, deps: RemoteAdminDeps): A {
  const now = deps.now ?? Date.now;
  const online = () => deps.remote ? deps.remote.presence.online(deps.store.listDevices(), now()) : [];

  app.post("/pairing", async (c) => {
    const remote = deps.remote;
    if (!remote) return c.json({ error: "remote access is off; start the daemon with AGENTSWITCH_REMOTE=1" }, 409);
    const [addresses, gate] = await Promise.all([remote.addresses(), remote.gateKey()]);
    const { code, expiresAt } = remote.pairing.issue();
    const { payload, link } = pairPayload({ name: remote.name, port: remote.port, fp: remote.tls.fingerprint, code, lan: addresses.lan, tailnet: addresses.tailnet, gate });
    return c.json({ code, expiresAt, link, payload });
  });

  app.get("/devices", (c) => {
    const live = new Set(online().map((d) => d.id));
    return c.json(deps.store.listDevices().map((d) => ({ ...d, online: live.has(d.id) })));
  });

  app.delete("/devices/:id", (c) => {
    const device = deps.store.revokeDevice(c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    deps.remote?.presence.disconnect(device.id);
    return c.json({ ok: true, device });
  });

  app.get("/remote/info", async (c) => {
    const remote = deps.remote;
    if (!remote) return c.json({ enabled: false, port: null, fingerprint: null, name: null, bonjour: null, lan: [], tailnet: [], onlineDevices: 0 });
    const addresses = await remote.addresses();
    return c.json({ enabled: true, port: remote.port, fingerprint: remote.tls.fingerprint, name: remote.name, bonjour: bonjourName(remote.name), lan: addresses.lan, tailnet: addresses.tailnet, onlineDevices: online().length });
  });
  return app;
}
