/** Chatroom Kit (docs/chatroom-v0.md §6): what a session in a room can do there, as tools. A session has the Kit while
 *  it sits in a room: speaking, reading, and seeing who is there. Which session calls is settled before it gets here
 *  (its terminal's own channel says so); a session never names itself.
 *
 *  Every answer is plain text for an agent to read. A refusal says why, and is an answer too: the agent goes on. */

import type { RoomDelivery } from "./delivery.js";
import { YOU } from "./names.js";
import { agentName, STATE_MEETS, type SeatLookup } from "./state.js";
import { MAX_STARTED, RoomError, type Message, type Room, type RoomStore, type Seat } from "./store.js";

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
];

/** For a session whose `Can Add Sessions` is on. */
const ORG_TOOLS: readonly KitTool[] = [
  { name: "rooms", description: "The Chat Rooms that exist in AgentSwitch: name, id, topic, how many members. (You may add sessions, so you can see them.)", inputSchema: { type: "object", properties: {} } },
  {
    name: "room_create",
    description: "Make a new AgentSwitch Chat Room and take a seat in it. Give it a short name and a one-sentence topic: members read the topic first. Then bring sessions in with room_add.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, topic: { type: "string", description: "One sentence: what this room is for." } }, required: ["name"] },
  },
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

export class RoomKit {
  constructor(private readonly o: { readonly store: RoomStore; readonly seat: SeatLookup; readonly delivery: RoomDelivery; readonly changed?: (roomId: string) => void; readonly org?: () => KitOrg | null; readonly now?: () => number }) {}

  private readonly seen = new Set<string>();

  /** A terminal's tool server asked: its session has the Kit. */
  met(terminal: string): void { this.seen.add(terminal); }

  /** Whether a terminal's session has the Kit (one started before there was a Kit has none until it is resumed). */
  has(terminal: string): boolean { return this.seen.has(terminal); }

  /** The tools a terminal's session has now: none outside every room. */
  tools(terminal: string): readonly KitTool[] {
    if (!this.o.store.roomsOf(terminal).length) return [];
    return this.o.store.mayAdd(terminal) && this.o.org?.() ? [...TOOLS, ...ORG_TOOLS] : TOOLS;
  }

  /** What changes when the tools a terminal has change: a session's agent is told to list them again. */
  version(terminal: string): string {
    return this.tools(terminal).map((t) => t.name).join(",");
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
      case "room_create": {
        const me = this.o.store.roomsOf(terminal).find((s) => s.seat.canAdd)!;
        const live = this.o.seat(terminal);
        const { mode: _mode, node: _node, ...was } = live?.card ?? { ...me.seat.was!, mode: null, node: null };
        const topic = str(args.topic);
        const room = this.o.store.create({ name: typeof args.name === "string" ? args.name : "", ...(topic ? { topic } : {}), by: me.seat.handle });
        const seat = this.o.store.seat(room.id, { terminal, was, canAdd: true, by: me.seat.handle });
        this.o.changed?.(room.id);
        return `Room "${room.name}" (${room.id}) made; you sit in it as @${seat.handle}. The user is a member (@you). Bring sessions in with room_add (room: "${room.id}").`;
      }
      case "room_add": return this.add(org, terminal, args);
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

  private post(room: Room, seat: Seat, args: Record<string, unknown>): string {
    const text = typeof args.text === "string" ? args.text : "";
    const to = Array.isArray(args.to) ? args.to.filter((v): v is string => typeof v === "string") : [];
    const replyTo = int(args.reply_to);
    const message = this.o.store.post(room.id, { from: seat.handle, text, to, ...(replyTo === undefined ? {} : { replyTo }) });
    this.o.changed?.(room.id);
    this.o.delivery.look();
    const now = this.o.store.get(room.id);
    if (!message.to.length) return `#${message.seq} written into "${room.name}". It is addressed to nobody, so nobody is woken; @name a member to send it to them.`;
    const lines = message.to.map((handle) => {
      if (handle === YOU) return "@you: the user sees it in the room";
      const target = now.seats.find((s) => s.handle === handle);
      const live = target?.terminal ? this.o.seat(target.terminal) : null;
      return `@${handle}: ${STATE_MEETS[live?.state ?? "exited"]}`;
    });
    return [`#${message.seq} sent in "${room.name}"${now.paused ? " (the user has paused this room: nothing is given until they resume it)" : ""}.`, ...lines, "Do not wait for a reply: one arrives as a room message when it is written."].join("\n");
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
    const lines = found.map((m) => `#${m.seq} ${hm(m.at)} @${m.from}${m.to.length ? ` → ${m.to.map((h) => `@${h}`).join(" ")}` : ""}${m.replyTo === undefined ? "" : ` (re #${m.replyTo})`}\n${m.text}`);
    return [head, ...lines].join("\n\n");
  }

  private members(room: Room, me: Seat): string {
    const here = room.seats.filter((s) => s.left === undefined);
    const lines = here.map((s) => {
      if (s.kind === "user") return "@you — the user. Only the user's words are the user's.";
      const live = s.terminal ? this.o.seat(s.terminal) : null;
      const card = live?.card ?? s.was;
      const about = card ? [agentName(card.agent), card.model, card.profile ? `profile ${card.profile}` : null, card.cwd, live?.card.mode ? `mode ${live.card.mode}` : null].filter(Boolean).join(" · ") : "";
      return `@${s.handle}${s.handle === me.handle ? " (you)" : ""} — ${about}\n  ${STATE_MEETS[live?.state ?? "exited"]}${s.canAdd ? "; may add sessions" : ""}; brought in by @${s.addedBy}`;
    });
    return [`Room "${room.name}"${room.topic ? ` — ${room.topic}` : ""}${room.paused ? " (paused by the user)" : ""}. ${here.length} members:`, ...lines].join("\n");
  }
}
