/** Git at a glance for the terminal tree's folders (docs/terminal-v0.md §5 "git 状态"): the branch, how many files
 *  changed, how far ahead of or behind its upstream — `main ±5 ↑2 ↓4` after the folder's name. Only for folders the tree
 *  shows (a terminal's or a session's), never a path a caller names. `git status` runs without the file-system monitor
 *  and without optional locks (a status must not take the index lock an agent's own git needs), at most a few at a
 *  time, and gives up after 1.5 s (a huge repository shows nothing rather than slowing everything). A result is kept a
 *  while: a look after that gets it at once and a fresh one comes in the background; an agent finishing a tool call in a
 *  folder marks it out of date. */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type GitSummary = {
  /** The branch, or the commit's short id when detached. */
  readonly branch: string;
  /** Files changed, staged or not, untracked included. */
  readonly changed: number;
  readonly ahead: number;
  readonly behind: number;
};

type Entry = { value: GitSummary | null; at: number; stale: boolean; running: Promise<void> | null };
type Run = (cwd: string, timeoutMs: number) => Promise<string | null>;

export type GitStatusOptions = {
  /** How long a result counts as fresh (default 15 s). */
  readonly freshMs?: number;
  /** A `git status` that takes longer is given up (default 1.5 s). */
  readonly timeoutMs?: number;
  /** How many run at once (default 4). */
  readonly parallel?: number;
  readonly now?: () => number;
  /** Runs `git status` in a folder: its output, or null (not a repository, no git, too slow). */
  readonly run?: Run;
};

export class GitStatus {
  private readonly entries = new Map<string, Entry>();
  private readonly o: Required<GitStatusOptions>;
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(opts: GitStatusOptions = {}) {
    this.o = { freshMs: 15_000, timeoutMs: 1_500, parallel: 4, now: Date.now, run: runGitStatus, ...opts };
  }

  /** Each folder's summary (a folder not in a repository is left out). A folder never looked at is waited for, up to
   *  `waitMs`; one out of date answers what it had and looks again in the background. */
  async summaries(folders: Iterable<string>, waitMs = this.o.timeoutMs + 100): Promise<Record<string, GitSummary>> {
    const firsts: Promise<void>[] = [];
    const wanted = [...new Set(folders)];
    for (const cwd of wanted) {
      const e = this.entries.get(cwd);
      if (!e) firsts.push(this.refresh(cwd));
      else if ((e.stale || this.o.now() - e.at >= this.o.freshMs) && !e.running) void this.refresh(cwd);
    }
    if (firsts.length) await Promise.race([Promise.all(firsts), sleep(waitMs)]);
    const out: Record<string, GitSummary> = {};
    for (const cwd of wanted) {
      const value = this.entries.get(cwd)?.value;
      if (value) out[cwd] = value;
    }
    return out;
  }

  /** Something may have changed in `cwd` (an agent's tool call ended there): looked at again on the next ask. */
  invalidate(cwd: string): void {
    for (const [path, e] of this.entries) if (path === cwd || path.startsWith(`${cwd}/`) || cwd.startsWith(`${path}/`)) e.stale = true;
  }

  private refresh(cwd: string): Promise<void> {
    const e = this.entries.get(cwd) ?? { value: null, at: 0, stale: false, running: null };
    this.entries.set(cwd, e);
    if (e.running) return e.running;
    e.stale = false;
    e.running = this.slot(async () => {
      const out = await this.o.run(cwd, this.o.timeoutMs).catch(() => null);
      // A look that timed out keeps what was known; one that says "no repository" clears it.
      if (out !== null) e.value = parseGitStatus(out);
      else if (!e.at) e.value = null;
      e.at = this.o.now();
    }).finally(() => { e.running = null; });
    return e.running;
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.o.parallel) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try { return await work(); } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** `git status --porcelain=v2 --branch`: the header lines say the branch and ahead/behind, every other line is a file. */
export function parseGitStatus(out: string): GitSummary | null {
  let head = "", oid = "", ahead = 0, behind = 0, changed = 0;
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) head = line.slice(14).trim();
    else if (line.startsWith("# branch.oid ")) oid = line.slice(13).trim();
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
    } else if (!line.startsWith("#")) changed++;
  }
  if (!head) return null;
  const branch = head === "(detached)" ? (oid && oid !== "(initial)" ? oid.slice(0, 7) : "detached") : head;
  return { branch, changed, ahead, behind };
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/** The real `git status`: null when the folder is not in a repository, git is missing, or it takes too long. */
const runGitStatus: Run = (cwd, timeoutMs) => new Promise((resolve) => {
  const git = gitBinary();
  if (!git || !existsSync(cwd)) return resolve(null);
  const child = spawn(git, ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "--no-optional-locks",
    "status", "--porcelain=v2", "--branch", "--untracked-files=normal", "--ignore-submodules=dirty"], {
    cwd, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  let out = "", size = 0, done = false;
  const finish = (value: string | null) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
  const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, timeoutMs);
  timer.unref();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    size += chunk.length;
    if (size > MAX_OUTPUT) { child.kill("SIGKILL"); finish(null); return; }
    out += chunk;
  });
  child.on("error", () => finish(null));
  child.on("close", (code) => finish(code === 0 ? out : ""));
});

let gitPath: string | null | undefined;

/** git on the PATH. On macOS `/usr/bin/git` is only a stub without the developer tools, and running it asks the user to
 *  install them: it is used only when they are there. */
export function gitBinary(): string | null {
  if (gitPath !== undefined) return gitPath;
  const found = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "git")).find((p) => existsSync(p)) ?? null;
  if (found === "/usr/bin/git" && process.platform === "darwin") {
    gitPath = spawnSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore", timeout: 2000 }).status === 0 ? found : null;
  } else gitPath = found;
  return gitPath;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
