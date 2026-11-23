/** Chatroom Kit (docs/chatroom-v0.md §6): what a session in a room can do there, as tools. A session has the Kit while
 *  it sits in a room: speaking, reading, and seeing who is there. Which session calls is settled before it gets here
 *  (its terminal's own channel says so); a session never names itself.
 *
 *  Every answer is plain text for an agent to read. A refusal says why, and is an answer too: the agent goes on. */

import type { RoomDelivery } from "./delivery.js";
import { YOU } from "./names.js";
import { agentName, STATE_MEETS, type SeatLookup } from "./state.js";
import { MAX_STARTED, RoomError, type Claim, type Message, type Room, type RoomStore, type Seat, type SeatWas, type Task } from "./store.js";

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
  /** Ends a terminal started here that nothing sits in after all. */
  stop(terminal: string): Promise<void>;
  resume(req: { readonly agent: string; readonly cwd: string; readonly session: string; readonly profile?: string; readonly model?: string; readonly effort?: string; readonly mode?: string }): Promise<{ readonly id: string }>;
};

export type KitTool = { readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown> };
export type KitAnswer = { readonly text: string; readonly isError?: true };

const ROOM_ARG = { type: "string", description: "The room, by its name or id. Needed only when you sit in more than one room." };

const TOOLS: readonly KitTool[] = [
  {
    name: "room_post",
    description: "Say something in an AgentSwitch Chat Room you sit in. Other sessions there are colleagues working on their own tasks; the user reads the room too. Write @name in the text (or list names in `to`) to send it to those members: they are woken with it, each when it can take it. Without an @ the message is only written into the room and wakes nobody. This returns at once and does not wait for a reply: a reply arrives later as a room message addressed to you. Keep it short and exact (what changed, what you need, file paths); do not chat.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The message. @name addresses a member; @you is the user." },
        to: { type: "array", items: { type: "string" }, description: "Members to address, besides any @name in the text." },
        files: { type: "array", items: { type: "string" }, description: "Files to point the others at, by absolute path on this machine (they are not copied; the others read them where they are)." },
        reply_to: { type: "integer", description: "The number of the message this answers (the #n in its envelope)." },
        room: ROOM_ARG,
      },
      required: ["text"],
    },
  },
  {
    name: "room_read",
    description: "Read messages of an AgentSwitch Chat Room you sit in: the latest ones, or those after a number, from one member, or containing a text. Messages not addressed to you are not sent to you; this is how you see them.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many, at most (default 20, up to 100)." },
        after: { type: "integer", description: "Only messages after this number." },
        from: { type: "string", description: "Only this member's messages." },
        search: { type: "string", description: "Only messages containing this text." },
        room: ROOM_ARG,
      },
    },
  },
  {
    name: "room_members",
    description: "Who sits in an AgentSwitch Chat Room you sit in: each member's @name, agent, model, profile, folder, and its state now (whether a message to it would be taken now, later, or not at all).",
    inputSchema: { type: "object", properties: { room: ROOM_ARG } },
  },
  {
    name: "room_notes",
    description: "The pinned notes of an AgentSwitch Chat Room you sit in: one shared text all members read and write — what was agreed (conventions, interfaces, who does what, what is left). Without `text` this reads them. With `text` it replaces the whole notes with that text: read first, then write back everything that should stay plus your change. Use it for what must outlast the conversation, not for chatting.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "The whole new notes. Omit to read." }, room: ROOM_ARG } },
  },
  {
    name: "room_files",
    description: "The shared folder of an AgentSwitch Chat Room you sit in: its absolute path and the files in it, newest first. Every member reads and writes this folder directly, with its own file tools. Hand over anything longer than a few lines as a file here — a report, a plan, an interface, a diff, a log — and room_post only its path and one sentence of what it says: nothing is lost in retelling and nobody pays to read it twice. Give a file a name that says what it is, and write a new file rather than changing another member's.",
    inputSchema: { type: "object", properties: { room: ROOM_ARG } },
  },
  {
    name: "room_tasks",
    description: "The task list of an AgentSwitch Chat Room you sit in: who does what and how far it is, seen by every member and the user. Without `action` it lists the tasks. `add` a task for work that is not on the list yet (a title that says what is done when it is done; `after` for tasks that must come first; `owner` to give it to a member). Whoever a task is given to, and whoever waits for one that is done, is told in the room by itself: do not post that again. `take` a task before you start on it — one another member is doing can not be taken, so two never do the same work. `done` when it is finished, with `note`: the result in one line, or the path of the file that holds it. `release` gives back one you can not finish. Look here before you start something, and keep your own tasks true: others plan by them.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "take", "done", "release", "edit", "remove"], description: "Default: list." },
        n: { type: "integer", description: "The task's number (the 3 of T3), for take, done, release, edit, remove." },
        title: { type: "string", description: "For add (and edit)." },
        detail: { type: "string", description: "For add (and edit): what exactly, where, how it is checked." },
        after: { type: "array", items: { type: "integer" }, description: "For add: numbers of the tasks that must be done first." },
        owner: { type: "string", description: "For add or edit: the member whose task it is (@name)." },
        note: { type: "string", description: "For done (or edit): the result in a line, or the file that holds it." },
        room: ROOM_ARG,
      },
    },
  },
  {
    name: "room_changing",
    description: "Tell the members of an AgentSwitch Chat Room you sit in which files or folders you are about to change, so that two sessions do not change the same file unknowingly. Give `paths` (absolute; a folder covers what is in it) before you edit; it replaces what you said before and lapses by itself after `minutes` (default " + 30 + "). You are told at once if another member said it is changing the same files: then talk to it in the room before you touch them. It is a word to the others, not a lock: nothing is blocked. `paths: []` when you are done. Without `paths` it lists what everyone is changing now.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Absolute paths of the files or folders you are changing. Empty: none any more. Omit to list." },
        minutes: { type: "integer", description: "For how long (default 30, up to 240). Say it again to go on." },
        why: { type: "string", description: "What for, in a few words (or the task: T3)." },
        room: ROOM_ARG,
      },
    },
  },
];

/** For a session whose `Can Add Sessions` is on. */
const ORG_TOOLS: readonly KitTool[] = [
  { name: "rooms", description: "The Chat Rooms that exist in AgentSwitch: name, id, topic, how many members. (You may add sessions, so you can see them. A session sits in one room at a time: making a room is the user's.)", inputSchema: { type: "object", properties: {} } },
  {
    name: "room_add",
    description: "Bring a session into a Chat Room you sit in. One of three: (1) a session that is running — give `terminal` (from `sessions`); (2) a new session — give `agent` and `cwd`, and optionally `profile`, `model`, `mode`; (3) an existing session resumed — give `agent`, `resume` (its id from `sessions`) and `cwd`, optionally `profile` to continue it under another profile. A session you start can not start sessions itself, and you may start at most " + MAX_STARTED + ". It joins idle and knows nothing of your task: after adding it, room_post an @message that says exactly what you need from it.",
    inputSchema: {
      type: "object",
      properties: {
        terminal: { type: "string", description: "A running session's terminal id." },
        agent: { type: "string", enum: ["claude-code", "codex", "opencode", "pi"] },
        cwd: { type: "string", description: "The folder the session works in (absolute path)." },
        profile: { type: "string", description: "A profile id from `profiles`; default: the agent's current one." },
        model: { type: "string", description: "A model id from `models`; default: the agent's own default." },
        mode: { type: "string", enum: ["manual", "auto", "bypass"], description: "How it asks for permission; default manual. bypass only if you run in bypass yourself." },
        resume: { type: "string", description: "The id of an existing session to resume." },
        room: ROOM_ARG,
      },
    },
  },
  {
    name: "room_manage",
    description: "Admin actions in a Chat Room you sit in, if your Can Add Sessions is on (that switch makes you an admin): `resume` a member whose session has ended, bringing the same conversation back; `mute` a member that floods the room or does not do its work (it can still read and work, but not post or write the notes); `unmute` it; `kick` it out of the room (its session keeps running). Only the user can mute or kick another admin, and nobody can manage themselves or the user.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["resume", "mute", "unmute", "kick"] },
        handle: { type: "string", description: "The member's @name." },
        room: ROOM_ARG,
      },
      required: ["action", "handle"],
    },
  },
  { name: "profiles", description: "AgentSwitch's profiles per agent: id, name, whether it is a subscription or pays by an API key, and the result and time of its last health check. No accounts, no keys.", inputSchema: { type: "object", properties: {} } },
  { name: "models", description: "The models each agent offers now, for room_add's `model`.", inputSchema: { type: "object", properties: { agent: { type: "string", description: "Only this agent's." } } } },
  { name: "sessions", description: "Sessions that can be brought into a room: the ones running in AgentSwitch's terminals (with their terminal id and state), and recent ones that can be resumed (with their id, title, folder, time). Truncated: ask with `search` to narrow.", inputSchema: { type: "object", properties: { search: { type: "string", description: "Only sessions whose title or folder contains this." }, limit: { type: "integer", description: "How many resumable ones at most (default 20, up to 50)." } } } },
  { name: "profile_check", description: "Check again whether a profile can reach its service. For a Claude subscription profile this sends one real request and may use a little quota: use it only when the last result (in `profiles`) is old or you are about to start a session under it.", inputSchema: { type: "object", properties: { agent: { type: "string" }, profile: { type: "string", description: "The profile's id." } }, required: ["agent", "profile"] } },
];
const NO_ROOM = "This session sits in no Chat Room now. The user (or a member who may add sessions) seats a session in a room.";
const NOT_ALLOWED = "This session may not add sessions: the user has not turned on Can Add Sessions for it (the switch is on its card in the room).";
const ago = (at: number, now: number): string => { const m = Math.round((now - at) / 60_000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

const hm = (at: number): string => { const t = new Date(at); return `${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`; };
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** What it takes to bring the conversation behind an ended seat back (§6.2): the session the seat kept while its
 *  terminal lived. Throws a RoomError when it kept none. */
export function resumeOf(seat: Seat): { agent: string; cwd: string; session: string; profile?: string; model?: string; effort?: string; mode?: string } {
  const s = seat.session;
  if (!s || !seat.was) throw new RoomError(409, `@${seat.handle} took its seat before session ids were kept, so its conversation can not be found again from here. Remove it from the room and add the session again (room_add with agent, resume, cwd — see \`sessions\`).`);
  return { agent: seat.was.agent, cwd: s.cwd, session: s.id, ...(s.profile ? { profile: s.profile } : {}), ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}), ...(s.mode ? { mode: s.mode } : {}) };
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

export class RoomKit {
  constructor(private readonly o: { readonly store: RoomStore; readonly seat: SeatLookup; readonly delivery: RoomDelivery; readonly changed?: (roomId: string) => void; readonly org?: () => KitOrg | null; readonly now?: () => number }) {}

  private readonly seen = new Set<string>();

  /** A terminal's tool server asked: its session has the Kit. */
  met(terminal: string): void { this.seen.add(terminal); }

  /** Whether a terminal's session has the Kit (one started before there was a Kit has none until it is resumed). */
  has(terminal: string): boolean { return this.seen.has(terminal); }

  /** The tools a terminal's session has now: none outside every room. */
  tools(terminal: string, always = false): readonly KitTool[] {
    // `always`: for an agent that lists its tools once, when it starts, and never again (Codex): it is seated long
    // after, and would sit in the room with no way to speak. Outside every room a call is answered with why not.
    if (!this.o.store.roomsOf(terminal).length) return always ? TOOLS : [];
    return this.o.store.mayAdd(terminal) && this.o.org?.() ? [...TOOLS, ...ORG_TOOLS] : TOOLS;
  }

  /** What changes when the tools a terminal has change: a session's agent is told to list them again. */
  version(terminal: string, always = false): string {
    return this.tools(terminal, always).map((t) => t.name).join(",");
  }

  /** One call of a tool by a terminal's session. The switch is looked at now, each time: turned off, the next call
   *  is refused whatever the agent still lists. */
  async call(terminal: string, name: string, args: Record<string, unknown>): Promise<KitAnswer> {
    try {
      if (ORG_TOOLS.some((t) => t.name === name)) {
        const org = this.o.org?.();
        if (!this.o.store.roomsOf(terminal).length) throw new RoomError(403, NO_ROOM);
        if (!this.o.store.mayAdd(terminal) || !org) throw new RoomError(403, NOT_ALLOWED);
        return { text: await this.organize(org, terminal, name, args) };
      }
      if (!TOOLS.some((t) => t.name === name)) return { text: `There is no tool ${name} in the Chatroom Kit.`, isError: true };
      const { room, seat } = this.where(terminal, str(args.room));
      switch (name) {
        case "room_post": return { text: this.post(room, seat, args) };
        case "room_read": return { text: this.read(room, args) };
        case "room_notes": return { text: this.notes(room, seat, args) };
        case "room_files": return { text: this.files(room) };
        case "room_tasks": return { text: this.tasks(room, seat, args) };
        case "room_changing": return { text: this.changing(room, seat, args) };
        default: return { text: this.members(room, seat) };
      }
    } catch (err) {
      if (err instanceof RoomError) return { text: err.message, isError: true };
      throw err;
    }
  }

  private async organize(org: KitOrg, terminal: string, name: string, args: Record<string, unknown>): Promise<string> {
    const now = (this.o.now ?? Date.now)();
    switch (name) {
      case "rooms": {
        const mine = new Set(this.o.store.roomsOf(terminal).map((s) => s.room.id));
        const all = this.o.store.list();
        return [`${all.length} room${all.length === 1 ? "" : "s"}:`, ...all.map((r) => `"${r.name}" (${r.id})${mine.has(r.id) ? " — you sit here" : ""} · ${r.seats.filter((s) => s.left === undefined).length} members${r.paused ? " · paused" : ""}${r.topic ? `\n  ${r.topic}` : ""}`)].join("\n");
      }
      case "room_add": return this.add(org, terminal, args);
      case "room_manage": return this.manage(org, terminal, args);
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
          `Running (${running.length}) — add with room_add { terminal }:`,
          ...running.map((s) => `  ${s.terminal} · ${s.agent} · "${s.name}" · ${s.cwd} · ${s.state}${s.profile ? ` · profile ${s.profile}` : ""}${s.terminal === terminal ? " · (you)" : seated.has(s.terminal) ? " · in a room" : ""}`),
          `Can be resumed (${resumable.length} shown) — add with room_add { agent, resume, cwd }:`,
          ...resumable.filter((s) => !open.has(s.id)).map((s) => `  ${s.agent} · ${s.id} · "${s.title}" · ${s.cwd} · ${ago(s.updatedAt, now)}${s.profile ? ` · profile ${s.profile}` : ""}`),
        ].join("\n");
      }
      default: {
        const agent = str(args.agent), profile = str(args.profile);
        if (!agent || !profile) throw new RoomError(400, "profile_check needs `agent` and `profile` (an id from `profiles`).");
        const result = await org.check(agent, profile);
        return `${agent} · ${profile}: ${result.status}${result.message ? ` — ${result.message}` : ""} (checked just now)`;
      }
    }
  }

  private async add(org: KitOrg, terminal: string, args: Record<string, unknown>): Promise<string> {
    const { room, seat: me } = this.where(terminal, str(args.room));
    const running = str(args.terminal), agent = str(args.agent), cwd = str(args.cwd), resume = str(args.resume);
    const sit = (target: string, started: boolean): string => {
      const live = this.o.seat(target);
      if (!live) throw new RoomError(404, `There is no running session with terminal id ${target}. See \`sessions\`.`);
      if (live.state === "exited") throw new RoomError(409, "That session has ended; resume it instead (room_add with `agent`, `resume`, `cwd`).");
      const { mode: _mode, node: _node, ...was } = live.card;
      const seat = this.o.store.seat(room.id, { terminal: target, was, by: me.handle, ...(started ? { byAgent: true, starter: terminal } : {}) });
      this.o.changed?.(room.id);
      return `@${seat.handle} now sits in "${room.name}" (${[agentName(was.agent), was.model, was.cwd].filter(Boolean).join(" · ")}; ${STATE_MEETS[live.state]}). It knows nothing of your task yet: room_post an @${seat.handle} message that says what you need.`;
    };
    if (running) {
      if (running === terminal) throw new RoomError(400, "That is you; you already sit here.");
      return sit(running, false);
    }
    if (!agent || !cwd) throw new RoomError(400, "room_add needs `terminal` (a running session), or `agent` and `cwd` (a new session; with `resume` an existing one).");
    if (this.o.store.startedBy(terminal) >= MAX_STARTED) throw new RoomError(409, `You have started ${MAX_STARTED} sessions that still sit in rooms; that is the most one session may. Work with them, or ask the user.`);
    const mode = str(args.mode);
    const mine = this.o.seat(terminal)?.card.mode ?? "";
    if (mode === "bypass" && !/bypass/i.test(mine)) throw new RoomError(403, "You do not run in bypass yourself, so you can not start a session in bypass. Use manual or auto.");
    const profile = str(args.profile), model = str(args.model);
    const started = await org.start({ agent, cwd, ...(profile ? { profile } : {}), ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(resume ? { resume } : {}) });
    return sit(started, true);
  }

  /** An admin's work on one member (§6.2): resume an ended session, mute or unmute it, or kick it out. */
  private async manage(org: KitOrg, terminal: string, args: Record<string, unknown>): Promise<string> {
    const { room, seat: me } = this.where(terminal, str(args.room));
    if (!me.canAdd) throw new RoomError(403, NOT_ALLOWED);
    if (me.muted) throw new RoomError(403, `@${me.handle} is muted by @${me.muted.by}: it can not manage the room until it is unmuted.`);
    const action = str(args.action), name = str(args.handle)?.replace(/^@/, "").toLowerCase();
    if (!action || !name) throw new RoomError(400, "room_manage needs `action` and `handle`.");
    const target = room.seats.find((s) => s.handle === name);
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
      case "kick": {
        this.o.store.unseat(room.id, target.handle, me.handle);
        this.o.changed?.(room.id);
        this.o.delivery.look();
        return `@${target.handle} is out of "${room.name}". Its session keeps running outside the room; the user or an admin can bring it back with room_add.`;
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
      default: throw new RoomError(400, "room_manage: action is resume, mute, unmute or kick.");
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
      return `T${t.n} [${t.state === "todo" ? "to do" : t.state}${t.owner ? ` · @${t.owner}${t.owner === seat.handle ? " (you)" : ""}` : ""}] ${t.title}${waits.length ? ` — waits for ${waits.map((a) => `T${a}`).join(", ")}` : ""}${t.detail ? `\n    ${t.detail.replace(/\n/g, "\n    ")}` : ""}${t.note ? `\n    → ${t.note.replace(/\n/g, "\n    ")}` : ""}`;
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
          `Tasks of "${room.name}": ${count("doing")} doing · ${count("todo")} to do · ${count("done")} done`,
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
    if (!files.length) return `The shared folder of "${room.name}" is ${folder}\nIt is empty. Write files there with your own file tools; room_post their path.`;
    return [`The shared folder of "${room.name}" is ${folder}`, `${files.length} file${files.length === 1 ? "" : "s"}${more ? " (more are not listed)" : ""}, newest first:`, ...files.map((f) => `  ${f.path} · ${size(f.size)} · ${ago(f.modifiedAt, now)}`)].join("\n");
  }

  private post(room: Room, seat: Seat, args: Record<string, unknown>): string {
    const text = typeof args.text === "string" ? args.text : "";
    const to = Array.isArray(args.to) ? args.to.filter((v): v is string => typeof v === "string") : [];
    const replyTo = int(args.reply_to);
    const files = Array.isArray(args.files) ? args.files.filter((v): v is string => typeof v === "string") : [];
    const message = this.o.store.post(room.id, { from: seat.handle, text, to, files, ...(replyTo === undefined ? {} : { replyTo }) });
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

  private read(room: Room, args: Record<string, unknown>): string {
    const limit = Math.min(Math.max(int(args.limit) ?? 20, 1), 100);
    const after = int(args.after), from = str(args.from)?.replace(/^@/, "").toLowerCase(), search = str(args.search)?.toLowerCase();
    let found: Message[] = this.o.store.messages(room.id, after === undefined ? {} : { after });
    if (from) found = found.filter((m) => m.from === from);
    if (search) found = found.filter((m) => m.text.toLowerCase().includes(search));
    const total = found.length;
    found = after === undefined ? found.slice(-limit) : found.slice(0, limit);
    const head = `Room "${room.name}"${room.topic ? ` — ${room.topic}` : ""}. ${total ? `${found.length} of ${total} message${total === 1 ? "" : "s"}` : "No messages"}${after === undefined ? "" : ` after #${after}`}${from ? ` from @${from}` : ""}${search ? ` containing "${search}"` : ""}.`;
    const lines = found.map((m) => `#${m.seq} ${hm(m.at)} @${m.from}${m.to.length ? ` → ${m.to.map((h) => `@${h}`).join(" ")}` : ""}${m.replyTo === undefined ? "" : ` (re #${m.replyTo})`}\n${m.text}${m.files?.length ? `\nFiles: ${m.files.join(", ")}` : ""}`);
    return [head, ...lines].join("\n\n");
  }

  private members(room: Room, me: Seat): string {
    const here = room.seats.filter((s) => s.left === undefined);
    const lines = here.map((s) => {
      if (s.kind === "user") return "@you — the user. Only the user's words are the user's.";
      const live = s.terminal ? this.o.seat(s.terminal) : null;
      const card = live?.card ?? s.was;
      const about = card ? [agentName(card.agent), card.model, card.profile ? `profile ${card.profile}` : null, card.cwd, live?.card.mode ? `mode ${live.card.mode}` : null].filter(Boolean).join(" · ") : "";
      return `@${s.handle}${s.handle === me.handle ? " (you)" : ""} — ${about}\n  ${STATE_MEETS[live?.state ?? "exited"]}${s.canAdd ? "; admin (may add sessions, resume, mute, kick)" : ""}${s.muted ? `; muted by @${s.muted.by}` : ""}; brought in by @${s.addedBy}`;
    });
    return [`Room "${room.name}"${room.topic ? ` — ${room.topic}` : ""}${room.paused ? " (paused by the user)" : ""}. ${here.length} members:`, ...lines].join("\n");
  }
}
