/** AgentSwitch's own terminals, the manual entry (docs/terminal-v0.md §4): list, start, resume, stream, reply, keys,
 *  resize, answer a permission request, end, delete. Same routes for this Mac and a paired phone, except the hook route,
 *  which only the agents' hook command calls (with its terminal's hook token, not the local token). */

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { remoteCaller } from "../core/caller.js";
import { SSE_HEARTBEAT_MS } from "../core/limits.js";
import type { TerminalAudit } from "../terminals/audit.js";
import type { ElsewhereCheck } from "../terminals/elsewhere.js";
import { PERMISSION_MODES, TERMINAL_HARNESSES, TerminalError, type TerminalEvent, type TerminalHarness, type TerminalHost } from "../terminals/host.js";
import type { TerminalStyle } from "../terminals/style.js";
import type { Offers } from "../router/modelOffers.js";
import { slashCommands } from "../terminals/commands.js";
import { CLICK, KEY_NAMES, type KeyName, keySequence, replyBytes } from "../terminals/keys.js";
import { deleteTranscript } from "../terminals/transcripts.js";
import { modelSettings } from "../router/modelOverlay.js";
import { modelName } from "../util/modelName.js";
import { checkTerminalCwd } from "./cwdPolicy.js";
import { parseBody, type ApiDeps } from "./shared.js";

export type Terminals = {
  readonly host: TerminalHost;
  readonly audit: TerminalAudit;
  /** The agents this Mac can start (the others show as not installed). */
  readonly agents: readonly TerminalHarness[];
  /** How the screens draw a terminal (the user's iTerm2 profile, else a default). */
  readonly style: () => TerminalStyle;
  /** Whether a session is open in another program (it is continued in place, so only one may write it). */
  readonly elsewhere: ElsewhereCheck;
  /** What each agent offers today for the model menu (its own list); the catalog stands in for an agent not asked. */
  readonly offers?: () => Offers;
  /** Where a terminal's attached files go (`<dir>/<id>/`); default the system's temporary folder (no spaces). */
  readonly attachDir?: string;
  /** Before an agent starts (Codex: its hooks trusted, codexHooks.ts); whatever happens, the start goes on. */
  readonly prepare?: (harness: TerminalHarness) => Promise<unknown>;
};

const MAX_INPUT = 20_000;
const Attach = z.object({ uploads: z.array(z.string().min(1).max(64)).min(1).max(10) });
const Size = { cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(300) };
/** A model id goes to the agent as `--model <id>`: never one that could read as a flag. */
const ModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,199}$/, "not a model id");
/** A session id goes after `--resume` / `resume` / `--session`: likewise never one that could read as a flag. */
const SessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/, "not a session id");
const NewTerminal = z.object({ harness: z.enum(TERMINAL_HARNESSES), cwd: z.string().min(1).max(4096), model: ModelId.optional(), mode: z.enum(PERMISSION_MODES).optional(), cols: Size.cols.optional(), rows: Size.rows.optional() });
const ResumeTerminal = NewTerminal.extend({ agentSessionId: SessionId, title: z.string().max(300).optional(), fork: z.boolean().optional() });
const Input = z.object({ text: z.string().min(1).max(MAX_INPUT), submit: z.boolean().default(true), seal: z.boolean().default(true) });
const Keys = z.object({ keys: z.array(z.union([z.enum(KEY_NAMES), z.string().regex(CLICK).transform((k) => k as KeyName)])).min(1).max(20) });
/** `screen`: the asking screen's own id, which then owns the size (terminal-v0 §1). */
const SCREEN_ID = /^[\w-]{1,64}$/;
const Resize = z.object({ ...Size, screen: z.string().regex(SCREEN_ID).optional() });
const Decide = z.object({ decision: z.enum(["allow", "deny"]) });
const Rename = z.object({ name: z.string().max(200).nullable() });
const HookBody = z.object({ event: z.string().min(1).max(64), payload: z.record(z.string(), z.unknown()) });
const Raw = z.object({ data: z.string().min(1).max(MAX_INPUT) });

const STATUS: Record<TerminalError["code"], 400 | 403 | 404 | 409> = { not_found: 404, exited: 409, unavailable: 400, forbidden: 403 };
/** Agents that can go on with a session, and those that can fork one (docs/terminal-v0.md §5). */
const RESUMES: ReadonlySet<TerminalHarness> = new Set(["claude-code", "codex", "opencode"]);
const FORKS: ReadonlySet<TerminalHarness> = new Set(["claude-code", "codex"]);
/** Events a stalled screen may fall behind by before its stream is ended (it reconnects to a fresh snapshot). */
const MAX_QUEUED = 5_000;

/** `~` and `~/x` as the user's home; everything else must be absolute. */
function expandCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return join(homedir(), cwd.slice(2));
  return cwd;
}

/** Consecutive output events as one (a busy agent writes in many small pieces). */
function coalesce(events: TerminalEvent[]): TerminalEvent[] {
  const out: TerminalEvent[] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (ev.type === "output" && last?.type === "output") out[out.length - 1] = { type: "output", seq: ev.seq, data: last.data + ev.data };
    else out.push(ev);
  }
  return out;
}

export function mountTerminals(app: Hono, deps: ApiDeps): void {
  const t = deps.terminals;
  if (!t) return;
  const { host, audit, agents } = t;
  const via = (c: Context): string => remoteCaller(c.env)?.deviceId ?? "local";
  const attachDir = (id: string): string => join(t.attachDir ?? join(tmpdir(), "agentswitch-attach"), id);
  const failed = (c: Context, err: unknown) => {
    if (err instanceof TerminalError) return c.json({ error: err.message }, STATUS[err.code]);
    throw err;
  };

  // The agents' hook command (terminals/hookClient.ts). Not on the remote allowlist; the local token check lets it
  // through (api/localAuth.ts) because the terminal's own hook token is checked here.
  app.post("/terminals/hook", async (c) => {
    const id = c.req.header("x-agentswitch-terminal") ?? "";
    const token = /^Bearer\s+(\S+)\s*$/.exec(c.req.header("authorization") ?? "")?.[1];
    const body = await parseBody(c, HookBody);
    if (!token || !body.ok) return c.json({ error: "bad hook call" }, 400);
    try {
      return c.json({ output: await host.hook(id, token, body.data, c.req.raw.signal) });
    } catch (err) { return failed(c, err); }
  });

  // The agents this Mac can start, and each one's models for the new terminal's model menu: what the agent offers
  // today, in its order and names, the superseded ones marked `older` (else the catalog, targets.yaml after discovery);
  // none chosen = the agent's own default, named in `defaults` when the agent says what it is.
  app.get("/terminals", (c) => {
    const catalog = modelSettings(deps.targets).harnesses;
    const offers = t.offers?.() ?? {};
    const models = Object.fromEntries(agents.map((a) => [a, offers[a as keyof Offers]?.models
      ?? (catalog[a]?.models ?? []).map((id) => ({ id, name: modelName(id) }))]));
    const defaults = Object.fromEntries(Object.entries(offers).flatMap(([a, o]) => (o?.defaultName ? [[a, o.defaultName]] : [])));
    return c.json({ terminals: host.list(), agents, models, defaults });
  });
  app.get("/terminals/style", (c) => c.json(t.style()));

  const start = async (c: Context, resume: boolean) => {
    const body = resume ? await parseBody(c, ResumeTerminal) : await parseBody(c, NewTerminal);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const typed = expandCwd(body.data.cwd);
    if (!isAbsolute(typed)) return c.json({ error: "cwd must be an absolute path" }, 400);
    const cwd = resolve(typed);   // `~/proj/` and `~/proj` are one folder

    // Any folder, as in any terminal (docs/terminal-v0.md §2, 2026-09-30); tasks keep control-v0 §2's rules.
    const problem = checkTerminalCwd(cwd);
    if (problem) return c.json({ error: problem }, 400);
    const resumed = resume ? (body.data as z.infer<typeof ResumeTerminal>) : null;
    const agentSessionId = resumed?.agentSessionId;
    const fork = Boolean(resumed?.fork);
    if (resumed && !RESUMES.has(resumed.harness)) return c.json({ error: `${resumed.harness} cannot continue a session` }, 400);
    if (fork && !FORKS.has(body.data.harness)) return c.json({ error: `${body.data.harness} cannot fork a session` }, 400);
    const openHere = () => host.list().find((x) => x.status !== "exited" && x.harness === body.data.harness && x.agentSessionId === agentSessionId);
    // The agent made ready (Codex: its hooks trusted, a few seconds at most); the start goes on whatever happens.
    await t.prepare?.(body.data.harness).catch(() => undefined);
    // One session, one writer (docs/terminal-v0.md §5): already open here → that terminal; open in another program → say
    // where, and the client may fork instead.
    if (agentSessionId && !fork) {
      const open = openHere();
      if (open) return c.json({ terminal: open, existing: true });
      const ours = host.list().flatMap((x) => (x.pid && x.status !== "exited" ? [x.pid] : []));
      const other = await t.elsewhere(body.data.harness, agentSessionId, ours).catch(() => null);
      if (other) return c.json({ error: `会话正在${other.app ?? "其他程序"}中运行`, elsewhere: other }, 409);
      // Checked again with nothing awaited before the spawn: two screens resuming at once get one terminal.
      const raced = openHere();
      if (raced) return c.json({ terminal: raced, existing: true });
    }
    try {
      const info = await host.spawn({ harness: body.data.harness, cwd, ...(body.data.model ? { model: body.data.model } : {}), ...(agentSessionId ? { resume: agentSessionId, ...(fork ? { fork } : {}) } : {}),
        ...(resumed?.title ? { name: resumed.title } : {}), ...(body.data.mode ? { mode: body.data.mode } : {}),
        allowBypass: true,
        ...(body.data.cols ? { cols: body.data.cols } : {}), ...(body.data.rows ? { rows: body.data.rows } : {}) });
      audit.record({ terminal: info.id, action: resume ? "resume" : "create", via: via(c), detail: { harness: info.harness, cwd, model: info.model, mode: info.mode, ...(resume ? { fork } : {}) } });
      return c.json({ terminal: info }, 201);
    } catch (err) { return failed(c, err); }
  };
  app.post("/terminals", (c) => start(c, false));
  app.post("/terminals/resume", (c) => start(c, true));

  app.get("/terminals/:id", (c) => {
    const info = host.get(c.req.param("id"));
    return info ? c.json({ terminal: info }) : c.json({ error: "not found" }, 404);
  });

  // The user's own name for a terminal; null or "" goes back to the derived one.
  app.patch("/terminals/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, Rename);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const info = host.rename(id, body.data.name);
      audit.record({ terminal: id, action: "rename", via: via(c) });
      return c.json({ terminal: info });
    } catch (err) { return failed(c, err); }
  });

  // Snapshot (or the missed output, with ?after=<seq>), then output, status, permission requests as they come.
  app.get("/terminals/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!host.get(id)) return c.json({ error: "not found" }, 404);
    const raw = c.req.query("after");
    const after = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
    // The drawing screen's id (terminal-v0 §1 "尺寸有主"); the page beside a native screen follows without one.
    const screen = c.req.query("screen");
    const by = screen && SCREEN_ID.test(screen) ? screen : null;
    return streamSSE(c, async (stream) => {
      const queue: TerminalEvent[] = [];
      let wake: (() => void) | null = null;
      let open = true;
      const unsubscribe = host.subscribe(id, after, (ev) => {
        queue.push(ev);
        if (queue.length > MAX_QUEUED) open = false;
        wake?.();
      }, by);
      stream.onAbort(() => { open = false; wake?.(); });
      const heartbeat = setInterval(() => { void stream.write(": ping\n\n").catch(() => undefined); }, deps.sseHeartbeatMs ?? SSE_HEARTBEAT_MS);
      try {
        while (open) {
          for (const ev of coalesce(queue.splice(0))) {
            await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev), ...("seq" in ev ? { id: String(ev.seq) } : {}) });
            if (ev.type === "removed") open = false;
          }
          if (!open) break;
          await new Promise<void>((resolve) => { wake = resolve; if (queue.length || !open) resolve(); });
          wake = null;
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });

  // A sealed reply goes through the sealer first, like a task (router-v0 §9): credentials in it reach the agent as
  // ciphertext. `seal: false` types it as it is, as a keyboard on the Mac would (the phone checks for secrets first).
  app.post("/terminals/:id/input", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, Input);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const info = host.get(id);
    if (!info) return c.json({ error: "not found" }, 404);
    if (info.status === "exited") return c.json({ error: `terminal ${id} has ended` }, 409);
    let text = body.data.text;
    let sealed = 0;
    if (deps.sealer && body.data.seal) {
      const r = await deps.sealer(text);
      if (!r.ok) return c.json({ error: r.error }, r.code === "unroutable" ? 400 : 503);
      text = r.text;
      sealed = r.sealed.length;
    }
    try {
      host.write(id, replyBytes(text, host.bracketedPaste(id), body.data.submit));
    } catch (err) { return failed(c, err); }
    audit.record({ terminal: id, action: "input", via: via(c), detail: { length: body.data.text.length, sealed, direct: !body.data.seal } });
    return c.json({ ok: true, sealed });
  });

  // Files for the agent (docs/terminal-v0.md §4; the phone's picture button): staged with POST /uploads, moved out of the
  // project into a folder of this terminal's own, their paths pasted into the agent's prompt as a file dragged into a
  // Mac terminal is (Claude Code turns an image's into [Image #n]). Nothing is sent: the user writes on and sends.
  app.post("/terminals/:id/attach", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, Attach);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const info = host.get(id);
    if (!info) return c.json({ error: "not found" }, 404);
    if (info.status === "exited") return c.json({ error: `terminal ${id} has ended` }, 409);
    let files;
    try { files = deps.uploads.moveToDir(body.data.uploads, attachDir(id)); }
    catch (err) { return c.json({ error: (err as Error).message }, 400); }
    try {
      host.write(id, replyBytes(`${files.map((f) => f.path).join(" ")} `, host.bracketedPaste(id), false));
    } catch (err) { return failed(c, err); }
    audit.record({ terminal: id, action: "attach", via: via(c), detail: { count: files.length, bytes: files.reduce((n, f) => n + f.size, 0) } });
    return c.json({ files });
  });

  // What `/` offers on the phone: the agent's slash commands in the terminal's folder (read afresh: a command file
  // written a moment ago is there).
  app.get("/terminals/:id/commands", (c) => {
    const info = host.get(c.req.param("id"));
    if (!info) return c.json({ error: "not found" }, 404);
    return c.json({ commands: slashCommands(info.harness, info.cwd) });
  });

  app.post("/terminals/:id/keys", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, Keys);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const ctx = host.keyContext(id);
      // A click outside the screen is a phone that has not heard the size yet: nothing of it is sent.
      const outside = body.data.keys.some((k) => { const m = CLICK.exec(k); return !!m && (Number(m[1]) >= ctx.cols || Number(m[2]) >= ctx.rows); });
      if (outside) return c.json({ error: "click outside the screen" }, 400);
      const bytes = body.data.keys.map((k) => keySequence(k, ctx)).join("");
      if (bytes) host.write(id, bytes);
    } catch (err) { return failed(c, err); }
    // Scrolling is not an action worth a line each notch.
    if (!body.data.keys.every((k) => k.startsWith("wheel-"))) audit.record({ terminal: id, action: "keys", via: via(c), detail: { keys: body.data.keys } });
    return c.json({ ok: true });
  });

  // Keystrokes as they are, from a full keyboard on this Mac (the web page, the Mac app's window). Not on the remote
  // allowlist: a paired phone replies through /input (sealed) and /keys.
  app.post("/terminals/:id/write", async (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "not available from a paired device" }, 403);
    const body = await parseBody(c, Raw);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      host.write(c.req.param("id"), body.data.data);
    } catch (err) { return failed(c, err); }
    return c.json({ ok: true });
  });

  // A screen that just attached asks for a fresh drawing (what a snapshot cannot carry, like links).
  app.post("/terminals/:id/redraw", (c) => {
    try {
      host.redraw(c.req.param("id"));
    } catch (err) { return failed(c, err); }
    return c.json({ ok: true });
  });

  app.post("/terminals/:id/resize", async (c) => {
    const body = await parseBody(c, Resize);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      host.resize(c.req.param("id"), body.data.cols, body.data.rows, body.data.screen ?? null);
    } catch (err) { return failed(c, err); }
    return c.json({ ok: true });
  });

  app.post("/terminals/:id/permissions/:pid", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, Decide);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const request = host.get(id)?.permissions.find((p) => p.id === c.req.param("pid"));
      if (!host.decide(id, c.req.param("pid"), body.data.decision)) return c.json({ error: "no such request (answered already?)" }, 404);
      audit.record({ terminal: id, action: "permission", via: via(c), detail: { decision: body.data.decision, tool: request?.tool ?? null } });
      return c.json({ ok: true });
    } catch (err) { return failed(c, err); }
  });

  // End the program; the terminal stays listed with its last screen until deleted.
  app.post("/terminals/:id/kill", (c) => {
    const id = c.req.param("id");
    try {
      host.kill(id);
    } catch (err) { return failed(c, err); }
    audit.record({ terminal: id, action: "kill", via: via(c) });
    return c.json({ ok: true });
  });

  // End it if it runs and forget it; ?transcript=1 also deletes the agent's own record of the session (irreversible) —
  // only a record this terminal started (a new session, a fork), never the one it went on writing or one `/resume`d
  // inside it, and only once the agent has exited (else its last writes would make the file again).
  app.delete("/terminals/:id", async (c) => {
    const id = c.req.param("id");
    const transcript = c.req.query("transcript") === "1";
    const before = host.get(id);
    if (transcript && before?.resumedFrom && !before.forked) return c.json({ error: "此终端写入的是原会话，关闭时不删除记录。如需删除，请在会话列表中操作。" }, 409);
    try {
      const own = transcript && before ? host.ownSession(id) : null;
      if (own) await host.stopped(id);
      const info = host.remove(id);
      rmSync(attachDir(id), { recursive: true, force: true });
      const removed = own ? deleteTranscript(info.harness, own) : [];
      audit.record({ terminal: id, action: "delete", via: via(c), detail: { transcript: removed.length } });
      return c.json({ ok: true, transcriptFiles: removed.length });
    } catch (err) { return failed(c, err); }
  });
}
