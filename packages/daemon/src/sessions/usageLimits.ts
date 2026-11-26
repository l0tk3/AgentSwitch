/** The account's allowances — the 5-hour and 7-day windows — as the agents say them (terminals/meter.ts; user #599),
 *  and the numbers' readers shared with it. Codex writes them into its session's record (record.ts). */

/** One allowance: its window's name (`5h`, `7d`), how much of it is used, when it starts afresh (ms; null: not said). */
export type UsageLimit = { readonly label: string; readonly percent: number; readonly resetsAt: number | null };

export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
export const pct = (v: number): number => Math.max(0, Math.min(100, v));
/** Seconds or milliseconds since 1970, or an ISO date, as milliseconds. */
export function when(v: unknown): number | null {
  const n = num(v);
  if (n !== null && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

/** A window's name from its length in minutes: `5h`, `7d`, `30d`. */
export function windowLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Codex's `rate_limits` of a `token_count` event, the shorter window first; none it does not say. */
export function codexLimits(rateLimits: unknown): UsageLimit[] {
  const rl = obj(rateLimits), out: { minutes: number; limit: UsageLimit }[] = [];
  for (const key of ["primary", "secondary"]) {
    const l = obj(rl[key]), v = num(l.used_percent), minutes = num(l.window_minutes);
    if (v === null || !minutes || minutes <= 0) continue;
    const resetsIn = num(l.resets_in_seconds);
    out.push({ minutes, limit: { label: windowLabel(minutes), percent: pct(v), resetsAt: when(l.resets_at) ?? (resetsIn !== null ? Date.now() + resetsIn * 1000 : null) } });
  }
  return out.sort((a, b) => a.minutes - b.minutes).map((o) => o.limit);
}
