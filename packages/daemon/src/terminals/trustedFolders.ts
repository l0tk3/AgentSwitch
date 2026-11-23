/** Folders trusted once in AgentSwitch (2026-11-24, user): an agent AgentSwitch starts in one of them, or below one,
 *  does not stop at its own "Do you trust this folder?" — before the start, the folder is marked trusted in that
 *  agent's own configuration, in the profile's own config folder, as the agent would mark it when the user says yes.
 *
 *  - Claude Code (2.1.330, read from its bundle): `<CLAUDE_CONFIG_DIR or HOME>/.claude.json` (a config folder's legacy
 *    `.config.json` when that is the one in use), `projects[<folder>].hasTrustDialogAccepted = true`. It looks the
 *    session's folder up and then each folder above it up to the repository's root, so the folder (as given and as the
 *    system resolves it) is marked, and the repository's root too when that is inside the trusted folder.
 *  - Codex (0.171.0): `<CODEX_HOME or ~/.codex>/config.toml`, `[projects."<folder>"] trust_level = "trusted"`.
 *  - OpenCode and pi ask no such question: nothing.
 *
 *  Each file is read, changed and replaced whole (a temporary file renamed over it); everything else in it is kept
 *  as it was. When the file changed while it was being changed (the agent writing it), it is done again from what is
 *  there now; a file that does not parse, or a folder the user marked untrusted in Codex, is left alone. A failure
 *  never stops the start: the agent then asks, as before. */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { TerminalHarness } from "./host.js";

export const TRUSTED_FOLDERS_FILE = "trusted-folders.json";

/** Tries at a file that keeps changing under us before it is left alone. */
const ATTEMPTS = 3;

/** Why a folder may not be on the list; null: it may. `path` must already be absolute. */
export function trustRefusal(path: string, home: string = homedir()): string | null {
  if (!isAbsolute(path)) return "a trusted folder must be an absolute path";
  const p = resolve(path);
  const roots = [resolve(home), ...(existsSync(home) ? [safeReal(home)] : [])];
  if (p === sep || p === resolve("/")) return "the root folder can not be trusted as a whole";
  // The home folder, or a folder above it, would trust every project of the user's at once.
  for (const h of roots) if (h === p || within(h, p)) return "the home folder (or one above it) can not be trusted as a whole";
  return null;
}

/** `child` is `parent` or below it. */
function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function safeReal(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** The list, normalized; a missing or broken file is an empty list. */
export function loadTrustedFolders(home: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(home, TRUSTED_FOLDERS_FILE), "utf8")) as { folders?: unknown };
    return Array.isArray(raw.folders) ? raw.folders.filter((f): f is string => typeof f === "string" && isAbsolute(f)).map((f) => resolve(f)) : [];
  } catch { return []; }
}

/** Saves the list (0600, replaced whole). Throws with the reason when one of them may not be on it. */
export function saveTrustedFolders(home: string, folders: readonly string[], userHome: string = homedir()): string[] {
  const clean: string[] = [];
  for (const f of folders) {
    const why = trustRefusal(f, userHome);
    if (why) throw new Error(`${f}: ${why}`);
    const p = resolve(f);
    if (!clean.includes(p)) clean.push(p);
  }
  mkdirSync(home, { recursive: true });
  replaceFile(join(home, TRUSTED_FOLDERS_FILE), `${JSON.stringify({ folders: clean }, null, 2)}\n`);
  return clean;
}

/** The trusted folder `cwd` is in (itself or one above it), as given or as the system resolves it; null: none. */
export function trustedRootOf(cwd: string, folders: readonly string[]): string | null {
  if (!isAbsolute(cwd)) return null;
  const forms = [...new Set([resolve(cwd), safeReal(cwd)])];
  for (const root of folders) {
    const roots = [...new Set([resolve(root), safeReal(root)])];
    if (forms.some((f) => roots.some((r) => within(f, r)))) return root;
  }
  return null;
}

/** The names the folder goes by in an agent's own list: as given and resolved (macOS: /tmp is /private/tmp), and its
 *  repository's root when that is inside the trusted folder too. NFC, as Claude Code keys them. */
export function trustKeys(cwd: string, root: string): string[] {
  const forms = [resolve(cwd), safeReal(cwd)];
  const repo = repositoryRoot(safeReal(cwd));
  const roots = [resolve(root), safeReal(root)];
  if (repo && roots.some((r) => within(repo, r))) forms.push(repo);
  return [...new Set(forms.map((f) => f.normalize("NFC")))];
}

function repositoryRoot(dir: string): string | null {
  let d = dir;
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export type TrustOutcome = "written" | "already" | "skipped";

/** Before an agent starts in `cwd` with `env` (its config folder variables set): marks it trusted where the folder
 *  is on the list. Never throws. */
export function pretrust(harness: TerminalHarness, cwd: string, env: Readonly<Record<string, string | undefined>>, folders: readonly string[], log: (line: string) => void = (l) => console.error(l)): TrustOutcome | null {
  try {
    if (harness !== "claude-code" && harness !== "codex") return null;
    const root = trustedRootOf(cwd, folders);
    if (!root) return null;
    const keys = trustKeys(cwd, root);
    const out = harness === "claude-code" ? trustInClaude(claudeConfigFile(env), keys) : trustInCodex(codexConfigFile(env), keys);
    if (out.note) log(`trusted folders: ${harness}: ${out.note}`);
    return out.outcome;
  } catch (err) {
    log(`trusted folders: ${harness}: ${(err as Error).message}`);
    return "skipped";
  }
}

/** Claude Code's own file of settings and per-folder records for this environment (its `getGlobalClaudeFile`). */
export function claudeConfigFile(env: Readonly<Record<string, string | undefined>>): string {
  const home = env.HOME || homedir();
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const file = join(env.CLAUDE_CONFIG_DIR || home, ".claude.json");
  // Before `.claude.json` there was `<config dir>/.config.json`: still the one read where it is all there is.
  const legacy = join(configDir, ".config.json");
  if (!existsSync(file)) { try { if (statSync(legacy).size > 0) return legacy; } catch { /* none */ } }
  return file;
}

export function codexConfigFile(env: Readonly<Record<string, string | undefined>>): string {
  return join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "config.toml");
}

type Change = { readonly outcome: TrustOutcome; readonly note?: string };

/** The file `path` points at (a profile's file may be a link to the user's own): replaced there, the link kept. */
function target(path: string): string {
  try { return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path; } catch { return path; }
}

function readOrNull(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
}

/** Read, change, and replace `path` whole, unless it changed meanwhile (then again, a few times at most). `edit`
 *  answers the new text, or a Change saying why not. */
function rewrite(path: string, edit: (text: string | null) => string | Change): Change {
  const file = target(path);
  for (let i = 0; i < ATTEMPTS; i++) {
    const before = readOrNull(file);
    const next = edit(before);
    if (typeof next !== "string") return next;
    // Read once more right before the replace: the agent may be writing it now.
    if (readOrNull(file) !== before) continue;
    let mode = 0o600;
    try { mode = statSync(file).mode & 0o777; } catch { /* a new file */ }
    mkdirSync(dirname(file), { recursive: true });
    replaceFile(file, next, mode);
    return { outcome: "written" };
  }
  return { outcome: "skipped", note: `${file} kept changing; left alone` };
}

function replaceFile(file: string, text: string, mode = 0o600): void {
  const part = `${file}.agentswitch-${process.pid}-${Date.now()}.part`;
  writeFileSync(part, text, { mode });
  renameSync(part, file);
}

/** What Claude Code writes for a folder it has never seen (its own defaults), with the question answered. */
const CLAUDE_PROJECT = {
  allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
};

export function trustInClaude(path: string, keys: readonly string[]): Change {
  return rewrite(path, (text) => {
    let config: Record<string, unknown> = {};
    if (text !== null && text.trim() !== "") {
      try { config = JSON.parse(text) as Record<string, unknown>; } catch { return { outcome: "skipped", note: `${path} does not parse; left alone` }; }
      if (!config || typeof config !== "object" || Array.isArray(config)) return { outcome: "skipped", note: `${path} is not an object; left alone` };
    }
    const had = config.projects;
    const projects: Record<string, unknown> = had && typeof had === "object" && !Array.isArray(had) ? { ...(had as Record<string, unknown>) } : {};
    let changed = false;
    for (const key of keys) {
      const now = projects[key];
      const entry = now && typeof now === "object" && !Array.isArray(now) ? now as Record<string, unknown> : null;
      if (entry?.hasTrustDialogAccepted === true) continue;
      projects[key] = { ...(entry ?? CLAUDE_PROJECT), hasTrustDialogAccepted: true };
      changed = true;
    }
    if (!changed) return { outcome: "already" };
    return `${JSON.stringify({ ...config, projects }, null, 2)}\n`;
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** TOML's basic string for a key (JSON's escapes are TOML's). */
const tomlKey = (s: string) => JSON.stringify(s);

/** `[projects."<key>"]` (or with a literal string) as a header line. */
function headerRe(key: string): RegExp {
  return new RegExp(`^[ \\t]*\\[[ \\t]*projects[ \\t]*\\.[ \\t]*(?:${escapeRe(tomlKey(key))}|'${escapeRe(key)}')[ \\t]*\\][ \\t]*(?:#.*)?$`);
}

export function trustInCodex(path: string, keys: readonly string[]): Change {
  return rewrite(path, (text) => {
    const source = text ?? "";
    // Projects kept some other way (an inline table, or keys under `[projects]`) are not edited: a second definition
    // of the same table would make the whole file unreadable to Codex.
    if (/^[ \t]*projects[ \t]*=/m.test(source)) return { outcome: "skipped", note: `${path} keeps projects inline; left alone` };
    const lines = source.split("\n");
    let changed = false;
    for (const key of keys) {
      if (/^[ \t]*\[[ \t]*projects[ \t]*\][ \t]*(?:#.*)?$/m.test(lines.join("\n")) && lines.some((l) => l.trimStart().startsWith(`${tomlKey(key)}`) || l.trimStart().startsWith(`'${key}'`))) {
        return { outcome: "skipped", note: `${path} keeps ${key} under [projects]; left alone` };
      }
      const at = lines.findIndex((l) => headerRe(key).test(l));
      if (at >= 0) {
        let end = at + 1;
        while (end < lines.length && !/^[ \t]*\[/.test(lines[end]!)) end++;
        const level = lines.slice(at + 1, end).find((l) => /^[ \t]*trust_level[ \t]*=/.test(l));
        if (level) {
          if (/=[ \t]*["']trusted["']/.test(level)) continue;
          // The user said no to this very folder in Codex: that stays.
          return { outcome: "skipped", note: `${key} is marked otherwise in ${path}; left as the user set it` };
        }
        lines.splice(at + 1, 0, `trust_level = "trusted"`);
        changed = true;
        continue;
      }
      // Appended after whatever is there, which is left as it is (only the file's last line break is reused).
      if (lines[lines.length - 1] === "") lines.pop();
      lines.push(...(lines.length ? [""] : []), `[projects.${tomlKey(key)}]`, `trust_level = "trusted"`, "");
      changed = true;
    }
    if (!changed) return { outcome: "already" };
    const out = lines.join("\n");
    return out.endsWith("\n") ? out : `${out}\n`;
  });
}
