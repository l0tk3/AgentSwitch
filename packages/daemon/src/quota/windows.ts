/** Rate-limit windows (5h / 7d) as shown in the panel, plus the cache Claude's events feed. */

export type Window = {
  readonly label: string;          // "5h" | "7d" | "7d opus" ...
  readonly usedPercent: number;    // 0..100
  readonly resetsAt: number | null; // epoch seconds
};

export function labelForMinutes(mins: number | null | undefined): string {
  if (!mins) return "?";
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

const CLAUDE_LABELS: Record<string, string> = { five_hour: "5h", seven_day: "7d", seven_day_opus: "7d opus", seven_day_sonnet: "7d sonnet", seven_day_overage_included: "7d+overage", overage: "overage" };

/** Observed 2026-09-21 (SDK 0.3.278): the CLI sends `unifiedWindows: {five_hour: {utilization, resetsAt},
 *  seven_day: {...}}` alongside the declared top-level fields, which may be absent. Both forms are read. */
export type RateLimitInfo = {
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  status?: string;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
};

function percent(utilization: number | undefined): number | null {
  if (utilization === undefined) return null;
  return Math.round(utilization <= 1 ? utilization * 100 : utilization);
}

/** Latest Claude rate-limit info per window type, fed by the executor's rate_limit_event messages. */
export class RateLimitCache {
  private readonly windows = new Map<string, Window & { seenAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  record(info: RateLimitInfo): void {
    const seenAt = this.now();
    for (const [type, w] of Object.entries(info.unifiedWindows ?? {})) {
      const used = percent(w.utilization);
      if (used !== null) this.windows.set(type, { label: CLAUDE_LABELS[type] ?? type, usedPercent: used, resetsAt: w.resetsAt ?? null, seenAt });
    }
    const type = info.rateLimitType ?? "unknown";
    const used = percent(info.utilization);
    if (info.status === "rejected") {
      const prev = this.windows.get(type);
      this.windows.set(type, { label: CLAUDE_LABELS[type] ?? type, usedPercent: 100, resetsAt: info.resetsAt ?? prev?.resetsAt ?? null, seenAt });
    } else if (used !== null && !(info.unifiedWindows && type in info.unifiedWindows)) {
      this.windows.set(type, { label: CLAUDE_LABELS[type] ?? type, usedPercent: used, resetsAt: info.resetsAt ?? null, seenAt });
    }
  }

  list(): Window[] {
    return [...this.windows.values()].map(({ seenAt: _s, ...w }) => w);
  }

  ageMs(): number | null {
    const seen = [...this.windows.values()].map((w) => w.seenAt);
    return seen.length ? this.now() - Math.max(...seen) : null;
  }
}

/** Fraction left = worst window. */
export function remainingFromWindows(windows: readonly Window[]): number | null {
  if (!windows.length) return null;
  return Math.max(0, Math.min(1, 1 - Math.max(...windows.map((w) => w.usedPercent)) / 100));
}
