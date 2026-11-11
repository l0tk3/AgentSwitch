/** The Mac's coding sessions (docs/control-v0.md §3): the list and one session's latest messages, read-only, for the
 *  phone as for the Mac. Absent when the daemon does not watch sessions (tests, AGENTSWITCH_SESSIONS=0). */

import type { Hono } from "hono";
import { z } from "zod";
import type { SessionMonitor } from "../sessions/monitor.js";
import type { SessionHarness } from "../sessions/types.js";
import { AGENT_ID, MAX_RECORD_LIMIT, RECORD_LIMIT } from "../sessions/record.js";
import { PROFILE_AGENTS } from "../profiles/store.js";
import { SessionSearch } from "../sessions/search.js";
import { join } from "node:path";
import { remoteCaller } from "../core/caller.js";
import { TerminalAudit } from "../terminals/audit.js";
import { limitParam, parseBody, versionedJson, type ApiDeps } from "./shared.js";
import { typedFolder } from "../sessions/shownFolders.js";

const HARNESSES: ReadonlySet<string> = new Set<SessionHarness>(["claude-code", "codex", "opencode", "pi", "grok"]);
/** Agents that keep no register of a running session and no writer lock (docs/terminal-v0.md §5): a session written in
 *  the last 90 seconds may be open in another program. */
const UNSEEN: ReadonlySet<string> = new Set<SessionHarness>(["opencode", "pi"]);
/** How many sessions one `POST /sessions/delete` takes: more than the list ever holds for one agent (400). */
const MAX_BATCH = 500;
/** What `limit` means when it is not a number (older phones ask for 80). */
const LIST_LIMIT = 60;
const MESSAGE_LIMIT = 80;
const MAX_MESSAGES = 300;
const MAX_QUERY = 200;

export function mountSessions(app: Hono, deps: ApiDeps): void {
  const monitor: SessionMonitor | undefined = deps.sessions;
  if (!monitor) return;
  // Without `limit`, every session the Mac lists, so the tree shows each folder whole: a list cut at the newest 80
  // left older sessions out of their folders, and deleting one let the next one in (2026-10-03, user: 有的目录下面的
  // session显示不完全，经常是有的时候我删除一个session之后又蹦出来几个).
  // The Mac's Terminals page reads it every twenty seconds or so: unchanged, it is not sent again (versionedJson).
  // With each, the profile it last ran under when that is not the Mac's own (docs/profiles-v0.md §3.3): where it goes
  // on unless another is chosen.
  const withProfiles = <T extends { readonly harness: string; readonly id: string }>(list: readonly T[]): (T & { profile?: string })[] => {
    const by = new Map<string, ReadonlyMap<string, string>>();
    return list.map((s) => {
      const agent = PROFILE_AGENTS.find((a) => a === s.harness);
      if (!agent || !deps.profiles) return s;
      const known = by.get(agent) ?? deps.profiles.sessionProfiles(agent);
      by.set(agent, known);
      const profile = known.get(s.id);
      return profile ? { ...s, profile } : s;
    });
  };
  // The folders the user shows or hides in the list (sessions/shownFolders.ts). This Mac's screens only.
  const folders = deps.sessionFolders;
  if (folders) {
    app.get("/sessions/folders", (c) => c.json(folders.get()));
    app.post("/sessions/folders", async (c) => {
      const body = await parseBody(c, z.object({ action: z.enum(["show", "hide", "forget"]), folder: z.string().min(1).max(1000) }));
      if (!body.ok) return c.json({ error: body.error }, 400);
      const folder = typedFolder(body.data.folder);
      if (!folder) return c.json({ error: "请输入一个完整的目录路径，例如 /tmp/demo 或 ~/Desktop/demo。" }, 400);
      return c.json(body.data.action === "show" ? folders.show(folder) : body.data.action === "hide" ? folders.hide(folder) : folders.forget(folder));
    });
  }
  app.get("/sessions", (c) => versionedJson(c, { sessions: withProfiles(monitor.list(c.req.query("limit") === undefined ? Infinity : limitParam(c, LIST_LIMIT, Infinity))) }));
  // What was said in them (docs/terminal-v0.md §1 搜索): the tree's search, for the words only the Mac has.
  const search = new SessionSearch(monitor);
  app.get("/sessions/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q || q.length > MAX_QUERY) return c.json({ error: `q: 1–${MAX_QUERY} characters` }, 400);
    return c.json({ hits: await search.search(q) });
  });
  app.get("/sessions/:harness/:id", (c) => {
    const harness = c.req.param("harness");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    const found = monitor.read(harness as SessionHarness, c.req.param("id"), limitParam(c, MESSAGE_LIMIT, MAX_MESSAGES));
    return found ? c.json(found) : c.json({ error: "no such session" }, 404);
  });
  // A terminal of ours reads its own session wherever it runs (a scratch folder the list leaves out, a session with
  // nothing said yet): the simple view shows it. Any other unlisted session stays unreadable by its id.
  const ours = (id: string): boolean => deps.terminals?.host.list().some((t) => t.agentSessionId === id) ?? false;
  // The simple view's record (docs/simple-view-v0.md §4): what was said and each run of work as its steps, the last
  // `limit` items before `before` (a page's `cursor`). Asked again with the version it has, an unchanged one is a 304.
  app.get("/sessions/:harness/:id/record", (c) => {
    const harness = c.req.param("harness");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    const before = c.req.query("before");
    if (before !== undefined && !/^\d{1,15}$/.test(before)) return c.json({ error: "before: a page's cursor" }, 400);
    const found = monitor.record(harness as SessionHarness, c.req.param("id"), { limit: limitParam(c, RECORD_LIMIT, MAX_RECORD_LIMIT), ...(before !== undefined ? { before: Number(before) } : {}) }, ours(c.req.param("id")));
    return found ? versionedJson(c, { session: found.session, ...found.record }) : c.json({ error: "no such session" }, 404);
  });
  // What it changed, file by file: in one run of work (`work`, the item's id), else in the last turn.
  app.get("/sessions/:harness/:id/changes", (c) => {
    const harness = c.req.param("harness");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    const work = c.req.query("work");
    if (work !== undefined && !/^\d{1,15}(\.\d{1,4})?$/.test(work)) return c.json({ error: "work: an item's id" }, 400);
    const files = monitor.changes(harness as SessionHarness, c.req.param("id"), work, ours(c.req.param("id")));
    return files ? c.json({ files }) : c.json({ error: "no changes recorded" }, 404);
  });
  // One step of a run of work, whole (docs/simple-view-v0.md §4): the command as it was written and all it printed, for
  // the step a screen opens. The record carries one line of it and the end of the output.
  app.get("/sessions/:harness/:id/steps/:item/:n", (c) => {
    const harness = c.req.param("harness");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    const item = c.req.param("item"), n = c.req.param("n");
    if (!/^\d{1,15}(\.\d{1,4})?$/.test(item) || !/^\d{1,4}$/.test(n)) return c.json({ error: "no such step" }, 400);
    const step = monitor.step(harness as SessionHarness, c.req.param("id"), item, Number(n), ours(c.req.param("id")));
    return step ? c.json(step) : c.json({ error: "no such step" }, 404);
  });
  // A picture a step brought back (a picture file it read, a screenshot a tool took): the `k`-th of that step. As
  // unchanging as the step, and served as a picture only (never a type a browser would run).
  app.get("/sessions/:harness/:id/steps/:item/:n/images/:k", (c) => {
    const harness = c.req.param("harness");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    const item = c.req.param("item"), n = c.req.param("n"), k = c.req.param("k");
    if (!/^\d{1,15}(\.\d{1,4})?$/.test(item) || !/^\d{1,4}$/.test(n) || !/^\d{1,2}$/.test(k)) return c.json({ error: "no such picture" }, 400);
    const picture = monitor.stepImage(harness as SessionHarness, c.req.param("id"), item, Number(n), Number(k), ours(c.req.param("id")));
    if (!picture) return c.json({ error: "no such picture" }, 404);
    return c.body(new Uint8Array(picture.data), 200, { "Content-Type": picture.type, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
  });
  // A picture the user sent with a message (docs/simple-view-v0.md §4): the `n`-th of the record's item, as the agent
  // kept it. It never changes (an item's id is its place in a file that only grows): the screens keep it.
  app.get("/sessions/:harness/:id/images/:item/:n", (c) => {
    const harness = c.req.param("harness");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    const item = c.req.param("item"), n = c.req.param("n");
    if (!/^\d{1,15}(\.\d{1,4})?$/.test(item) || !/^\d{1,2}$/.test(n)) return c.json({ error: "no such picture" }, 400);
    const picture = monitor.image(harness as SessionHarness, c.req.param("id"), item, Number(n), ours(c.req.param("id")));
    if (!picture) return c.json({ error: "no such picture" }, 404);
    return c.body(new Uint8Array(picture.data), 200, { "Content-Type": picture.type, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
  });
  // A session's sub-agents (docs/simple-view-v0.md §5.22; sessions/subagents.ts): the ones Claude Code keeps a file of
  // their own for, in the order they started — each its id, its kind, what it was sent to do, whether it has ended.
  // None for an agent that keeps none. Read as the session's own record is: a listed session, or a terminal's of ours.
  app.get("/sessions/:harness/:id/subagents", (c) => {
    const harness = c.req.param("harness");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    const subagents = monitor.subagents(harness as SessionHarness, c.req.param("id"), ours(c.req.param("id")));
    return subagents ? versionedJson(c, { subagents }) : c.json({ error: "no such session" }, 404);
  });
  // One sub-agent's record: what it was sent to do, its work step by step, what it handed back — the shape of a
  // session's record, with `agent` (what the list says of it). A screen showing it asks again every second or so while
  // the sub-agent works, with the version it has (`If-None-Match`): for the same one nothing is read (a 304 by the
  // file's size and time, not by reading and hashing it as `versionedJson` does).
  app.get("/sessions/:harness/:id/subagents/:agent/record", (c) => {
    const harness = c.req.param("harness"), id = c.req.param("id"), agent = c.req.param("agent");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    if (!AGENT_ID.test(agent)) return c.json({ error: "no such sub-agent" }, 404);
    const before = c.req.query("before");
    if (before !== undefined && !/^\d{1,15}$/.test(before)) return c.json({ error: "before: a page's cursor" }, 400);
    const mine = ours(id);
    const asked = c.req.header("if-none-match");
    if (asked && before === undefined) {
      const version = monitor.subagentVersion(harness as SessionHarness, id, agent, mine);
      if (version && asked === `"${version}"`) return c.body(null, 304, { ETag: asked });
    }
    const found = monitor.subagentRecord(harness as SessionHarness, id, agent, { limit: limitParam(c, RECORD_LIMIT, MAX_RECORD_LIMIT), ...(before !== undefined ? { before: Number(before) } : {}) }, mine);
    if (!found) return c.json({ error: "no such sub-agent" }, 404);
    // An earlier page is not the record's latest: it carries no version to ask again with.
    return c.json({ session: found.session, agent: found.agent, ...found.record }, 200, before === undefined ? { ETag: `"${found.record.rev}"` } : {});
  });
  // One step of a sub-agent's run of work, whole, and a picture such a step brought back: as a session's own.
  app.get("/sessions/:harness/:id/subagents/:agent/steps/:item/:n", (c) => {
    const harness = c.req.param("harness"), agent = c.req.param("agent");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    const item = c.req.param("item"), n = c.req.param("n");
    if (!AGENT_ID.test(agent) || !/^\d{1,15}(\.\d{1,4})?$/.test(item) || !/^\d{1,4}$/.test(n)) return c.json({ error: "no such step" }, 400);
    const step = monitor.subagentStep(harness as SessionHarness, c.req.param("id"), agent, item, Number(n), ours(c.req.param("id")));
    return step ? c.json(step) : c.json({ error: "no such step" }, 404);
  });
  app.get("/sessions/:harness/:id/subagents/:agent/steps/:item/:n/images/:k", (c) => {
    const harness = c.req.param("harness"), agent = c.req.param("agent");
    if (!HARNESSES.has(harness)) return c.json({ error: "unknown harness" }, 404);
    const item = c.req.param("item"), n = c.req.param("n"), k = c.req.param("k");
    if (!AGENT_ID.test(agent) || !/^\d{1,15}(\.\d{1,4})?$/.test(item) || !/^\d{1,4}$/.test(n) || !/^\d{1,2}$/.test(k)) return c.json({ error: "no such picture" }, 400);
    const picture = monitor.subagentStepImage(harness as SessionHarness, c.req.param("id"), agent, item, Number(n), Number(k), ours(c.req.param("id")));
    if (!picture) return c.json({ error: "no such picture" }, 404);
    return c.body(new Uint8Array(picture.data), 200, { "Content-Type": picture.type, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
  });
  // Deleting a session's record (docs/terminal-v0.md §5): not one in use (just active, open in a terminal here, or held
  // by another program); always audited, terminals on or off.
  const audit = deps.terminals?.audit ?? (deps.home ? new TerminalAudit(join(deps.home, "terminals", "audit.jsonl")) : null);
  type Removal = { status: 200 | 404 | 409 | 500; body: { ok?: true; error?: string; files?: number } };
  const removeOne = async (harness: string, id: string, via: string): Promise<Removal> => {
    if (!HARNESSES.has(harness)) return { status: 404, body: { error: "unknown harness" } };
    const session = monitor.find(harness as SessionHarness, id);
    if (!session) return { status: 404, body: { error: "no such session" } };
    // What writes a session is a terminal here that still runs, or another program (Claude's session registry, Codex's
    // writer lock). Recent activity is not: a terminal just closed writes its last line on the way out. Only without
    // those checks (terminals off) does recent activity stand in for them.
    if (session.active && !deps.terminals) return { status: 409, body: { error: "会话正在使用中" } };
    // OpenCode and pi say nothing of who has a session open: written just now is taken as in use, unless it was one of
    // our own terminals (closed now; a running one is refused below).
    if (session.active && UNSEEN.has(harness) && !deps.terminals?.host.list().some((t) => t.agentSessionId === id)) {
      return { status: 409, body: { error: "会话刚刚还在写入，可能正在别处使用；请稍后再删。" } };
    }
    if (deps.terminals?.host.list().some((t) => t.status !== "exited" && t.agentSessionId === id)) return { status: 409, body: { error: "会话正在终端中打开，请先关闭终端。" } };
    const other = await deps.terminals?.elsewhere(harness as SessionHarness, id, []).catch(() => null);
    if (other) return { status: 409, body: { error: `会话正在${other.app ?? "其他程序"}中打开，请先在那里退出。` } };
    const { removed, failed } = await monitor.remove(harness as SessionHarness, id);
    audit?.record({ terminal: "-", action: "session-delete", via, detail: { harness, session: id, files: removed.length, failed: failed.length } });
    if (failed.length) return { status: 500, body: { error: harness === "opencode" ? "OpenCode 未能删除这段会话。" : `有 ${failed.length} 个记录文件未能删除。`, files: removed.length } };
    if (!removed.length) return { status: 404, body: { error: "未找到该会话的记录文件，未删除任何内容。" } };
    return { status: 200, body: { ok: true, files: removed.length } };
  };
  app.delete("/sessions/:harness/:id", async (c) => {
    const done = await removeOne(c.req.param("harness"), c.req.param("id"), remoteCaller(c.env)?.deviceId ?? "local");
    return c.json(done.body, done.status);
  });

  // Several at once (docs/terminal-v0.md §5 批量删除): each by the same rules and with its own audit line, one after
  // another; one in use is left and said so, the rest go. `outcome`: `deleted`, `busy` (in use), `gone` (not there any
  // more — as good as deleted to who asked), `failed`.
  app.post("/sessions/delete", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sessions?: unknown } | null;
    const asked = Array.isArray(body?.sessions) ? body.sessions : null;
    if (!asked || !asked.length || asked.length > MAX_BATCH) return c.json({ error: `sessions: 1 to ${MAX_BATCH} of {harness, id}` }, 400);
    const wanted: { harness: string; id: string }[] = [];
    for (const one of asked as { harness?: unknown; id?: unknown }[]) {
      if (typeof one?.harness !== "string" || typeof one.id !== "string" || !one.id) return c.json({ error: "sessions: each is {harness, id}" }, 400);
      if (!wanted.some((w) => w.harness === one.harness && w.id === one.id)) wanted.push({ harness: one.harness, id: one.id });
    }
    const via = remoteCaller(c.env)?.deviceId ?? "local";
    const results: { harness: string; id: string; outcome: "deleted" | "busy" | "gone" | "failed"; error?: string }[] = [];
    for (const { harness, id } of wanted) {
      const done = await removeOne(harness, id, via);
      const outcome = done.status === 200 ? "deleted" : done.status === 409 ? "busy" : done.status === 404 ? "gone" : "failed";
      results.push({ harness, id, outcome, ...(done.body.error && outcome !== "deleted" ? { error: done.body.error } : {}) });
    }
    const count = (o: string) => results.filter((r) => r.outcome === o).length;
    return c.json({ results, deleted: count("deleted"), busy: count("busy"), gone: count("gone"), failed: count("failed") });
  });
}
