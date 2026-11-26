/** How full a terminal's context is and how much of the account's 5-hour and 7-day allowance is used, read as the
 *  agent goes, without asking anyone for it (docs/simple-view-v0.md §5.25; user #599).
 *
 *  - **Claude Code** hands its status line one JSON object on stdin whenever it redraws it: among the rest
 *    `context_window` (`context_window_size`, `used_percentage`, `current_usage`) and, for a subscription,
 *    `rate_limits.five_hour` / `.seven_day` (`used_percentage`, `resets_at` in Unix seconds). A terminal of ours gets a
 *    status line of AgentSwitch's own through `--settings` (`hookClient.js status <file>`): it hands the service those
 *    numbers and nothing else of the object, and runs the status line the user had (`ownStatusLine`, kept in `<file>`)
 *    with the same input, printing what it prints — claude-hud and the like stay as they were. Without one of the
 *    user's own it prints nothing, which is what Claude Code shows without a status line.
 *  - **Antigravity** (`agy`) hands its status line, which is ours already (agy.ts), the same `context_window` and a
 *    `quota` of its own: `<family>-<window>` (`gemini-weekly`, `3p-5h`, `3p-weekly` for the other makers' models) with
 *    `remaining_fraction` and `reset_time`; the hook program passes on those numbers, and the family of the model it is
 *    on is shown (seen 2026-11-26 on 1.5.17).
 *  - **Codex** writes them into its session's record (`token_count`: `info.model_context_window`, `rate_limits.primary`
 *    / `.secondary` with `used_percent`, `window_minutes`, `resets_at`): sessions/record.ts reads them there. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { num, obj, pct, type UsageLimit, when } from "../sessions/usageLimits.js";

export type { UsageLimit } from "../sessions/usageLimits.js";
export { codexLimits, windowLabel } from "../sessions/usageLimits.js";

/** What the status line said last. `context`: null where it has not said (before the first answer). */
export type TerminalMeter = {
  readonly context: { readonly percent: number; readonly used: number | null; readonly window: number | null } | null;
  readonly limits: readonly UsageLimit[];
  /** When the hook program read it: a later reading counts over an earlier one that arrives after it. */
  readonly at: number;
};

/** The event the hook program hands the service for each run of Claude Code's status line. */
export const CLAUDE_METER_EVENT = "ClaudeMeter";

/** What the service keeps of one reading, as the hook program hands it on (hookClient.ts `status`). */
export function claudeMeter(p: Readonly<Record<string, unknown>>): TerminalMeter {
  const c = obj(p.context);
  const window = num(c.size), used = num(c.used);
  let percent = num(c.used_percentage);
  if (percent === null && used && window) percent = (used / window) * 100;
  const limits: UsageLimit[] = [];
  for (const [label, key] of [["5h", "five_hour"], ["7d", "seven_day"]] as const) {
    const l = obj(p[key]), v = num(l.used_percentage);
    if (v !== null) limits.push({ label, percent: pct(v), resetsAt: when(l.resets_at) });
  }
  return {
    context: percent === null ? null : { percent: pct(percent), used: used && used > 0 ? used : null, window: window && window > 0 ? window : null },
    limits, at: num(p.at) ?? 0,
  };
}

/** Antigravity's reading (hookClient.ts `agy`: `context` as Claude Code's, `quota` as it says it), for `model`. */
export function agyMeter(p: Readonly<Record<string, unknown>>, model: string): TerminalMeter {
  const { context } = claudeMeter({ context: p.context });
  const family = /^gemini/i.test(model.trim()) ? "gemini" : "3p";
  const limits: { order: number; limit: UsageLimit }[] = [];
  for (const [key, value] of Object.entries(obj(p.quota))) {
    const m = /^(.+)-(\d+h|weekly|daily)$/.exec(key);
    if (!m || m[1] !== family) continue;
    const q = obj(value), left = num(q.remaining_fraction);
    if (left === null) continue;
    const reset = when(q.reset_time);
    const label = m[2] === "weekly" ? "7d" : m[2] === "daily" ? "1d" : m[2]!;
    limits.push({ order: label.endsWith("h") ? parseInt(label, 10) : parseInt(label, 10) * 24, limit: { label, percent: pct((1 - left) * 100), resetsAt: reset && reset > 0 ? reset : null } });
  }
  return { context, limits: limits.sort((a, b) => a.order - b.order).map((l) => l.limit), at: num(p.at) ?? 0 };
}

// ── The user's own status line ───────────────────────────────────────────────────────────────────────────────────────

/** The status line Claude Code would have drawn in `cwd` without ours: the nearest of the folder's local settings, its
 *  shared ones and the user's (`configDir`: `CLAUDE_CONFIG_DIR`, else `~/.claude`), the order it reads them in —
 *  `--settings` comes before all three, so ours is the one it runs. `userOnly`: started with `--setting-sources user`.
 *  Null: none, or one that is not a command. */
export function ownStatusLine(cwd: string, configDir: string | undefined, userOnly = false): Record<string, unknown> | null {
  const files = [
    ...(userOnly ? [] : [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json")]),
    join(configDir || join(homedir(), ".claude"), "settings.json"),
  ];
  for (const file of files) {
    let line: unknown;
    try { if (!existsSync(file)) continue; line = obj(JSON.parse(readFileSync(file, "utf8"))).statusLine; } catch { continue; }
    if (line === undefined) continue;
    const o = obj(line);
    return o.type === "command" && typeof o.command === "string" && o.command.trim() ? o : null;
  }
  return null;
}

/** The status line of a terminal's `--settings`: ours (`command`), with what else the user's had (its padding …), and
 *  the user's own written to `file` for ours to run. */
export function claudeStatusLine(hookCommand: string, file: string, own: Record<string, unknown> | null): Record<string, unknown> {
  writeFileSync(file, JSON.stringify(own ? { command: own.command } : {}), { mode: 0o600 });
  return { ...(own ?? {}), type: "command", command: `${hookCommand} status ${shq(file)}` };
}

const shq = (s: string): string => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
