/** What a tool call of Claude Code's needs: allowed, asked of the user, or denied outright where it reaches a
 *  protected path (core/protected.ts). The terminals' floor (terminals/host.ts `floor`); it was the managed Claude
 *  executor's own until that went (2026-11-25). */

import { resolve } from "node:path";
import { APPROVAL_EVIDENCE_CHARS } from "./limits.js";
import { canonicalPath, commandTouchesProtected, containsReadDenied, isProtected, isReadDenied, NO_PROTECTED, PROTECTED_DENIAL, type ProtectedPaths } from "./protected.js";

/** The server of an MCP tool's name (`mcp__server__tool`), or null. */
function mcpServerOf(toolName: string): string | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(toolName);
  return m ? m[1]! : null;
}

const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "TodoRead", "Task", "NotebookRead", "WebSearch"]);   // search has no side effects (decided 2026-09-22); WebFetch still asks
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export type ToolDecision = { kind: "allow" } | { kind: "ask"; action: string; evidence: string } | { kind: "deny"; reason: string };

export const READ_DENIAL = "denied by AgentSwitch: this path holds credentials (gate keys, browser sessions, TLS keys) that executors may not read";
export const SEARCH_DENIAL = "denied by AgentSwitch: this directory contains credentials (gate keys, browser sessions, TLS keys) that executors may not read; search a narrower directory";
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);

/** The paths a read tool would look at: its file or directory, and for Glob an absolute pattern's fixed prefix. */
function readTargets(toolName: string, input: Record<string, unknown>): string[] {
  const home = process.env.HOME ?? "";
  const expand = (p: string) => (p.startsWith("~") ? home + p.slice(1) : p);
  const out = [input.file_path, input.path, input.notebook_path].filter((v): v is string => typeof v === "string").map(expand);
  if (toolName === "Glob" && typeof input.pattern === "string") {
    const pattern = expand(input.pattern);
    const fixed = pattern.slice(0, pattern.search(/[*?[{]/) === -1 ? pattern.length : pattern.search(/[*?[{]/));
    if (fixed.startsWith("/") || fixed.startsWith(".")) out.push(fixed);
  }
  return out;
}

/** Real path of `p` even when it does not exist yet: realpath of the nearest existing ancestor + the rest, in the
 *  disk's own case and without the data volume's prefix (core/paths.ts). macOS reports the temp dir as /var/... and
 *  /private/var/... interchangeably. */
export function canonical(p: string): string {
  return canonicalPath(p);
}

/** Policy: what needs a human. `cwd` should already be canonical; `allowedMcp` = registry servers marked approval=allow. */
export function decideTool(toolName: string, input: Record<string, unknown>, cwd: string, allowedMcp: ReadonlySet<string> = new Set(), prot: ProtectedPaths = NO_PROTECTED): ToolDecision {
  if (READ_TOOLS.has(toolName)) {
    const targets = readTargets(toolName, input);
    const hit = targets.find((p) => isReadDenied(p, cwd, prot));
    if (hit) return { kind: "deny", reason: `${READ_DENIAL} (${hit})` };
    // A content search above a credential store would read it too; a Glob only lists names.
    const wide = toolName === "Grep" ? targets.find((p) => containsReadDenied(p, cwd, prot)) : undefined;
    if (wide) return { kind: "deny", reason: `${SEARCH_DENIAL} (${wide})` };
  }
  if (READ_ONLY.has(toolName) || toolName === "Skill") return { kind: "allow" };
  const server = mcpServerOf(toolName);
  if (server && (server === "secret-gate" || server === "playwright" || allowedMcp.has(server))) return { kind: "allow" };
  if (EDIT_TOOLS.has(toolName)) {
    const raw = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
    const p = raw === null ? null : canonical(resolve(cwd, raw));
    if (p && isProtected(p, cwd, prot)) return { kind: "deny", reason: `${PROTECTED_DENIAL} (${p})` };
    // Any other folder of the Mac, like Claude Code on it (2026-09-25, user decision); only the protected ones are out.
    if (p) return { kind: "allow" };
    return { kind: "ask", action: `${toolName} without a path`, evidence: JSON.stringify(input).slice(0, APPROVAL_EVIDENCE_CHARS) };
  }
  if (toolName === "Bash") {
    const command = String(input.command ?? "");
    const hit = commandTouchesProtected(command, cwd, prot);
    if (hit) return { kind: "deny", reason: `${PROTECTED_DENIAL} (${hit})` };
    return { kind: "ask", action: `Bash: ${command}`, evidence: String(input.description ?? "") };
  }
  return { kind: "ask", action: `${toolName}`, evidence: JSON.stringify(input).slice(0, APPROVAL_EVIDENCE_CHARS) };
}

