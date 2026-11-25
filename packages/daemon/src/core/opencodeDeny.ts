/** The protected paths (protected.ts) as OpenCode's permission rules: what a terminal's OpenCode is started with
 *  (terminals/launch.ts). */

import { rootSpellings, type ProtectedPaths } from "./protected.js";

export type ProtectedDeny = { edit: Record<string, string>; bash: Record<string, string>; read: Record<string, string>; external: Record<string, string> };

/** Static rules for the folders outside the project: any folder of the Mac is open, like Claude Code on it (2026-09-25,
 *  user decision), except the protected roots: no edit under them, no shell command naming them, no working in them
 *  (`cd`, the shell tool's `workdir`, a file outside the project: OpenCode asks `external_directory` for those and
 *  never matches them against the bash patterns), and no read at all of the read-denied ones (credentials at rest).
 *  Exempt subtrees and `askUnder` (the skills dir) inside a root are open again. OpenCode takes the last matching rule,
 *  so the order is: everything, then the roots, then what is exempt inside them. */
export function protectedDeny(prot: ProtectedPaths, env: NodeJS.ProcessEnv = process.env, askUnder: readonly string[] = []): ProtectedDeny {
  const home = env.HOME ?? "";
  const edit: Record<string, string> = {};
  const bash: Record<string, string> = {};
  const read: Record<string, string> = {};
  const external: Record<string, string> = { "*": "allow" };
  // Each root also as the data volume spells it (`/System/Volumes/Data/Users/…`): OpenCode matches paths as text.
  for (const root of prot.roots) {
    for (const r of rootSpellings(root)) {
      edit[`${r}/*`] = "deny";
      external[r] = "deny";
      external[`${r}/*`] = "deny";
    }
    for (const form of [...shellForms(root, home), ...appDataTails(root, home)]) bash[`*${form}*`] = "deny";
  }
  for (const r of (prot.readDenied ?? []).flatMap(rootSpellings)) { read[r] = "deny"; read[`${r}/*`] = "deny"; }
  for (const d of [...prot.exempt, ...askUnder]) { external[d] = "allow"; external[`${d}/*`] = "allow"; }
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

