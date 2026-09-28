/** Deleting an agent's own record of a session (docs/terminal-v0.md §4, `DELETE /terminals/:id?transcript=1`): only for
 *  terminals AgentSwitch started, only by the session id the agent reported, and only where that agent keeps it. */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TerminalHarness } from "./host.js";

const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/;

/** The files removed; empty when there was nothing, or the agent keeps its sessions some other way (not supported). */
export function deleteTranscript(harness: TerminalHarness, sessionId: string, home: string = homedir()): string[] {
  if (!SESSION_ID.test(sessionId)) return [];
  if (harness !== "claude-code") return [];
  const projects = join(home, ".claude", "projects");
  if (!existsSync(projects)) return [];
  const removed: string[] = [];
  for (const dir of readdirSync(projects, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = join(projects, dir.name, `${sessionId}.jsonl`);
    if (existsSync(file)) { rmSync(file); removed.push(file); }
  }
  return removed;
}
