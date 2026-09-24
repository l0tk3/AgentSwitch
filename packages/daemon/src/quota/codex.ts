/** Codex quota via `codex app-server` JSON-RPC `account/rateLimits/read` (verified 2026-09-20). */

import { appServerRequest, type Json } from "../harness/appserver.js";
import type { QuotaProvider } from "./types.js";
import { labelForMinutes, type Window } from "./windows.js";
import { APP_SERVER_REQUEST_TIMEOUT_MS } from "../core/limits.js";

/** `{rateLimits:{primary:{usedPercent,windowDurationMins,resetsAt},planType,...}}` → remaining fraction. */
export function parseRateLimits(result: Json): { remaining: number | null; detail: Json } {
  const limits = (result.rateLimits as Json | undefined) ?? result;
  const primary = limits.primary as Json | undefined;
  const used = typeof primary?.usedPercent === "number" ? primary.usedPercent : null;
  const secondary = limits.secondary as Json | null | undefined;
  const usedSecondary = typeof secondary?.usedPercent === "number" ? secondary.usedPercent : null;
  const worst = Math.max(used ?? 0, usedSecondary ?? 0);
  const windows: Window[] = [];
  for (const w of [primary, secondary]) {
    if (w && typeof w.usedPercent === "number") windows.push({ label: labelForMinutes(w.windowDurationMins as number | undefined), usedPercent: w.usedPercent, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null });
  }
  return {
    remaining: used === null && usedSecondary === null ? null : Math.max(0, Math.min(1, 1 - worst / 100)),
    detail: {
      planType: limits.planType ?? null,
      windows,
      credits: limits.credits ?? null,
      rateLimitReachedType: limits.rateLimitReachedType ?? null,
    },
  };
}

export function codexQuota(opts: { binary: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): QuotaProvider {
  return {
    harness: "codex",
    async read(_force, signal) {
      try {
        const result = await appServerRequest(opts.binary, "account/rateLimits/read", {}, opts.timeoutMs ?? APP_SERVER_REQUEST_TIMEOUT_MS, opts.env, signal);
        return { ...parseRateLimits(result), source: "codex app-server account/rateLimits/read", error: null };
      } catch (err) {
        return { remaining: null, detail: {}, source: "codex app-server", error: (err as Error).message };
      }
    },
  };
}
