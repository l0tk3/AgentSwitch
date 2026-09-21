/** Claude Code quota: the 5h / 7d windows come from rate_limit_event messages the executor sees
 *  (cached in RateLimitCache). With nothing cached, a force refresh may run a one-turn probe query
 *  (cheap) to fetch them; the local token count is shown alongside. */

import type { Store } from "../engine/store.js";
import type { QuotaProvider } from "./types.js";
import { remainingFromWindows, type RateLimitCache, type RateLimitInfo } from "./windows.js";

export type ClaudeQuotaOptions = {
  readonly cache: RateLimitCache;
  readonly probe?: () => Promise<RateLimitInfo[]>;   // one-turn query that yields rate_limit_event infos
  readonly probeIfOlderThanMs?: number;
  readonly dailyTokenBudget?: number;
  readonly now?: () => number;
};

export function claudeQuota(store: Store, opts: ClaudeQuotaOptions): QuotaProvider {
  const budget = opts.dailyTokenBudget ?? 5_000_000;
  const now = opts.now ?? Date.now;
  return {
    harness: "claude-code",
    async read(force = false) {
      let error: string | null = null;
      const age = opts.cache.ageMs();
      if (opts.probe && (age === null || (force && age > (opts.probeIfOlderThanMs ?? 5 * 60_000)))) {
        try { for (const info of await opts.probe()) opts.cache.record(info); } catch (e) { error = `probe: ${(e as Error).message}`; }
      }
      const windows = opts.cache.list();
      const used = store.usageSince(now() - 24 * 3600 * 1000)["claude-code"] ?? 0;
      const remaining = remainingFromWindows(windows) ?? Math.max(0, Math.min(1, 1 - used / budget));
      return {
        remaining,
        detail: { windows, usedTokens24h: used, dailyTokenBudget: budget, windowsAgeMs: opts.cache.ageMs() },
        source: windows.length ? "claude rate_limit_event (subscription windows)" : "local token count (no windows seen yet)",
        error,
      };
    },
  };
}
