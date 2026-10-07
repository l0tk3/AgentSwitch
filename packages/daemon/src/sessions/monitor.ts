/** Watching the Mac's coding sessions (docs/control-v0.md §3): newest first across Claude Code, Codex, OpenCode and pi,
 *  each file parsed again only when it changed. Sessions that ran in a temporary folder or in AgentSwitch's own data
 *  directory are left out (probes, tests, AgentSwitch's executors). Read-only, except `remove`: the user deleting a
 *  session's record (docs/terminal-v0.md §5). */

import { RATE_LIMIT_PROBE_PROMPT } from "../core/probes.js";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeFacts, claudeMessages } from "./claude.js";
import { codexFacts, codexMessages } from "./codex.js";
import { openCodeMessages, openCodeSessions, type OpenCodeDelete } from "./opencode.js";
import { piFacts, piMessages } from "./pi.js";
import { MAX_RECORD_LIMIT, readChanges, readRecord, recordFromMessages, type FileDiff, type SessionRecord } from "./record.js";
import { ACTIVE_MS, oneLine, TITLE_CHARS, type SessionHarness, type SessionMessage, type SessionMode, type SessionSummary } from "./types.js";

export type SessionSources = {
  readonly claudeProjects: string;   // ~/.claude/projects
  readonly codexSessions: string;    // ~/.codex/sessions
  readonly opencodeDb: string;       // ~/.local/share/opencode/opencode.db
  /** ~/.pi/agent/sessions; absent: pi's sessions are not read. */
  readonly piSessions?: string;
  /** Deleting an OpenCode session (its own command); absent: OpenCode's sessions cannot be deleted here. */
  readonly openCodeDelete?: OpenCodeDelete;
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
    piSessions: join(piAgentDir(env), "sessions"),
    excluded: [tmpdir(), "/tmp/", "/private/tmp/", "/private/var/folders/", "/var/folders/", dataHome],
  };
}

/** Files the list looks at: the newest by modification time, at most this many per harness. */
const SCAN_FILES = 400;
const MAX_AGE_MS = 90 * 24 * 3600_000;

/** `born`: when the file was made (the session began). */
type FileRef = { readonly path: string; readonly mtime: number; readonly size: number; readonly born: number };
type Cached = { readonly mtime: number; readonly size: number; readonly summary: SessionSummary | null };

export class SessionMonitor {
  private readonly cache = new Map<string, Cached>();
  /** Where each listed Claude / Codex session lives, for opening one. */
  private readonly files = new Map<string, string>();

  constructor(private readonly sources: SessionSources, private readonly now: () => number = Date.now) {}

  /** The Mac's sessions, newest first: each agent's newest `SCAN_FILES` records of the last 90 days, less those left
   *  out (scratch folders, our own executors', untitled, probes); `limit` keeps the first so many. */
  list(limit = Infinity): SessionSummary[] {
    const now = this.now();
    const fromFiles = [
      ...this.scan(jsonlFiles(this.sources.claudeProjects, 1, now, this.scanFiles, (dir) => this.isExcludedKey(dir)), "claude-code", now),
      ...this.scan(jsonlFiles(this.sources.codexSessions, 3, now, this.scanFiles), "codex", now),
      ...(this.sources.piSessions ? this.scan(jsonlFiles(this.sources.piSessions, 1, now, this.scanFiles), "pi", now) : []),
    ];
    const opencode = openCodeSessions(this.sources.opencodeDb, this.scanFiles).map((s) => this.summary("opencode", s, now));
    const own = this.sources.ownIds?.() ?? new Set<string>();
    return [...fromFiles, ...opencode]
      .filter((s): s is SessionSummary => s !== null && !this.isExcluded(s.cwd) && !own.has(s.id) && !!(s.title || s.lastText) && s.title !== RATE_LIMIT_PROBE_PROMPT)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  /** Where a listed session is kept: its file (Claude Code, Codex, pi) or OpenCode's database; null for one not listed. */
  source(harness: SessionHarness, id: string): string | null {
    return harness === "opencode" ? this.sources.opencodeDb : this.files.get(`${harness}:${id}`) ?? null;
  }

  /** A listed session by its agent and id, wherever it falls in the list; null for one not listed. */
  find(harness: SessionHarness, id: string): SessionSummary | null {
    return this.list().find((s) => s.harness === harness && s.id === id) ?? null;
  }

  read(harness: SessionHarness, id: string, limit = 80): { session: SessionSummary; messages: SessionMessage[] } | null {
    const session = this.find(harness, id);
    if (!session) return null;
    if (harness === "opencode") return { session, messages: openCodeMessages(this.sources.opencodeDb, id, limit) };
    const path = this.files.get(`${harness}:${id}`);
    if (!path) return null;
    return { session, messages: harness === "claude-code" ? claudeMessages(path, limit) : harness === "pi" ? piMessages(path, limit) : codexMessages(path, limit) };
  }

  /** A session's record for the simple view (docs/simple-view-v0.md §2): Claude Code's and Codex's from their files,
   *  step by step; the others' (and an older Codex rollout's) from the coarse messages, one line per tool. */
  record(harness: SessionHarness, id: string, o: { limit?: number; before?: number } = {}): { session: SessionSummary; record: SessionRecord } | null {
    const session = this.find(harness, id);
    if (!session) return null;
    const path = this.files.get(`${harness}:${id}`);
    if (path && (harness === "claude-code" || harness === "codex")) {
      const record = readRecord(harness, path, { ...o, cwd: session.cwd });
      if (record) return { session, record };
    }
    const coarse = this.read(harness, id, MAX_RECORD_LIMIT);
    return coarse && { session, record: recordFromMessages(coarse.messages, `u${session.updatedAt.toString(36)}`) };
  }

  /** What a session changed, file by file: in one run of work, else in its last turn. Null when it is not listed, the
   *  run is not there, or the agent's record carries no changes (OpenCode, pi). */
  changes(harness: SessionHarness, id: string, work?: string): FileDiff[] | null {
    const session = this.find(harness, id);
    const path = this.files.get(`${harness}:${id}`);
    if (!session || !path || (harness !== "claude-code" && harness !== "codex")) return null;
    return readChanges(harness, path, { ...(work !== undefined ? { work } : {}), cwd: session.cwd });
  }

  private scan(refs: FileRef[], harness: "claude-code" | "codex" | "pi", now: number): (SessionSummary | null)[] {
    return refs.map((ref) => {
      const hit = this.cache.get(ref.path);
      if (hit && hit.mtime === ref.mtime && hit.size === ref.size) return hit.summary && { ...hit.summary, active: now - hit.summary.updatedAt < ACTIVE_MS };
      let summary: SessionSummary | null = null;
      try {
        const facts = harness === "claude-code" ? claudeFacts(ref.path, ref.mtime) : harness === "pi" ? piFacts(ref.path, ref.mtime) : codexFacts(ref.path, ref.mtime);
        // When it began: what the record says (pi), else when its file was made.
        summary = facts ? this.summary(harness, { startedAt: ref.born, ...facts }, now) : null;
      } catch { summary = null; }
      this.cache.set(ref.path, { mtime: ref.mtime, size: ref.size, summary });
      if (summary) this.files.set(`${harness}:${summary.id}`, ref.path);
      return summary;
    });
  }

  private summary(harness: SessionHarness, f: { id: string; cwd: string; title: string; lastText: string; updatedAt: number; startedAt?: number; origin?: string; branch?: string; model?: string; mode?: SessionMode; forkedFrom?: string }, now: number): SessionSummary {
    return {
      harness, id: f.id, cwd: f.cwd, title: oneLine(f.title, TITLE_CHARS), lastText: oneLine(f.lastText, TITLE_CHARS),
      // Whole milliseconds: a file's mtime has a fraction, which a client reading an integer may refuse.
      updatedAt: Math.round(f.updatedAt),
      startedAt: Math.round(Math.min(f.startedAt || f.updatedAt, f.updatedAt)),
      active: now - f.updatedAt < ACTIVE_MS, ...(f.origin ? { origin: f.origin } : {}), ...(f.branch ? { branch: f.branch } : {}), ...(f.model ? { model: f.model } : {}),
      ...(f.mode ? { mode: f.mode } : {}), ...(f.forkedFrom ? { forkedFrom: f.forkedFrom } : {}),
    };
  }

  private get scanFiles(): number { return this.sources.scanFiles ?? SCAN_FILES; }

  /** Deletes the agent's own record of a session (docs/terminal-v0.md §5, the user's own management): Claude Code's
   *  `<project>/<id>.jsonl`, Codex's `rollout-…-<id>.jsonl`, pi's `<time>_<id>.jsonl`; OpenCode's through its own
   *  command (its database, the session's children with it). Nothing else is touched. The file the list read comes
   *  first (it may sit where the id alone does not say); one that cannot be removed is reported, not thrown, so what did
   *  go is still known. */
  async remove(harness: SessionHarness, id: string): Promise<{ removed: string[]; failed: string[] }> {
    const removed: string[] = [], failed: string[] = [];
    if (!SESSION_ID.test(id)) return { removed, failed };
    if (harness === "opencode") {
      const record = `${this.sources.opencodeDb}#${id}`;
      if (!this.sources.openCodeDelete) return { removed, failed: [record] };
      try { if (await this.sources.openCodeDelete(id)) removed.push(record); } catch { failed.push(record); }
      return { removed, failed };
    }
    const drop = (file: string) => {
      if (removed.includes(file) || failed.includes(file) || !existsSync(file)) return;
      try { rmSync(file); removed.push(file); } catch { failed.push(file); }
    };
    const listed = this.files.get(`${harness}:${id}`);
    if (listed) drop(listed);
    if (harness === "claude-code") {
      for (const dir of safeDirs(this.sources.claudeProjects)) {
        const file = join(this.sources.claudeProjects, dir, `${id}.jsonl`);
        if (existsSync(file)) drop(file);
      }
    } else if (harness === "codex") {
      const walk = (dir: string, left: number) => {
        for (const name of safeDirs(dir, true)) {
          const path = join(dir, name);
          if (left > 0) walk(path, left - 1);
          else if (name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`)) drop(path);
        }
      };
      walk(this.sources.codexSessions, 3);
    } else if (harness === "pi" && this.sources.piSessions) {
      for (const dir of safeDirs(this.sources.piSessions)) {
        for (const name of safeDirs(join(this.sources.piSessions, dir), true)) {
          if (name.endsWith(`_${id}.jsonl`)) drop(join(this.sources.piSessions, dir, name));
        }
      }
    }
    if (removed.length) this.files.delete(`${harness}:${id}`);
    return { removed, failed };
  }

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

/** Session ids as the agents write them (uuids, short ids, OpenCode's `ses_…`): never a path. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** pi's agent directory: `PI_CODING_AGENT_DIR` (a leading `~` is the home), else `~/.pi/agent`. */
function piAgentDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? ".";
  const set = env.PI_CODING_AGENT_DIR?.trim();
  return set ? set.replace(/^~(?=$|\/)/, home) : join(home, ".pi", "agent");
}

/** Entry names in `dir` (directories only unless `all`); none when it cannot be read. */
function safeDirs(dir: string, all = false): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => all || e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
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
        if (st.isFile() && now - st.mtimeMs < MAX_AGE_MS) found.push({ path, mtime: st.mtimeMs, size: st.size, born: st.birthtimeMs || st.ctimeMs });
      } catch { /* gone meanwhile */ }
    }
  };
  walk(root, depth);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}
