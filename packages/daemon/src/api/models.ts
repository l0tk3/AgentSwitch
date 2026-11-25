/** Model settings for the Mac app (app-v0 §2 模型设置, local only): GET shows the router (dispatch) model and every
 *  harness's models as they will be after the next start; PUT checks a router model against the catalog and writes it
 *  to $AGENTSWITCH_HOME/models.json. The running daemon keeps its catalog; the Mac app restarts it. The dispatch model
 *  is the only model setting: the separate default executor/model was removed on 2026-11-23 (user decision, pending a
 *  redesign). GET still returns `default`, equal to the router target, for older Mac apps; PUT refuses it. */

import type { Hono } from "hono";
import { applyModelOverlay, ModelOverlayChange, modelSettings, overlayProblems, readModelOverlay, writeModelOverlay } from "../models/modelOverlay.js";
import type { Targets } from "../models/targets.js";
import { issues, type ApiDeps } from "./shared.js";

/** The router model: the only thing the overlay changes (the fallback target follows it). */
const selection = (t: Targets): string => t.router.model;

export function mountModelSettings(app: Hono, deps: ApiDeps): void {
  /** targets.yaml after discovery, before the overlay; the running catalog when the daemon was built without one. */
  const base = (): Targets => deps.models?.base ?? deps.targets;
  const pending = (): Targets => {
    const read = deps.models ? readModelOverlay(deps.models.path) : { overlay: null };
    return applyModelOverlay(base(), read.overlay ?? {}).targets;
  };

  app.get("/settings/models", (c) => {
    const next = pending();
    return c.json({ ...modelSettings(next), restartRequired: selection(next) !== selection(deps.targets) });
  });

  app.put("/settings/models", async (c) => {
    if (!deps.models) return c.json({ error: "model settings file not configured" }, 503);
    const raw: unknown = await c.req.json().catch(() => ({}));
    if (raw && typeof raw === "object" && "default" in raw) {
      return c.json({ error: "default is no longer a setting (removed 2026-11-23): tasks the dispatch model cannot place run on the dispatch model itself; send router only" }, 400);
    }
    const body = ModelOverlayChange.safeParse(raw);
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    const problems = overlayProblems(base(), body.data);
    if (problems.length) return c.json({ error: problems.join("; ") }, 400);
    writeModelOverlay(deps.models.path, body.data);
    return c.json({ restartRequired: true });
  });
}
