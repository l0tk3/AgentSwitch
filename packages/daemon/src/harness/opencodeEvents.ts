/** OpenCode's event stream (2.0: `GET /api/event`, server-sent events) and what it says of an answer being written
 *  (docs/simple-view-v0.md §5.14). Its messages endpoint has a part of an answer only once that part is written; the
 *  pieces are here alone (measured 2026-10-16, scripts/partial_probe.ts: `session.text.delta` from 1.35 s, the messages
 *  endpoint nothing until 4.54 s). The shapes, as 2.0.25 sends them:
 *
 *    session.text.started|delta|ended       { data: { sessionID, assistantMessageID, ordinal, delta | text } }
 *    session.reasoning.started|delta|ended  the same, what it thinks on the way
 *    session.execution.failed               { data: { sessionID, error: { type, message, status, response } } } */

import type { Writing, WritingText } from "../core/writing.js";

type Json = Record<string, unknown>;

/** The stream's events, each as it comes, until `signal` aborts or the server ends the stream. */
export async function followEventStream(url: string, authorization: string, onEvent: (event: Json) => void, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(url, { headers: { authorization, accept: "text/event-stream" }, signal });
  if (!res.ok || !res.body) throw new Error(`GET /api/event: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let event: unknown;
        try { event = JSON.parse(data); } catch { continue; }
        if (event && typeof event === "object") onEvent(event as Json);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** What an event of the stream says of session `session`'s part being written: its text so far (a piece came; the
 *  whole of it when the part ended), null (a part of what it thinks ended: nothing more of it will be shown), or
 *  undefined (nothing about that). */
export function openCodeWriting(event: Json, session: string, written: WritingText): Writing | null | undefined {
  const type = String(event.type ?? "");
  const m = /^session\.(text|reasoning)\.(delta|ended)$/.exec(type);
  if (!m) return undefined;
  const data = (event.data ?? {}) as Json;
  if (data.sessionID !== session) return undefined;
  const thinking = m[1] === "reasoning";
  const key = `${String(data.assistantMessageID ?? "")}:${String(data.ordinal ?? "")}`;
  if (m[2] === "delta") return typeof data.delta === "string" && data.delta ? written.add(key, data.delta, thinking) : undefined;
  if (thinking) return null;
  // The answer's part is written whole: shown as it is until the task's events have it.
  return typeof data.text === "string" ? { text: data.text } : undefined;
}
