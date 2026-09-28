/** Is an agent's session open in another program right now (docs/terminal-v0.md §5)? "Continue" goes on in the same
 *  session — one record, and whoever opens it next sees what was said — so only one program may write it at a time.
 *  Codex locks a conversation while a process writes it (`~/.codex/thread-writer-locks/<id>.lock`); Claude Code has no
 *  lock, but lists each running session in `~/.claude/sessions/<pid>.json` and removes the file when it exits. */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { TerminalHarness } from "./host.js";

const run = promisify(execFile);
const TIMEOUT_MS = 3000;

export type Elsewhere = {
  readonly pid: number;
  /** The app it runs in (iTerm2, ChatGPT, Visual Studio Code); null when none was found (a detached tmux, say). */
  readonly app: string | null;
};

/** `ours`: the pids of AgentSwitch's own terminals — a session one of them holds is not "elsewhere". */
export type ElsewhereCheck = (harness: TerminalHarness, sessionId: string, ours: readonly number[]) => Promise<Elsewhere | null>;

export type Proc = { readonly ppid: number; readonly comm: string };

export type ElsewhereOptions = {
  readonly home?: string;
  /** The pids holding a file open (lsof). */
  readonly holders?: (file: string) => Promise<number[]>;
  /** Every process: pid → parent and executable path (ps). */
  readonly processes?: () => Promise<Map<number, Proc>>;
  readonly alive?: (pid: number) => boolean;
  /** An app bundle's name as Finder shows it (its Info.plist), null to use the bundle's file name. */
  readonly appName?: (bundle: string) => Promise<string | null>;
};

async function lsofHolders(file: string): Promise<number[]> {
  // lsof exits 1 when nobody holds the file.
  const out = await run("lsof", ["-t", "--", file], { timeout: TIMEOUT_MS }).then((r) => r.stdout, (err: { stdout?: string }) => err.stdout ?? "");
  return out.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

async function psTable(): Promise<Map<number, Proc>> {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,comm="], { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  const table = new Map<number, Proc>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3]!.trim() });
  }
  return table;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function plistName(bundle: string): Promise<string | null> {
  for (const key of ["CFBundleDisplayName", "CFBundleName"]) {
    const name = await run("plutil", ["-extract", key, "raw", "-o", "-", join(bundle, "Contents", "Info.plist")], { timeout: TIMEOUT_MS })
      .then((r) => r.stdout.trim(), () => "");
    if (name) return name;
  }
  return null;
}

/** The pids Claude Code lists as running `sessionId`. */
export function claudeRunning(dir: string, sessionId: string): number[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of names) {
    try {
      const entry = JSON.parse(readFileSync(join(dir, name), "utf8")) as { pid?: unknown; sessionId?: unknown };
      if (entry.sessionId === sessionId && Number.isInteger(entry.pid)) pids.push(entry.pid as number);
    } catch { /* being written, or not ours to read */ }
  }
  return pids;
}

/** `pid` and its parents, nearest first. */
function ancestry(table: Map<number, Proc>, pid: number): number[] {
  const chain: number[] = [];
  for (let p: number | undefined = pid; p && p > 1 && !chain.includes(p) && chain.length < 32; p = table.get(p)?.ppid) chain.push(p);
  return chain;
}

/** The outermost app bundle an executable lives in: `/Applications/ChatGPT.app/…/CodexCLI.app/…/codex` → ChatGPT.app. */
const bundleOf = (comm: string): string | null => /^(.*?\.app)\//.exec(comm)?.[1] ?? null;

export function elsewhereCheck(opts: ElsewhereOptions = {}): ElsewhereCheck {
  const home = opts.home ?? homedir();
  const holders = opts.holders ?? lsofHolders;
  const processes = opts.processes ?? psTable;
  const alive = opts.alive ?? isAlive;
  const appName = opts.appName ?? plistName;
  return async (harness, sessionId, ours) => {
    let pids: number[];
    if (harness === "claude-code") {
      pids = claudeRunning(join(home, ".claude", "sessions"), sessionId).filter(alive);
    } else if (harness === "codex") {
      const lock = join(home, ".codex", "thread-writer-locks", `${sessionId}.lock`);
      pids = existsSync(lock) ? await holders(lock).catch(() => []) : [];
    } else {
      return null;   // OpenCode: nothing to look at (the page asks when the session was active lately)
    }
    if (pids.length === 0) return null;
    const table = await processes().catch(() => new Map<number, Proc>());
    const mine = new Set(ours);
    for (const pid of pids) {
      const proc = table.get(pid);
      // A Claude Code entry whose pid now belongs to some other program is left over from a crash.
      if (harness === "claude-code" && proc && !/claude|node|bun/i.test(proc.comm)) continue;
      const chain = ancestry(table, pid);
      if (chain.some((p) => mine.has(p))) continue;   // one of AgentSwitch's own terminals
      // The app it runs in: the first parent inside an .app (the agent's own executable may be in one, like Codex's).
      const bundle = chain.slice(1).map((p) => bundleOf(table.get(p)?.comm ?? "")).find(Boolean) ?? null;
      const app = bundle ? (await appName(bundle).catch(() => null)) ?? basename(bundle, ".app") : null;
      return { pid, app };
    }
    return null;
  };
}
