/** Codex sessions: `~/.codex/sessions/<y>/<m>/<d>/rollout-<time>-<id>.jsonl`. The first line is `session_meta` (id,
 *  cwd, where it was started); turns are `response_item` messages (role user / assistant) and tool calls. The first user
 *  items are the harness's own context blocks, not what the user typed. */

import { headLines, isTypedText, obj, str, tailLines, time, type Json } from "./jsonl.js";
import { clipText, type SessionMessage, type SessionMode } from "./types.js";
import { movedFolder } from "./moved.js";

export type CodexFacts = { readonly id: string; readonly cwd: string; readonly title: string; readonly lastText: string; readonly updatedAt: number; readonly origin?: string; readonly model?: string; readonly mode?: SessionMode; readonly forkedFrom?: string };

/** A turn's approval policy and sandbox in the terminals' three words, never one that allows more than the session
 *  did: never asking with full access is a bypass; a writable sandbox is auto (`-s workspace-write`); read-only, an
 *  unknown sandbox or asking about everything continues as asking (`-s read-only`). */
export function codexMode(context: Json): SessionMode | undefined {
  const approval = str(context.approval_policy);
  const sandbox = str(obj(context.sandbox_policy).type) || str(context.sandbox_mode);
  if (!approval) return undefined;
  if (approval === "never" && sandbox === "danger-full-access") return "bypass";
  if (approval === "untrusted" || !["workspace-write", "danger-full-access"].includes(sandbox)) return "manual";
  return "auto";
}

function messageText(payload: Json, role: "user" | "assistant"): string | null {
  if (payload.type !== "message" || payload.role !== role) return null;
  const parts = Array.isArray(payload.content) ? payload.content.map(obj) : [];
  const text = parts.map((p) => str(p.text)).join("\n").trim();
  return role === "user" ? typedRequest(text) : text || null;
}

/** What a line says, for search: a request the user typed or the agent's reply. */
export function codexSaid(line: Json): string | null {
  if (line.type !== "response_item") return null;
  const payload = obj(line.payload);
  return messageText(payload, "user") ?? messageText(payload, "assistant");
}

/** Codex desktop puts the files the user attached ahead of the request (`# Files mentioned by the user: … ## My
 *  request: …`): the request is what the user typed. */
function typedRequest(text: string): string | null {
  const marker = /^##\s*My request[^:\n]*:\s*$/im.exec(text);
  const typed = marker ? text.slice(marker.index + marker[0].length).trim() : text;
  return isTypedText(typed) && !typed.startsWith("# Files mentioned") ? typed : null;
}

/** desktop / cli / vscode, from `originator` and `source`. */
function originOf(meta: Json): string | undefined {
  const o = `${str(meta.originator)} ${str(meta.source)}`.toLowerCase();
  if (o.includes("desktop")) return "desktop";
  if (o.includes("vscode")) return "vscode";
  if (o.includes("cli") || o.includes("exec")) return "cli";
  return undefined;
}

export function codexFacts(path: string, mtime: number): CodexFacts | null {
  const head = headLines(path).map(obj);
  const meta = obj(head.find((l) => l.type === "session_meta")?.payload);
  const began = str(meta.cwd);
  const id = str(meta.id) || str(meta.session_id);
  if (!began || !id) return null;
  // Sub-agents Codex spawned inside a thread (thread_source "subagent"): each starts with a copy of the thread's first
  // message, so they read as duplicates of it; they are part of that thread, not sessions of the user's own.
  if (str(meta.thread_source) === "subagent" || obj(meta.source).subagent) return null;
  const forkedFrom = str(meta.forked_from_id);
  const tail = tailLines(path).map(obj);
  const title = head.map((l) => messageText(obj(l.payload), "user")).find((t) => t !== null) ?? "";
  const last = [...tail].reverse();
  // Each turn says its folder: a session continued in another one (`codex resume -C`) is listed there while it is there.
  const cwd = movedFolder(began, last.map((l) => (l.type === "turn_context" ? str(obj(l.payload).cwd) : "")).find(Boolean));
  const lastText = last.map((l) => messageText(obj(l.payload), "assistant")).find((t) => t !== null) ?? "";
  const model = last.map((l) => (l.type === "turn_context" ? str(obj(l.payload).model) : "")).find(Boolean);
  const context = last.find((l) => l.type === "turn_context");
  const mode = context ? codexMode(obj(context.payload)) : undefined;
  const origin = originOf(meta);
  return { id, cwd, title, lastText, updatedAt: Math.max(time(last.find((l) => l.timestamp)?.timestamp), mtime), ...(origin ? { origin } : {}), ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(forkedFrom ? { forkedFrom } : {}) };
}

export function codexMessages(path: string, limit: number): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const line of tailLines(path).map(obj)) {
    if (line.type !== "response_item") continue;
    const payload = obj(line.payload);
    const ts = time(line.timestamp);
    const user = messageText(payload, "user");
    if (user) { out.push({ role: "user", text: clipText(user), ts }); continue; }
    const reply = messageText(payload, "assistant");
    if (reply) { out.push({ role: "assistant", text: clipText(reply), ts }); continue; }
    if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "local_shell_call") {
      out.push({ role: "tool", tool: str(payload.name) || "shell", text: clipText(toolSummary(payload)), ts });
    }
  }
  return out.slice(-limit);
}

function toolSummary(payload: Json): string {
  const raw = str(payload.arguments) || str(payload.input);
  try {
    const args = obj(JSON.parse(raw));
    const command = args.command;
    if (Array.isArray(command)) return command.map(String).join(" ");
    if (typeof command === "string") return command;
  } catch { /* free-form input */ }
  return raw || JSON.stringify(obj(payload.action));
}
