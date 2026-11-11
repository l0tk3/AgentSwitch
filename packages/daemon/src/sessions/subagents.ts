/** A Claude Code session's sub-agents as Claude Code itself keeps them (seen on 2.1.319): beside the session's file
 *  `<session id>.jsonl`, a folder `<session id>/subagents/` with one file a sub-agent — `agent-<agent id>.jsonl`, its
 *  lines as the session's own, each marked `isSidechain` — and beside each `agent-<agent id>.meta.json`: its kind
 *  (`agentType`), what it was sent to do (`description`), and `finished` once it has ended. The id is the one its hook
 *  calls carry (`agent_id`, terminals/host.ts) and the result of the call that sent it names (`agentId`, record.ts).
 *
 *  What a sub-agent did is read from its file as a record (`readRecord` with `side`), for the screens' sub-agent card
 *  (docs/simple-view-v0.md §5.22). Read-only; nothing here opens a file by a name a caller made up: the id is letters
 *  and digits, and the file is looked for in the session's own folder alone. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { obj, str } from "./jsonl.js";
import { AGENT_ID } from "./record.js";

export type SubagentSummary = {
  readonly id: string;
  /** Its kind (`Explore`, `general-purpose` …); "" where Claude Code did not say. */
  readonly type: string;
  /** What it was sent to do (the Agent tool's `description`); "" where Claude Code did not say. */
  readonly name: string;
  /** When its file was made, and when it was last written. */
  readonly startedAt: number;
  readonly updatedAt: number;
  /** It has ended, as Claude Code marks it. False: still at work, or stopped short of its end (its terminal closed). */
  readonly done: boolean;
};

/** A session's sub-agents listed: the latest so many (a long session sends hundreds). */
export const SUBAGENT_LIMIT = 200;
/** A meta file is a line of JSON: one larger than this is not Claude Code's. */
const META_BYTES = 64 * 1024;
const FILE = /^agent-([A-Za-z0-9_-]{1,80})\.jsonl$/;

/** Where the sub-agents of the session kept in `sessionFile` are. */
export function subagentsDir(sessionFile: string): string {
  return join(dirname(sessionFile), basename(sessionFile, ".jsonl"), "subagents");
}

/** The file of sub-agent `agent` of the session kept in `sessionFile`; null for an id that is not one, or no file. */
export function subagentFile(sessionFile: string, agent: string): string | null {
  if (!AGENT_ID.test(agent)) return null;
  const file = join(subagentsDir(sessionFile), `agent-${agent}.jsonl`);
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}

/** What Claude Code wrote beside a sub-agent's file; nothing where there is none (or it cannot be read as one). */
function meta(file: string): { type: string; name: string; done: boolean } {
  const path = file.replace(/\.jsonl$/, ".meta.json");
  try {
    if (statSync(path).size > META_BYTES) return { type: "", name: "", done: false };
    const m = obj(JSON.parse(readFileSync(path, "utf8")) as unknown);
    return { type: oneLine(str(m.agentType), 80), name: oneLine(str(m.description), 200), done: m.finished === true };
  } catch { return { type: "", name: "", done: false }; }
}

const oneLine = (text: string, limit: number): string => text.replace(/\s+/g, " ").trim().slice(0, limit);

function summary(file: string, id: string): SubagentSummary | null {
  try {
    const st = statSync(file);
    if (!st.isFile()) return null;
    return { id, ...meta(file), startedAt: Math.round(st.birthtimeMs || st.ctimeMs), updatedAt: Math.round(st.mtimeMs) };
  } catch { return null; }
}

/** Sub-agent `agent` of the session kept in `sessionFile`; null when it has no such one. */
export function subagentOf(sessionFile: string, agent: string): SubagentSummary | null {
  const file = subagentFile(sessionFile, agent);
  return file ? summary(file, agent) : null;
}

/** The sub-agents of the session kept in `sessionFile`, in the order they started: the latest `limit`. None for a
 *  session that sent none (or an agent that keeps them otherwise). */
export function listSubagents(sessionFile: string, limit = SUBAGENT_LIMIT): SubagentSummary[] {
  const dir = subagentsDir(sessionFile);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const all: SubagentSummary[] = [];
  for (const name of names) {
    const id = FILE.exec(name)?.[1];
    const one = id ? summary(join(dir, name), id) : null;
    if (one) all.push(one);
  }
  return all.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)).slice(-Math.max(1, limit));
}
