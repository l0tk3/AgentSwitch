/** A staged AgentSwitch.app and the user's go-ahead to install it (assistant-v0 §5). Both the Mac and the phone may look
 *  and confirm: installing is the user's decision wherever they are. The Mac app does the swap and the fallback. */

import type { Hono } from "hono";
import { remoteCaller } from "../core/caller.js";
import { lastResult, requestInstall, updateState } from "../files/appUpdate.js";
import type { ApiDeps } from "./shared.js";

export function mountUpdate(app: Hono, deps: ApiDeps): void {
  app.get("/update", (c) => {
    const state = updateState(deps.appBundle);
    return c.json({ running: state?.running.built ?? null, staged: state?.staged?.built ?? null, last: deps.home ? lastResult(deps.home) : null });
  });

  app.post("/update/install", (c) => {
    const state = updateState(deps.appBundle);
    if (!state || !deps.home) return c.json({ error: "this daemon does not run from AgentSwitch.app" }, 409);
    if (!state.staged) return c.json({ error: "no newer version is waiting to be installed" }, 409);
    const caller = remoteCaller(c.env);
    requestInstall(deps.home, caller ? `device ${caller.deviceId}` : "mac", Date.now());
    return c.json({ requested: true, staged: state.staged.built }, 202);
  });
}
