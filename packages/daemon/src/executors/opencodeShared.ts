/** What both OpenCode paths share (standalone `opencode run` and the resident executor server): the static permission
 *  and MCP config of one execution, and how a folded run becomes an ExecutionOutcome. Kept apart from opencode.ts so
 *  the serve path can use it without an import cycle; opencode.ts re-exports it. */

import { detectRefusal, NO_SIDE_EFFECTS, type ExecutionOutcome } from "../core/outcome.js";
import { opencodeGateConfig, type GateOptions, type GateRun } from "./gate.js";
import { NO_PROTECTED, type ProtectedPaths } from "../core/protected.js";

export type OpenCodeExtras = { readonly mcp?: Record<string, unknown>; readonly skillsDir?: string | null; readonly protected?: ProtectedPaths };

export { protectedDeny, type ProtectedDeny } from "../core/opencodeDeny.js";
import { protectedDeny } from "../core/opencodeDeny.js";

/** No `instructions` key: OpenCode 2.0.8 ignores it (verified for `run` and `serve`); the guidance goes at the head of
 *  the prompt (standalone) or into a session instruction entry (resident server). */
export function opencodeExecConfig(gate: GateOptions | null | undefined, profile: string, browser: boolean, extras: OpenCodeExtras = {}, run: GateRun = {}): object {
  const g = gate ? opencodeGateConfig(gate, profile, browser, run) : { mcp: {}, readDeny: {} };
  const deny = protectedDeny(extras.protected ?? NO_PROTECTED, process.env, extras.skillsDir ? [extras.skillsDir] : []);
  return {
    $schema: "https://opencode.ai/config.json",
    ...(extras.skillsDir ? { skills: { paths: [extras.skillsDir] } } : {}),
    mcp: { ...g.mcp, ...(extras.mcp ?? {}) },
    permission: {
      read: { "*": "allow", ...g.readDeny, ...deny.read, "**/.env": "deny", "**/*.pem": "deny", "**/*.key": "deny" },
      bash: { "*": "allow", "secret-gate keygen*": "deny", ...(gate ? { [`cat ${gate.home}/*`]: "deny" } : {}), ...deny.bash },
      edit: Object.keys(deny.edit).length ? { "*": "allow", ...deny.edit } : "allow",
      external_directory: deny.external,
      webfetch: "deny",
    },
  };
}

export type RunSummary = { text: string; tools: { tool: string; input: unknown; output?: string }[]; errors: string[]; sessionId: string | null; telemetryComplete: boolean };

/** OpenCode's synchronous sub-agent tool: `subagent` in v2 (seen with 2.0.8), `task` in v1. */
export const SUBAGENT_TOOL = /^(task|subagent)$/i;
const EDIT_TOOL = /^(edit|write|patch|multiedit|apply_patch)$/i;

/** `approvals` = actions the engine approved during the run (serve path only; `opencode run` cannot ask). */
export function outcomeFromRun(summary: RunSummary, exitCode: number | null, stderr: string, timedOut: boolean, approvals = 0): ExecutionOutcome {
  const edits = summary.tools.filter((t) => EDIT_TOOL.test(t.tool)).length;
  // MCP/browser tools and sub-agents can mutate remote state without any file or shell event.
  const operations = summary.tools.length - edits;
  const subagents = summary.tools.filter((t) => SUBAGENT_TOOL.test(t.tool)).length;
  const sideEffects = { ...NO_SIDE_EFFECTS, filesChanged: edits, commandsRun: operations, approvalsGranted: approvals };
  const agents = { spawned: subagents, completed: subagents, failed: 0 };
  const errText = [...summary.errors, stderr.trim()].filter(Boolean).join("\n");
  const lastText = summary.text.trimEnd();
  const refusal = detectRefusal({ ok: true, lastText });
  const ok = !refusal && !timedOut && exitCode === 0 && summary.errors.length === 0 && lastText.trim().length > 0;
  return { ok, exitCode, stderr: errText, lastText, timedOut, sideEffects, sideEffectsKnown: !timedOut && exitCode === 0 && summary.telemetryComplete, agents, ...(refusal ? { refusal } : {}), ...(summary.sessionId ? { sessionId: summary.sessionId } : {}) };
}
