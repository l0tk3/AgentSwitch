import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** A Claude Code session going on under another profile: its record goes to that profile and is given a new id there,
 *  with what Claude Code keeps beside it by that id — the folder of its subagents' records, its file history, its
 *  environment, its todos. One conversation stays one record: whoever goes on with it next finds everything said so
 *  far, and the list shows it once. And no two profiles ever send the same session id: an id seen under one account
 *  and then under another says the two are one person's (2026-11-22, user: 用其他profile继续的话应该换一个新的会话 id).
 *
 *  Until then it was copied under a new id where a profile kept its own sessions, the first left where it was — two
 *  rows for one conversation, each missing what was said in the other, a third at the next tap — and went on under the
 *  same id between profiles that share their sessions.
 *
 *  `source`: the record, `<config>/projects/<folder>/<id>.jsonl`. `projects`: the target's `projects` folder (the same
 *  folder for profiles that share their sessions: the record is then renamed where it is). The record keeps the folder
 *  name it had — Claude Code finds a session by its id wherever it runs it next — and every line as it was but for
 *  the id. Returns the new id. Throws when the record cannot be written there: nothing is changed then. What stands
 *  beside it follows as far as it goes: a piece left behind is no reason to undo the record's move. */
export function moveClaudeSession(source: string, projects: string, id: string = randomUUID()): string {
  const file = basename(source), old = file.replace(/\.jsonl$/, "");
  if (!SESSION_ID.test(old) || file === old || !SESSION_ID.test(id) || id === old) throw new Error("not a session record");
  const fromFolder = dirname(source), toFolder = join(projects, basename(fromFolder));
  const fromConfig = dirname(dirname(fromFolder)), toConfig = dirname(projects);
  const to = join(toFolder, `${id}.jsonl`);
  if (existsSync(to)) throw new Error("the target already has this session");
  mkdirSync(toFolder, { recursive: true, mode: 0o700 });
  // The record whole under its new id first, then the old one removed: at no moment is there none.
  const part = `${to}.part`;
  try {
    rewritten(source, part, old, id);
    renameSync(part, to);
  } catch (err) { rmSync(part, { force: true }); throw err; }
  rmSync(source, { force: true });
  const beside: [string, string][] = [[join(fromFolder, old), join(toFolder, id)], ...["file-history", "session-env"].map((kind): [string, string] => [join(fromConfig, kind, old), join(toConfig, kind, id)])];
  try { for (const name of readdirSync(join(fromConfig, "todos"))) if (name.startsWith(old)) beside.push([join(fromConfig, "todos", name), join(toConfig, "todos", name.split(old).join(id))]); } catch { /* it keeps none */ }
  for (const [from, there] of beside) {
    try {
      if (!existsSync(from) || existsSync(there)) continue;
      mkdirSync(dirname(there), { recursive: true, mode: 0o700 });
      move(from, there);
    } catch { /* left where it was */ }
  }
  // Its subagents' records name the session they belong to as well.
  try {
    const agents = join(toFolder, id, "subagents");
    for (const name of readdirSync(agents)) if (name.endsWith(".jsonl")) { const at = join(agents, name); rewritten(at, `${at}.part`, old, id); renameSync(`${at}.part`, at); }
  } catch { /* it has none */ }
  return id;
}

/** A Codex thread going on under a profile that keeps its own sessions, or coming from one: its record's files (a
 *  thread may be in several) go to that profile's `sessions`, each under the dated folders it was in. As they are and
 *  under the id they have — Codex's id is in the file's name, in its first line and in Codex's own database, and a
 *  record under another would be another thread to it. `file`: one of them, `<sessions>/<y>/<m>/<d>/<name>`; `mine`:
 *  whether a file's name is this thread's. Throws, with nothing moved, when the target has one of them already. */
export function moveCodexSession(file: string, sessions: string, mine: (name: string) => boolean): void {
  const from = dirname(dirname(dirname(dirname(file))));
  if (same(from, sessions)) return;
  const found: string[] = [];
  const walk = (dir: string, left: number, under: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (left > 0) walk(join(dir, name), left - 1, join(under, name));
      else if (mine(name)) found.push(join(under, name));
    }
  };
  walk(from, 3, "");
  if (!found.length) throw new Error("the thread has no record");
  if (found.some((rel) => existsSync(join(sessions, rel)))) throw new Error("the target already has this thread");
  for (const rel of found) {
    mkdirSync(dirname(join(sessions, rel)), { recursive: true, mode: 0o700 });
    move(join(from, rel), join(sessions, rel));
  }
}

function same(a: string, b: string): boolean {
  const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  return real(a) === real(b);
}

const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/;

/** `from` written to `to` with the session's id replaced wherever a line names it as its own (`"sessionId":"…"`):
 *  nothing else of a line is touched, and the file keeps its times (the list sorts by them). */
function rewritten(from: string, to: string, old: string, id: string): void {
  const names = new RegExp(`("sessionId"\\s*:\\s*")${old}(")`, "g");
  const st = statSync(from);
  writeFileSync(to, readFileSync(from, "utf8").replace(names, `$1${id}$2`), { mode: 0o600, flag: "wx" });
  try { utimesSync(to, st.atime, st.mtime); } catch { /* now, then */ }
}

/** A rename, or — across disks — a copy that is removed where it came from once it is whole. */
function move(from: string, to: string): void {
  try { renameSync(from, to); return; } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err; }
  try { cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true }); }
  catch (err) { rmSync(to, { recursive: true, force: true }); throw err; }
  rmSync(from, { recursive: true, force: true });
}
