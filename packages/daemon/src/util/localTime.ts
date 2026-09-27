const DAY_MS = 86_400_000;

/** A time for people (docs/ui-v0.md §4), in the Mac's time zone: 今天 20:24 · 昨天 17:12 · 9月24日 17:12. Anything
 *  that is not a date is returned as it is. */
export function localTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  if (!iso || Number.isNaN(t.getTime())) return iso || "未知时间";
  const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(t)) / DAY_MS);
  if (days === 0) return `今天 ${hm}`;
  if (days === 1) return `昨天 ${hm}`;
  return `${t.getMonth() + 1}月${t.getDate()}日 ${hm}`;
}
