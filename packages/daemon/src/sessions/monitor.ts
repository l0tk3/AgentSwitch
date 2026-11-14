/** Watching the Mac's coding sessions (docs/control-v0.md §3): newest first across Claude Code, Codex, OpenCode and pi,
 *  each file parsed again only when it changed. Sessions that ran in a temporary folder or in AgentSwitch's own data
 *  directory are left out (probes, tests, AgentSwitch's executors). Read-only, except `remove`: the user deleting a
 *  session's record (docs/terminal-v0.md §5). */

import { canonicalFolder, folderNames, type ShownFolders } from "./shownFolders.js";
import { keptDiskSpelling } from "../core/paths.js";
import { RATE_LIMIT_PROBE_PROMPT } from "../core/probes.js";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeFacts, claudeMessages } from "./claude.js";
import { codexFacts, codexMessages, codexProviderOf } from "./codex.js";
import { openCodeMessages, openCodeSessions, type OpenCodeDelete } from "./opencode.js";
import { piFacts, piMessages } from "./pi.js";
import type { KeptPictures } from "./pictures.js";
import { MAX_RECORD_LIMIT, readChanges, readImage, readRecord, readStep, readStepImage, recordFromMessages, type FileDiff, type RecordImage, type SessionRecord, type StepDetail } from "./record.js";
import { ACTIVE_MS, MESSAGE_CHARS, oneLine, TITLE_CHARS, type SessionHarness, type SessionMessage, type SessionMode, type SessionSummary } from "./types.js";

export type SessionSources = {
  readonly claudeProfileProjects?: () => readonly string[];
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
  /** The title a session's agent gave it while it ran in a terminal here (sessions/titles.ts); null: none known. */
  readonly agentTitle?: (harness: SessionHarness, id: string) => string | null;
  readonly customTitle?: (harness: SessionHarness, id: string) => string | null;
  /** The session ran in a terminal the user started here: it is listed whatever its folder — a temporary one too.
   *  Sessions in `/tmp` and the like are left out as probes' and executors'; one the user began there in AgentSwitch
   *  was on the list only while its terminal ran, and gone after a restart (2026-11-11, user: 我在agentswitch里在/tmp
   *  开的session为什么重新启动agentswitch之后就没了). */
  readonly ranHere?: (harness: SessionHarness, id: string) => boolean;
  /** The folders the user says are shown, and the ones they say are hidden (sessions/shownFolders.ts): what they say
   *  comes before what is left out by itself. */
  readonly folders?: () => ShownFolders;
  /** Copies of the pictures a Codex record names only by their file's place (sessions/pictures.ts); absent: a
   *  picture is shown while its file is there, and no longer. */
  readonly pictures?: KeptPictures;
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

  private readonly spelled = new Map<string, string>();

  constructor(private readonly sources: SessionSources, private readonly now: () => number = Date.now) {}

  /** The Mac's sessions, newest first: each agent's newest `SCAN_FILES` records of the last 90 days, less those left
   *  out (scratch folders, our own executors', untitled, probes); `limit` keeps the first so many. */
  list(limit = Infinity): SessionSummary[] {
    const now = this.now();
    const said = this.sources.folders?.() ?? { shown: [], hidden: [] };
    const within = (cwd: string, roots: readonly string[]): boolean => {
      if (!roots.length || !cwd) return false;
      const at = this.canon(cwd);
      return roots.some((root) => at === root || at.startsWith(root === "/" ? "/" : `${root}/`));
    };
    const shown = said.shown.map((f) => this.canon(f)), hidden = said.hidden.map((f) => this.canon(f));
    // Claude Code keeps a folder's records under the folder's name: a folder the user shows is read whole, beside the
    // newest of everything else — an old session in it is not crowded out by the rest.
    const shownKeys = said.shown.flatMap(folderNames).map(claudeKey);
    const shownDir = (dir: string): boolean => shownKeys.some((key) => dir === key || dir.startsWith(`${key}-`));
    const claude = [this.sources.claudeProjects, ...(this.sources.claudeProfileProjects?.() ?? [])].flatMap((root) => jsonlFiles(root, 1, now, this.scanFiles, (dir) => root === this.sources.claudeProjects && this.isExcludedKey(dir) && !shownDir(dir), (id) => this.sources.ranHere?.("claude-code", id) ?? false));
    const forced = shownKeys.length ? jsonlFiles(this.sources.claudeProjects, 1, now, SHOWN_FILES, (dir) => !shownDir(dir)) : [];
    const have = new Set(claude.map((r) => r.path));
    const fromFiles = [
      ...this.scan([...claude, ...forced.filter((r) => !have.has(r.path))], "claude-code", now),
      ...this.codexThreads(jsonlFiles(this.sources.codexSessions, 3, now, this.scanFiles), now),
      ...(this.sources.piSessions ? this.scan(jsonlFiles(this.sources.piSessions, 1, now, this.scanFiles), "pi", now) : []),
    ];
    // OpenCode's title is its own, kept in its own store: nothing of ours stands in for it.
    const opencode = openCodeSessions(this.sources.opencodeDb, this.scanFiles).map((s) => this.summary("opencode", { ...s, named: true }, now));
    const own = this.sources.ownIds?.() ?? new Set<string>();
    return [...fromFiles, ...opencode]
      .filter((s): s is SessionSummary => s !== null && !within(s.cwd, hidden) && (!this.isExcluded(s.cwd) || within(s.cwd, shown) || (this.sources.ranHere?.(s.harness, s.id) ?? false)) && !own.has(s.id) && !!(s.title || s.lastText) && s.title !== RATE_LIMIT_PROBE_PROMPT)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((s) => this.titled(s));
  }

  /** `s` by the title its agent gave it, where the user gave it no name in the agent and one is known. Read each time
   *  the list is: the title changes while the record's file does not. */
  private titled(s: SessionSummary): SessionSummary {
    const custom = this.sources.customTitle?.(s.harness, s.id);
    if (custom) return { ...s, title: oneLine(custom, TITLE_CHARS) };
    if (s.named) return s;
    const given = this.sources.agentTitle?.(s.harness, s.id);
    return given ? { ...s, title: oneLine(given, TITLE_CHARS) } : s;
  }

  /** Codex's threads, one each. A long thread is kept in pages (Codex 0.162: `rollout-…-<thread>_<page>.jsonl`, each
   *  from where the one before ended, the same thread's id in each), which read as so many sessions of the same id —
   *  four of one thread in the list, the record and its deletion on its first page alone (2026-10-24). It is listed
   *  once: what was asked first from its earliest page, all the rest from its newest, which is the file read. */
  private codexThreads(refs: FileRef[], now: number): (SessionSummary | null)[] {
    const summaries = this.scan(refs, "codex", now);
    const by = new Map<string, { newest: SessionSummary; newestPath: string; first: SessionSummary }>();
    summaries.forEach((summary, i) => {
      if (!summary) return;
      const path = refs[i]!.path;
      const had = by.get(summary.id);
      if (!had) { by.set(summary.id, { newest: summary, newestPath: path, first: summary }); return; }
      if (summary.updatedAt > had.newest.updatedAt) { had.newest = summary; had.newestPath = path; }
      if (summary.startedAt < had.first.startedAt) had.first = summary;
    });
    return [...by.values()].map(({ newest, newestPath, first }) => {
      this.files.set(`codex:${newest.id}`, newestPath);
      return first === newest ? newest : { ...newest, title: first.title || newest.title, startedAt: first.startedAt };
    });
  }

  /** The model provider a Codex thread went on with last (its newest page's `thread_settings_applied`, else what it
   *  began with); null when it is not found or says none. A thread that ran under a profile that pays by a key says
   *  AgentSwitch's own (`agentswitch`), which only a terminal of that kind defines (terminals/launch.ts). */
  codexProvider(id: string): string | null {
    const path = this.locate("codex", id);
    if (!path) return null;
    try { return codexProviderOf(path); } catch { return null; }
  }

  /** Where a listed session is kept: its file (Claude Code, Codex, pi) or OpenCode's database; null for one not listed. */
  source(harness: SessionHarness, id: string): string | null {
    return harness === "opencode" ? this.sources.opencodeDb : this.files.get(`${harness}:${id}`) ?? null;
  }

  /** A listed session by its agent and id, wherever it falls in the list; null for one not listed. */
  find(harness: SessionHarness, id: string): SessionSummary | null {
    return this.list().find((s) => s.harness === harness && s.id === id) ?? null;
  }

  /** `chars`: how much of a message is kept (`MESSAGE_CHARS`, with a note of its length); Infinity keeps it whole. */
  read(harness: SessionHarness, id: string, limit = 80, chars = MESSAGE_CHARS): { session: SessionSummary; messages: SessionMessage[] } | null {
    const session = this.find(harness, id);
    if (!session) return null;
    if (harness === "opencode") { const messages = openCodeMessages(this.sources.opencodeDb, id, limit, chars); return messages && { session, messages }; }
    const path = this.files.get(`${harness}:${id}`);
    if (!path) return null;
    return { session, messages: harness === "claude-code" ? claudeMessages(path, limit, chars) : harness === "pi" ? piMessages(path, limit, chars) : codexMessages(path, limit, chars) };
  }

  /** A session's record for the simple view (docs/simple-view-v0.md §2): Claude Code's and Codex's from their files,
   *  step by step; the others' (and an older Codex rollout's) from the coarse messages, one line per tool. */
  record(harness: SessionHarness, id: string, o: { limit?: number; before?: number } = {}, ours = false): { session: SessionSummary; record: SessionRecord } | null {
    const found = this.open(harness, id, ours);
    if (!found) return null;
    const { session, path } = found;
    if (path && (harness === "claude-code" || harness === "codex")) {
      const record = readRecord(harness, path, { ...o, cwd: session.cwd });
      if (record) return { session, record };
    }
    // Whole: the record keeps TEXT_CHARS of each, as the step-by-step reader does. Clipped at MESSAGE_CHARS, an
    // answer of OpenCode's or pi's ended in "…（共 2822 字）" with no way to read the rest (2026-10-14, user: what is this).
    const coarse = this.read(harness, id, MAX_RECORD_LIMIT, Infinity);
    return coarse && { session, record: recordFromMessages(coarse.messages, `u${session.updatedAt.toString(36)}`) };
  }

  /** One step of a run of work, whole: its command as written and all it printed. */
  step(harness: SessionHarness, id: string, work: string, n: number, ours = false): StepDetail | null {
    const found = this.open(harness, id, ours);
    if (!found?.path || (harness !== "claude-code" && harness !== "codex")) return null;
    try { return readStep(harness, found.path, { work, n, cwd: found.session.cwd }); } catch { return null; }
  }

  /** A picture a step brought back: the `k`-th of the `n`-th step of the run of work `work`. */
  stepImage(harness: SessionHarness, id: string, work: string, n: number, k: number, ours = false): RecordImage | null {
    const found = this.open(harness, id, ours);
    if (!found?.path || (harness !== "claude-code" && harness !== "codex")) return null;
    try { return readStepImage(harness, found.path, { work, n, k, cwd: found.session.cwd }, this.sources.pictures?.seen); } catch { return null; }
  }

  /** A picture the user sent with a message of the session: the `n`-th of the record's item `item`. */
  image(harness: SessionHarness, id: string, item: string, n: number, ours = false): RecordImage | null {
    const found = this.open(harness, id, ours);
    if (!found?.path || (harness !== "claude-code" && harness !== "codex")) return null;
    try { return readImage(harness, found.path, item, n, this.sources.pictures?.sent); } catch { return null; }
  }

  /** A session and where it is kept. `ours`: it is the session of a terminal of ours, read wherever it runs — the list
   *  leaves out scratch folders (a terminal started under /tmp) and sessions with nothing said yet, and such a
   *  terminal's simple view had no record to show (found with a live probe, 2026-10-07). Anyone else's unlisted session
   *  stays unreadable by its id. */
  private open(harness: SessionHarness, id: string, ours: boolean): { session: SessionSummary; path: string | undefined } | null {
    const listed = this.find(harness, id);
    if (listed) return { session: listed, path: this.files.get(`${harness}:${id}`) };
    if (!ours) return null;
    const path = this.locate(harness, id);
    if (!path) return null;
    try {
      const st = statSync(path);
      if (harness === "codex") this.sources.pictures?.noticed(path, st.size, st.mtimeMs);
      const facts = harness === "claude-code" ? claudeFacts(path, st.mtimeMs) : harness === "pi" ? piFacts(path, st.mtimeMs) : codexFacts(path, st.mtimeMs);
      return facts ? { session: this.summary(harness, { startedAt: st.birthtimeMs || st.ctimeMs, ...facts }, this.now()), path } : null;
    } catch { return null; }
  }

  /** Where the session of a terminal of ours is kept, listed or not: its file as the list knows it, else looked for by
   *  its id (Claude Code's `<project>/<id>.jsonl`, Codex's `rollout-…-<id>.jsonl`, pi's `<time>_<id>.jsonl`). Null for
   *  OpenCode (one database for all) and for a session with no file yet. */
  locate(harness: SessionHarness, id: string): string | null {
    if (harness === "opencode" || !SESSION_ID.test(id)) return null;
    const key = `${harness}:${id}`;
    const known = this.files.get(key);
    if (known && existsSync(known)) return known;
    let found: string | null = null;
    // A Codex thread in pages: the newest page.
    let foundAt = -1;
    if (harness === "claude-code") {
      for (const root of [this.sources.claudeProjects, ...(this.sources.claudeProfileProjects?.() ?? [])]) for (const dir of safeDirs(root)) {
        const file = join(root, dir, `${id}.jsonl`);
        if (existsSync(file)) { found = file; break; }
      }
    } else if (harness === "codex") {
      const walk = (dir: string, left: number) => {
        for (const name of safeDirs(dir, true)) {
          const path = join(dir, name);
          if (left > 0) walk(path, left - 1);
          else if (codexFileOf(name, id)) {
            const at = (() => { try { return statSync(path).mtimeMs; } catch { return -1; } })();
            if (at > foundAt) { found = path; foundAt = at; }
          }
        }
      };
      walk(this.sources.codexSessions, 3);
    } else if (this.sources.piSessions) {
      for (const dir of safeDirs(this.sources.piSessions)) {
        const name = safeDirs(join(this.sources.piSessions, dir), true).find((n) => n.endsWith(`_${id}.jsonl`));
        if (name) { found = join(this.sources.piSessions, dir, name); break; }
      }
    }
    if (found) this.files.set(key, found);
    return found;
  }

  /** Every Codex record looked at for the picture files it names, and the copies tidied: what the list does as it is
   *  read, for the hours no screen reads it (a pasted picture's file lasts about three days). */
  keepPictures(): void {
    const pictures = this.sources.pictures;
    if (!pictures) return;
    for (const ref of jsonlFiles(this.sources.codexSessions, 3, this.now(), this.scanFiles)) pictures.noticed(ref.path, ref.size, ref.mtime);
    pictures.tidy();
  }

  /** The picture files in `dir` are kept now: the folder is about to go (a terminal's attached files, which Codex's
   *  record names by their place). */
  keepPicturesIn(dir: string): void {
    this.sources.pictures?.keepIn(dir);
  }

  /** What a session changed, file by file: in one run of work, else in its last turn. Null when it is not listed, the
   *  run is not there, or the agent's record carries no changes (OpenCode, pi). */
  changes(harness: SessionHarness, id: string, work?: string, ours = false): FileDiff[] | null {
    const found = this.open(harness, id, ours);
    if (!found?.path || (harness !== "claude-code" && harness !== "codex")) return null;
    return readChanges(harness, found.path, { ...(work !== undefined ? { work } : {}), cwd: found.session.cwd });
  }

  private scan(refs: FileRef[], harness: "claude-code" | "codex" | "pi", now: number): (SessionSummary | null)[] {
    return refs.map((ref) => {
      // Codex names a picture by its file's place: what the record grew by is read for them while they are there.
      if (harness === "codex") this.sources.pictures?.noticed(ref.path, ref.size, ref.mtime);
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

  private summary(harness: SessionHarness, f: { id: string; cwd: string; title: string; named?: true; lastText: string; updatedAt: number; startedAt?: number; origin?: string; branch?: string; model?: string; mode?: SessionMode; forkedFrom?: string }, now: number): SessionSummary {
    return {
      // The folder as the disk spells it: a session recorded in `~/x/pi` is with the ones in `~/x/Pi`.
      harness, id: f.id, cwd: keptDiskSpelling(f.cwd, now), title: oneLine(f.title, TITLE_CHARS), ...(f.named ? { named: true as const } : {}), lastText: oneLine(f.lastText, TITLE_CHARS),
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
      for (const root of [this.sources.claudeProjects, ...(this.sources.claudeProfileProjects?.() ?? [])]) for (const dir of safeDirs(root)) {
        const file = join(root, dir, `${id}.jsonl`);
        if (existsSync(file)) drop(file);
      }
    } else if (harness === "codex") {
      const walk = (dir: string, left: number) => {
        for (const name of safeDirs(dir, true)) {
          const path = join(dir, name);
          if (left > 0) walk(path, left - 1);
          else if (codexFileOf(name, id)) drop(path);
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

  /** A folder's one spelling (`/tmp/x` is `/private/tmp/x`), remembered: the disk is asked once for each. */
  private canon(cwd: string): string {
    const known = this.spelled.get(cwd);
    if (known !== undefined) return known;
    if (this.spelled.size > 5000) this.spelled.clear();
    const at = canonicalFolder(cwd);
    this.spelled.set(cwd, at);
    return at;
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

/** Records read in the folders the user shows, beside the newest of the rest. */
const SHOWN_FILES = 2000;

function claudeKey(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

/** A file of Codex thread `id`: its record (`rollout-<time>-<id>.jsonl`) or one of its pages (`…-<id>_<page>.jsonl`). */
export function codexFileOf(name: string, id: string): boolean {
  if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) return false;
  const stem = name.slice(0, -".jsonl".length);
  if (stem.endsWith(`-${id}`)) return true;
  const at = stem.lastIndexOf(`-${id}_`);
  return at > 0 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(stem.slice(at + id.length + 2));
}

/** `*.jsonl` files `depth` directories below `root`, the newest `limit` modified within `MAX_AGE_MS`; top-level
 *  directories `skip` names are not entered. */
/** `skip`: a folder right under `root` that is passed over — but for the records in it that `keep` names (by their
 *  file's name without `.jsonl`). */
function jsonlFiles(root: string, depth: number, now: number, limit: number, skip: (dir: string) => boolean = () => false, keep: (id: string) => boolean = () => false): FileRef[] {
  const found: FileRef[] = [];
  const walk = (dir: string, left: number, only: boolean) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      if (left > 0) { walk(path, left - 1, only || (dir === root && skip(name))); continue; }
      if (!name.endsWith(".jsonl") || (only && !keep(name.slice(0, -6)))) continue;
      try {
        const st = statSync(path);
        if (st.isFile() && now - st.mtimeMs < MAX_AGE_MS) found.push({ path, mtime: st.mtimeMs, size: st.size, born: st.birthtimeMs || st.ctimeMs });
      } catch { /* gone meanwhile */ }
    }
  };
  walk(root, depth, false);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}
