/** The Mac's coding sessions by folder (docs/control-v0.md §3): what the assistant and the router read. One line per
 *  folder — when it was last worked in, which executors, how many sessions and each one's latest title, clipped and
 *  masked. Only metadata: never a session's text. */

import { ago } from "../util/ago.js";
import { maskSecrets, oneLine, type SessionHarness, type SessionSummary } from "./types.js";

/** How many sessions are read to build the lines (the monitor keeps the newest per harness anyway). */
export const SESSIONS_READ = 500;
/** Folders the assistant sees, newest first. */
export const FOLDERS_SHOWN = 20;
const TITLE_CHARS = 50;

const NAMES: Record<SessionHarness, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" };

type Folder = { readonly cwd: string; readonly sessions: readonly SessionSummary[] };

/** Sessions grouped by folder, newest folder first; within a folder, newest session first. */
function byFolder(sessions: readonly SessionSummary[]): Folder[] {
  const groups = new Map<string, SessionSummary[]>();
  for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) groups.set(s.cwd, [...(groups.get(s.cwd) ?? []), s]);
  return [...groups].map(([cwd, list]) => ({ cwd, sessions: list }));
}

function folderLine(folder: Folder, now: number): string {
  const newest = folder.sessions[0]!;
  const when = folder.sessions.some((s) => s.active) ? "running now" : ago(now - newest.updatedAt);
  const harnesses = [...new Set(folder.sessions.map((s) => s.harness))].map((h) => {
    const mine = folder.sessions.filter((s) => s.harness === h);
    const latest = mine[0]!;
    const title = latest.title ? `: "${maskSecrets(oneLine(latest.title, TITLE_CHARS))}"` : "";
    return `${NAMES[h]} ${mine.length} (latest ${latest.active ? "just now" : ago(now - latest.updatedAt)}${title})`;
  });
  return `- ${folder.cwd} · ${when} · ${harnesses.join(", ")}`;
}

/** Folders too broad to work in (tasks may not use them), so neither offered nor counted as a project's parent. */
export function broadFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["/", env.HOME ?? ""].filter(Boolean);
}

/** For the assistant: every folder the user worked in, newest first, at most `limit`. */
export function folderLines(sessions: readonly SessionSummary[], now: number, limit = FOLDERS_SHOWN, broad: readonly string[] = []): string {
  const folders = byFolder(sessions.filter((s) => !broad.includes(s.cwd))).slice(0, limit);
  return folders.length ? folders.map((f) => folderLine(f, now)).join("\n") : "(none)";
}

/** For the router: the user's sessions in the task's folder, below it, or in a folder it sits in; null when none. */
export function sessionsNear(sessions: readonly SessionSummary[], cwd: string, now: number, broad: readonly string[] = []): string | null {
  const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
  const near = byFolder(sessions.filter((s) => !broad.includes(s.cwd) && (within(s.cwd, cwd) || within(cwd, s.cwd))));
  return near.length ? near.map((f) => folderLine(f, now)).join("\n") : null;
}
