/** Claude Code has no quota endpoint: count tokens from our own done events against a daily budget. */

import type { Store } from "../engine/store.js";
import type { QuotaProvider } from "./types.js";

export function claudeQuota(store: Store, opts: { dailyTokenBudget?: number; now?: () => number } = {}): QuotaProvider {
  const budget = opts.dailyTokenBudget ?? 5_000_000;
  return {
    harness: "claude-code",
    async read() {
      const since = (opts.now ?? Date.now)() - 24 * 3600 * 1000;
      const used = store.usageSince(since)["claude-code"] ?? 0;
      return { remaining: Math.max(0, Math.min(1, 1 - used / budget)), detail: { usedTokens24h: used, dailyTokenBudget: budget }, source: "local token count (no official endpoint)", error: null };
    },
  };
}
