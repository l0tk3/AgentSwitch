/** Ephemeral tasks leave nothing behind: the work dir, Claude Code's per-project transcripts and
 *  OpenCode's session rows/snapshots for that directory. Codex already runs in a private CODEX_HOME
 *  that is deleted after every run, so it needs nothing here.
 *
 *  Deleting the work dir itself is guarded: only paths under the OS temp dir or the daemon's own
 *  work dir are ever removed, whatever the flag says. */

import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CleanupPaths = {
  readonly claudeHome: string;      // ~/.claude
  readonly opencodeData: string;    // ~/.local/share/opencode
  readonly workRoot: string;        // ~/.agentswitch/work
};

export type CleanupReport = {
  readonly workDirRemoved: boolean;
  readonly claudeProjectsRemoved: string[];
  readonly claudeHistoryLinesRemoved: number;
  readonly opencodeSessionsRemoved: number;
  readonly opencodeProjectsRemoved: number;
  readonly opencodeSnapshotsRemoved: string[];
  readonly errors: string[];
};

export function defaultCleanupPaths(env: NodeJS.ProcessEnv = process.env): CleanupPaths {
  const home = env.HOME ?? ".";
  return {
    claudeHome: join(home, ".claude"),
    opencodeData: join(home, ".local", "share", "opencode"),
    workRoot: join(env.AGENTSWITCH_HOME ?? join(home, ".agentswitch"), "work"),
  };
}

/** Claude Code names the per-project dir by replacing every non-alphanumeric character with "-". */
export function claudeProjectKey(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Both spellings of a path (macOS: /var/... and /private/var/...). */
export function spellings(cwd: string): string[] {
  const out = new Set([cwd]);
  try { out.add(realpathSync(cwd)); } catch { /* gone already */ }
  if (cwd.startsWith("/private/")) out.add(cwd.slice("/private".length));
  else if (cwd.startsWith("/var/") || cwd.startsWith("/tmp/")) out.add("/private" + cwd);
  return [...out];
}

export function isDeletableWorkDir(cwd: string, paths: CleanupPaths): boolean {
  const roots = [tmpdir(), paths.workRoot].flatMap((r) => { try { return [r, realpathSync(r)]; } catch { return [r]; } });
  return spellings(resolve(cwd)).some((p) => roots.some((r) => p.startsWith(r.replace(/\/$/, "") + sep)));
}

function cleanClaude(cwd: string, paths: CleanupPaths, report: { claudeProjectsRemoved: string[]; claudeHistoryLinesRemoved: number; errors: string[] }): void {
  for (const p of spellings(cwd)) {
    const dir = join(paths.claudeHome, "projects", claudeProjectKey(p));
    if (!existsSync(dir)) continue;
    try { rmSync(dir, { recursive: true, force: true }); report.claudeProjectsRemoved.push(dir); } catch (e) { report.errors.push(`claude project dir: ${(e as Error).message}`); }
  }
  const history = join(paths.claudeHome, "history.jsonl");
  if (!existsSync(history)) return;
  try {
    const lines = readFileSync(history, "utf8").split("\n");
    const keep = lines.filter((l) => { if (!l.trim()) return true; try { const proj = (JSON.parse(l) as { project?: string }).project; return !proj || !spellings(cwd).includes(proj); } catch { return true; } });
    const removed = lines.length - keep.length;
    if (removed > 0) writeFileSync(history, keep.join("\n"));
    report.claudeHistoryLinesRemoved = removed;
  } catch (e) { report.errors.push(`claude history: ${(e as Error).message}`); }
}

function cleanOpenCode(cwd: string, paths: CleanupPaths, report: { opencodeSessionsRemoved: number; opencodeProjectsRemoved: number; opencodeSnapshotsRemoved: string[]; errors: string[] }): void {
  const dbPath = join(paths.opencodeData, "opencode.db");
  if (!existsSync(dbPath)) return;
  const dirs = spellings(cwd);
  const marks = dirs.map(() => "?").join(", ");
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("BEGIN");
      const sessions = (db.prepare(`SELECT id FROM session_v2 WHERE directory IN (${marks})`).all(...dirs) as { id: string }[]).map((r) => r.id);
      for (const t of ["session_message", "session_pending", "session_inbox"]) {
        for (const id of sessions) db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(id);
      }
      report.opencodeSessionsRemoved = Number(db.prepare(`DELETE FROM session_v2 WHERE directory IN (${marks})`).run(...dirs).changes);
      const projects = (db.prepare(`SELECT id FROM project WHERE worktree IN (${marks})`).all(...dirs) as { id: string }[]).map((r) => r.id);
      db.prepare(`DELETE FROM project_directory WHERE directory IN (${marks})`).run(...dirs);
      for (const id of projects) {
        db.prepare("DELETE FROM worktree WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM project_directory WHERE project_id = ?").run(id);
        db.prepare("DELETE FROM project WHERE id = ?").run(id);
        for (const sub of ["snapshot", "tool-output"]) {
          const dir = join(paths.opencodeData, sub, id);
          if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); report.opencodeSnapshotsRemoved.push(dir); }
        }
      }
      report.opencodeProjectsRemoved = projects.length;
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; } finally { db.close(); }
  } catch (e) { report.errors.push(`opencode db: ${(e as Error).message}`); }
}

export function cleanupEphemeral(cwd: string, paths: CleanupPaths): CleanupReport {
  const report = { workDirRemoved: false, claudeProjectsRemoved: [] as string[], claudeHistoryLinesRemoved: 0, opencodeSessionsRemoved: 0, opencodeProjectsRemoved: 0, opencodeSnapshotsRemoved: [] as string[], errors: [] as string[] };
  cleanClaude(cwd, paths, report);
  cleanOpenCode(cwd, paths, report);
  if (isDeletableWorkDir(cwd, paths)) {
    try { rmSync(cwd, { recursive: true, force: true }); report.workDirRemoved = true; } catch (e) { report.errors.push(`work dir: ${(e as Error).message}`); }
  } else {
    report.errors.push(`work dir kept: ${cwd} is not under ${tmpdir()} or ${paths.workRoot}`);
  }
  return report;
}
