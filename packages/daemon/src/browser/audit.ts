/** What was done to the shared browser and from where (docs/browser-v0.md §2 安全), the terminals' way
 *  (terminals/audit.ts): one JSON line each in `$AGENTSWITCH_HOME/browser/audit.jsonl`. A URL is recorded without its
 *  query and fragment (they can carry tokens); what was typed into a page is never recorded, a fill only by the
 *  ciphertext's label and the page's host. Agents' tabs and navigations are recorded with `via: "agent"`. */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type BrowserAuditEntry = {
  readonly tab: string | null;
  readonly action: "open" | "navigate" | "close" | "take" | "release" | "fill" | "refused";
  /** "local" (this Mac: the Mac app, the web page), the paired device's id, or "agent" (the agent bridge). */
  readonly via: string;
  readonly detail?: Record<string, unknown>;
};

export class BrowserAudit {
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  record(entry: BrowserAuditEntry): void {
    try { appendFileSync(this.path, `${JSON.stringify({ ts: this.now(), ...entry })}\n`, { mode: 0o600 }); } catch { /* auditing never breaks the browser */ }
  }
}
