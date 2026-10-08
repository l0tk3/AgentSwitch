/** HTTP API. The phone is just another client of these routes; the CLI uses the same ones. */

import { Hono } from "hono";
import { mountAssistant } from "./assistant.js";
import { mountBrowser } from "./browser.js";
import { mountBrowserEngine } from "./browserEngine.js";
import { mountBrowserIdentity } from "./browserIdentity.js";
import { mountUpdate } from "./update.js";
import { mountExtensions } from "./extensions.js";
import { mountFiles } from "./files.js";
import { mountLive } from "./live.js";
import { mountModelSettings } from "./models.js";
import { mountSessions } from "./sessions.js";
import { mountSettings } from "./settings.js";
import { type ApiDeps } from "./shared.js";
import { mountTasks } from "./tasks.js";
import { mountTerminals } from "./terminals.js";
import { mountProfiles } from "./profiles.js";
import { mountClash } from "./clash.js";
import { mountThreads } from "./threads.js";
import { mountUi, uiFile } from "./ui.js";

export type { ApiDeps } from "./shared.js";
export { uiFile };

export function createApp(deps: ApiDeps): Hono {
  const app = new Hono();
  mountUi(app);
  mountSettings(app, deps);
  mountUpdate(app, deps);
  mountModelSettings(app, deps);
  mountTasks(app, deps);
  mountAssistant(app, deps);
  mountFiles(app, deps);
  mountThreads(app, deps);
  mountSessions(app, deps);
  mountTerminals(app, deps);
  mountProfiles(app, deps);
  mountClash(app, deps);
  mountBrowser(app, deps);
  mountBrowserEngine(app, deps);
  mountBrowserIdentity(app, deps);
  mountLive(app, deps);
  mountExtensions(app, deps.extensions);
  return app;
}
