/** OpenCode's models with their variants (its models' thinking levels), for the terminals' menus (models/modelOffers.ts):
 *  asked of an `opencode serve --stdio` started for the question and stopped after it. (Until 2026-11-25 the old
 *  Dispatch's resident executor server answered it; no server of ours stays up now.) The server's environment has no
 *  proxy, as that one's had none. */

import { mkdirSync } from "node:fs";
import { openCodeVariants } from "../harness/efforts.js";
import { basicAuth, startStdioServe, stopStdioServe } from "../harness/opencodeStdio.js";
import { stripProxy } from "../util/env.js";
import { sleep } from "../util/sleep.js";

const CALL_TIMEOUT_MS = 15_000;
/** A server that has just started lists no models until it has loaded them: asked again this often, this long. */
const ASK_EVERY_MS = 1_000;
const ASK_FOR_MS = 20_000;

export type OpenCodeVariantsOptions = {
  readonly binary: string;
  /** A private folder the server runs in and is asked about (`<AGENTSWITCH_HOME>/opencode-exec`). */
  readonly home: string;
  readonly startTimeoutMs?: number;
  /** Tests: how long it is asked again, and how often. */
  readonly askForMs?: number;
  readonly askEveryMs?: number;
};

/** `provider/id` → the variants' ids; empty when the server listed no models in time. Throws when it does not start. */
export async function readOpenCodeVariants(opts: OpenCodeVariantsOptions): Promise<Record<string, string[]>> {
  mkdirSync(opts.home, { recursive: true, mode: 0o700 });
  const { child, url, password } = await startStdioServe({ binary: opts.binary, cwd: opts.home, env: { ...stripProxy(process.env), PWD: opts.home }, port: 0, startTimeoutMs: opts.startTimeoutMs });
  try {
    const call = async (method: string, path: string): Promise<unknown> => {
      const res = await fetch(`${url}${path}`, { method, headers: { authorization: basicAuth(password) }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`${method} ${path.split("?")[0]}: HTTP ${res.status}`);
      return res.json();
    };
    const until = Date.now() + (opts.askForMs ?? ASK_FOR_MS);
    for (;;) {
      const found = await openCodeVariants(call, opts.home);
      if (Object.keys(found).length || Date.now() >= until) return found;
      await sleep(opts.askEveryMs ?? ASK_EVERY_MS);
    }
  } finally {
    await stopStdioServe(child);
  }
}
