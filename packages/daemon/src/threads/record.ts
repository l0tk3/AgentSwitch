/** The track record (threads-v0 §7): plain bookkeeping per finished task, summarised for the router's
 *  prompt, plus two deterministic guards. No learned weights: a single user's samples are too few and
 *  too noisy, so the router reads the ledger and decides; code only demotes a target that keeps failing
 *  and flags one the user walked away from. */

import type { TargetRef } from "../router/targets.js";

/** Router-labelled task kind (Decision.kind); code falls back to the coarse default-policy classes. */
export const KINDS = ["code-multifile", "code-small", "browser", "chat", "translate", "code", "other"] as const;

export type RecordRow = {
  readonly taskId: string;
  readonly ts: number;
  readonly kind: string;
  readonly harness: string;
  readonly model: string;
  readonly status: string;              // done | failed | cancelled
  readonly failureKind: string | null;  // refusal | quota | transport | ...
  readonly ms: number;
  readonly tokens: number;
  readonly approvals: number;
  readonly handedOff: boolean;          // the engine moved it to another target mid-task
  readonly pinned: boolean;             // the user chose the target (--pin)
  readonly userHandoff: boolean;        // the user took it away from this target afterwards
  readonly rating: number | null;       // the user's 👍 (1) / 👎 (-1)
};

export const RECORD_WINDOW_MS = 30 * 86400_000;
export const DEMOTE_AFTER = 3;

export type TargetStats = {
  readonly harness: string;
  readonly model: string;
  readonly runs: number;
  readonly ok: number;
  readonly refusals: number;
  readonly failures: number;
  readonly transports: number;
  readonly avgMs: number;
  readonly avgTokens: number;
  readonly userHandoffs: number;
  readonly thumbsUp: number;
  readonly thumbsDown: number;
};

export type KindStats = { readonly kind: string; readonly targets: readonly TargetStats[] };

const key = (r: { harness: string; model: string }): string => `${r.harness}/${r.model}`;

/** Per kind, per target: counts and averages over the window. Pure. */
export function aggregateRecords(rows: readonly RecordRow[], now = Date.now(), windowMs = RECORD_WINDOW_MS): KindStats[] {
  const recent = rows.filter((r) => r.ts >= now - windowMs);
  const byKind = new Map<string, Map<string, RecordRow[]>>();
  for (const r of recent) {
    const targets = byKind.get(r.kind) ?? new Map<string, RecordRow[]>();
    targets.set(key(r), [...(targets.get(key(r)) ?? []), r]);
    byKind.set(r.kind, targets);
  }
  return [...byKind.entries()].map(([kind, targets]) => ({
    kind,
    targets: [...targets.values()].map((rs) => {
      const first = rs[0]!;
      const n = rs.length;
      return {
        harness: first.harness, model: first.model, runs: n,
        ok: rs.filter((r) => r.status === "done").length,
        refusals: rs.filter((r) => r.failureKind === "refusal").length,
        failures: rs.filter((r) => r.status === "failed" && r.failureKind !== "refusal" && r.failureKind !== "transport" && r.failureKind !== "quota").length,
        transports: rs.filter((r) => r.failureKind === "transport" || r.failureKind === "quota").length,
        avgMs: Math.round(rs.reduce((s, r) => s + r.ms, 0) / n),
        avgTokens: Math.round(rs.reduce((s, r) => s + r.tokens, 0) / n),
        userHandoffs: rs.filter((r) => r.userHandoff).length,
        thumbsUp: rs.filter((r) => r.rating === 1).length,
        thumbsDown: rs.filter((r) => r.rating === -1).length,
      };
    }).sort((a, b) => b.runs - a.runs),
  })).sort((a, b) => a.kind.localeCompare(b.kind));
}

/** The few lines the router reads. Empty string when there is nothing yet. */
export function recordText(stats: readonly KindStats[]): string {
  const lines: string[] = [];
  for (const k of stats) {
    const parts = k.targets.map((t) => {
      const extras = [t.refusals ? `${t.refusals} refused` : "", t.transports ? `${t.transports} transport/quota` : "", t.userHandoffs ? `user handed off ${t.userHandoffs}×` : "", t.thumbsUp || t.thumbsDown ? `user rated 👍${t.thumbsUp} 👎${t.thumbsDown}` : ""].filter(Boolean);
      return `${t.harness}/${t.model} ${t.runs} runs ${t.ok} ok, avg ${Math.round(t.avgMs / 1000)} s${t.avgTokens ? `, ${t.avgTokens} tok` : ""}${extras.length ? ` (${extras.join(", ")})` : ""}`;
    });
    lines.push(`${k.kind}: ${parts.join("; ")}`);
  }
  return lines.join("\n");
}

export type Guards = {
  /** Same kind, same target, DEMOTE_AFTER consecutive refusals/task failures: moved after the fallbacks. */
  readonly demoted: readonly TargetRef[];
  /** Targets the user took this kind of task away from: the router must say why it picks them again. */
  readonly overridden: readonly TargetRef[];
};

export const NO_GUARDS: Guards = { demoted: [], overridden: [] };

const isStrike = (r: RecordRow): boolean => r.status === "failed" && (r.failureKind === "refusal" || r.failureKind === "task_failed" || r.failureKind === "unknown");

export function guardsFor(rows: readonly RecordRow[], kind: string | null, now = Date.now(), windowMs = RECORD_WINDOW_MS): Guards {
  if (!kind) return NO_GUARDS;
  const recent = rows.filter((r) => r.kind === kind && r.ts >= now - windowMs).sort((a, b) => a.ts - b.ts);
  const streak = new Map<string, number>();
  const demoted = new Map<string, TargetRef>();
  const overridden = new Map<string, TargetRef>();
  for (const r of recent) {
    const k = key(r);
    if (r.userHandoff) overridden.set(k, { harness: r.harness, model: r.model });
    if (r.status === "cancelled" || r.failureKind === "transport" || r.failureKind === "quota") continue;   // not a verdict on the model
    const n = isStrike(r) ? (streak.get(k) ?? 0) + 1 : 0;
    streak.set(k, n);
    if (n >= DEMOTE_AFTER) demoted.set(k, { harness: r.harness, model: r.model });
    else demoted.delete(k);
  }
  return { demoted: [...demoted.values()], overridden: [...overridden.values()] };
}
