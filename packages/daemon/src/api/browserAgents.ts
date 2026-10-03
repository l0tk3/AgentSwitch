/** The agent bridge's routes (docs/browser-v0.md §2 给 agent): what `bridgeClient.ts` talks to. Local only, never on the
 *  remote allowlist; the local token check lets them through (api/localAuth.ts) because each request shows its agent
 *  session's own token, which is checked here: valid for that session alone, and only until it ends.
 *
 *  `GET /browser/agent/mcp` opens one connection (SSE: `endpoint {connection}`, then `message` events, each a JSON-RPC
 *  message for the agent; a comment every few seconds; the stream ends when the session does). `POST
 *  /browser/agent/mcp/:connection` hands it one message from the agent (202). Headers: `Authorization: Bearer <token>`,
 *  `X-AgentSwitch-Browser-Session: <id>`. Messages are never logged: after the gate, a fill's text is the plaintext. */

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { BrowserAgents, JsonRpcMessage } from "../browser/agents.js";
import { BrowserError } from "../browser/types.js";
import { SSE_HEARTBEAT_MS } from "../core/limits.js";

export const AGENT_SESSION_HEADER = "x-agentswitch-browser-session";
/** One message from the agent, at most. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Messages a stalled bridge may fall behind by before its connection is dropped. */
const MAX_QUEUED = 1_000;

/** The session and token a request shows, or null. */
function credentials(c: Context): { session: string; token: string } | null {
  const session = c.req.header(AGENT_SESSION_HEADER) ?? "";
  const m = /^Bearer\s+(\S+)\s*$/.exec(c.req.header("authorization") ?? "");
  return /^[\w-]{1,64}$/.test(session) && m ? { session, token: m[1]! } : null;
}

const isMessage = (v: unknown): v is JsonRpcMessage => !!v && typeof v === "object" && !Array.isArray(v) && (v as { jsonrpc?: unknown }).jsonrpc === "2.0";

export function mountBrowserAgents(app: Hono, agents: BrowserAgents, heartbeatMs = SSE_HEARTBEAT_MS): void {
  const unauthorized = (c: Context) => c.json({ error: "unknown or revoked browser session" }, 401);

  app.get("/browser/agent/mcp", (c) => {
    const auth = credentials(c);
    if (!auth || !agents.verify(auth.session, auth.token)) return unauthorized(c);
    return streamSSE(c, async (stream) => {
      const queue: JsonRpcMessage[] = [];
      let wake: (() => void) | null = null;
      let open = true;
      const stop = () => { open = false; wake?.(); };
      const push = (m: JsonRpcMessage) => {
        queue.push(m);
        if (queue.length > MAX_QUEUED) open = false;
        wake?.();
      };
      let connection: Awaited<ReturnType<BrowserAgents["connect"]>> | null = null;
      stream.onAbort(stop);
      try {
        connection = await agents.connect(auth.session, auth.token, push, stop);
      } catch (err) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: err instanceof BrowserError ? err.message : "the agent connection did not start" }) });
        return;
      }
      const heartbeat = setInterval(() => { void stream.write(": ping\n\n").catch(() => undefined); }, heartbeatMs);
      try {
        await stream.writeSSE({ event: "endpoint", data: JSON.stringify({ connection: connection.id }) });
        while (open) {
          for (const m of queue.splice(0)) await stream.writeSSE({ event: "message", data: JSON.stringify(m) });
          if (!open) break;
          await new Promise<void>((resolve) => { wake = resolve; if (queue.length || !open) resolve(); });
          wake = null;
        }
      } finally {
        clearInterval(heartbeat);
        await connection.close();
      }
    });
  });

  app.post("/browser/agent/mcp/:connection", async (c) => {
    const auth = credentials(c);
    if (!auth) return unauthorized(c);
    const connection = agents.connection(auth.session, auth.token, c.req.param("connection"));
    if (!connection) return agents.verify(auth.session, auth.token) ? c.json({ error: "no such connection" }, 404) : unauthorized(c);
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) return c.json({ error: "message too large" }, 413);
    let message: unknown;
    try { message = JSON.parse(raw); } catch { return c.json({ error: "not JSON" }, 400); }
    if (!isMessage(message)) return c.json({ error: "not a JSON-RPC 2.0 message" }, 400);
    connection.receive(message);
    return c.json({ ok: true }, 202);
  });
}
