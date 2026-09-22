/** Claude Code quota: only the 5h / 7d windows from rate_limit_event messages the executor sees (cached in
 *  RateLimitCache). With nothing cached, a force refresh may run a one-turn probe query (cheap). No local
 *  token guesswork (decided 2026-09-22): unknown means "assume available" to the router's floor. */

import type { QuotaProvider } from "./types.js";
import { remainingFromWindows, type RateLimitCache, type RateLimitInfo } from "./windows.js";

export type ClaudeQuotaOptions = {
  readonly cache: RateLimitCache;
  readonly probe?: () => Promise<RateLimitInfo[]>;   // one-turn query that yields rate_limit_event infos
  readonly probeIfOlderThanMs?: number;
};

export const PROBE_IF_OLDER_THAN_MS = 5 * 60_000;

export function claudeQuota(opts: ClaudeQuotaOptions): QuotaProvider {
  return {
    harness: "claude-code",
    async read(force = false) {
      let error: string | null = null;
      const age = opts.cache.ageMs();
      if (opts.probe && (age === null || (force && age > (opts.probeIfOlderThanMs ?? PROBE_IF_OLDER_THAN_MS)))) {
        try { for (const info of await opts.probe()) opts.cache.record(info); } catch (e) { error = `probe: ${(e as Error).message}`; }
      }
      const windows = opts.cache.list();
      return {
        remaining: remainingFromWindows(windows),
        detail: { windows, windowsAgeMs: opts.cache.ageMs() },
        source: windows.length ? "claude rate_limit_event (subscription windows)" : "no windows seen yet",
        error,
      };
    },
  };
}
