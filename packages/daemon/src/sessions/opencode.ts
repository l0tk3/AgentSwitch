/** OpenCode sessions: `~/.local/share/opencode/opencode.db`, tables `session_v2` (directory, title, times, model) and
 *  `session_message` (type user / assistant / system, JSON `data`). Opened read-only; child sessions (sub-agents) are
 *  left out, and so are AgentSwitch's own model calls (`OWN_OPENCODE_AGENTS`). OpenCode writes the file while it runs:
 *  every read opens and closes it. */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { OWN_OPENCODE_AGENTS } from "../core/probes.js";
import { obj, str } from "./jsonl.js";
import { clipText, type SessionMessage } from "./types.js";

export type OpenCodeFacts = { readonly id: string; readonly cwd: string; readonly title: string; readonly lastText: string; readonly updatedAt: number; readonly startedAt?: number; readonly model?: string };

function withDb<T>(path: string, fallback: T, read: (db: DatabaseSync) => T): T {
  if (!existsSync(path)) return fallback;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return read(db);
  } catch {
    return fallback;
  } finally {
    db?.close();
  }
}

function replyText(data: unknown): string {
  const parts = obj(data).content;
  return Array.isArray(parts) ? parts.map(obj).filter((p) => p.type === "text").map((p) => str(p.text)).join("\n").trim() : "";
}

function parse(json: string): unknown {
  try { return JSON.parse(json); } catch { return {}; }
}

export function openCodeSessions(path: string, limit: number): OpenCodeFacts[] {
  return withDb(path, [] as OpenCodeFacts[], (db) => {
    // Older OpenCode builds have no `agent` column: then nothing tells our model calls apart here.
    const columns = (db.prepare("PRAGMA table_info(session_v2)").all() as { name: string }[]).map((c) => c.name);
    const hasAgent = columns.includes("agent");
    // When it began (the tree's fixed order); a build without the column says only when it was last touched.
    const created = columns.includes("time_created") ? "time_created" : "NULL AS time_created";
    const notOurs = hasAgent ? ` AND (agent IS NULL OR agent NOT IN (${OWN_OPENCODE_AGENTS.map(() => "?").join(", ")}))` : "";
    const rows = db.prepare(`SELECT id, directory, title, model, ${created}, time_updated FROM session_v2 WHERE parent_id IS NULL${notOurs} ORDER BY time_updated DESC LIMIT ?`)
      .all(...(hasAgent ? OWN_OPENCODE_AGENTS : []), limit) as Record<string, unknown>[];
    const last = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 5");
    return rows.map((r) => {
      const replies = (last.all(String(r.id)) as { data: string }[]).map((m) => replyText(parse(m.data))).filter(Boolean);
      const model = str(obj(parse(str(r.model))).id);
      return { id: String(r.id), cwd: str(r.directory), title: str(r.title), lastText: replies[0] ?? "", updatedAt: Number(r.time_updated) || 0, ...(Number(r.time_created) ? { startedAt: Number(r.time_created) } : {}), ...(model ? { model } : {}) };
    });
  });
}

export function openCodeMessages(path: string, id: string, limit: number): SessionMessage[] {
  return withDb(path, [] as SessionMessage[], (db) => {
    const rows = db.prepare("SELECT type, data, time_created FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY seq DESC LIMIT ?").all(id, limit * 3) as { type: string; data: string; time_created: number }[];
    const out: SessionMessage[] = [];
    for (const row of rows.reverse()) {
      const data = obj(parse(row.data));
      if (row.type === "user") {
        const text = str(data.text).split("\n\nUser environment context")[0]!.trim();
        if (text) out.push({ role: "user", text: clipText(text), ts: row.time_created });
        continue;
      }
      for (const part of (Array.isArray(data.content) ? data.content : []).map(obj)) {
        if (part.type === "text" && str(part.text).trim()) out.push({ role: "assistant", text: clipText(str(part.text)), ts: row.time_created });
        if (part.type === "tool" || part.type === "tool-call") {
          const input = obj(part.input ?? obj(part.state).input);
          out.push({ role: "tool", tool: str(part.tool) || str(part.name), text: clipText(str(input.command) || str(input.filePath) || str(input.path) || JSON.stringify(input)), ts: row.time_created });
        }
      }
    }
    return out.slice(-limit);
  });
}

/** Deleting one of the user's OpenCode sessions (docs/terminal-v0.md §5, 2026-10-01): through OpenCode's own command,
 *  `opencode session delete --standalone <id>` — the session and its child sessions, on a private server so the
 *  background service is not involved; the database is the one the list reads (`XDG_DATA_HOME` set to match). true:
 *  deleted; false: OpenCode has no such session; throws when the command fails otherwise. */
export type OpenCodeDelete = (id: string) => Promise<boolean>;

const runFile = promisify(execFile);

export function openCodeDeleter(binary: string, db: string, env: NodeJS.ProcessEnv = process.env): OpenCodeDelete {
  return async (id) => {
    try {
      await runFile(binary, ["session", "delete", "--standalone", id], {
        timeout: 30_000, cwd: env.HOME ?? "/", env: { ...env, XDG_DATA_HOME: dirname(dirname(db)) },
      });
      return true;
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      if (/session not found/i.test(`${e.stderr ?? ""}${e.stdout ?? ""}`)) return false;
      throw new Error((e.stderr || e.message || "opencode session delete failed").trim().split("\n").slice(-1)[0]);
    }
  };
}
