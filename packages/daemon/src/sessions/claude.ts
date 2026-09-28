/** Claude Code sessions: `~/.claude/projects/<dir key>/<session id>.jsonl`, one JSON line per event; user and assistant
 *  lines carry `cwd`, `gitBranch` and `timestamp`. Sub-agent lines (`isSidechain`) are left out. */

import { basename } from "node:path";
import { headLines, isTypedText, obj, str, tailLines, time, type Json } from "./jsonl.js";
import { clipText, type SessionMessage, type SessionMode } from "./types.js";

export type ClaudeFacts = { readonly id: string; readonly cwd: string; readonly title: string; readonly lastText: string; readonly updatedAt: number; readonly branch?: string; readonly model?: string; readonly mode?: SessionMode };

/** Claude Code's `permissionMode` in the terminals' three words, never one that allows more than the session did:
 *  a mode narrower than `auto` (edits only, pre-approved only, plan) continues as asking each time. */
export function claudeMode(permissionMode: string): SessionMode | undefined {
  if (permissionMode === "bypassPermissions") return "bypass";
  if (permissionMode === "auto") return "auto";
  if (["default", "manual", "plan", "acceptEdits", "dontAsk"].includes(permissionMode)) return "manual";
  return undefined;
}

function content(line: Json): unknown[] {
  const c = obj(line.message).content;
  return Array.isArray(c) ? c : typeof c === "string" ? [{ type: "text", text: c }] : [];
}

function userText(line: Json): string | null {
  if (line.type !== "user" || line.isMeta || line.isSidechain) return null;
  const text = content(line).map((p) => (obj(p).type === "text" ? str(obj(p).text) : "")).join("\n").trim();
  return isTypedText(text) ? text : null;
}

function assistantText(line: Json): string | null {
  if (line.type !== "assistant" || line.isSidechain) return null;
  const text = content(line).map((p) => (obj(p).type === "text" ? str(obj(p).text) : "")).join("\n").trim();
  return text || null;
}

/** What the list shows: the first typed prompt from the head, the latest reply and where it ran from the tail. */
export function claudeFacts(path: string, mtime: number): ClaudeFacts | null {
  const head = headLines(path).map(obj);
  const tail = tailLines(path).map(obj);
  const all = [...head, ...tail];
  const cwd = all.map((l) => str(l.cwd)).find(Boolean) ?? "";
  if (!cwd) return null;
  const title = str(tail.findLast((l) => l.type === "custom-title")?.customTitle) || (head.map(userText).find((t) => t !== null) ?? "");
  const last = [...tail].reverse();
  const lastText = last.map(assistantText).find((t) => t !== null) ?? "";
  const stamped = last.find((l) => l.timestamp);
  const branch = last.map((l) => str(l.gitBranch)).find(Boolean);
  const model = last.map((l) => str(obj(l.message).model)).find((m) => m && !m.startsWith("<"));
  const mode = claudeMode(last.map((l) => str(l.permissionMode)).find(Boolean) ?? "");
  return {
    id: basename(path, ".jsonl"), cwd, title, lastText, updatedAt: Math.max(time(stamped?.timestamp), mtime),
    ...(branch ? { branch } : {}), ...(model ? { model } : {}), ...(mode ? { mode } : {}),
  };
}

/** The last `limit` messages: typed prompts, replies, and one line per tool call. */
export function claudeMessages(path: string, limit: number): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const line of tailLines(path).map(obj)) {
    if (line.isSidechain) continue;
    const ts = time(line.timestamp);
    const user = userText(line);
    if (user) { out.push({ role: "user", text: clipText(user), ts }); continue; }
    if (line.type !== "assistant") continue;
    for (const part of content(line).map(obj)) {
      if (part.type === "text" && str(part.text).trim()) out.push({ role: "assistant", text: clipText(str(part.text)), ts });
      if (part.type === "tool_use") out.push({ role: "tool", tool: str(part.name), text: clipText(toolSummary(obj(part.input))), ts });
    }
  }
  return out.slice(-limit);
}

function toolSummary(input: Json): string {
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description"]) {
    if (str(input[key])) return str(input[key]);
  }
  return JSON.stringify(input);
}
