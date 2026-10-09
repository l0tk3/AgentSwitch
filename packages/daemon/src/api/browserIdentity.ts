/** The browser's identity over the API (docs/browser-v0.md §7.2 第 5 条): the fingerprint and the proxy. A paired
 *  phone has the proxy (§7.5): it is told the fingerprint in a line, not its text, and changes none. A fingerprint
 *  takes a restart of the browser (its tabs come back); a proxy is in force at once, but the time zone of its exit
 *  only from the browser's next start (`restartNeeded`, `POST /browser/identity/restart`). A profile's own browser
 *  (`shared: false`) keeps its identity to this Mac: its proxy is its profile's, set where the profile is. */

import type { Context, Hono } from "hono";
import { z } from "zod";
import { FillRefused } from "../browser/fill.js";
import { IdentityError } from "../browser/identity.js";
import { remoteCaller } from "../core/caller.js";
import { parseBody, type ApiDeps } from "./shared.js";

const Put = z.object({
  fingerprint: z.union([z.literal("new"), z.object({ config: z.record(z.string(), z.unknown()) })]).optional(),
  /** `keepPassword`: no password is sent because the one stored stays. */
  proxy: z.object({ server: z.string().min(1).max(300), username: z.string().max(200).optional(), password: z.string().max(4000).optional(), keepPassword: z.boolean().optional() }).nullable().optional(),
}).refine((v) => v.fingerprint !== undefined || v.proxy !== undefined, { message: "nothing to change" });

export function mountBrowserIdentity(app: Hono, deps: ApiDeps, o: { readonly shared: boolean } = { shared: true }): void {
  const browser = deps.browser;
  const identity = browser?.identity;
  if (!browser || !identity) return;
  if (!o.shared) {
    app.use("/browser/identity/*", async (c, next) => (remoteCaller(c.env) ? c.json({ error: "not available from a paired device" }, 403) : next()));
    app.use("/browser/identity", async (c, next) => (remoteCaller(c.env) ? c.json({ error: "not available from a paired device" }, 403) : next()));
  }
  /** The identity as its caller may have it: a phone without the fingerprint's text. */
  const view = (c: Context) => {
    const all = identity.view({ running: browser.host.running });
    if (!remoteCaller(c.env)) return all;
    const { config: _text, ...fingerprint } = all.fingerprint;
    return { ...all, fingerprint };
  };
  app.get("/browser/identity", (c) => c.json(view(c)));
  /** The browser again with what it would be given now (a time zone that changed with the proxy); its tabs come back. */
  app.post("/browser/identity/restart", async (c) => {
    if (browser.host.running) await browser.host.restart();
    return c.json(view(c));
  });
  app.put("/browser/identity", async (c) => {
    const body = await parseBody(c, Put);
    if (!body.ok) return c.json({ error: body.error }, 400);
    if (remoteCaller(c.env) && body.data.fingerprint !== undefined) return c.json({ error: "a fingerprint is changed on the Mac" }, 403);
    try {
      if (body.data.proxy !== undefined) await identity.setProxy(body.data.proxy, { keepPassword: body.data.proxy?.keepPassword });
      if (body.data.fingerprint !== undefined) {
        await identity.setFingerprint(body.data.fingerprint);
        // In force when the browser starts: now, with its tabs brought back.
        if (browser.host.running) await browser.host.restart();
      }
    } catch (err) {
      if (err instanceof IdentityError) return c.json({ error: err.message }, 400);
      if (err instanceof FillRefused) return c.json({ error: err.message }, 403);
      throw err;
    }
    return c.json(view(c));
  });
}
