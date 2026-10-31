/** AgentSwitch's own terminals, the manual entry (docs/terminal-v0.md §4): list, start, resume, stream, reply, keys,
 *  resize, answer a permission request, end, delete. Same routes for this Mac and a paired phone, except the hook route,
 *  which only the agents' hook command calls (with its terminal's hook token, not the local token). */

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { diskSpelling, keptDiskSpelling } from "../core/paths.js";
import { z } from "zod";
import { remoteCaller } from "../core/caller.js";
import { SSE_HEARTBEAT_MS } from "../core/limits.js";
import type { TerminalAudit } from "../terminals/audit.js";
import { attachable } from "../files/browse.js";
import { viewerFor } from "./browse.js";
import type { ElsewhereCheck } from "../terminals/elsewhere.js";
import { checkPicks, MAX_OTHER, PERMISSION_MODES, TERMINAL_HARNESSES, TerminalError, type QuestionPick, type TerminalEvent, type TerminalHarness, type TerminalHost, CLAUDE_MODES } from "../terminals/host.js";
import type { TerminalStyle } from "../terminals/style.js";
import type { ModelOffer, Offers } from "../router/modelOffers.js";
import { CLAUDE_EFFORTS, EFFORT, effortsFor, PI_THINKING, type EffortOffers } from "../harness/efforts.js";
import { slashCommands, withCommand } from "../terminals/commands.js";
import { BrowserError, YOU } from "../browser/types.js";
import { DEFAULT_PROFILE } from "../profiles/store.js";
import { browserExitProblem, exitFor } from "./profiles.js";
import { folderFiles, matchFiles } from "../terminals/files.js";
import { CLICK, droppedPath, KEY_NAMES, type KeyName, keySequence, replyBytes } from "../terminals/keys.js";
import { deleteTranscript } from "../terminals/transcripts.js";
import { GitStatus } from "../terminals/gitStatus.js";
import { CODEX_KEY_PROVIDER } from "../terminals/launch.js";
import type { SentReply, TerminalInfo } from "../terminals/host.js";
import { subagentDoing } from "./live.js";
import { modelSettings } from "../router/modelOverlay.js";
import { modelName } from "../util/modelName.js";
import { checkTerminalCwd } from "./cwdPolicy.js";
import { parseBody, type ApiDeps } from "./shared.js";
import { whereNow } from "../sessions/moved.js";
import type { SessionMonitor } from "../sessions/monitor.js";
import { fileRev, type RecordItem } from "../sessions/record.js";

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
  /** OpenCode's variants per model (`provider/id`), as its server lists them. */
  readonly variants?: () => Readonly<Record<string, readonly string[]>>;
  /** Codex's Daybreak switch was turned from a screen: its own default went with it (the offers say how new sessions
   *  start). */
  readonly daybreakTurned?: (on: boolean) => void;
  /** Where a terminal's attached files go (`<dir>/<id>/`); default the system's temporary folder (no spaces). */
  readonly attachDir?: string;
  /** Before an agent starts (Codex: its hooks trusted, codexHooks.ts); whatever happens, the start goes on. */
  readonly prepare?: (harness: TerminalHarness, home?: string) => Promise<unknown>;
  /** The tree's git status (default: `git status` itself, gitStatus.ts). */
  readonly git?: GitStatus;
  /** Whether `harness` is signed in, in the folder a profile gives it (signIn.ts); null or absent: not known. */
  readonly signedIn?: (harness: TerminalHarness, configHome: string) => Promise<boolean | null>;
};

/** A terminal as the screens list it: each sub-agent with what it is doing in words (`doing`, as the Live Activity). */
/** A terminal as the list gives it: its folders spelled as the disk spells them (one opened as `~/x/pi` is in the same
 *  folder as the sessions recorded in `~/x/Pi`, and listed with them). */
function shown(t: TerminalInfo) {
  const cwd = keptDiskSpelling(t.cwd), workdir = keptDiskSpelling(t.workdir);
  return { ...t, cwd, workdir, subagents: t.subagents.map((a) => ({ ...a, doing: subagentDoing(a.activity, t.cwd) })) };
}

const MAX_INPUT = 20_000;
/** Sessions' folders whose git is shown: the most recently used ones, at most this many (the terminals' always). */
const GIT_FOLDERS = 60;
const Attach = z.object({ uploads: z.array(z.string().min(1).max(64)).min(1).max(10) });
const Size = { cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(300) };
/** A model id goes to the agent as `--model <id>`: never one that could read as a flag. */
const ModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,199}$/, "not a model id");
/** A session id goes after `--resume` / `resume` / `--session`: likewise never one that could read as a flag. */
const SessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/, "not a session id");
const Effort = z.string().regex(EFFORT, "not a level");
const NewTerminal = z.object({ harness: z.enum(TERMINAL_HARNESSES), cwd: z.string().min(1).max(4096), profile: z.string().regex(/^[a-z0-9]{6,16}$|^default$/).optional(), model: ModelId.optional(), effort: Effort.optional(), mode: z.enum(PERMISSION_MODES).optional(), cols: Size.cols.optional(), rows: Size.rows.optional() });
const ResumeTerminal = NewTerminal.extend({ agentSessionId: SessionId, title: z.string().max(300).optional(), fork: z.boolean().optional() });
/** `attachments`: a reply's files, each where its placeholder stands in `text` (terminal-v0 §4): one staged with
 *  POST /uploads (`upload`, a phone's, or a picture pasted on the Mac with no file behind it), or one already on this
 *  Mac by where it is (`path`, the Mac app's: a file dragged into its reply box is not copied, its path is typed as a
 *  terminal would type it). */
const Input = z.object({
  text: z.string().min(1).max(MAX_INPUT), submit: z.boolean().default(true),
  attachments: z.array(z.object({
    token: z.string().regex(/^\[(Image|File) #\d{1,3}\]$/),
    upload: z.string().min(1).max(64).optional(),
    // No control character: nothing in it could end the paste or enter a line.
    path: z.string().min(2).max(4096).regex(/^\/[^\x00-\x1f\x7f]*$/, "an absolute path").optional(),
  }).refine((a) => (a.upload === undefined) !== (a.path === undefined), "one of upload, path")).max(10).default([]),
});
/** Between the pastes of one reply: the agent takes each (Claude Code reads an image's path) before the next. */
const PASTE_GAP_MS = 150;
/** A paired node typing into a terminal is one line in the audit this often, not one a keystroke. */
const REMOTE_TYPING_AUDIT_MS = 60_000;
const SUBMIT_AFTER_FILES_MS = 400;
const Keys = z.object({ keys: z.array(z.union([z.enum(KEY_NAMES), z.string().regex(CLICK).transform((k) => k as KeyName)])).min(1).max(20) });
/** `screen`: the asking screen's own id, which then owns the size (terminal-v0 §1). */
const SCREEN_ID = /^[\w-]{1,64}$/;
const Resize = z.object({ ...Size, screen: z.string().regex(SCREEN_ID).optional() });
/** `answers`: a question's (AskUserQuestion, terminal-v0 §3 "选择题"), by its text: the options picked, Other's words.
 *  Other's words are typed as written. */
const Decide = z.object({
  decision: z.enum(["allow", "deny"]),
  answers: z.record(z.string().max(2000), z.object({ labels: z.array(z.string().max(2000)).max(16).optional(), other: z.string().max(MAX_OTHER).optional() })).optional(),
});
const Rename = z.object({ name: z.string().max(200).nullable() });
const HookBody = z.object({ event: z.string().min(1).max(64), payload: z.record(z.string(), z.unknown()) });
const Raw = z.object({ data: z.string().min(1).max(MAX_INPUT) });

const STATUS: Record<TerminalError["code"], 400 | 403 | 404 | 409> = { not_found: 404, exited: 409, unavailable: 400, forbidden: 403, invalid: 400, busy: 409 };
/** Agents that can go on with a session, and those that can fork one (docs/terminal-v0.md §5). */
const RESUMES: ReadonlySet<TerminalHarness> = new Set(["claude-code", "codex", "opencode", "pi"]);
const FORKS: ReadonlySet<TerminalHarness> = new Set(["claude-code", "codex", "pi"]);
/** Events a stalled screen may fall behind by before its stream is ended (it reconnects to a fresh snapshot). */
const MAX_QUEUED = 5_000;

/** `~` and `~/x` as the user's home; everything else must be absolute. */
function expandCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return join(homedir(), cwd.slice(2));
  return cwd;
}

/** Consecutive output events as one (a busy agent writes in many small pieces). */
/** How often a record's stream looks at the session's file, and how often it looks for the file while there is none
 *  yet (a terminal just started has no session until the agent says which; a new session has no file until its first
 *  message). The file the agent's hooks named is looked at on each look. */
const RECORD_WATCH_MS = 300;
const RECORD_FIND_MS = 1000;

/** A record's user entry stands for a reply sent at `at` when it is no older than that (a moment's slack for the two
 *  clocks' rounding) and says the same — its first words, since a long one is cut short in the record; one that went
 *  with files reads otherwise there (a placeholder where a path was typed), so the time alone decides. */
const SENT_SLACK_MS = 3_000;
const SENT_SAME_CHARS = 24;
const words = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, SENT_SAME_CHARS);
export function holdsReply(items: readonly RecordItem[], reply: SentReply): boolean {
  return items.some((item) => item.type === "user" && item.ts >= reply.at - SENT_SLACK_MS && (reply.files > 0 || words(item.text) === words(reply.text)));
}

/** The terminal's record changed: the replies sent to it that the record now holds are no longer shown beside it. */
function confirmSent(host: TerminalHost, sessions: SessionMonitor, id: string): void {
  const t = host.get(id);
  if (!t?.sent.length || !t.agentSessionId) return;
  try {
    const items = sessions.record(t.harness, t.agentSessionId, { limit: 40 }, true)?.record.items ?? [];
    const held = t.sent.filter((reply) => holdsReply(items, reply)).map((reply) => reply.id);
    if (held.length) host.confirmSent(id, held);
  } catch { /* unreadable just now: the next change looks again */ }
}

/** Calls `changed` with the version of the terminal's session file and the session it is of, now and each time the
 *  file changes; a session the terminal goes to (a `/clear`, another one resumed) is told at once, with no version
 *  while it has no file yet — a screen need not wait for the terminals' list to know it. OpenCode keeps its sessions
 *  in one database, which says nothing of one session: its screens ask again on their own. Returns the stop. */
export function watchRecord(host: TerminalHost, sessions: SessionMonitor, id: string, changed: (rev: string, session: string) => void, everyMs = RECORD_WATCH_MS): () => void {
  let path: string | null = null, of: string | null = null, last: string | null = null, looked = 0, told = false, named: string | null = null;
  const look = () => {
    const t = host.get(id);
    const session = t?.agentSessionId;
    if (!t || !session || t.harness === "opencode") return;
    if (of !== session) { of = session; path = null; last = null; looked = 0; told = false; named = null; }
    if (!path) {
      // Where its hooks said it writes: there now, it is looked for at once (once for each file named).
      const file = host.recordFileOf(id);
      const there = file !== null && file !== named && existsSync(file);
      if (!there && Date.now() - looked < RECORD_FIND_MS) return;
      if (there) named = file;
      looked = Date.now();
      // Its own session, wherever it runs (the list leaves scratch folders out).
      path = sessions.locate(t.harness, session);
      if (!path) {
        if (!told) { told = true; changed("", session); }
        return;
      }
    }
    try { const { rev } = fileRev(path); if (rev !== last) { last = rev; told = true; changed(rev, session); } } catch { path = null; }
  };
  look();
  const timer = setInterval(look, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

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

  // Git at a glance for the tree's folders (docs/terminal-v0.md §5): the folders of the terminals and of the sessions
  // the tree lists, never a path a caller names. Folders not in a repository are left out.
  const git = t.git ?? new GitStatus();
  host.onWorkDone((cwd) => git.invalidate(cwd));
  app.get("/folders/git", async (c) => {
    // The terminals' folders, where their agents work now (the window's title), the sessions' folders.
    const recent = [...new Set((deps.sessions?.list() ?? []).map((x) => x.cwd))].slice(0, GIT_FOLDERS);
    const folders = [...host.list().flatMap((x) => [x.cwd, x.workdir]), ...recent];
    return c.json({ folders: await git.summaries(folders.filter((f) => isAbsolute(f))) });
  });

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

  // The key a terminal's profile pays by, for its agent to send (hookClient.ts `key`; docs/profiles-v0.md §3.6). Let
  // through the local token check like the hook, and proven the same way; not on the remote allowlist. Why none was
  // given is written down here — the agent shows little of what the program says.
  app.post("/terminals/key", async (c) => {
    const id = c.req.header("x-agentswitch-terminal") ?? "";
    const token = /^Bearer\s+(\S+)\s*$/.exec(c.req.header("authorization") ?? "")?.[1];
    const refuse = (status: 400 | 409 | 502, error: string) => { console.error(`terminals: terminal ${id.slice(0, 16) || "?"} asked for its profile's key and was given none (${status}: ${error})`); return c.json({ error }, status); };
    if (!token) return refuse(400, "bad key call");
    try {
      const of = host.profileOf(id, token);
      if (!of.profile || !deps.apiKeys) return refuse(409, "this terminal's profile pays by no key");
      try { return c.json({ key: await deps.apiKeys.plain(of.harness, of.profile) }); }
      catch (err) { return refuse(502, (err as Error).message); }
    } catch (err) { return failed(c, err); }
  });

  // A web address the agent in a terminal asked the system to open (launch.ts `openInProfileBrowser`): opened in its
  // profile's own browser. Let through the local token check like the hook, and proven the same way. Refused when the
  // terminal has no browser of its own, or that browser shows nothing on this Mac (nobody could sign in there).
  app.post("/terminals/open", async (c) => {
    const id = c.req.header("x-agentswitch-terminal") ?? "";
    const token = /^Bearer\s+(\S+)\s*$/.exec(c.req.header("authorization") ?? "")?.[1];
    // JSON, as everything the local listener takes (api/localGuard.ts): the opener sends it so.
    const said = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof said?.url === "string" ? said.url : "";
    // Why a page was not opened is written down here: the opener's own words go to the agent, which shows none of
    // them. Never the address — a sign-in's carries what is good for one use.
    const refuse = (status: 400 | 409 | 502, error: string) => { console.error(`terminals: a page terminal ${id.slice(0, 16) || "?"} asked to have opened in its own browser was not opened (${status}: ${error})`); return c.json({ error }, status); };
    if (!token || !/^https?:\/\/\S{1,4000}$/.test(url)) return refuse(400, "bad open call");
    try {
      const key = host.browserOf(id, token);
      const browser = key ? deps.profileBrowsers?.of(key) ?? null : null;
      if (!browser) return refuse(409, "this terminal has no browser of its own");
      if (!browser.visible()) return refuse(409, "this terminal's browser shows no window on this Mac");
      if (!browser.host.running) {
        const problem = await browserExitProblem(deps, key!);
        if (problem) return refuse(502, problem);
      }
      // Said before the browser is started (a few seconds for one that was not running): the Mac's app is to know
      // that this browser's window was asked for by the time it comes up, not after.
      const at = Date.now();
      deps.profileBrowsers?.noteShown(key!, "", at);
      const tab = await browser.host.open(YOU, url);
      deps.profileBrowsers?.noteShown(key!, tab.id, at);
      browser.audit.record({ tab: tab.id, action: "open", via: `terminal ${id}`, detail: { url: new URL(url).origin } });
      void browser.host.show(tab.id).catch(() => undefined);
      return c.json({ tab: tab.id });
    } catch (err) {
      // Nothing was opened after all: no window is to be waited for.
      if (deps.profileBrowsers?.shown?.tab === "") deps.profileBrowsers.shown = null;
      if (err instanceof BrowserError) return refuse(502, err.message);
      console.error(`terminals: a page terminal ${id.slice(0, 16) || "?"} asked to have opened in its own browser was not opened (${(err as Error).message})`);
      return failed(c, err);
    }
  });

  // The agents this Mac can start, and each one's models for the new terminal's model menu: what the agent offers
  // today, in its order and names, the superseded ones marked `older` (else the catalog, targets.yaml after discovery);
  // none chosen = the agent's own default, named in `defaults` when the agent says what it is.
  // With each model, how hard it can be asked to think (`efforts`, lowest first; none: it takes no level) and what it
  // uses unless told (`defaultEffort`), in the agent's own words (harness/efforts.ts). `efforts[agent]`: the levels
  // when no model is chosen (the agent's default model; pi's one list); absent: none without a model (OpenCode).
  const listing = () => {
    const catalog = modelSettings(deps.targets).harnesses;
    const offers = t.offers?.() ?? {};
    const variants = t.variants?.() ?? {};
    const models = Object.fromEntries(agents.map((a) => [a, (offers[a as keyof Offers]?.models
      ?? (catalog[a]?.models ?? []).map((id): ModelOffer => ({ id, name: modelName(id), ...(a === "opencode" && variants[id] ? { efforts: variants[id] } : {}) }))) as readonly ModelOffer[]]));
    const defaults = Object.fromEntries(Object.entries(offers).flatMap(([a, o]) => (o?.defaultName ? [[a, o.defaultName]] : [])));
    const efforts = Object.fromEntries(agents.flatMap((a): [string, readonly string[]][] => {
      const own = a === "pi" ? PI_THINKING : offers[a as keyof Offers]?.efforts;
      return own?.length ? [[a, own]] : [];
    }));
    const effortDefaults = Object.fromEntries(Object.entries(offers).flatMap(([a, o]) => (o?.defaultEffort ? [[a, o.defaultEffort]] : [])));
    // Codex's Daybreak switch, where it has one: how its new sessions start (a new terminal's models are listed by it,
    // docs/simple-view-v0.md §5.8). An agent without the switch is not named.
    const daybreak = Object.fromEntries(Object.entries(offers).flatMap(([a, o]) => (o?.daybreak !== undefined ? [[a, o.daybreak]] : [])));
    return { models, defaults, efforts, effortDefaults, daybreak };
  };
  /** What a new terminal may be started at, from the same lists the screens were given. */
  const effortOffers = (): EffortOffers => {
    const { models, efforts } = listing();
    return {
      any: efforts,
      models: Object.fromEntries(Object.entries(models).map(([a, list]) => [a, Object.fromEntries(list.flatMap((m) => (m.efforts ? [[m.id, m.efforts]] : [])))])),
    };
  };
  app.get("/terminals", (c) => c.json({ terminals: host.list().map(shown), agents, ...listing() }));
  app.get("/terminals/style", (c) => c.json(t.style()));

  const start = async (c: Context, resume: boolean) => {
    const body = resume ? await parseBody(c, ResumeTerminal) : await parseBody(c, NewTerminal);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const typed = expandCwd(body.data.cwd);
    if (!isAbsolute(typed)) return c.json({ error: "cwd must be an absolute path" }, 400);
    // A level the agent does not list for this model would fail its launch (or, OpenCode, its first turn): refused here.
    if (body.data.effort) {
      const takes = effortsFor(effortOffers(), body.data.harness, body.data.model);
      if (!takes?.includes(body.data.effort)) {
        return c.json({ error: takes ? `effort: one of ${takes.join(", ")}` : "effort: this model takes no level (OpenCode: choose a model first)" }, 400);
      }
    }
    // `~/proj/` and `~/proj` are one folder; so are `~/proj` and `~/Proj` on a Mac's disk, which the agent then records
    // and the list shows by the disk's own spelling.
    const cwd = diskSpelling(resolve(typed));

    const resumed = resume ? (body.data as z.infer<typeof ResumeTerminal>) : null;
    const agentSessionId = resumed?.agentSessionId;
    const fork = Boolean(resumed?.fork);
    if (resumed && !RESUMES.has(resumed.harness)) return c.json({ error: `${resumed.harness} cannot continue a session` }, 400);
    if (fork && !FORKS.has(body.data.harness)) return c.json({ error: `${body.data.harness} cannot fork a session` }, 400);
    const openHere = () => host.list().find((x) => x.status !== "exited" && x.harness === body.data.harness && x.agentSessionId === agentSessionId);
    // One session, one writer (docs/terminal-v0.md §5): already open here → that terminal, wherever its folder is now.
    const already = agentSessionId && !fork ? openHere() : undefined;
    if (already) return c.json({ terminal: already, existing: true });

    // Any folder, as in any terminal (docs/terminal-v0.md §2, 2026-09-30); tasks keep control-v0 §2's rules.
    const problem = checkTerminalCwd(cwd);
    if (problem && !resume) return c.json({ error: problem }, 400);
    // A session whose folder is gone (moved, renamed, deleted) goes on in a folder the user picks (docs/terminal-v0.md
    // §5, 2026-10-03, user: 如果会话没了选择新目录继续): said apart from other refusals, with where it may be now.
    if (problem) {
      const known = [...host.list().map((x) => x.cwd), ...(deps.sessions?.list() ?? []).map((x) => x.cwd)];
      return c.json({ error: `会话所在的文件夹 ${cwd} 已不存在。`, folderGone: cwd, ...whereNow(cwd, known) }, 422);
    }
    // Continued somewhere other than where it is listed (the folder it ran in is gone; the user picked this one): said
    // in the audit.
    const listedAt = resumed ? deps.sessions?.find(resumed.harness, resumed.agentSessionId)?.cwd : undefined;
    const movedFrom = listedAt && listedAt !== cwd ? listedAt : undefined;
    // pi goes on with a session only in the folder it began in (it keeps it under that folder and does not move it);
    // started anywhere else it asks, in the terminal, whether to fork it there. In another folder the service asks for
    // the fork itself: a new session there with the whole history, the first one left where it is (§5, 2026-10-11).
    const forks = fork || (body.data.harness === "pi" && movedFrom !== undefined);
    // The profile it starts under (docs/profiles-v0.md §3.3): the one named. Not named — a conversation goes on under
    // the one it last ran under (the Mac's own when none is known, or that one is gone); a new terminal starts under
    // the one last chosen for a new terminal. `Default` is the Mac's own: nothing is set for it.
    // A Codex thread says which model provider it went on with last (sessions/codex.ts): AgentSwitch's own one is a
    // profile's that pays by a key (§3.6). With nothing noted of which (the note was lost, 2026-10-24), it goes on under
    // the only such profile there is; and should it go on under one that pays by no key, Codex is told the user's own
    // provider — else it will not start, the thread's naming one only that kind of terminal defines.
    const provider = resumed?.harness === "codex" ? deps.sessions?.codexProvider(resumed.agentSessionId) ?? null : null;
    const noted = resumed ? deps.profiles?.sessionProfile(resumed.harness, resumed.agentSessionId) ?? null : null;
    const keyed = provider === CODEX_KEY_PROVIDER && !noted ? (deps.profiles?.all().codex.profiles ?? []).filter((p) => p.kind === "api") : [];
    const recorded = resumed ? noted ?? (keyed.length === 1 ? keyed[0]!.id : DEFAULT_PROFILE) : null;
    const wanted = body.data.profile ?? recorded ?? deps.profiles?.current(body.data.harness) ?? DEFAULT_PROFILE;
    const profileHome = wanted === DEFAULT_PROFILE ? null : deps.profiles?.homeOf(body.data.harness, wanted) ?? null;
    // What of the Mac's own set-up came since the profile was made is linked into its folder (Codex's, §6.2).
    if (profileHome) deps.profiles?.keepLinked(body.data.harness, wanted);
    // The agent made ready (Codex: its hooks trusted in the folder it runs in, a few seconds at most); the start goes
    // on whatever happens.
    await t.prepare?.(body.data.harness, profileHome ?? undefined).catch(() => undefined);
    // Open in another program → say where, and the client may fork instead.
    if (agentSessionId && !forks) {
      const open = openHere();
      if (open) return c.json({ terminal: open, existing: true });
      const ours = host.list().flatMap((x) => (x.pid && x.status !== "exited" ? [x.pid] : []));
      const other = await t.elsewhere(body.data.harness, agentSessionId, ours).catch(() => null);
      if (other) return c.json({ error: `会话正在${other.app ?? "其他程序"}中运行`, elsewhere: other }, 409);
      // Checked again with nothing awaited before the spawn: two screens resuming at once get one terminal.
      const raced = openHere();
      if (raced) return c.json({ terminal: raced, existing: true });
    }
    // One that pays by a key (§3.6): the agent is told where to send it and asks for the key itself. Codex's has no
    // folder of its own.
    const paid = wanted === DEFAULT_PROFILE ? null : deps.profiles?.apiOf(body.data.harness, wanted) ?? null;
    if (wanted !== DEFAULT_PROFILE && !profileHome && !paid) return c.json({ error: "no such profile" }, 400);
    const color = wanted !== DEFAULT_PROFILE ? deps.profiles!.colorOf(body.data.harness, wanted) : null;
    const quiet = wanted !== DEFAULT_PROFILE && deps.profiles!.telemetryOff(body.data.harness, wanted);
    let profile: { id: string; name: string; home?: string; proxy?: string; exit?: { ip: string; place: string | null }; browserKey?: string; color?: string; api?: { baseUrl?: string; model?: string }; telemetryOff?: true } | null =
      wanted !== DEFAULT_PROFILE ? { id: wanted, name: deps.profiles!.nameOf(body.data.harness, wanted) ?? wanted, ...(profileHome ? { home: profileHome } : {}), ...(color ? { color } : {}), ...(quiet ? { telemetryOff: true as const } : {}),
        ...(paid ? { api: { ...(paid.baseUrl ? { baseUrl: paid.baseUrl } : {}), ...(paid.model ? { model: paid.model } : {}) } } : {}) } : null;
    // A profile with a proxy of its own: before anything is started under it, the proxy is asked where it lets
    // traffic out. One that does not answer starts nothing — the agent is not let out another way (§4).
    if (profile) {
      const way = await exitFor(deps, body.data.harness, wanted, profile.name);
      if ("refused" in way) return c.json({ error: way.refused }, way.status);
      profile = { ...profile, ...way };
      // A browser of its own goes with a folder of its own: without one the shared browser, and the system's for a
      // page the agent asks to have opened.
      if (!profile.home) delete profile.browserKey;
    }
    // A profile nobody is signed in to starts at its sign-in (docs/profiles-v0.md §3.1), not at a prompt that cannot
    // answer. Asked of the agent itself; when it does not say, nothing is assumed.
    // Only one that signs in with an account: one that pays by a key has nobody to sign in.
    const account = profile && deps.profiles!.kindOf(body.data.harness, wanted) === "subscription";
    const signIn = Boolean(profile?.home && account && (await t.signedIn?.(body.data.harness, profile.home).catch(() => null)) === false);
    try {
      const info = await host.spawn({ harness: body.data.harness, cwd, ...(profile ? { profile } : {}), ...(signIn ? { signIn: true as const } : {}), ...(body.data.model ? { model: body.data.model } : {}), ...(body.data.effort ? { effort: body.data.effort } : {}), ...(agentSessionId ? { resume: agentSessionId, ...(forks ? { fork: forks } : {}) } : {}),
        ...(resumed?.title ? { name: resumed.title } : {}), ...(body.data.mode ? { mode: body.data.mode } : {}),
        ...(provider === CODEX_KEY_PROVIDER && !paid ? { ownProvider: true as const } : {}),
        allowBypass: true,
        ...(body.data.cols ? { cols: body.data.cols } : {}), ...(body.data.rows ? { rows: body.data.rows } : {}) });
      // What a new terminal was started under is what the next one is offered first.
      if (!resume && body.data.profile) { try { deps.profiles?.setCurrent(body.data.harness, body.data.profile); } catch { /* it started all the same */ } }
      audit.record({ terminal: info.id, action: resume ? "resume" : "create", via: via(c), detail: { harness: info.harness, cwd, model: info.model, effort: info.effort, mode: info.mode, ...(resume ? { fork: forks } : {}), ...(movedFrom ? { movedFrom } : {}) } });
      return c.json({ terminal: info }, 201);
    } catch (err) { return failed(c, err); }
  };
  app.post("/terminals", (c) => start(c, false));
  app.post("/terminals/resume", (c) => start(c, true));

  app.get("/terminals/:id", (c) => {
    const info = host.get(c.req.param("id"));
    return info ? c.json({ terminal: shown(info) }) : c.json({ error: "not found" }, 404);
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
    // `view=record`: a screen that shows the session's record instead of the terminal (docs/simple-view-v0.md §4). It
    // gets no screen content, and is told what the agent is doing now and when its record changed. It draws no
    // terminal, so it owns no size.
    const record = c.req.query("view") === "record";
    return streamSSE(c, async (stream) => {
      const queue: TerminalEvent[] = [];
      let wake: (() => void) | null = null;
      let open = true;
      const unsubscribe = host.subscribe(id, record ? null : after, (ev) => {
        if (record ? ev.type === "snapshot" || ev.type === "output" : ev.type === "activity" || ev.type === "progress" || ev.type === "sent" || ev.type === "choices" || ev.type === "notices" || ev.type === "writing") return;
        queue.push(ev);
        if (queue.length > MAX_QUEUED) open = false;
        wake?.();
      }, by);
      stream.onAbort(() => { open = false; wake?.(); });
      const heartbeat = setInterval(() => { void stream.write(": ping\n\n").catch(() => undefined); }, deps.sseHeartbeatMs ?? SSE_HEARTBEAT_MS);
      const watch = record && deps.sessions ? watchRecord(host, deps.sessions, id, (rev, session) => { queue.push({ type: "record", rev, session }); wake?.(); if (rev) confirmSent(host, deps.sessions!, id); }, deps.recordWatchMs ?? RECORD_WATCH_MS) : null;
      if (record) {
        const now = host.get(id);
        if (now) {
          queue.push({ type: "activity", activity: now.activity, subagents: now.subagents });
          if (now.progress) queue.push({ type: "progress", progress: now.progress });
          if (now.sent.length) queue.push({ type: "sent", replies: now.sent });
          if (now.choices) queue.push({ type: "choices", choices: now.choices });
          if (now.notices.length) queue.push({ type: "notices", notices: now.notices });
          const writing = host.writingOf(id);
          if (writing) queue.push({ type: "writing", writing });
        }
      }
      try {
        while (open) {
          for (const ev of coalesce(queue.splice(0))) {
            // Sub-agents as the list gives them: each with what it is doing in words.
            const said = ev.type === "activity" ? { ...ev, subagents: ev.subagents.map((a) => ({ ...a, doing: subagentDoing(a.activity, host.get(id)?.cwd ?? "") })) }
              // What it is writing: `{text, thinking?}`, or `{done: true}` once it is not (as a task's stream says it).
              : ev.type === "writing" ? (ev.writing ?? { done: true })
              : ev;
            await stream.writeSSE({ event: ev.type, data: JSON.stringify(said), ...("seq" in ev ? { id: String(ev.seq) } : {}) });
            if (ev.type === "removed") open = false;
          }
          if (!open) break;
          await new Promise<void>((resolve) => { wake = resolve; if (queue.length || !open) resolve(); });
          wake = null;
        }
      } finally {
        clearInterval(heartbeat);
        watch?.();
        unsubscribe();
      }
    });
  });

  // Another model for the agent (docs/simple-view-v0.md §5.4): its own command typed for the screen, Claude Code only.
  // 409 while it works or waits for an answer; 400 for an agent that chooses in a picker of its own.
  app.post("/terminals/:id/model", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, z.object({ model: ModelId }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    try { await host.askModel(id, body.data.model); } catch (err) { return failed(c, err); }
    audit.record({ terminal: id, action: "model", via: via(c), detail: { model: body.data.model } });
    return c.json({ ok: true });
  });

  // Another way of asking for the agent (docs/simple-view-v0.md §5.4 “换模式”): Claude Code only, while it rests; the
  // service presses its ⇧Tab and reads its screen until it is there. 409 while it works or waits, or when its screen
  // did not take the key; 400 for a mode this session does not offer (the answer says the one it is in).
  app.post("/terminals/:id/mode", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, z.object({ mode: z.enum(CLAUDE_MODES) }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    // Skipping every permission is chosen on this Mac, where the terminal is started (terminal-v0 §7): not from a phone.
    if (body.data.mode === "bypassPermissions" && remoteCaller(c.env)) return c.json({ error: "bypass is chosen on the Mac" }, 403);
    let mode: string;
    try { mode = await host.askMode(id, body.data.mode); } catch (err) { return failed(c, err); }
    audit.record({ terminal: id, action: "mode", via: via(c), detail: { mode } });
    return c.json({ ok: true, mode });
  });

  // Another thinking level for the agent (terminal-v0 §1 思考强度): Claude Code's own command typed for the screen. One of
  // the levels its current model takes when that is known (the model it reported, else the one it was started with).
  app.post("/terminals/:id/effort", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, z.object({ effort: Effort }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    const info = host.get(id);
    if (!info) return c.json({ error: "not found" }, 404);
    // Each agent's own levels: Claude Code's, pi's thinking levels. OpenCode's are its model's variants and Codex's its
    // model's reasoning efforts, which their own servers know: checked there.
    const levels: readonly string[] | null = info.harness === "opencode" || info.harness === "codex" ? null : info.harness === "pi" ? PI_THINKING : CLAUDE_EFFORTS;
    if (levels && !levels.includes(body.data.effort)) return c.json({ error: `effort: one of ${levels.join(", ")}` }, 400);
    try { await host.askEffort(id, body.data.effort); } catch (err) { return failed(c, err); }
    audit.record({ terminal: id, action: "effort", via: via(c), detail: { effort: body.data.effort } });
    return c.json({ ok: true });
  });

  // Codex's Daybreak switch turned from a screen (docs/simple-view-v0.md §5.8): its own `/daybreak` typed when it
  // stands otherwise, then its server asked until it says so. 400 for a terminal without the switch; 409 while
  // something waits for an answer, or when Codex did not turn it. Codex keeps the choice as its default as well.
  app.post("/terminals/:id/daybreak", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, z.object({ on: z.boolean() }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    let on: boolean;
    try { on = await host.askDaybreak(id, body.data.on); } catch (err) { return failed(c, err); }
    t.daybreakTurned?.(on);
    audit.record({ terminal: id, action: "daybreak", via: via(c), detail: { on } });
    return c.json({ ok: true, on });
  });

  // A reply is typed as it is, as a keyboard on the Mac would type it. Until 2026-10-08 it could go through the sealer
  // first (`seal`, the default): a terminal is not behind the credential gate now (docs/profiles-v0.md §8), and a
  // `seal` an older screen still sends is not read.
  app.post("/terminals/:id/input", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, Input);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const info = host.get(id);
    if (!info) return c.json({ error: "not found" }, 404);
    if (info.status === "exited") return c.json({ error: `terminal ${id} has ended` }, 409);
    const text = body.data.text;
    // The placeholders in the text that have a file, in order: the text is pasted between them, each file's path on its
    // own (as a file dragged into a Mac terminal), then Enter.
    const byToken = new Map(body.data.attachments.map((a) => [a.token, a]));
    const pieces = byToken.size ? text.split(/(\[(?:Image|File) #\d{1,3}\])/) : [text];
    const used = [...new Set(pieces.filter((p) => byToken.has(p)))];
    // A file by its place here has to be there (a file, or a folder: a terminal types a dragged folder's path too). This
    // node's own screens may name any but AgentSwitch's own credential places; a paired device one its Files column
    // could give it (docs/files-v0.md §7.1: the switch, its scope), and none without the Files column.
    const local = used.filter((t) => byToken.get(t)!.path !== undefined);
    if (local.length && remoteCaller(c.env) && !deps.fileAccess) return c.json({ error: "attachments: a path is this Mac's own to give" }, 403);
    const missing = local.find((t) => !existsSync(byToken.get(t)!.path!));
    if (missing) return c.json({ error: `文件不存在：${byToken.get(missing)!.path}` }, 400);
    if (local.length && deps.fileAccess) {
      const viewer = viewerFor(deps.fileAccess, c.env);
      if (viewer === "files-off") return c.json({ error: "此节点不允许配对的设备读取文件。", code: "files-off" }, 403);
      for (const t of local) {
        const p = byToken.get(t)!.path!;
        const why = attachable(p, viewer);
        if (why === "locked") return c.json({ error: `此处存放 AgentSwitch 的凭据，无法交给 agent：${p}`, code: why }, 403);
        if (why === "scope") return c.json({ error: `不在这台设备的授权范围内：${p}`, code: why }, 403);
        if (why === "permission") return c.json({ error: `AgentSwitch 无权访问：${p}`, code: why }, 403);
        if (why) return c.json({ error: `文件不存在：${p}` }, 400);
      }
    }
    const staged = used.filter((t) => byToken.get(t)!.upload !== undefined);
    let moved: { name: string; path: string; size: number }[] = [];
    if (staged.length) {
      try { moved = deps.uploads.moveToDir(staged.map((t) => byToken.get(t)!.upload!), attachDir(id)); }
      catch (err) { return c.json({ error: (err as Error).message }, 400); }
    }
    const sized = (p: string): number => { try { const st = statSync(p); return st.isFile() ? st.size : 0; } catch { return 0; } };
    const files = [...moved, ...local.map((t) => ({ name: byToken.get(t)!.path!.split("/").pop() ?? "", path: byToken.get(t)!.path!, size: sized(byToken.get(t)!.path!) }))];
    // Typed as a terminal types a dropped file: one word, whatever is in its name.
    const path = new Map([...staged.map((t, i): [string, string] => [t, moved[i]!.path]), ...local.map((t): [string, string] => [t, droppedPath(byToken.get(t)!.path!)])]);
    try {
      // One of the agent's own commands: what its screen says to it is told to the record's screens (it is in no record).
      if (body.data.submit && /^\s*\//.test(text)) host.commanded(id);
      const bracketed = host.bracketedPaste(id);
      if (!files.length) {
        host.write(id, replyBytes(text, bracketed, body.data.submit));
      } else {
        for (const piece of pieces) {
          if (!piece) continue;
          host.write(id, replyBytes(path.get(piece) ?? piece, bracketed, false));
          await new Promise((r) => setTimeout(r, PASTE_GAP_MS));
        }
        if (body.data.submit) {
          await new Promise((r) => setTimeout(r, SUBMIT_AFTER_FILES_MS));
          host.write(id, "\r");
        }
      }
    } catch (err) { return failed(c, err); }
    // What was typed and entered shows on the record's screens until the record itself holds it.
    if (body.data.submit) host.replied(id, text, files.length);
    audit.record({ terminal: id, action: "input", via: via(c), detail: { length: body.data.text.length, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) } });
    // `sealed`: always none now; older screens read the field.
    return c.json({ ok: true, sealed: 0, attached: files.length });
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
    // Codex's `/daybreak` is a command only where its feature is on: this terminal has the switch, or this Codex and
    // this account offer it (the feature is then enabled at each Codex terminal's start, launch.ts).
    // The agent's own list where a terminal running this program has been read; reading starts now if not (it takes
    // a few seconds and types into the terminal only while it rests with an empty input).
    const live = host.commandsOf(info.id);
    if (!live && (info.harness === "codex" || info.harness === "claude-code")) void host.learnCommands(info.id).catch(() => undefined);
    const commands = slashCommands(info.harness, info.cwd, undefined, live);
    const daybreak = info.harness === "codex" && (info.daybreak !== null || t.offers?.().codex?.daybreak !== undefined);
    return c.json({ commands: daybreak ? withCommand(commands, { name: "daybreak", description: "turn Daybreak on or off" }) : commands });
  });

  // What `@` offers in a reply (docs/simple-view-v0.md §5.5): the files of the folder the agent works in, by name.
  // The folder is the terminal's own, never the caller's; `q` is what was typed after the `@`.
  app.get("/terminals/:id/files", async (c) => {
    const info = host.get(c.req.param("id"));
    if (!info) return c.json({ error: "not found" }, 404);
    const q = (c.req.query("q") ?? "").slice(0, 200);
    if (/[\x00-\x1f]/.test(q)) return c.json({ error: "q: not a name" }, 400);
    return c.json({ files: matchFiles(await folderFiles(info.workdir ?? info.cwd), q) });
  });

  // One row of the list the agent's own screen shows, taken from a screen that shows the record: by its place and its
  // words as that screen had them (409 when the terminal's screen has moved on).
  app.post("/terminals/:id/choices", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, z.object({ pick: z.number().int().min(0).max(60), label: z.string().min(1).max(200) }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    try { host.choose(id, body.data.pick, body.data.label); } catch (err) { return failed(c, err); }
    audit.record({ terminal: id, action: "keys", via: via(c), detail: { choice: body.data.pick } });
    return c.json({ ok: true });
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

  // Keystrokes as they are, from a full keyboard: this Mac's own screens (the web page, the Mac app's window), and
  // another node's when this node lets paired nodes type (docs/mesh-v0.md §10; a phone replies through /input and
  // /keys). A keystroke is not a line in the audit each; a paired node's typing into a terminal is said once a minute.
  const typed = new Map<string, number>();
  app.post("/terminals/:id/write", async (c) => {
    const id = c.req.param("id");
    const remote = remoteCaller(c.env);
    if (remote && !(deps.remoteKeyboard?.() ?? false)) return c.json({ error: "this node does not take keystrokes from paired nodes" }, 403);
    const body = await parseBody(c, Raw);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      host.write(id, body.data.data);
    } catch (err) { return failed(c, err); }
    if (remote) {
      const key = `${id} ${remote.deviceId}`;
      const now = Date.now();
      if (now - (typed.get(key) ?? 0) >= REMOTE_TYPING_AUDIT_MS) {
        for (const [k, at] of typed) if (now - at >= REMOTE_TYPING_AUDIT_MS) typed.delete(k);
        typed.set(key, now);
        audit.record({ terminal: id, action: "write", via: remote.deviceId, detail: { keyboard: true } });
      }
    }
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

  // Allow or deny; a question is answered instead (terminal-v0 §3 "选择题"): checked against the request, Other's words
  // as they were written (as a reply's are). The audit says the decision and the tool, never answers.
  app.post("/terminals/:id/permissions/:pid", async (c) => {
    const id = c.req.param("id");
    const pid = c.req.param("pid");
    const body = await parseBody(c, Decide);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const request = host.get(id)?.permissions.find((p) => p.id === pid);
      const picks: Record<string, QuestionPick> | undefined = body.data.answers;
      if (picks && request?.questions && body.data.decision === "allow") {
        const wrong = checkPicks(request.questions, picks);
        if (wrong) return c.json({ error: wrong }, 400);
      }
      if (!host.decide(id, pid, body.data.decision, picks)) return c.json({ error: "no such request (answered already?)" }, 404);
      audit.record({ terminal: id, action: "permission", via: via(c), detail: { decision: body.data.decision, tool: request?.tool ?? null } });
      return c.json(picks ? { ok: true, sealed: 0 } : { ok: true });
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
      // Codex's record names a picture sent to it by its place in this folder: a copy outlives the folder
      // (docs/simple-view-v0.md §4). Claude Code keeps the picture in its own record.
      if (info.harness === "codex") deps.sessions?.keepPicturesIn(attachDir(id));
      rmSync(attachDir(id), { recursive: true, force: true });
      const removed = own ? deleteTranscript(info.harness, own) : [];
      audit.record({ terminal: id, action: "delete", via: via(c), detail: { transcript: removed.length } });
      return c.json({ ok: true, transcriptFiles: removed.length });
    } catch (err) { return failed(c, err); }
  });
}
