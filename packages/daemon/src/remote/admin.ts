/** Local-only management of remote access (app-v0 §2): POST /pairing, GET /devices, DELETE /devices/:id,
 *  GET /remote/info, and what of this node's files each device may read (`PUT /devices/:id/files`, docs/files-v0.md
 *  §7.5). Mounted on the 127.0.0.1 listener only; the remote allowlist never lists them. */

import type { Hono } from "hono";
import { statSync } from "node:fs";
import { z } from "zod";
import { canonicalPath } from "../core/paths.js";
import type { Devices } from "./deviceStore.js";
import { askedPath, MAX_SCOPE_FOLDERS, type FileScope } from "../files/browse.js";
import { pairPayload, bonjourName } from "./pairing.js";
import type { RemoteRuntime } from "./runtime.js";

export type RemoteAdminDeps = {
  readonly store: Devices;
  /** Null when AGENTSWITCH_REMOTE is off: devices can still be listed and revoked, but nothing can pair. */
  readonly remote: RemoteRuntime | null;
  /** A device was revoked here: it may have been another node's (nodes/nodes.ts). */
  readonly onRevoke?: (deviceId: string) => void;
  /** Each device's reach on this node's files (nodes/settings.ts); absent = not told, not set. */
  readonly fileScopes?: { readonly get: (deviceId: string) => FileScope; readonly set: (deviceId: string, scope: FileScope | null) => void };
  readonly now?: () => number;
};

const ScopeBody = z.object({ mode: z.enum(["home", "all", "folders", "none"]), folders: z.array(z.string().min(1).max(4096)).max(MAX_SCOPE_FOLDERS).optional() });

export function mountRemoteAdmin<A extends Hono>(app: A, deps: RemoteAdminDeps): A {
  const now = deps.now ?? Date.now;
  const online = () => deps.remote ? deps.remote.presence.online(deps.store.listDevices(), now()) : [];

  app.post("/pairing", async (c) => {
    const remote = deps.remote;
    if (!remote) return c.json({ error: "remote access is off; start the daemon with AGENTSWITCH_REMOTE=1" }, 409);
    const [addresses, gate] = await Promise.all([remote.addresses(), remote.gateKey()]);
    // `{back: false}`: whoever redeems this code is not used in return (docs/mesh-v0.md §2.2); the default is both ways.
    const asked = await c.req.json().catch(() => null) as { back?: unknown } | null;
    const { code, expiresAt } = remote.pairing.issue({ back: asked?.back !== false });
    const { payload, link } = pairPayload({ name: remote.name, port: remote.port, fp: remote.tls.fingerprint, code, lan: addresses.lan, tailnet: addresses.tailnet, gate });
    return c.json({ code, expiresAt, link, payload });
  });

  app.get("/devices", (c) => {
    const live = new Set(online().map((d) => d.id));
    const scopes = deps.fileScopes;
    return c.json(deps.store.listDevices().map((d) => ({ ...d, online: live.has(d.id), ...(scopes ? { files: scopes.get(d.id) } : {}) })));
  });

  app.delete("/devices/:id", (c) => {
    const device = deps.store.revokeDevice(c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    deps.remote?.presence.disconnect(device.id);
    deps.onRevoke?.(device.id);
    deps.fileScopes?.set(device.id, null);
    return c.json({ ok: true, device });
  });

  // A device's reach on this node's files: its home folder (the default), all, some folders, none. The folders are
  // kept as they really are, and must be folders that are there.
  app.put("/devices/:id/files", async (c) => {
    const scopes = deps.fileScopes;
    if (!scopes) return c.json({ error: "not found" }, 404);
    const device = deps.store.getDevice(c.req.param("id"));
    if (!device || device.revokedAt !== null) return c.json({ error: "not found" }, 404);
    const body = ScopeBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "bad scope" }, 400);
    let scope: FileScope = { mode: body.data.mode };
    if (body.data.mode === "folders") {
      const folders: string[] = [];
      for (const raw of body.data.folders ?? []) {
        const p = askedPath(raw, process.env.HOME ?? "/");
        let isDir = false;
        try { isDir = p !== null && statSync(p).isDirectory(); } catch { isDir = false; }
        if (!p || !isDir) return c.json({ error: `not a folder: ${raw}` }, 400);
        const real = canonicalPath(p);
        if (!folders.includes(real)) folders.push(real);
      }
      scope = { mode: "folders", folders };
    }
    scopes.set(device.id, scope);
    return c.json({ ok: true, files: scopes.get(device.id) });
  });

  app.get("/remote/info", async (c) => {
    const remote = deps.remote;
    if (!remote) return c.json({ enabled: false, port: null, fingerprint: null, name: null, bonjour: null, lan: [], tailnet: [], onlineDevices: 0 });
    const addresses = await remote.addresses();
    return c.json({ enabled: true, port: remote.port, fingerprint: remote.tls.fingerprint, name: remote.name, bonjour: bonjourName(remote.name), lan: addresses.lan, tailnet: addresses.tailnet, onlineDevices: online().length });
  });
  return app;
}
