/** HTTP API. The phone is just another client of these routes; the CLI uses the same ones. */

import { Hono } from "hono";
import { mountBrowser, mountProfileBrowsers } from "./browser.js";
import { mountBrowserEngine } from "./browserEngine.js";
import { mountBrowserIdentity } from "./browserIdentity.js";
import { mountUpdate } from "./update.js";
import { mountBrowse } from "./browse.js";
import { mountFileChanges } from "./fileChanges.js";
import { mountFiles } from "./files.js";
import { mountLive } from "./live.js";
import { mountSessions } from "./sessions.js";
import { mountSettings } from "./settings.js";
import { type ApiDeps } from "./shared.js";
import { mountTerminals } from "./terminals.js";
import { mountProfiles } from "./profiles.js";
import { mountAddons } from "./addons.js";
import { mountClash } from "./clash.js";
import { mountAgentsBoard } from "./agentsBoard.js";
import { mountPasswords } from "./passwords.js";
import { mountRedaction } from "./redaction.js";
import { mountRooms } from "./rooms.js";
import { mountDispatchDesk } from "./dispatchDesk.js";
import { mountUi, uiFile } from "./ui.js";

export type { ApiDeps } from "./shared.js";
export { uiFile };

export function createApp(deps: ApiDeps): Hono {
  const app = new Hono();
  mountUi(app);
  mountSettings(app, deps);
  mountUpdate(app, deps);
  mountFiles(app, deps);
  if (deps.fileAccess) { mountBrowse(app, deps.fileAccess); mountFileChanges(app, deps.fileAccess); }
  mountSessions(app, deps);
  mountTerminals(app, deps);
  mountProfiles(app, deps);
  mountAddons(app, deps);
  mountClash(app, deps);
  mountAgentsBoard(app);
  mountRooms(app, deps);
  mountRedaction(app, deps);
  mountPasswords(app, deps);
  mountDispatchDesk(app, deps);
  mountBrowser(app, deps);
  mountProfileBrowsers(app, deps);
  mountBrowserEngine(app, deps);
  mountBrowserIdentity(app, deps);
  mountLive(app, deps);
  return app;
}
