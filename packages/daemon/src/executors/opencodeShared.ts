/** What both OpenCode paths share (standalone `opencode run` and the resident executor server): the static permission
 *  and MCP config of one execution, and how a folded run becomes an ExecutionOutcome. Kept apart from opencode.ts so
 *  the serve path can use it without an import cycle; opencode.ts re-exports it. */

import { detectRefusal, NO_SIDE_EFFECTS, type ExecutionOutcome } from "../core/outcome.js";
import { opencodeGateConfig, type GateOptions, type GateRun } from "./gate.js";
import { NO_PROTECTED, type ProtectedPaths } from "./protected.js";
import type { CredentialRepair } from "./types.js";

export type OpenCodeExtras = { readonly mcp?: Record<string, unknown>; readonly skillsDir?: string | null; readonly protected?: ProtectedPaths };

export type ProtectedDeny = { edit: Record<string, string>; bash: Record<string, string>; read: Record<string, string>; external: Record<string, string> };

/** Static deny patterns for the protected roots: no edit under them, no shell command naming them, no working in them
 *  (`cd`, the shell tool's `workdir`, a file outside the project: OpenCode asks `external_directory` for those and
 *  never matches them against the bash patterns), and no read at all of the read-denied ones (credentials at rest).
 *  Exempt subtrees and `askUnder` (the skills dir) keep OpenCode's default for outside directories: ask. OpenCode
 *  takes the last matching rule, so they come after the denies. */
export function protectedDeny(prot: ProtectedPaths, env: NodeJS.ProcessEnv = process.env, askUnder: readonly string[] = []): ProtectedDeny {
  const home = env.HOME ?? "";
  const edit: Record<string, string> = {};
  const bash: Record<string, string> = {};
  const read: Record<string, string> = {};
  const external: Record<string, string> = {};
  for (const r of prot.roots) {
    edit[`${r}/*`] = "deny";
    for (const form of [...shellForms(r, home), ...appDataTails(r, home)]) bash[`*${form}*`] = "deny";
    external[r] = "deny";
    external[`${r}/*`] = "deny";
  }
  for (const r of prot.readDenied ?? []) { read[r] = "deny"; read[`${r}/*`] = "deny"; }
  for (const d of [...prot.exempt, ...askUnder]) { external[d] = "ask"; external[`${d}/*`] = "ask"; }
  return { edit, bash, read, external };
}

/** The ways a command can name `path`: as is (also inside quotes), with backslash-escaped spaces, and from `~`,
 *  `$HOME` or `${HOME}`. OpenCode matches its patterns against the raw command text. */
function shellForms(path: string, home: string): string[] {
  const bases = [path];
  if (home && (path === home || path.startsWith(`${home}/`))) {
    const rest = path.slice(home.length);
    bases.push(`~${rest}`, `$HOME${rest}`, `\${HOME}${rest}`);
  }
  return [...new Set(bases.flatMap((b) => [b, b.replace(/ /g, "\\ ")]))];
}

const QUOTES = ["", "\"", "'"] as const;

/** A per-user data dir (`~/.secret-gate`, `~/.agentswitch`, `~/Library/Application Support/AgentSwitch`) is named by
 *  its tail however the rest is written — `"$HOME"/.secret-gate`, `~/Library/"Application Support"/AgentSwitch`:
 *  `/.secret-gate`, `Support/AgentSwitch` with a quote on either side of the slash. Other roots (a repo's config dir)
 *  have tails too common to deny everywhere. */
function appDataTails(path: string, home: string): string[] {
  if (!home || !path.startsWith(`${home}/`)) return [];
  const rel = path.slice(home.length + 1);
  if (!rel.startsWith(".") && !rel.startsWith("Library/")) return [];
  const segments = rel.split("/");
  const last = segments[segments.length - 1]!;
  const before = segments.length > 1 ? segments[segments.length - 2]!.split(" ").pop()! : "";
  const heads = before ? QUOTES.map((q) => `${before}${q}`) : [""];
  return heads.flatMap((head) => QUOTES.map((q) => `${head}/${q}${last}`));
}

/** No `instructions` key: OpenCode 2.0.8 ignores it (verified for `run` and `serve`); the guidance goes at the head of
 *  the prompt (standalone) or into a session instruction entry (resident server). */
export function opencodeExecConfig(gate: GateOptions | null | undefined, profile: string, browser: boolean, extras: OpenCodeExtras = {}, repair?: CredentialRepair, run: GateRun = {}): object {
  const g = gate ? opencodeGateConfig(gate, profile, browser, repair, run) : { mcp: {}, readDeny: {} };
  const deny = protectedDeny(extras.protected ?? NO_PROTECTED, process.env, extras.skillsDir ? [extras.skillsDir] : []);
  return {
    $schema: "https://opencode.ai/config.json",
    ...(extras.skillsDir ? { skills: { paths: [extras.skillsDir] } } : {}),
    mcp: { ...g.mcp, ...(extras.mcp ?? {}) },
    permission: {
      read: { "*": "allow", ...g.readDeny, ...deny.read, "**/.env": "deny", "**/*.pem": "deny", "**/*.key": "deny" },
      bash: { "*": "allow", "secret-gate keygen*": "deny", ...(gate ? { [`cat ${gate.home}/*`]: "deny" } : {}), ...deny.bash },
      edit: Object.keys(deny.edit).length ? { "*": "allow", ...deny.edit } : "allow",
      // No "*" key: every other outside directory keeps OpenCode's default, ask.
      ...(Object.keys(deny.external).length ? { external_directory: deny.external } : {}),
      webfetch: "deny",
    },
  };
}

export type RunSummary = { text: string; tools: { tool: string; input: unknown }[]; errors: string[]; sessionId: string | null; telemetryComplete: boolean };

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
