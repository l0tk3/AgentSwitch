/** pi sessions: `~/.pi/agent/sessions/--<folder>--/<time>_<id>.jsonl` (`PI_CODING_AGENT_DIR` moves `~/.pi/agent`). The
 *  first line is the session (`id`, `cwd`, `timestamp`); then entries, `message` ones with role user, assistant or
 *  toolResult (content parts text, thinking, toolCall), and `session_info` when the user names it (`/name`; the last one
 *  counts). 2026-10-01, user: opencode、pi 都加上删除支持 — pi's sessions were not listed before. */

import { basename } from "node:path";
import { headLines, isTypedText, obj, str, tailLines, time, type Json } from "./jsonl.js";
import { clipText, type SessionMessage } from "./types.js";

export type PiFacts = { readonly id: string; readonly cwd: string; readonly title: string; readonly lastText: string; readonly updatedAt: number; readonly startedAt?: number; readonly model?: string };

function parts(line: Json): Json[] {
  const c = obj(line.message).content;
  return Array.isArray(c) ? c.map(obj) : typeof c === "string" ? [{ type: "text", text: c }] : [];
}

function text(line: Json): string {
  return parts(line).map((p) => (p.type === "text" ? str(p.text) : "")).join("\n").trim();
}

const role = (line: Json): string => (line.type === "message" ? str(obj(line.message).role) : "");

function userText(line: Json): string | null {
  if (role(line) !== "user") return null;
  const t = text(line);
  return isTypedText(t) ? t : null;
}

function assistantText(line: Json): string | null {
  return role(line) === "assistant" ? text(line) || null : null;
}

/** What a line says, for search: a prompt the user typed or the agent's reply (not tool calls or their results). */
export function piSaid(line: Json): string | null {
  return userText(line) ?? assistantText(line);
}

/** The id from the file name when the first line lacks it: `<time>_<id>.jsonl`. */
function idOf(path: string): string {
  const name = basename(path, ".jsonl");
  return name.slice(name.lastIndexOf("_") + 1);
}

/** What the list shows: its name (else the first typed prompt), the latest reply, the model and where it ran. */
export function piFacts(path: string, mtime: number): PiFacts | null {
  const head = headLines(path).map(obj);
  const tail = tailLines(path).map(obj);
  const header = head.find((l) => l.type === "session");
  const cwd = str(header?.cwd);
  if (!header || !cwd) return null;
  const last = [...tail].reverse();
  const named = [...last, ...[...head].reverse()].find((l) => l.type === "session_info" && str(l.name).trim());
  const title = str(named?.name).trim() || (head.map(userText).find((t) => t !== null) ?? "");
  const lastText = last.map(assistantText).find((t) => t !== null) ?? "";
  const stamped = last.find((l) => l.timestamp);
  const model = last.map((l) => (role(l) === "assistant" ? str(obj(l.message).model) : l.type === "model_change" ? str(l.modelId) : "")).find(Boolean);
  const started = time(header.timestamp);
  return {
    id: str(header.id) || idOf(path), cwd, title, lastText, updatedAt: Math.max(time(stamped?.timestamp), mtime),
    ...(started ? { startedAt: started } : {}), ...(model ? { model } : {}),
  };
}

/** The last `limit` messages: typed prompts, replies, and one line per tool call. */
export function piMessages(path: string, limit: number): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const line of tailLines(path).map(obj)) {
    const ts = time(line.timestamp);
    const user = userText(line);
    if (user) { out.push({ role: "user", text: clipText(user), ts }); continue; }
    if (role(line) !== "assistant") continue;
    for (const part of parts(line)) {
      if (part.type === "text" && str(part.text).trim()) out.push({ role: "assistant", text: clipText(str(part.text)), ts });
      if (part.type === "toolCall") out.push({ role: "tool", tool: str(part.name), text: clipText(toolSummary(obj(part.arguments))), ts });
    }
  }
  return out.slice(-limit);
}

function toolSummary(input: Json): string {
  for (const key of ["command", "path", "file_path", "pattern", "url", "query", "description"]) {
    if (str(input[key])) return str(input[key]);
  }
  return JSON.stringify(input);
}
