/** Folders trusted once in AgentSwitch (2026-11-24, user): an agent AgentSwitch starts in one of them, or below one,
 *  does not stop at its own "Do you trust this folder?" — before the start, the folder is marked trusted in that
 *  agent's own configuration, in the profile's own config folder, as the agent would mark it when the user says yes.
 *
 *  - Claude Code (2.1.330, read from its bundle): `<CLAUDE_CONFIG_DIR or HOME>/.claude.json` (a config folder's legacy
 *    `.config.json` when that is the one in use), `projects[<folder>].hasTrustDialogAccepted = true`. It looks the
 *    session's folder up and then each folder above it up to the repository's root, so the folder (as given and as the
 *    system resolves it) is marked, and the repository's root too when that is inside the trusted folder.
 *  - Codex (0.171.0): `<CODEX_HOME or ~/.codex>/config.toml`, `[projects."<folder>"] trust_level = "trusted"`.
 *  - Antigravity CLI (1.5.17): `<~/.gemini>/antigravity-cli/settings.json`, the folder's path in `trustedWorkspaces`
 *    (where its own "Yes, I trust this folder" puts it: seen).
 *  - OpenCode and pi ask no such question: nothing. Grok's is not written yet.
 *
 *  Each file is read, changed and replaced whole (a temporary file renamed over it); everything else in it is kept
 *  as it was. When the file changed while it was being changed (the agent writing it), it is done again from what is
 *  there now; a file that does not parse, or a folder the user marked untrusted in Codex, is left alone. A failure
 *  never stops the start: the agent then asks, as before. */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { trustInGrok } from "./grokHooks.js";
import type { TerminalHarness } from "./host.js";
import { agyHome } from "../sessions/agy.js";

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

/** What is trusted: `folders` with everything below them, `only` each by itself (2026-11-26, user #463: asked at a
 *  new session — no, this folder, or this folder and all below it). */
export type TrustList = { readonly folders: readonly string[]; readonly only: readonly string[] };

const paths = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string" && isAbsolute(f)).map((f) => resolve(f)) : [];

/** Both lists, normalized; a missing or broken file is two empty lists. */
export function loadTrustList(home: string): { folders: string[]; only: string[] } {
  try {
    const raw = JSON.parse(readFileSync(join(home, TRUSTED_FOLDERS_FILE), "utf8")) as { folders?: unknown; only?: unknown };
    return { folders: paths(raw.folders), only: paths(raw.only) };
  } catch { return { folders: [], only: [] }; }
}

/** The folders trusted with everything below them. */
export function loadTrustedFolders(home: string): string[] {
  return loadTrustList(home).folders;
}

/** Saves the lists (0600, replaced whole); `only` left out is kept as it was. A folder trusted by itself that one of
 *  `folders` covers is dropped. Throws with the reason when a folder may not be on a list. */
export function saveTrustList(home: string, folders: readonly string[], only?: readonly string[], userHome: string = homedir()): { folders: string[]; only: string[] } {
  const clean = (list: readonly string[]): string[] => {
    const out: string[] = [];
    for (const f of list) {
      const why = trustRefusal(f, userHome);
      if (why) throw new Error(`${f}: ${why}`);
      const p = resolve(f);
      if (!out.includes(p)) out.push(p);
    }
    return out;
  };
  const whole = clean(folders);
  const single = clean(only ?? loadTrustList(home).only).filter((f) => !whole.some((w) => within(f, w)));
  mkdirSync(home, { recursive: true });
  replaceFile(join(home, TRUSTED_FOLDERS_FILE), `${JSON.stringify({ folders: whole, only: single }, null, 2)}\n`);
  return { folders: whole, only: single };
}

export function saveTrustedFolders(home: string, folders: readonly string[], userHome: string = homedir()): string[] {
  return saveTrustList(home, folders, undefined, userHome).folders;
}

const formsOf = (path: string): string[] => [...new Set([resolve(path), safeReal(path)])];

/** The trusted folder `cwd` is in (itself or one above it), as given or as the system resolves it; null: none. */
export function trustedRootOf(cwd: string, folders: readonly string[]): string | null {
  if (!isAbsolute(cwd)) return null;
  const forms = formsOf(cwd);
  for (const root of folders) {
    const roots = formsOf(root);
    if (forms.some((f) => roots.some((r) => within(f, r)))) return root;
  }
  return null;
}

/** `cwd` is one of the folders trusted by themselves. */
export function trustedAlone(cwd: string, only: readonly string[]): boolean {
  if (!isAbsolute(cwd)) return false;
  const forms = formsOf(cwd);
  return only.some((o) => formsOf(o).some((r) => forms.includes(r)));
}

/** Whether an agent started in `cwd` finds it trusted, and whether it may be put on a list at all. */
export function trustState(cwd: string, list: TrustList, userHome: string = homedir()): { trusted: boolean; allowed: boolean } {
  return { trusted: trustedRootOf(cwd, list.folders) !== null || trustedAlone(cwd, list.only), allowed: trustRefusal(cwd, userHome) === null };
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
export function pretrust(harness: TerminalHarness, cwd: string, env: Readonly<Record<string, string | undefined>>, trusted: readonly string[] | TrustList, log: (line: string) => void = (l) => console.error(l)): TrustOutcome | null {
  try {
    if (harness !== "claude-code" && harness !== "codex" && harness !== "grok" && harness !== "agy") return null;
    const list: TrustList = "folders" in trusted ? trusted : { folders: trusted, only: [] };
    // A folder trusted by itself is its own root: nothing above it (its repository's root) is marked with it.
    const root = trustedRootOf(cwd, list.folders) ?? (trustedAlone(cwd, list.only) ? cwd : null);
    if (!root) return null;
    const keys = trustKeys(cwd, root);
    // Grok (1.0.92): `<GROK_HOME or ~/.grok>/trusted_folders.toml`.
    if (harness === "grok") return trustInGrok(env.GROK_HOME || join(env.HOME || homedir(), ".grok"), keys);
    const out = harness === "claude-code" ? trustInClaude(claudeConfigFile(env), keys)
      // Antigravity lists the folder it is started in, as the system resolves it; the repository's root is not asked about.
      : harness === "agy" ? trustInAgy(agySettingsFile(env), [...new Set([safeReal(cwd), resolve(cwd)])])
      : trustInCodex(codexConfigFile(env), keys);
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

/** Antigravity CLI's own settings for this environment. */
export function agySettingsFile(env: Readonly<Record<string, string | undefined>>): string {
  return join(agyHome(env), "settings.json");
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

/** `trustedWorkspaces` in Antigravity's settings.json: the folders it does not ask about, as absolute paths. A list
 *  that is something else, or a file that does not parse, is left alone. */
export function trustInAgy(path: string, keys: readonly string[]): Change {
  return rewrite(path, (text) => {
    let settings: Record<string, unknown> = {};
    if (text !== null && text.trim() !== "") {
      try { settings = JSON.parse(text) as Record<string, unknown>; } catch { return { outcome: "skipped", note: `${path} does not parse; left alone` }; }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { outcome: "skipped", note: `${path} is not an object; left alone` };
    }
    const had = settings.trustedWorkspaces;
    if (had !== undefined && !Array.isArray(had)) return { outcome: "skipped", note: `${path} keeps trustedWorkspaces some other way; left alone` };
    const list: unknown[] = [...(had ?? [])];
    // Each spelling of the folder: it looks its working folder up as it was given it (a link's own path where it
    // was started through one: seen), which is not always how the system resolves it.
    const missing = keys.filter((k) => !list.includes(k));
    if (!missing.length) return { outcome: "already" };
    list.push(...missing);
    return `${JSON.stringify({ ...settings, trustedWorkspaces: list }, null, 2)}\n`;
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
