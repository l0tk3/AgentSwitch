/** The Mac's coding sessions (docs/control-v0.md §3): the list and one session's latest messages, read-only, for the
 *  phone as for the Mac. Absent when the daemon does not watch sessions (tests, AGENTSWITCH_SESSIONS=0). */

import type { Hono } from "hono";
import type { SessionMonitor } from "../sessions/monitor.js";
import type { SessionHarness } from "../sessions/types.js";
import { limitParam, type ApiDeps } from "./shared.js";

const HARNESSES: ReadonlySet<string> = new Set<SessionHarness>(["claude-code", "codex", "opencode"]);
const LIST_LIMIT = 60;
const MESSAGE_LIMIT = 80;
const MAX_MESSAGES = 300;

export function mountSessions(app: Hono, deps: ApiDeps): void {
  const monitor: SessionMonitor | undefined = deps.sessions;
  if (!monitor) return;
  app.get("/sessions", (c) => c.json({ sessions: monitor.list(limitParam(c, LIST_LIMIT)) }));
  app.get("/sessions/:harness/:id", (c) => {
    const harness = c.req.param("harness");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    const found = monitor.read(harness as SessionHarness, c.req.param("id"), limitParam(c, MESSAGE_LIMIT, MAX_MESSAGES));
    return found ? c.json(found) : c.json({ error: "no such session" }, 404);
  });
}
