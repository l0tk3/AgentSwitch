/** Chatroom Kit (docs/chatroom-v0.md §6): what a session in a room can do there, as tools. A session has the Kit while
 *  it sits in a room: speaking, reading, and seeing who is there. Which session calls is settled before it gets here
 *  (its terminal's own channel says so); a session never names itself.
 *
 *  Every answer is plain text for an agent to read. A refusal says why, and is an answer too: the agent goes on. */

import { statSync } from "node:fs";
import type { RoomDelivery } from "./delivery.js";
import { YOU } from "./names.js";
import { agentName, STATE_MEETS, type SeatLookup } from "./state.js";
import { classicFrom, defaultBg, LIBRARY_SAYS, pixelFrom, type ClassicAvatar, type PixelAvatar } from "./avatars.js";
import { MAX_SESSION_TEXT, MAX_STARTED, RoomError, handleIn, type Claim, type Message, type Room, type RoomStore, type Seat, type SeatWas, type Task } from "./store.js";

/** What bringing sessions in needs of the rest of AgentSwitch (§6 开了“拉会话”才有的): the lists, a check, and
 *  starting a session. Given by the composition root; nothing here carries a credential or an account. */
export type KitOrg = {
  profiles(): Promise<readonly { readonly agent: string; readonly id: string; readonly name: string; readonly kind: string; readonly health: { readonly status: string; readonly checkedAt: number; readonly message: string } | null }[]>;
  models(): Promise<Readonly<Record<string, readonly { readonly id: string; readonly name: string; readonly description?: string }[]>>>;
  sessions(limit: number): Promise<{
    readonly running: readonly { readonly terminal: string; readonly agent: string; readonly name: string; readonly cwd: string; readonly state: string; readonly profile: string | null }[];
    readonly resumable: readonly { readonly agent: string; readonly id: string; readonly title: string; readonly cwd: string; readonly updatedAt: number; readonly profile: string | null }[];
  }>;
  check(agent: string, profile: string): Promise<{ readonly status: string; readonly checkedAt: number; readonly message: string }>;
  /** Starts a session in a terminal (`resume`: an existing one goes on); the terminal's id. Throws a RoomError that
   *  says why not. */
  start(req: { readonly agent: string; readonly cwd: string; readonly profile?: string; readonly model?: string; readonly mode?: string; readonly resume?: string }): Promise<string>;
  /** The session behind an ended terminal goes on in a new one (§6.2). Throws a RoomError that says why not. */
  /** The user's own name for a session, as the screens show it (the terminal list, the session's title): the same
   *  renaming the user does there. Throws a RoomError that says why not. */
  rename(terminal: string, name: string): Promise<void>;
  /** Ends a terminal; `transcript`: its conversation's record goes with it. Whether it was there to end. */
  stop(terminal: string, transcript?: boolean): Promise<boolean>;
  resume(req: { readonly agent: string; readonly cwd: string; readonly session: string; readonly profile?: string; readonly model?: string; readonly effort?: string; readonly mode?: string }): Promise<{ readonly id: string }>;
};

export type KitTool = { readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown> };
export type KitAnswer = { readonly text: string; readonly isError?: true };

const ROOM_ARG = { type: "string", description: "The room, by its name or id. Needed only when you sit in more than one room." };

/** The Kit, small (2026-11-24, user: 不让模型上下文瞬间填满又能检索到需要的数据): five tools, and one more for an
 *  admin. What they answer is bounded — an index first, a whole message when it is asked for by its number — so a
 *  session that reads the room does not fill its context with it. The tools of before are still answered by their
 *  old names (an agent lists its tools once and keeps calling them), see ALIASES. */
const TOOLS: readonly KitTool[] = [
  {
    name: "room_post",
    description: `Say something in an AgentSwitch Chat Room you sit in; the user reads it too. @name (or \`to\`) sends it to those members and wakes them; without an @ it wakes nobody. Returns at once; a reply comes later as a room message. At most ${MAX_SESSION_TEXT} characters: the conclusion, what you need, paths — anything longer goes into a file in the shared folder (room_info files) and the message names it. No credentials or private matters of the user's.`,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The message. @name addresses a member; @you is the user." },
        to: { type: "array", items: { type: "string" }, description: "Members to address, besides any @name in the text." },
        files: { type: "array", items: { type: "string" }, description: "Absolute paths of files to point at (not copied)." },
        reply_to: { type: "integer", description: "The #n this answers; its author gets it if you name nobody." },
        expects: { type: "string", enum: ["none", "answer"], description: "When you address someone: none — a report, no reply wanted; answer — a question or request." },
        task: { type: "integer", description: "The task this is about (3 for T3). A reply keeps the task of what it answers." },
        room: ROOM_ARG,
      },
      required: ["text"],
    },
  },
  {
    name: "room_read",
    description: "Read a Chat Room you sit in. No arguments: what you have not read yet, each message once — short ones whole, the rest as one line each. `seq`: one message whole (`part` for the next part of a long one). `search` (words), `task`, `from`, `before`: an index, one line a message, newest last — then ask for the ones you need by `seq`. Messages not addressed to you reach you only this way.",
    inputSchema: {
      type: "object",
      properties: {
        seq: { type: "integer", description: "One message, whole." },
        part: { type: "integer", description: "With seq: the part of a long message (1, 2, …)." },
        search: { type: "string", description: "Messages whose words contain this." },
        task: { type: "integer", description: "Messages about this task (3 for T3)." },
        from: { type: "string", description: "One member's messages." },
        before: { type: "integer", description: "The page of messages before this number." },
        room: ROOM_ARG,
      },
    },
  },
  {
    name: "room_tasks",
    description: "The room's task list: who does what, seen by all. No action: the list. `show` n: one task with its latest messages and who changes which files — enough to take it over. `add` (title; detail; after: tasks first; owner). `take` before you start; `block` with `note` when you can not go on (the asker and the user are told); `done` with `note` (the result in a line: names, file:line, the check run, or the file that holds it); `release`; `edit`; `remove`. Whoever a task is given to or freed for is told by itself: do not post it again.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "show", "add", "take", "block", "done", "release", "edit", "remove"] },
        n: { type: "integer", description: "The task's number (3 for T3)." },
        title: { type: "string" },
        detail: { type: "string" },
        after: { type: "array", items: { type: "integer" }, description: "For add: tasks that must be done first." },
        owner: { type: "string", description: "@name." },
        note: { type: "string", description: "For block, done, edit." },
        room: ROOM_ARG,
      },
    },
  },
  {
    name: "room_info",
    description: "About a room you sit in. `members` (default): who is here, their agent, model, folder and state. `notes`: the pinned notes all members keep. `files`: the shared folder's path and its files, newest first — hand anything long over as a file there. `changing`: which files members said they are changing now. `rooms`: yours. `avatars`: the avatar library.",
    inputSchema: { type: "object", properties: { show: { type: "string", enum: ["members", "notes", "files", "changing", "rooms", "avatars"] }, room: ROOM_ARG } },
  },
  {
    name: "room_update",
    description: "Change something of yours in a room. `notes` with text: replaces the whole pinned notes (read them first, write back what stays). `changing` with paths: the files you are about to change (absolute; [] when done; lapses after `minutes`) — you are told if another member said the same files. `handoff` with text: your handover note — what you did, how far, what next, where the files are. `rename` with name: your @name here (an admin may give `handle`). `session_rename` with name: your session's own name in AgentSwitch. `avatar`: yours in all rooms — `pixel` id (or `rows`+`color`), `classic` id (or `emoji`, `bg`); see room_info avatars.",
    inputSchema: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["notes", "changing", "handoff", "rename", "session_rename", "avatar"] },
        pixel: { type: "string" }, rows: { type: "array", items: { type: "string" } }, color: { type: "integer" },
        classic: { type: "string" }, emoji: { type: "string" }, bg: { type: "integer" },
        text: { type: "string" },
        name: { type: "string" },
        handle: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        minutes: { type: "integer" },
        why: { type: "string" },
        room: ROOM_ARG,
      },
      required: ["what"],
    },
  },
];

/** For an admin: a session whose `Admin` switch (the `canAdd` of its seat) is on. */
const ORG_TOOLS: readonly KitTool[] = [
  {
    name: "room_admin",
    description: "For a room's admin. `sessions` (search, limit): running sessions and ones that can be resumed. `profiles`, `models` (agent), `check` (agent, profile). `add`: bring a session in — `terminal` (running), or `agent` + `cwd` (new; profile, model, mode — default bypass), or `agent` + `resume` + `cwd`. It joins knowing nothing: then room_post it what you need. Before adding, ask whether you can say what each part hands over and neither waits for the other; if not, the work is not ready to split. You may start at most " + MAX_STARTED + " sessions. `resume`, `mute`, `unmute`, `kick`, `end` (closes a session a session started; its conversation kept), `delete` (and its record) — with `handle` (`resume` all: every ended one). `create`: a new room (name, topic; `terminals` to bring in). `dissolve` (room): gone, sessions started for it ended. `rooms`: every room.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["sessions", "profiles", "models", "check", "add", "resume", "mute", "unmute", "kick", "end", "delete", "create", "dissolve", "rooms"] },
        handle: { type: "string" }, terminal: { type: "string" }, terminals: { type: "array", items: { type: "string" } }, agent: { type: "string", enum: ["claude-code", "codex", "opencode", "pi", "grok"] },
        cwd: { type: "string" }, profile: { type: "string" }, model: { type: "string" }, mode: { type: "string", enum: ["manual", "auto", "bypass"] },
        resume: { type: "string" }, name: { type: "string" }, topic: { type: "string" }, search: { type: "string" }, limit: { type: "integer" },
        room: ROOM_ARG,
      },
      required: ["action"],
    },
  },
];

/** The tools of before, answered still: an agent that listed them keeps calling them by these names. */
const ALIASES: Readonly<Record<string, (args: Record<string, unknown>) => [string, Record<string, unknown>]>> = {
  room_members: (a) => ["room_info", { ...a, show: "members" }],
  room_files: (a) => ["room_info", { ...a, show: "files" }],
  room_notes: (a) => (typeof a.text === "string" ? ["room_update", { ...a, what: "notes" }] : ["room_info", { ...a, show: "notes" }]),
  room_changing: (a) => (Array.isArray(a.paths) ? ["room_update", { ...a, what: "changing" }] : ["room_info", { ...a, show: "changing" }]),
  room_handoff: (a) => ["room_update", { ...a, what: "handoff" }],
  room_rename: (a) => ["room_update", { ...a, what: "rename" }],
  session_rename: (a) => ["room_update", { ...a, what: "session_rename" }],
  rooms: (a) => ["room_admin", { ...a, action: "rooms" }],
  room_create: (a) => ["room_admin", { ...a, action: "create" }],
  room_add: (a) => ["room_admin", { ...a, action: "add" }],
  room_manage: (a) => ["room_admin", { ...a }],
  profiles: (a) => ["room_admin", { ...a, action: "profiles" }],
  models: (a) => ["room_admin", { ...a, action: "models" }],
  sessions: (a) => ["room_admin", { ...a, action: "sessions" }],
  profile_check: (a) => ["room_admin", { ...a, action: "check" }],
};
/** What a message says to a reader: a deleted one says so (user #278). */
const said = (m: Message): string => (m.deleted ? "(deleted by the user)" : m.text);


/** How much one answer of room_read may be: what is past it is given as one line a message. */
const READ_BUDGET = 4000;
/** A message given whole in the unread is at most this long; past it, a line and its number. */
const WHOLE_UP_TO = 1200;
/** One part of a long message asked for by its number. */
const PART = 3000;
/** Lines in an index. */
const INDEX_LINES = 30;

const NO_ROOM = "This session sits in no Chat Room now. The user (or an admin of a room) seats a session in a room.";
const NOT_ALLOWED = "This session is not an admin of the room: the user has not turned on Admin for it (the switch is on its card in the room).";
const ago = (at: number, now: number): string => { const m = Math.round((now - at) / 60_000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

const hm = (at: number): string => { const t = new Date(at); return `${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`; };
/** Of its own message, a session is told who has read it and who has not yet. */
const readBy = (m: Message, me: string, reads: Readonly<Record<string, readonly string[]>>, lead: string): string => {
  if (m.from !== me || !m.to.length) return "";
  const sessions = m.to.filter((h) => h !== YOU), read = sessions.filter((h) => reads[String(m.seq)]?.includes(h)), not = sessions.filter((h) => !read.includes(h));
  return sessions.length ? `${lead}[${read.length ? `read by ${read.map((h) => `@${h}`).join(" ")}` : "read by nobody yet"}${not.length && read.length ? `; not yet: ${not.map((h) => `@${h}`).join(" ")}` : ""}]` : "";
};
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** What it takes to bring the conversation behind an ended seat back (§6.2): the session the seat kept while its
 *  terminal lived. Throws a RoomError when it kept none. */
export function resumeOf(seat: Seat): { agent: string; cwd: string; session: string; profile?: string; model?: string; effort?: string; mode?: string } {
  const s = seat.session;
  if (!s || !seat.was) throw new RoomError(409, `@${seat.handle} took its seat before session ids were kept, so its conversation can not be found again from here. Remove it from the room and add the session again (room_add with agent, resume, cwd — see \`sessions\`).`);
  return { agent: seat.was.agent, cwd: s.cwd, session: s.id, ...(s.profile ? { profile: s.profile } : {}), ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}), ...(s.mode ? { mode: s.mode } : {}) };
}

/** A room dissolved (解散, 2026-11-24, user #230): gone with its messages and shared folder; the sessions started for
 *  it that sit in no other room are ended (their conversations kept, to be resumed); sessions that were running before
 *  they were brought in go on. The ended terminals. */
export async function dissolveRoom(store: RoomStore, stop: (terminal: string) => Promise<boolean>, id: string): Promise<string[]> {
  const started = store.startedFor(id);
  store.remove(id);
  const ended: string[] = [];
  for (const t of started) if (await stop(t).catch(() => false)) ended.push(t);
  return ended;
}

const RESUMING = new Set<string>();

/** The conversation behind an ended seat goes on in a new terminal, and the seat sits there (§6.2). One at a time per
 *  seat. Should the seat be gone when the terminal is up — kicked meanwhile — that terminal is ended again: nothing is
 *  left running that sits nowhere. `wasOf`: what the new terminal says of itself, when it is known. */
export async function resumeSeat(store: RoomStore, org: Pick<KitOrg, "resume" | "stop">, roomId: string, seat: Seat, wasOf: (terminal: string) => SeatWas | null): Promise<{ readonly seat: Seat; readonly terminal: string }> {
  const key = `${roomId}:${seat.handle}`;
  if (RESUMING.has(key)) throw new RoomError(409, `@${seat.handle} is being resumed already.`);
  RESUMING.add(key);
  try {
    const started = await org.resume(resumeOf(seat));
    try {
      const was = wasOf(started.id) ?? seat.was!;
      return { seat: store.rebind(roomId, seat.handle, started.id, was), terminal: started.id };
    } catch (err) {
      await org.stop(started.id);
      if (err instanceof RoomError) throw new RoomError(409, `@${seat.handle} could not take its seat again (${err.message}); the terminal started for it was ended.`);
      throw err;
    }
  } finally { RESUMING.delete(key); }
}

/** Every seat of a room whose session has ended is brought back (§6.2, "批量 resume"), one after another; each says
 *  how it went. `except`: a seat that is not tried (the one that asks). */
export async function resumeEnded(store: RoomStore, org: Pick<KitOrg, "resume" | "stop">, roomId: string, stateOf: (terminal: string) => string | null, wasOf: (terminal: string) => SeatWas | null, except?: string): Promise<{ readonly handle: string; readonly error?: string }[]> {
  const done: { handle: string; error?: string }[] = [];
  for (const seat of store.get(roomId).seats) {
    if (seat.kind !== "session" || seat.left !== undefined || seat.handle === except || !seat.terminal) continue;
    const state = stateOf(seat.terminal);
    if (state !== null && state !== "exited") continue;
    try { await resumeSeat(store, org, roomId, seat, wasOf); done.push({ handle: seat.handle }); }
    catch (err) { if (err instanceof RoomError) done.push({ handle: seat.handle, error: err.message }); else throw err; }
  }
  return done;
}

/** How long a member asked to hand over before it is ended is waited for, and how often its note is looked at.
 *  Tests make these short. */
export const HANDOFF = { waitMs: 120_000, pollMs: 2_000 };
const ENDING = new Set<string>();

/** Whether a member should hand over before it is ended (2026-11-24, user: 结束前先让它写交接): its session is still
 *  there to write, and it holds unfinished work of the list. */
export function owesHandoff(room: Room, seat: Seat, live: boolean): boolean {
  return live && room.tasks.some((t) => t.owner === seat.handle && (t.state === "doing" || t.state === "blocked"));
}

/** A member out of the room and its session ended (`transcript`: and its record deleted). One that owes a handover is
 *  first asked for it, in the room, and ended once its note is written or `HANDOFF.waitMs` has gone by — in the
 *  background: the caller is told "handing over" at once. */
export async function closeSeat(o: { readonly store: RoomStore; readonly stop: (terminal: string, transcript: boolean) => Promise<boolean>; readonly changed?: (roomId: string) => void; readonly look?: () => void; readonly now?: () => number },
  roomId: string, handle: string, by: string, transcript: boolean, handoff: boolean): Promise<"closed" | "gone" | "handing over"> {
  const room = o.store.get(roomId);
  const seat = room.seats.find((x) => x.handle === handle);
  if (!seat) throw new RoomError(404, `There is no @${handle} in this room.`);
  const finish = async (): Promise<boolean> => {
    if (o.store.get(roomId).seats.find((x) => x.handle === handle)?.left === undefined) o.store.unseat(roomId, handle, by);
    const ended = seat.terminal ? await o.stop(seat.terminal, transcript) : false;
    o.changed?.(roomId);
    o.look?.();
    return ended;
  };
  if (!handoff) return (await finish()) ? "closed" : "gone";
  const key = `${roomId}:${handle}`;
  if (ENDING.has(key)) return "handing over";
  ENDING.add(key);
  const now = o.now ?? Date.now;
  const asked = now();
  const owns = room.tasks.filter((t) => t.owner === handle && (t.state === "doing" || t.state === "blocked")).map((t) => `T${t.n}`);
  try {
    o.store.post(roomId, { from: by, text: `〔交接〕@${handle} 你马上要被结束。先用 room_update { what: "handoff" } 写交接：做了什么、做到哪、下一步、文件在哪（你手上有 ${owns.join("、")}）。写完就会被结束，最多等 ${Math.round(HANDOFF.waitMs / 60_000) || 1} 分钟。`, to: [handle], expects: "none" });
  } catch { /* the asker may not post (muted): ended after the wait all the same */ }
  o.changed?.(roomId);
  o.look?.();
  void (async () => {
    try {
      for (let waited = 0; waited < HANDOFF.waitMs; waited += HANDOFF.pollMs) {
        const file = o.store.handoffPath(roomId, handle);
        if (file && statSync(file).mtimeMs >= asked) break;
        await new Promise((r) => setTimeout(r, HANDOFF.pollMs));
      }
      await finish();
    } catch { /* the room went meanwhile */ } finally { ENDING.delete(key); }
  })();
  return "handing over";
}

export class RoomKit {
  constructor(private readonly o: { readonly store: RoomStore; readonly seat: SeatLookup; readonly delivery: RoomDelivery; readonly changed?: (roomId: string) => void; readonly org?: () => KitOrg | null; readonly now?: () => number; /** Tests: how long a started session is waited for. */ readonly kitWaitMs?: number;
    /** How many sessions a session may start (MAX_STARTED; the dispatch its own, 2026-11-24). */ readonly startLimit?: (terminal: string) => number; }) {}

  private readonly seen = new Set<string>();

  /** A terminal's tool server asked: its session has the Kit. */
  met(terminal: string): void { this.seen.add(terminal); }

  /** Whether a terminal's session has the Kit (one started before there was a Kit has none until it is resumed). */
  has(terminal: string): boolean { return this.seen.has(terminal); }

  /** The tools a terminal's session has now: none outside every room. */
  tools(terminal: string, always = false): readonly KitTool[] {
    // `always`: for an agent that lists its tools once, when it starts, and never again (Codex): it is seated long
    // after, and would sit in the room with no way to speak. Outside every room a call is answered with why not.
    const sits = this.o.store.roomsOf(terminal);
    if (!sits.length) return always ? TOOLS : [];
    const own = TOOLS;
    return this.o.store.mayAdd(terminal) && this.o.org?.() ? [...own, ...ORG_TOOLS] : own;
  }

  /** What changes when the tools a terminal has change: a session's agent is told to list them again. */
  version(terminal: string, always = false): string {
    // The names, and how much is said of them: a tool whose description or arguments changed with a new version of
    // the service is listed again too (2026-11-23: `room_manage` had two new actions and a session's agent still
    // showed the old ones, the names being the same).
    const tools = this.tools(terminal, always);
    return tools.length ? `${tools.map((t) => t.name).join(",")}#${JSON.stringify(tools).length}` : "";
  }

  /** One call of a tool by a terminal's session. The switch is looked at now, each time: turned off, the next call
   *  is refused whatever the agent still lists. */
  async call(terminal: string, asked: string, given: Record<string, unknown>): Promise<KitAnswer> {
    const [name, args] = ALIASES[asked]?.(given) ?? [asked, given];
    try {
      if (name === "room_admin") {
        const org = this.o.org?.();
        if (!this.o.store.roomsOf(terminal).length) throw new RoomError(403, NO_ROOM);
        if (!this.o.store.mayAdd(terminal) || !org) throw new RoomError(403, NOT_ALLOWED);
        return { text: await this.organize(org, terminal, str(args.action) ?? "", args) };
      }
      if (!TOOLS.some((t) => t.name === name)) return { text: `There is no tool ${asked} in the Chatroom Kit.`, isError: true };
      const { room, seat } = this.where(terminal, str(args.room));
      this.o.store.count(room.id, seat.handle, { calls: 1 }, int(args.task) ?? (name === "room_tasks" ? int(args.n) : undefined));
      switch (name) {
        case "room_post": return { text: this.post(room, seat, args) };
        case "room_read": return { text: this.read(room, seat, args) };
        case "room_tasks": return { text: this.tasks(room, seat, args) };
        case "room_info": {
          switch (str(args.show) ?? "members") {
            case "notes": return { text: this.notes(room, seat, {}) };
            case "files": return { text: this.files(room) };
            case "changing": return { text: this.changing(room, seat, {}) };
            case "rooms": {
              const sits = this.o.store.roomsOf(terminal);
              return { text: sits.map((x) => `"${x.room.name}" (${x.room.id}) — you are @${x.seat.handle}${x.seat.canAdd ? ", admin" : ""}${x.room.topic ? ` · ${x.room.topic}` : ""}`).join("\n") };
            }
            case "avatars": {
              const mine = this.o.store.avatarOf(seat);
              return { text: `${LIBRARY_SAYS}\nYours: pixel ${mine?.pixel ? (mine.pixel.kind === "grid" ? mine.pixel.id : mine.pixel.id ?? "drawn") : "your seat's face (unchosen)"}, classic ${mine?.classic?.emoji ?? "your initials (unchosen)"}. Set with room_update { what: "avatar", pixel: "p7", classic: "e3" }.` };
            }
            default: return { text: this.members(room, seat) };
          }
        }
        default: return { text: await this.update(terminal, room, seat, args) };
      }
    } catch (err) {
      if (err instanceof RoomError) return { text: err.message, isError: true };
      throw err;
    }
  }

  private async update(terminal: string, room: Room, seat: Seat, args: Record<string, unknown>): Promise<string> {
    switch (str(args.what)) {
      case "notes":
        if (typeof args.text !== "string") throw new RoomError(400, "room_update notes needs `text`, the whole new notes.");
        return this.notes(room, seat, args);
      case "changing": return this.changing(room, seat, { ...args, paths: Array.isArray(args.paths) ? args.paths : [] });
      case "handoff": {
        const file = this.o.store.handoff(room.id, seat.handle, typeof args.text === "string" ? args.text : "");
        this.o.changed?.(room.id);
        return `Your handover note is kept at ${file}. Whoever takes your work over reads it there; tell them it exists (room_post, expects none) if someone is waiting for it.`;
      }
      case "rename": {
        const other = str(args.handle)?.replace(/^@/, "").toLowerCase();
        const target = other && other !== seat.handle ? room.seats.find((x) => x.handle === handleIn(room, other)) : seat;
        if (!target) throw new RoomError(404, `There is no @${other} in this room.`);
        const was = target.handle;
        const now = this.o.store.rename(room.id, seat.handle, target.handle, typeof args.name === "string" ? args.name : "");
        this.o.changed?.(room.id);
        const who = target === seat ? "You are" : `@${was} is`;
        return now.handle === was ? `${who} @${was} already.` : `${who} @${now.handle} in "${room.name}" now (was @${was}; that name still reaches ${target === seat ? "you" : "it"}). A room's nickname only: ${target === seat ? "your session's own name in AgentSwitch is unchanged (room_update session_rename changes that)" : "its session's own name is unchanged"}.`;
      }
      case "session_rename": {
        const wanted = (typeof args.name === "string" ? args.name : "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (!wanted) throw new RoomError(400, "session_rename needs a name.");
        const org = this.o.org?.();
        if (!org) throw new RoomError(409, "Sessions can not be renamed from here on this service.");
        await org.rename(terminal, wanted);
        return `This session is called "${wanted}" in AgentSwitch now. Your @name in the room is still @${seat.handle} (room_update rename changes that).`;
      }
      case "avatar": {
        const change: { pixel?: PixelAvatar; classic?: ClassicAvatar } = {};
        if (args.pixel !== undefined || args.rows !== undefined) {
          const p = pixelFrom({ ...(typeof args.pixel === "string" ? { id: args.pixel } : {}), rows: args.rows, color: args.color });
          if (typeof p === "string") throw new RoomError(400, p);
          change.pixel = p;
        }
        if (args.classic !== undefined || args.emoji !== undefined) {
          const c = classicFrom({ ...(typeof args.classic === "string" ? { id: args.classic } : {}), ...(typeof args.emoji === "string" ? { emoji: args.emoji } : {}), bg: args.bg }, defaultBg(seat.handle));
          if (typeof c === "string") throw new RoomError(400, c);
          change.classic = c;
        }
        if (!change.pixel && !change.classic) throw new RoomError(400, `room_update avatar needs \`pixel\` (or \`rows\`) and/or \`classic\` (or \`emoji\`). ${LIBRARY_SAYS}`);
        this.o.store.setAvatar(terminal, change);
        for (const r of this.o.store.roomsOf(terminal)) this.o.changed?.(r.room.id);
        return `Your avatar is changed in every room you sit in${change.pixel ? ` (pixel look: ${change.pixel.kind === "grid" ? change.pixel.id : change.pixel.id ?? "your drawn face"})` : ""}${change.classic ? ` (classic look: ${change.classic.emoji})` : ""}.`;
      }
      default: throw new RoomError(400, "room_update: `what` is notes, changing, handoff, rename, session_rename or avatar.");
    }
  }

  private async organize(org: KitOrg, terminal: string, action: string, args: Record<string, unknown>): Promise<string> {
    const now = (this.o.now ?? Date.now)();
    switch (action) {
      case "rooms": {
        const mine = new Set(this.o.store.roomsOf(terminal).map((s) => s.room.id));
        const all = this.o.store.list();
        return [`${all.length} room${all.length === 1 ? "" : "s"}:`, ...all.map((r) => `"${r.name}" (${r.id})${mine.has(r.id) ? " — you sit here" : ""} · ${r.seats.filter((s) => s.left === undefined).length} members${r.paused ? " · paused" : ""}${r.topic ? `\n  ${r.topic}` : ""}`)].join("\n");
      }
      case "create": {
        const me = this.o.store.roomsOf(terminal).find((s) => s.seat.canAdd)!;
        const live = this.o.seat(terminal);
        const { mode: _mode, node: _node, ...was } = live?.card ?? { ...me.seat.was!, mode: null, node: null };
        const topic = str(args.topic);
        const room = this.o.store.create({ name: typeof args.name === "string" ? args.name : "", ...(topic ? { topic } : {}), by: me.seat.handle,
          // The dispatch's own rooms are listed with its desk (user #500).
          byDesk: this.o.store.roomsOf(terminal).some((s) => s.room.desk === true) });
        const seat = this.o.store.seat(room.id, { terminal, was, canAdd: true, by: me.seat.handle });
        this.o.changed?.(room.id);
        const made = `Room "${room.name}" (${room.id}) made; you sit in it as @${seat.handle}. The user is a member (@you).`;
        // Made with its members at once (拉群, user #230): each running session named is brought in.
        const bring = Array.isArray(args.terminals) ? [...new Set(args.terminals.filter((t): t is string => typeof t === "string" && t !== terminal))] : [];
        if (!bring.length) return `${made} Bring sessions in with room_admin { action: "add", room: "${room.id}"). You sit in more than one room now: name the room in each call.`;
        const said: string[] = [];
        for (const t of bring) {
          try { said.push(await this.add(org, terminal, { room: room.id, terminal: t })); } catch (err) { said.push(`${t}: not brought in — ${err instanceof Error ? err.message : String(err)}`); }
        }
        return [made, ...said, `You sit in more than one room now: name the room ("${room.id}") in each call.`].join("\n");
      }
      case "dissolve": {
        const { room, seat: me } = this.where(terminal, str(args.room));
        if (!me.canAdd) throw new RoomError(403, NOT_ALLOWED);
        if (room.desk) throw new RoomError(409, "调度台 is not dissolved.");
        const ended = await dissolveRoom(this.o.store, (t) => org.stop(t), room.id);
        this.o.changed?.(room.id);
        return `"${room.name}" is dissolved: its messages and shared folder are gone${ended.length ? `; the ${ended.length} session${ended.length === 1 ? "" : "s"} started for it ended (conversations kept)` : ""}. Sessions that were running before they joined go on.`;
      }
      case "add": return this.add(org, terminal, args);
      case "resume": case "mute": case "unmute": case "kick": case "end": case "delete": return this.manage(org, terminal, args);
      case "profiles": {
        const all = await org.profiles();
        return [`${all.length} profiles:`, ...all.map((p) => `${p.agent} · ${p.id} · "${p.name}" · ${p.kind === "api" ? "API key" : "subscription"} · ${p.health ? `${p.health.status}, checked ${ago(p.health.checkedAt, now)}${p.health.message ? ` (${p.health.message})` : ""}` : "not checked yet"}`)].join("\n");
      }
      case "models": {
        const all = await org.models();
        const only = str(args.agent);
        return Object.entries(all).filter(([a]) => !only || a === only).map(([a, list]) => `${a}:\n${list.map((m) => `  ${m.id} — ${m.name}${m.description ? ` · ${m.description}` : ""}`).join("\n") || "  (none listed; its own default is used)"}`).join("\n") || "No such agent.";
      }
      case "sessions": {
        const limit = Math.min(Math.max(int(args.limit) ?? 20, 1), 50), search = str(args.search)?.toLowerCase();
        const all = await org.sessions(search ? 500 : limit * 3);
        const seated = new Set(this.o.store.list().flatMap((r) => r.seats.filter((s) => s.left === undefined && s.terminal).map((s) => s.terminal!)));
        const hit = (...texts: string[]): boolean => !search || texts.some((t) => t.toLowerCase().includes(search));
        const running = all.running.filter((s) => hit(s.name, s.cwd));
        const open = new Set(all.running.map((s) => s.terminal));
        const resumable = all.resumable.filter((s) => hit(s.title, s.cwd)).slice(0, limit);
        return [
          `Running (${running.length}) — add with room_admin { action: "add", terminal }:`,
          ...running.map((s) => `  ${s.terminal} · ${s.agent} · "${s.name}" · ${s.cwd} · ${s.state}${s.profile ? ` · profile ${s.profile}` : ""}${s.terminal === terminal ? " · (you)" : seated.has(s.terminal) ? " · in a room" : ""}`),
          `Can be resumed (${resumable.length} shown) — add with room_admin { action: "add", agent, resume, cwd }:`,
          ...resumable.filter((s) => !open.has(s.id)).map((s) => `  ${s.agent} · ${s.id} · "${s.title}" · ${s.cwd} · ${ago(s.updatedAt, now)}${s.profile ? ` · profile ${s.profile}` : ""}`),
        ].join("\n");
      }
      case "check": {
        const agent = str(args.agent), profile = str(args.profile);
        if (!agent || !profile) throw new RoomError(400, "room_admin check needs `agent` and `profile` (an id from `profiles`).");
        const result = await org.check(agent, profile);
        return `${agent} · ${profile}: ${result.status}${result.message ? ` — ${result.message}` : ""} (checked just now)`;
      }
      default: throw new RoomError(400, "room_admin: `action` is sessions, profiles, models, check, add, resume, mute, unmute, kick, end, delete, create, dissolve or rooms.");
    }
  }

  private async add(org: KitOrg, terminal: string, args: Record<string, unknown>): Promise<string> {
    const { room, seat: me } = this.where(terminal, str(args.room));
    const running = str(args.terminal), agent = str(args.agent), cwd = str(args.cwd), resume = str(args.resume);
    const sit = (target: string, started: boolean): string => {
      const live = this.o.seat(target);
      if (!live) throw new RoomError(404, `There is no running session with terminal id ${target}. See \`sessions\`.`);
      if (live.state === "exited") throw new RoomError(409, "That session has ended; resume it instead (room_admin add with `agent`, `resume`, `cwd`).");
      const { mode: _mode, node: _node, ...was } = live.card;
      const seat = this.o.store.seat(room.id, { terminal: target, was, by: me.handle, ...(started ? { byAgent: true, starter: terminal } : {}) });
      this.o.changed?.(room.id);
      return `@${seat.handle} now sits in "${room.name}" (${[agentName(was.agent), was.model, was.cwd].filter(Boolean).join(" · ")}; ${STATE_MEETS[live.state]}). It knows nothing of your task yet: room_post an @${seat.handle} message that says what you need.`;
    };
    if (running) {
      if (running === terminal) throw new RoomError(400, "That is you; you already sit here.");
      return sit(running, false);
    }
    if (!agent || !cwd) throw new RoomError(400, "room_admin add needs `terminal` (a running session), or `agent` and `cwd` (a new session; with `resume` an existing one).");
    const limit = this.o.startLimit?.(terminal) ?? MAX_STARTED;
    if (this.o.store.startedBy(terminal) >= limit) throw new RoomError(409, `You have started ${limit} sessions that still sit in rooms; that is the most you may. Work with them, end the ones done, or ask the user.`);
    // A session started for a room runs in bypass unless the caller says otherwise (2026-11-24, user).
    const mode = str(args.mode) || "bypass";
    const profile = str(args.profile), model = str(args.model);
    const started = await org.start({ agent, cwd, ...(profile ? { profile } : {}), ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(resume ? { resume } : {}) });
    const said = sit(started, true);
    // A session that has started is in the room once its Kit has asked for its tools. One that does not within a
    // little while is most often stopped at a question of its agent's own that only the user can answer (Claude
    // Code's "do you trust this folder", in a folder it was never in): said as it is, not "idle, gets the message
    // now" (2026-11-23: three helpers sat there for minutes, their task undelivered, and nobody was told).
    for (let waited = 0; !this.seen.has(started) && waited < (this.o.kitWaitMs ?? 10_000); waited += 250) await new Promise((r) => setTimeout(r, 250));
    if (this.seen.has(started)) return said;
    return `${said}\n\nBut it has not connected to the room yet, so no message reaches it: it is probably stopped at a question of its own at start (in a folder it has not worked in, Claude Code asks whether the folder is trusted) that only the user can answer. Tell the user (@you) to look at its terminal; what you post to it is given once it connects. A folder under one already trusted needs no such answer.`;
  }

  /** An admin's work on one member (§6.2): resume an ended session, mute or unmute it, or kick it out. */
  private async manage(org: KitOrg, terminal: string, args: Record<string, unknown>): Promise<string> {
    const { room, seat: me } = this.where(terminal, str(args.room));
    if (!me.canAdd) throw new RoomError(403, NOT_ALLOWED);
    if (me.muted) throw new RoomError(403, `@${me.handle} is muted by @${me.muted.by}: it can not manage the room until it is unmuted.`);
    const action = str(args.action), name = str(args.handle)?.replace(/^@/, "").toLowerCase();
    if (!action || !name) throw new RoomError(400, "room_admin needs `action` and `handle`.");
    if (action === "resume" && name === "all") {
      const done = await resumeEnded(this.o.store, org, room.id, (t) => this.o.seat(t)?.state ?? null, (id) => {
        const card = this.o.seat(id)?.card;
        return card ? { agent: card.agent, name: card.name, cwd: card.cwd, model: card.model, profile: card.profile, ...(card.color ? { color: card.color } : {}) } : null;
      }, me.handle);
      this.o.changed?.(room.id);
      this.o.delivery.look();
      if (!done.length) return `Nobody in "${room.name}" has ended: there is nothing to resume.`;
      return done.map((d) => (d.error ? `@${d.handle}: not resumed — ${d.error}` : `@${d.handle}: back`)).join("\n");
    }
    const target = room.seats.find((s) => s.handle === handleIn(room, name));
    if (!target) throw new RoomError(404, `There is no @${name} in this room.`);
    if (target.kind === "user") throw new RoomError(403, "You can not manage the user.");
    if (target.handle === me.handle) throw new RoomError(403, "You can not manage yourself; ask the user or another admin.");
    switch (action) {
      case "mute":
      case "unmute": {
        const seat = this.o.store.setMuted(room.id, me.handle, target.handle, action === "mute");
        this.o.changed?.(room.id);
        return action === "mute"
          ? `@${target.handle} is muted by you (@${me.handle}). It still reads, is woken and works, but can not post or write the notes until you or the user unmute it.`
          : `@${target.handle} can speak again${seat.muted ? " (it is still muted by someone else)" : ""}.`;
      }
      case "end":
      case "delete": {
        // Only what a session brought up: the user's own sessions are the user's to close.
        if (!target.byAgent) throw new RoomError(403, `@${target.handle} was started by the user, not by a session: only the user closes it. You can kick it out of the room.`);
        if (!target.terminal) throw new RoomError(409, `@${target.handle} has no terminal.`);
        const live = this.o.seat(target.terminal);
        const how = await closeSeat({ store: this.o.store, stop: (t, transcript) => org.stop(t, transcript), changed: (r) => this.o.changed?.(r), look: () => this.o.delivery.look(), ...(this.o.now ? { now: this.o.now } : {}) },
          room.id, target.handle, me.handle, action === "delete", target.left === undefined && owesHandoff(room, target, !!live && live.state !== "exited"));
        if (how === "handing over") return `@${target.handle} holds unfinished tasks: it was asked to write its handover note first, and is ${action === "delete" ? "deleted" : "ended"} once it has (at most ${Math.round(HANDOFF.waitMs / 60_000) || 1} min). Nothing more to do.`;
        const ended = how === "closed";
        return ended
          ? `@${target.handle} is ${action === "delete" ? "deleted" : "ended"}: out of "${room.name}", its terminal closed${action === "delete" ? " and its conversation's record deleted" : "; its conversation is kept and can be resumed"}.`
          : `@${target.handle} is out of "${room.name}"; its terminal was not there to close any more (already closed, or the service started again since).`;
      }
      case "kick": {
        this.o.store.unseat(room.id, target.handle, me.handle);
        this.o.changed?.(room.id);
        this.o.delivery.look();
        return `@${target.handle} is out of "${room.name}". Its session keeps running outside the room; the user or an admin can bring it back with room_admin add.`;
      }
      case "resume": {
        if (target.left !== undefined) throw new RoomError(403, `@${target.handle} has left the room.`);
        const live = target.terminal ? this.o.seat(target.terminal) : null;
        if (live && live.state !== "exited") throw new RoomError(409, `@${target.handle} has not ended (${live.state}).`);
        const { seat: back } = await resumeSeat(this.o.store, org, room.id, target, (id) => {
          const card = this.o.seat(id)?.card;
          return card ? { agent: card.agent, name: card.name, cwd: card.cwd, model: card.model, profile: card.profile, ...(card.color ? { color: card.color } : {}) } : null;
        });
        const was = back.was!;
        this.o.changed?.(room.id);
        this.o.delivery.look();
        return `@${back.handle} is back in "${room.name}" with the same conversation (${[agentName(was.agent), was.model, was.cwd].filter(Boolean).join(" · ")}). It knows nothing new of your task: room_post an @${back.handle} message if it should go on.`;
      }
      default: throw new RoomError(400, "room_admin: action is resume, mute, unmute, kick, end or delete.");
    }
  }

  private where(terminal: string, named: string | undefined): { room: Room; seat: Seat } {
    const sits = this.o.store.roomsOf(terminal);
    if (!sits.length) throw new RoomError(403, NO_ROOM);
    if (named) {
      const wanted = named.toLowerCase();
      const found = sits.filter((s) => s.room.id === wanted || s.room.name.toLowerCase() === wanted);
      if (found.length === 1) return found[0]!;
      throw new RoomError(404, `You sit in no room called "${named}". Yours: ${sits.map((s) => `"${s.room.name}" (${s.room.id})`).join(", ")}.`);
    }
    if (sits.length > 1) throw new RoomError(400, `You sit in ${sits.length} rooms; say which with \`room\`: ${sits.map((s) => `"${s.room.name}" (${s.room.id})`).join(", ")}.`);
    return sits[0]!;
  }

  private tasks(room: Room, seat: Seat, args: Record<string, unknown>): string {
    const action = str(args.action) ?? "list", n = int(args.n);
    const store = this.o.store;
    const need = (): number => { if (n === undefined) throw new RoomError(400, `room_tasks ${action} needs \`n\`, the task's number.`); return n; };
    const line = (t: Task, all: readonly Task[]): string => {
      const waits = (t.after ?? []).filter((a) => all.some((o) => o.n === a && o.state !== "done"));
      return `T${t.n} [${t.state === "todo" ? "to do" : t.state === "blocked" ? "BLOCKED" : t.state}${t.owner ? ` · @${t.owner}${t.owner === seat.handle ? " (you)" : ""}` : ""}] ${t.title}${waits.length ? ` — waits for ${waits.map((a) => `T${a}`).join(", ")}` : ""}${t.detail ? `\n    ${t.detail.replace(/\n/g, "\n    ")}` : ""}${t.note ? `\n    → ${t.note.replace(/\n/g, "\n    ")}` : ""}`;
    };
    const told = (text: string): string => { this.o.changed?.(room.id); return text; };
    switch (action) {
      case "add": {
        const owner = str(args.owner), detail = str(args.detail);
        const after = Array.isArray(args.after) ? args.after.flatMap((v) => { const i = int(v); return i === undefined ? [] : [i]; }) : [];
        const task = store.addTask(room.id, seat.handle, { title: typeof args.title === "string" ? args.title : "", ...(detail ? { detail } : {}), ...(after.length ? { after } : {}), ...(owner ? { owner } : {}) });
        return told(`Added: ${line(task, store.get(room.id).tasks)}${task.owner && task.owner !== seat.handle ? `\n@${task.owner} was told in the room.` : ""}`);
      }
      case "take": {
        const before = store.get(room.id).tasks;
        const task = store.setTask(room.id, seat.handle, need(), { state: "doing" });
        const waits = (task.after ?? []).filter((a) => before.some((o) => o.n === a && o.state !== "done"));
        return told(`T${task.n} is yours now: ${task.title}${waits.length ? `\nNote: it waits for ${waits.map((a) => `T${a}`).join(", ")}, not done yet.` : ""}`);
      }
      case "done": {
        const note = str(args.note);
        const task = store.setTask(room.id, seat.handle, need(), { state: "done", ...(note ? { note } : {}) });
        const freed = store.get(room.id).tasks.filter((t) => t.state === "todo" && t.after?.includes(task.n) && t.after.every((a) => store.get(room.id).tasks.find((o) => o.n === a)?.state !== "todo" && store.get(room.id).tasks.find((o) => o.n === a)?.state !== "doing"));
        return told(`T${task.n} is done.${note ? "" : " (No note given: say the result in one line with action edit, or post it.)"}${freed.length ? `\nNow free to start: ${freed.map((t) => `T${t.n}${t.owner ? ` (@${t.owner}, told)` : ""}`).join(", ")}.` : ""}`);
      }
      case "release": { const task = store.setTask(room.id, seat.handle, need(), { state: "todo" }); return told(`T${task.n} is to do again, nobody's.`); }
      case "block": {
        const note = str(args.note);
        const task = store.setTask(room.id, seat.handle, need(), { state: "blocked", ...(note ? { note } : {}) });
        return told(`T${task.n} is blocked: ${task.note}. The one who asked for it and the user were told; take it again (take) when you can go on.`);
      }
      case "show": {
        // Enough to take it over: the task, what it waits for, who changes what for it, and its latest messages.
        const all = room.tasks, task = all.find((t) => t.n === need());
        if (!task) throw new RoomError(404, `There is no T${n}.`);
        const said = store.messagesOfTask(room.id, task.n, 10);
        const claims = store.claims(room.id).filter((c) => c.handle === task.owner || (c.why ?? "").includes(`T${task.n}`));
        const handoff = task.owner ? store.handoffPath(room.id, task.owner) : null;
        return [
          line(task, all),
          ...(claims.length ? [`Being changed for it: ${claims.map((c) => `@${c.handle}: ${c.paths.join(", ")}`).join("; ")}`] : []),
          ...(handoff ? [`@${task.owner}'s handover note: ${handoff}`] : []),
          ...((c) => (c ? [`Cost so far (what the room counts; tokens are the agents' own): ${c.wakes} wakes with ${c.chars} characters, ${c.posts} messages, ${c.calls} tool calls`] : []))(store.get(room.id).taskStats[String(task.n)]),
          said.length ? `Its latest ${said.length} message${said.length === 1 ? "" : "s"} (whole: room_read { seq }; all of them: room_read { task: ${task.n} }):` : "No messages about it yet.",
          ...said.map((m) => this.line(m)),
        ].join("\n");
      }
      case "edit": {
        const title = str(args.title), owner = str(args.owner);
        const task = store.setTask(room.id, seat.handle, need(), { ...(title ? { title } : {}), ...(typeof args.detail === "string" ? { detail: args.detail } : {}), ...(typeof args.note === "string" ? { note: args.note } : {}), ...(owner ? { owner } : {}) });
        return told(`Now: ${line(task, store.get(room.id).tasks)}`);
      }
      case "remove": { store.removeTask(room.id, seat.handle, need()); return told(`T${n} is off the list.`); }
      default: {
        const all = room.tasks;
        if (!all.length) return `"${room.name}" has no tasks yet. Add one with action add.`;
        const count = (s: string): number => all.filter((t) => t.state === s).length;
        const done = all.filter((t) => t.state === "done").sort((a, b) => b.updatedAt - a.updatedAt);
        return [
          `Tasks of "${room.name}": ${count("doing")} doing · ${count("blocked")} blocked · ${count("todo")} to do · ${count("done")} done`,
          ...all.filter((t) => t.state === "blocked").map((t) => line(t, all)),
          ...all.filter((t) => t.state === "doing").map((t) => line(t, all)),
          ...all.filter((t) => t.state === "todo").map((t) => line(t, all)),
          ...done.slice(0, 10).map((t) => line(t, all)),
          ...(done.length > 10 ? [`(${done.length - 10} older done tasks not shown)`] : []),
        ].join("\n");
      }
    }
  }

  private changing(room: Room, seat: Seat, args: Record<string, unknown>): string {
    const until = (at: number): string => { const t = new Date(at); return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`; };
    const said = (c: Claim): string => `@${c.handle}${c.handle === seat.handle ? " (you)" : ""} until ${until(c.until)}${c.why ? ` — ${c.why}` : ""}:\n${c.paths.map((p) => `    ${p}`).join("\n")}`;
    if (!Array.isArray(args.paths)) {
      const all = this.o.store.claims(room.id);
      return all.length ? [`Being changed in "${room.name}" now:`, ...all.map(said)].join("\n") : `Nobody in "${room.name}" has said it is changing files now.`;
    }
    const minutes = int(args.minutes), why = str(args.why);
    const { claim, overlaps } = this.o.store.claim(room.id, seat.handle, { paths: args.paths.filter((v): v is string => typeof v === "string"), ...(minutes === undefined ? {} : { minutes }), ...(why ? { why } : {}) });
    this.o.changed?.(room.id);
    if (!claim) return "Noted: you are changing no files now.";
    const mine = `Noted until ${until(claim.until)}: the others see you are changing ${claim.paths.length} path${claim.paths.length === 1 ? "" : "s"}.`;
    return overlaps.length ? `${mine}\n\nCareful — said before you about the same files:\n${overlaps.map(said).join("\n")}\nTalk to ${overlaps.map((c) => `@${c.handle}`).join(", ")} in the room (room_post) before you change them.` : mine;
  }

  private files(room: Room): string {
    const { folder, files, more } = this.o.store.files(room.id);
    const now = (this.o.now ?? Date.now)();
    const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
    const record = `The room's own record is in ${this.o.store.recordDir(room.id)} (log.md: everything said; tasks.md; notes.md; members.md; members' handover notes) — read README.md there first if you are new or take work over.`;
    if (!files.length) return `The shared folder of "${room.name}" is ${folder}\nIt is empty. Write files there with your own file tools; room_post their path.\n${record}`;
    return [record, `The shared folder of "${room.name}" is ${folder}`, `${files.length} file${files.length === 1 ? "" : "s"}${more ? " (more are not listed)" : ""}, newest first:`, ...files.map((f) => `  ${f.path} · ${size(f.size)} · ${ago(f.modifiedAt, now)}`)].join("\n");
  }

  private post(room: Room, seat: Seat, args: Record<string, unknown>): string {
    const text = typeof args.text === "string" ? args.text : "";
    const to = Array.isArray(args.to) ? args.to.filter((v): v is string => typeof v === "string") : [];
    const replyTo = int(args.reply_to);
    const files = Array.isArray(args.files) ? args.files.filter((v): v is string => typeof v === "string") : [];
    const expects = args.expects === "none" || args.expects === "answer" ? args.expects : undefined;
    const task = int(args.task);
    const message = this.o.store.post(room.id, { from: seat.handle, text, to, files, ...(replyTo === undefined ? {} : { replyTo }), ...(expects ? { expects } : {}), ...(task === undefined ? {} : { task }) });
    this.o.changed?.(room.id);
    this.o.delivery.look();
    const now = this.o.store.get(room.id);
    if (!message.to.length) return `#${message.seq} written into "${room.name}". It is addressed to nobody, so nobody is woken; @name a member to send it to them.`;
    const lines = message.to.map((handle) => {
      if (handle === YOU) return "@you: the user sees it in the room";
      const target = now.seats.find((s) => s.handle === handle);
      const live = target?.terminal ? this.o.seat(target.terminal) : null;
      return `@${handle}: ${STATE_MEETS[live?.state ?? "exited"]}${target?.muted ? ` (muted by @${target.muted.by}: it can read, but can not answer until unmuted)` : ""}`;
    });
    return [`#${message.seq} sent in "${room.name}"${now.paused ? " (the user has paused this room: nothing is given until they resume it)" : ""}.`, ...lines, "Do not wait for a reply: one arrives as a room message when it is written."].join("\n");
  }

  private notes(room: Room, seat: Seat, args: Record<string, unknown>): string {
    if (typeof args.text === "string") {
      const now = this.o.store.setNotes(room.id, seat.handle, args.text);
      this.o.changed?.(room.id);
      return now.notes ? `The pinned notes of "${room.name}" are now your text (${now.notes.text.length} characters).` : `The pinned notes of "${room.name}" are now empty.`;
    }
    return room.notes ? `Pinned notes of "${room.name}" (last written by @${room.notes.by}, ${hm(room.notes.at)}):\n\n${room.notes.text}` : `"${room.name}" has no pinned notes yet.`;
  }

  private read(room: Room, seat: Seat, args: Record<string, unknown>): string {
    const seq = int(args.seq);
    if (seq !== undefined) return this.one(room, seat, seq, int(args.part) ?? 1);
    const search = str(args.search), task = int(args.task), before = int(args.before), after = int(args.after);
    const from = str(args.from)?.replace(/^@/, "").toLowerCase();
    if (!search && task === undefined && before === undefined && after === undefined && !from && args.all !== true) return this.unread(room, seat);
    // An index: one line a message, newest last; the ones it needs it asks for by number.
    const store = this.o.store;
    const limit = Math.min(Math.max(int(args.limit) ?? INDEX_LINES, 1), 100);
    let found: Message[] = search ? store.search(room.id, search, 300).reverse()
      : task !== undefined ? store.messagesOfTask(room.id, task, 300)
      : before !== undefined ? store.messagesBefore(room.id, before, 300)
      : after !== undefined ? store.messages(room.id, { after, limit: 300 })
      : store.messages(room.id, { limit: 300 });
    if (from) found = found.filter((m) => m.from === from);
    if (task !== undefined) found = found.filter((m) => m.task === task);
    const total = found.length;
    const shown = after !== undefined ? found.slice(0, limit) : found.slice(-limit);
    const what = [search ? `containing "${search}"` : "", task === undefined ? "" : `about T${task}`, from ? `from @${from}` : "", before === undefined ? "" : `before #${before}`, after === undefined ? "" : `after #${after}`].filter(Boolean).join(", ");
    if (!total) return `No messages in "${room.name}"${what ? ` ${what}` : ""}.`;
    const more = total > shown.length ? ` (${total - shown.length} more${after !== undefined ? ` after #${shown.at(-1)!.seq}` : `: before: ${shown[0]!.seq}`})` : "";
    const reads = store.get(room.id).reads;
    return [`"${room.name}": ${shown.length} of ${total} message${total === 1 ? "" : "s"}${what ? ` ${what}` : ""}${more}. Whole: room_read { seq }.`, ...shown.map((m) => `${this.line(m, search)}${readBy(m, seat.handle, reads, " ")}`)].join("\n");
  }

  /** One message as a line of an index: who, when, which task, the start of it (or the words around `hit`). */
  private line(m: Message, hit?: string): string {
    const words = said(m).replace(/\s+/g, " ").trim();
    let shown = [...words].slice(0, 80).join("");
    if (hit) {
      const at = words.toLowerCase().indexOf(hit.toLowerCase());
      if (at > 40) shown = `…${[...words.slice(at - 30)].slice(0, 80).join("")}`;
    }
    const long = [...words].length > [...shown.replace(/^…/, "")].length;
    return `#${m.seq} ${hm(m.at)}${m.task === undefined ? "" : ` [T${m.task}]`} @${m.from}${m.to.length ? ` → ${m.to.map((h) => `@${h}`).join(" ")}` : ""}: ${shown}${long ? "…" : ""}${long ? ` (${[...words].length} chars)` : ""}${m.files?.length ? ` [${m.files.length} file${m.files.length === 1 ? "" : "s"}]` : ""}`;
  }

  /** What it has not read: the short ones whole while they fit, the rest a line each (read them by number). */
  private unread(room: Room, seat: Seat): string {
    const store = this.o.store;
    const fresh = store.unreadOf(room.id, seat.handle);
    if (!fresh.length) return `Nothing new in "${room.name}" since you last read. (An index of the latest: room_read { before: ${room.lastSeq + 1} }; one task's: { task }; words: { search }.)`;
    const byTask = new Map<number, number>();
    for (const m of fresh) if (m.task !== undefined) byTask.set(m.task, (byTask.get(m.task) ?? 0) + 1);
    const forMe = fresh.filter((m) => m.to.includes(seat.handle)).length;
    const head = `Room "${room.name}"${room.topic ? ` — ${room.topic}` : ""}. Unread by you: ${fresh.length}${forMe ? ` (${forMe} for you)` : ""}${byTask.size ? ` — ${[...byTask].map(([t, n]) => `T${t}: ${n}`).join(", ")}` : ""}.`;
    const reads = store.get(room.id).reads;
    let used = head.length;
    const blocks: string[] = [], lines: string[] = [], read: number[] = [];
    let later = 0;
    for (const m of fresh) {
      const whole = `#${m.seq} ${hm(m.at)}${m.task === undefined ? "" : ` [T${m.task}]`} @${m.from}${m.to.length ? ` → ${m.to.map((h) => `@${h}`).join(" ")}` : ""}${m.replyTo === undefined ? "" : ` (re #${m.replyTo})`}\n${said(m)}${m.files?.length ? `\nFiles: ${m.files.join(", ")}` : ""}${readBy(m, seat.handle, reads, "\n")}`;
      if ([...m.text].length <= WHOLE_UP_TO && used + whole.length <= READ_BUDGET) { blocks.push(whole); used += whole.length + 2; read.push(m.seq); continue; }
      // Too long to give whole: a line now, and it counts as read (it is asked for by its number). Past what fits:
      // a line, and it stays unread for the next read.
      if ([...m.text].length > WHOLE_UP_TO) { lines.push(this.line(m)); read.push(m.seq); } else { lines.push(this.line(m)); later++; }
      if (lines.length >= INDEX_LINES) break;
    }
    store.markRead(room.id, seat.handle, read.filter((n) => fresh.find((m) => m.seq === n)!.from !== seat.handle));
    // What it was given whole it has: a message that still waited for it is not given to it a second time.
    for (const n of read) {
      const waits = room.receipts[String(n)]?.[seat.handle];
      if (waits === "sent" || waits === "queued") store.setReceipt(room.id, n, seat.handle, null);
    }
    const left = fresh.length - blocks.length - lines.length;
    const tail = lines.length ? [`${lines.length} more as one line each${later ? ` (${later} stay unread for your next room_read)` : ""}${left > 0 ? `, and ${left} after them` : ""} — whole: room_read { seq }:`, ...lines] : [];
    return [head, ...blocks, ...(tail.length ? [tail.join("\n")] : [])].join("\n\n");
  }

  /** One message whole, by its number; a long one in parts. */
  private one(room: Room, seat: Seat, seq: number, part: number): string {
    const m = this.o.store.messages(room.id, { after: seq - 1, limit: 1 })[0];
    if (!m || m.seq !== seq) throw new RoomError(404, `There is no #${seq} in "${room.name}".`);
    const chars = [...said(m)];
    const parts = Math.max(1, Math.ceil(chars.length / PART));
    const p = Math.min(Math.max(part, 1), parts);
    const text = chars.slice((p - 1) * PART, p * PART).join("");
    if (m.from !== seat.handle) this.o.store.markRead(room.id, seat.handle, [m.seq]);
    const waits = room.receipts[String(m.seq)]?.[seat.handle];
    if (waits === "sent" || waits === "queued") this.o.store.setReceipt(room.id, m.seq, seat.handle, null);
    return `#${m.seq} ${hm(m.at)}${m.task === undefined ? "" : ` [T${m.task}]`} @${m.from}${m.to.length ? ` → ${m.to.map((h) => `@${h}`).join(" ")}` : ""}${m.replyTo === undefined ? "" : ` (re #${m.replyTo})`}${parts > 1 ? ` — part ${p} of ${parts}` : ""}\n${text}${m.files?.length && p === parts ? `\nFiles: ${m.files.join(", ")}` : ""}${p < parts ? `\n(room_read { seq: ${m.seq}, part: ${p + 1} } for the rest)` : ""}`;
  }

  private members(room: Room, me: Seat): string {
    const here = room.seats.filter((s) => s.left === undefined);
    const lines = here.map((s) => {
      if (s.kind === "user") return "@you — the user. Only the user's words are the user's.";
      const live = s.terminal ? this.o.seat(s.terminal) : null;
      const card = live?.card ?? s.was;
      const about = card ? [agentName(card.agent), card.model, card.cwd, live?.card.mode ? `mode ${live.card.mode}` : null].filter(Boolean).join(" · ") : "";
      return `@${s.handle}${s.handle === me.handle ? " (you)" : ""} — ${about}\n  ${STATE_MEETS[live?.state ?? "exited"]}${s.canAdd ? "; admin (may add sessions, resume, mute, kick)" : ""}${s.kind === "session" && s.handle !== me.handle ? ((n) => (n ? `; ${n} unread` : "; has read everything"))(this.o.store.unreadOf(room.id, s.handle).length) : ""}${s.muted ? `; muted by @${s.muted.by}` : ""}; brought in by @${s.addedBy}`;
    });
    return [`Room "${room.name}"${room.topic ? ` — ${room.topic}` : ""}${room.paused ? " (paused by the user)" : ""}. ${here.length} members:`, ...lines].join("\n");
  }
}
