/** `agentswitch config` started: the screen drawn on the terminal's alternate screen (what was there before comes back
 *  when it is left), until Q or Ctrl+C. */

import { render } from "ink";
import type { Locale } from "../i18n/index.js";
import { ConfigApp, PAGES, type PageId } from "./app.js";
import type { ConfigDeps } from "./deps.js";

export async function runConfig(deps: ConfigDeps, locale: Locale, page?: string): Promise<number> {
  const first = PAGES.find((p) => p === page) as PageId | undefined;
  const app = render(<ConfigApp deps={deps} locale={locale} {...(first ? { page: first } : {})} />, { alternateScreen: true, exitOnCtrlC: true });
  await app.waitUntilExit();
  return 0;
}
