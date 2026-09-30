/** What was done to AgentSwitch's terminals and from where (docs/terminal-v0.md §4): one JSON line each in
 *  `$AGENTSWITCH_HOME/terminals/audit.jsonl`. Replies are recorded by length and whether the sealer changed them, never
 *  by content. */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditEntry = {
  readonly terminal: string;
  readonly action: "create" | "resume" | "rename" | "input" | "attach" | "keys" | "permission" | "kill" | "delete" | "session-delete";
  /** "local" (this Mac: web page, Mac app) or the paired device's id. */
  readonly via: string;
  readonly detail?: Record<string, unknown>;
};

export class TerminalAudit {
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  record(entry: AuditEntry): void {
    try { appendFileSync(this.path, `${JSON.stringify({ ts: this.now(), ...entry })}\n`, { mode: 0o600 }); } catch { /* auditing never breaks the terminal */ }
  }
}
