/** Model settings for the Mac app (app-v0 §2 模型设置, local only): GET shows the router model, the default target and
 *  every harness's models as they will be after the next start; PUT checks a change against the catalog and merges it
 *  into $AGENTSWITCH_HOME/models.json. The running daemon keeps its catalog; the Mac app restarts it. */

import type { Hono } from "hono";
import { applyModelOverlay, ModelOverlay, modelSettings, overlayProblems, readModelOverlay, writeModelOverlay } from "../router/modelOverlay.js";
import type { Targets } from "../router/targets.js";
import { issues, type ApiDeps } from "./shared.js";

/** Router model and default target: the only two things the overlay changes. */
const selection = (t: Targets): string => JSON.stringify([t.router.model, t.router.default.harness, t.router.default.model]);

export function mountModelSettings(app: Hono, deps: ApiDeps): void {
  /** targets.yaml after discovery, before the overlay; the running catalog when the daemon was built without one. */
  const base = (): Targets => deps.models?.base ?? deps.targets;
  const pending = (): Targets => {
    const read = deps.models ? readModelOverlay(deps.models.path) : { overlay: null };
    return read.overlay ? applyModelOverlay(base(), read.overlay).targets : base();
  };

  app.get("/settings/models", (c) => {
    const next = pending();
    return c.json({ ...modelSettings(next), restartRequired: selection(next) !== selection(deps.targets) });
  });

  app.put("/settings/models", async (c) => {
    if (!deps.models) return c.json({ error: "model settings file not configured" }, 503);
    const body = ModelOverlay.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    if (!body.data.router && !body.data.default) return c.json({ error: "router or default required" }, 400);
    const problems = overlayProblems(base(), body.data);
    if (problems.length) return c.json({ error: problems.join("; ") }, 400);
    const current = readModelOverlay(deps.models.path).overlay ?? {};
    writeModelOverlay(deps.models.path, { ...current, ...body.data });
    return c.json({ restartRequired: true });
  });
}
