/** The browser engine's routes (docs/browser-v0.md §7.2 第 6 条), for the Mac app and the command line; not for paired
 *  phones (they are not on the remote list). Absent when the service has no engine kit. */

import type { Hono } from "hono";
import { z } from "zod";
import { parseBody, type ApiDeps } from "./shared.js";

const Update = z.object({
  camoufox: z.string().min(1).max(64).optional(),
  playwright: z.string().min(1).max(64).optional(),
  prerelease: z.boolean().optional(),
});

export function mountBrowserEngine(app: Hono, deps: ApiDeps): void {
  const kit = deps.engineKit;
  if (!kit) return;
  // `?check=1` asks GitHub what could be installed first; without it, what is known.
  app.get("/browser/engine", async (c) => c.json(c.req.query("check") ? await kit.check({ prerelease: c.req.query("prerelease") === "1" }) : kit.status()));
  app.post("/browser/engine/update", async (c) => {
    const body = await parseBody(c, Update);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const answer = await kit.update(body.data);
    return answer.ok ? c.json({ ok: true, ...kit.status() }, 202) : c.json({ error: answer.error }, answer.status);
  });
  app.post("/browser/engine/cancel", (c) => {
    kit.cancel();
    return c.json({ ok: true });
  });
}
