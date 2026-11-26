/** Grok sessions (xAI's Grok Build): `~/.grok/sessions/<folder, URL-encoded>/<session id>/` (`GROK_HOME` moves
 *  `~/.grok`), a folder a session. In it `summary.json` — its id and folder (`info`), the title Grok gave it, when it
 *  began and was last written, its model — and `updates.jsonl`, the conversation as it was shown, an update a line:
 *  `user_message_chunk` and `agent_message_chunk` carry what was said (`content.text`), `tool_call` a tool with what it
 *  was given (`rawInput`), and beside them its thinking, its hooks' runs and each turn's end. A sub-agent's session is
 *  kept the same way among the others, marked `session_kind: "subagent"`: it is its parent's work, not a session of the
 *  user's. Read 2026-11-11 from Grok 1.0.77 (docs/terminal-v0.md §3 Grok). */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isTypedText, obj, str, tailLines, time, type Json } from "./jsonl.js";
import { clipText, MESSAGE_CHARS, type SessionMessage } from "./types.js";

export type GrokFacts = { readonly id: string; readonly cwd: string; readonly title: string; readonly named?: true; readonly lastText: string; readonly updatedAt: number; readonly startedAt?: number; readonly model?: string };

/** The file a session's conversation is in, which stands for the session here (its folder holds the rest). */
export const GROK_RECORD = "updates.jsonl";
const SUMMARY = "summary.json";

/** Grok's own folder: `GROK_HOME`, else `~/.grok`. Null when there is no home to look under. */
export function grokHome(env: NodeJS.ProcessEnv = process.env): string | null {
  const set = env.GROK_HOME?.trim();
  if (set) return set;
  return env.HOME ? join(env.HOME, ".grok") : null;
}

const update = (line: Json): Json => obj(obj(line.params).update);
const kind = (line: Json): string => str(update(line).sessionUpdate);

/** When a line was written: the agent's own clock in milliseconds, else the line's (whole seconds). */
function stamp(line: Json): number {
  const ms = obj(obj(line.params)._meta).agentTimestampMs;
  if (typeof ms === "number" && Number.isFinite(ms)) return ms;
  return typeof line.timestamp === "number" && Number.isFinite(line.timestamp) ? line.timestamp * 1000 : 0;
}

function said(line: Json, which: "user_message_chunk" | "agent_message_chunk"): string | null {
  if (kind(line) !== which) return null;
  const content = obj(update(line).content);
  const text = content.type === "text" ? str(content.text).trim() : "";
  return text || null;
}

function userText(line: Json): string | null {
  const text = said(line, "user_message_chunk");
  return text && isTypedText(text) ? text : null;
}

const assistantText = (line: Json): string | null => said(line, "agent_message_chunk");

/** What a line says, for search: a prompt the user typed or the agent's reply (not its thinking, its tools, its hooks). */
export function grokSaid(line: Json): string | null {
  return userText(line) ?? assistantText(line);
}

/** The folder a group of sessions ran in, from the group folder's name where `summary.json` does not say: the path
 *  URL-encoded, or (a name too long for that) kept in a `.cwd` file inside. */
function groupFolder(group: string): string {
  try {
    const kept = join(group, ".cwd");
    if (existsSync(kept)) return readFileSync(kept, "utf8").trim();
    const name = decodeURIComponent(basename(group));
    return name.startsWith("/") ? name : "";
  } catch {
    return "";
  }
}

/** What the list shows of the session whose conversation is `path` (`…/<id>/updates.jsonl`): its title as Grok named
 *  it (else the first typed prompt read), the latest reply, the model and where it ran. Null for a sub-agent's session
 *  and for a folder that is not a session's. */
export function grokFacts(path: string, mtime: number): GrokFacts | null {
  const dir = dirname(path);
  let summary: Json = {};
  try { summary = obj(JSON.parse(readFileSync(join(dir, SUMMARY), "utf8"))); } catch { /* not written yet, or being written */ }
  if (summary.session_kind === "subagent") return null;
  const info = obj(summary.info);
  const id = str(info.id) || basename(dir);
  const cwd = str(info.cwd) || groupFolder(dirname(dir));
  if (!id || !cwd) return null;
  const lines = tailLines(path).map(obj);
  const last = [...lines].reverse();
  // Grok names its sessions itself: that name stands, whatever a terminal's title said (sessions/titles.ts).
  const own = str(summary.generated_title).trim() || str(summary.session_summary).trim();
  const title = own || (lines.map(userText).find((t) => t !== null) ?? "");
  const lastText = last.map(assistantText).find((t) => t !== null) ?? "";
  const written = Math.max(time(summary.updated_at), time(summary.last_active_at), stamp(last[0] ?? {}));
  const started = time(summary.created_at);
  const model = str(summary.current_model_id);
  return {
    id, cwd, title, ...(own ? { named: true as const } : {}), lastText, updatedAt: Math.max(written, mtime),
    ...(started ? { startedAt: started } : {}), ...(model ? { model } : {}),
  };
}

/** The last `limit` messages: typed prompts, replies, and one line per tool call. */
export function grokMessages(path: string, limit: number, chars = MESSAGE_CHARS): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const line of tailLines(path).map(obj)) {
    const ts = stamp(line);
    const user = userText(line);
    if (user) { out.push({ role: "user", text: clipText(user, chars), ts }); continue; }
    const reply = assistantText(line);
    if (reply) { out.push({ role: "assistant", text: clipText(reply, chars), ts }); continue; }
    if (kind(line) !== "tool_call") continue;
    const u = update(line);
    const tool = str(obj(obj(u._meta)["x.ai/tool"]).name) || str(u.title);
    out.push({ role: "tool", tool, text: clipText(toolSummary(obj(u.rawInput)), chars), ts });
  }
  return out.slice(-limit);
}

function toolSummary(input: Json): string {
  for (const key of ["command", "target_file", "file_path", "target_directory", "path", "pattern", "url", "query", "description"]) {
    if (str(input[key])) return str(input[key]);
  }
  return JSON.stringify(input);
}

/** The sessions of the sub-agents a session sent off, by their ids: Grok names each in the session's own
 *  `subagents/` folder and keeps its session among the others. */
export function grokChildren(dir: string, names: (dir: string) => string[]): string[] {
  return names(join(dir, "subagents")).filter((n) => /^[A-Za-z0-9_-]{1,80}$/.test(n));
}
