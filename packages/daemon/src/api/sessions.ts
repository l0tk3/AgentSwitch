/** The Mac's coding sessions (docs/control-v0.md §3): the list and one session's latest messages, read-only, for the
 *  phone as for the Mac. Absent when the daemon does not watch sessions (tests, AGENTSWITCH_SESSIONS=0). */

import type { Hono } from "hono";
import type { SessionMonitor } from "../sessions/monitor.js";
import type { SessionHarness } from "../sessions/types.js";
import { SessionSearch } from "../sessions/search.js";
import { join } from "node:path";
import { remoteCaller } from "../core/caller.js";
import { TerminalAudit } from "../terminals/audit.js";
import { limitParam, type ApiDeps } from "./shared.js";

const HARNESSES: ReadonlySet<string> = new Set<SessionHarness>(["claude-code", "codex", "opencode"]);
const LIST_LIMIT = 60;
const MESSAGE_LIMIT = 80;
const MAX_MESSAGES = 300;
const MAX_QUERY = 200;
/** As many sessions as the tree lists. */
const SEARCH_WITHIN = 80;

export function mountSessions(app: Hono, deps: ApiDeps): void {
  const monitor: SessionMonitor | undefined = deps.sessions;
  if (!monitor) return;
  app.get("/sessions", (c) => c.json({ sessions: monitor.list(limitParam(c, LIST_LIMIT)) }));
  // What was said in them (docs/terminal-v0.md §1 搜索): the tree's search, for the words only the Mac has.
  const search = new SessionSearch(monitor);
  app.get("/sessions/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q || q.length > MAX_QUERY) return c.json({ error: `q: 1–${MAX_QUERY} characters` }, 400);
    return c.json({ hits: await search.search(q, SEARCH_WITHIN) });
  });
  app.get("/sessions/:harness/:id", (c) => {
    const harness = c.req.param("harness");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    const found = monitor.read(harness as SessionHarness, c.req.param("id"), limitParam(c, MESSAGE_LIMIT, MAX_MESSAGES));
    return found ? c.json(found) : c.json({ error: "no such session" }, 404);
  });
  // Deleting a session's record (docs/terminal-v0.md §5): not one in use (just active, open in a terminal here, or held
  // by another program); always audited, terminals on or off.
  const audit = deps.terminals?.audit ?? (deps.home ? new TerminalAudit(join(deps.home, "terminals", "audit.jsonl")) : null);
  app.delete("/sessions/:harness/:id", async (c) => {
    const harness = c.req.param("harness");
    const id = c.req.param("id");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    if (harness === "opencode") return c.json({ error: "OpenCode 的会话还不能在这里删除" }, 400);
    const session = monitor.list(LIST_LIMIT * 4).find((s) => s.harness === harness && s.id === id);
    if (!session) return c.json({ error: "no such session" }, 404);
    // What writes a session is a terminal here that still runs, or another program (Claude's session registry, Codex's
    // writer lock). Recent activity is not: a terminal just closed writes its last line on the way out. Only without
    // those checks (terminals off) does recent activity stand in for them.
    if (session.active && !deps.terminals) return c.json({ error: "会话正在使用中" }, 409);
    if (deps.terminals?.host.list().some((t) => t.status !== "exited" && t.agentSessionId === id)) return c.json({ error: "会话正在终端中打开，请先关闭终端。" }, 409);
    const other = await deps.terminals?.elsewhere(harness as SessionHarness, id, []).catch(() => null);
    if (other) return c.json({ error: `会话正在${other.app ?? "其他程序"}中打开，请先在那里退出。` }, 409);
    const { removed, failed } = monitor.remove(harness as SessionHarness, id);
    audit?.record({ terminal: "-", action: "session-delete", via: remoteCaller(c.env)?.deviceId ?? "local", detail: { harness, session: id, files: removed.length, failed: failed.length } });
    if (failed.length) return c.json({ error: `有 ${failed.length} 个记录文件未能删除。`, files: removed.length }, 500);
    if (!removed.length) return c.json({ error: "未找到该会话的记录文件，未删除任何内容。" }, 404);
    return c.json({ ok: true, files: removed.length });
  });
}
