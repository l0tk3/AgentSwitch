/** Watching the Mac's coding sessions (docs/control-v0.md §3): newest first across Claude Code, Codex and OpenCode,
 *  each file parsed again only when it changed. Sessions that ran in a temporary folder or in AgentSwitch's own data
 *  directory are left out (probes, tests, AgentSwitch's executors). Read-only: nothing here writes to those stores. */

import { RATE_LIMIT_PROBE_PROMPT } from "../core/probes.js";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeFacts, claudeMessages } from "./claude.js";
import { codexFacts, codexMessages } from "./codex.js";
import { openCodeMessages, openCodeSessions } from "./opencode.js";
import { ACTIVE_MS, oneLine, TITLE_CHARS, type SessionHarness, type SessionMessage, type SessionSummary } from "./types.js";

export type SessionSources = {
  readonly claudeProjects: string;   // ~/.claude/projects
  readonly codexSessions: string;    // ~/.codex/sessions
  readonly opencodeDb: string;       // ~/.local/share/opencode/opencode.db
  /** Folders whose sessions are not the user's own (prefix match). */
  readonly excluded: readonly string[];
  /** Newest files looked at per harness, after our own and temporary folders are left out (tests set it low). */
  readonly scanFiles?: number;
  /** Session ids AgentSwitch's executors created (they may share the user's store, as OpenCode does). */
  readonly ownIds?: () => ReadonlySet<string>;
  /** Folders decided at run time whose sessions are AgentSwitch's (the default work folder). */
  readonly ownFolders?: () => readonly string[];
};

export function defaultSessionSources(dataHome: string, env: NodeJS.ProcessEnv = process.env): SessionSources {
  const home = env.HOME ?? ".";
  return {
    claudeProjects: join(home, ".claude", "projects"),
    codexSessions: join(home, ".codex", "sessions"),
    opencodeDb: join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode", "opencode.db"),
    excluded: [tmpdir(), "/tmp/", "/private/tmp/", "/private/var/folders/", "/var/folders/", dataHome],
  };
}

/** Files the list looks at: the newest by modification time, at most this many per harness. */
const SCAN_FILES = 400;
const MAX_AGE_MS = 90 * 24 * 3600_000;

type FileRef = { readonly path: string; readonly mtime: number; readonly size: number };
type Cached = { readonly mtime: number; readonly size: number; readonly summary: SessionSummary | null };

export class SessionMonitor {
  private readonly cache = new Map<string, Cached>();
  /** Where each listed Claude / Codex session lives, for opening one. */
  private readonly files = new Map<string, string>();

  constructor(private readonly sources: SessionSources, private readonly now: () => number = Date.now) {}

  list(limit = 60): SessionSummary[] {
    const now = this.now();
    const fromFiles = [
      ...this.scan(jsonlFiles(this.sources.claudeProjects, 1, now, this.scanFiles, (dir) => this.isExcludedKey(dir)), "claude-code", now),
      ...this.scan(jsonlFiles(this.sources.codexSessions, 3, now, this.scanFiles), "codex", now),
    ];
    const opencode = openCodeSessions(this.sources.opencodeDb, this.scanFiles).map((s) => this.summary("opencode", s, now));
    const own = this.sources.ownIds?.() ?? new Set<string>();
    return [...fromFiles, ...opencode]
      .filter((s): s is SessionSummary => s !== null && !this.isExcluded(s.cwd) && !own.has(s.id) && !!(s.title || s.lastText) && s.title !== RATE_LIMIT_PROBE_PROMPT)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  read(harness: SessionHarness, id: string, limit = 80): { session: SessionSummary; messages: SessionMessage[] } | null {
    const session = this.list(200).find((s) => s.harness === harness && s.id === id);
    if (!session) return null;
    if (harness === "opencode") return { session, messages: openCodeMessages(this.sources.opencodeDb, id, limit) };
    const path = this.files.get(`${harness}:${id}`);
    if (!path) return null;
    return { session, messages: harness === "claude-code" ? claudeMessages(path, limit) : codexMessages(path, limit) };
  }

  private scan(refs: FileRef[], harness: "claude-code" | "codex", now: number): (SessionSummary | null)[] {
    return refs.map((ref) => {
      const hit = this.cache.get(ref.path);
      if (hit && hit.mtime === ref.mtime && hit.size === ref.size) return hit.summary && { ...hit.summary, active: now - hit.summary.updatedAt < ACTIVE_MS };
      let summary: SessionSummary | null = null;
      try {
        const facts = harness === "claude-code" ? claudeFacts(ref.path, ref.mtime) : codexFacts(ref.path, ref.mtime);
        summary = facts ? this.summary(harness, facts, now) : null;
      } catch { summary = null; }
      this.cache.set(ref.path, { mtime: ref.mtime, size: ref.size, summary });
      if (summary) this.files.set(`${harness}:${summary.id}`, ref.path);
      return summary;
    });
  }

  private summary(harness: SessionHarness, f: { id: string; cwd: string; title: string; lastText: string; updatedAt: number; origin?: string; branch?: string; model?: string }, now: number): SessionSummary {
    return {
      harness, id: f.id, cwd: f.cwd, title: oneLine(f.title, TITLE_CHARS), lastText: oneLine(f.lastText, TITLE_CHARS), updatedAt: f.updatedAt,
      active: now - f.updatedAt < ACTIVE_MS, ...(f.origin ? { origin: f.origin } : {}), ...(f.branch ? { branch: f.branch } : {}), ...(f.model ? { model: f.model } : {}),
    };
  }

  private get scanFiles(): number { return this.sources.scanFiles ?? SCAN_FILES; }

  /** The folder or anything under it; `/private/tmp/` and `/private/tmp` mean the same. */
  private isExcluded(cwd: string): boolean {
    return !cwd || this.excludedRoots().some((root) => cwd === root || cwd.startsWith(`${root}/`));
  }

  /** A Claude project directory named after an excluded folder (Claude replaces every non-alphanumeric character with
   *  `-`), skipped before the scan limit so probes and our own executors' sessions do not crowd the user's out. */
  private isExcludedKey(dir: string): boolean {
    return this.excludedRoots().map(claudeKey).some((key) => dir === key || dir.startsWith(`${key}-`));
  }

  private excludedRoots(): string[] {
    return [...this.sources.excluded, ...(this.sources.ownFolders?.() ?? [])].map((p) => p.replace(/\/+$/, "")).filter(Boolean);
  }
}

function claudeKey(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

/** `*.jsonl` files `depth` directories below `root`, the newest `limit` modified within `MAX_AGE_MS`; top-level
 *  directories `skip` names are not entered. */
function jsonlFiles(root: string, depth: number, now: number, limit: number, skip: (dir: string) => boolean = () => false): FileRef[] {
  const found: FileRef[] = [];
  const walk = (dir: string, left: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      if (left > 0) { if (dir !== root || !skip(name)) walk(path, left - 1); continue; }
      if (!name.endsWith(".jsonl")) continue;
      try {
        const st = statSync(path);
        if (st.isFile() && now - st.mtimeMs < MAX_AGE_MS) found.push({ path, mtime: st.mtimeMs, size: st.size });
      } catch { /* gone meanwhile */ }
    }
  };
  walk(root, depth);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}
