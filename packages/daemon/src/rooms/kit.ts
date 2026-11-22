/** Chatroom Kit (docs/chatroom-v0.md §6): what a session in a room can do there, as tools. A session has the Kit while
 *  it sits in a room: speaking, reading, and seeing who is there. Which session calls is settled before it gets here
 *  (its terminal's own channel says so); a session never names itself.
 *
 *  Every answer is plain text for an agent to read. A refusal says why, and is an answer too: the agent goes on. */

import type { RoomDelivery } from "./delivery.js";
import { YOU } from "./names.js";
import { agentName, STATE_MEETS, type SeatLookup } from "./state.js";
import { RoomError, type Message, type Room, type RoomStore, type Seat } from "./store.js";

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

const hm = (at: number): string => { const t = new Date(at); return `${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`; };
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export class RoomKit {
  constructor(private readonly o: { readonly store: RoomStore; readonly seat: SeatLookup; readonly delivery: RoomDelivery; readonly changed?: (roomId: string) => void }) {}

  private readonly seen = new Set<string>();

  /** A terminal's tool server asked: its session has the Kit. */
  met(terminal: string): void { this.seen.add(terminal); }

  /** Whether a terminal's session has the Kit (one started before there was a Kit has none until it is resumed). */
  has(terminal: string): boolean { return this.seen.has(terminal); }

  /** The tools a terminal's session has now: none outside every room. */
  tools(terminal: string): readonly KitTool[] {
    return this.o.store.roomsOf(terminal).length ? TOOLS : [];
  }

  /** What changes when the tools a terminal has change: a session's agent is told to list them again. */
  version(terminal: string): string {
    return this.tools(terminal).map((t) => t.name).join(",");
  }

  /** The rooms a terminal sits in, for its agent's first look. */
  call(terminal: string, name: string, args: Record<string, unknown>): KitAnswer {
    try {
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

  private where(terminal: string, named: string | undefined): { room: Room; seat: Seat } {
    const sits = this.o.store.roomsOf(terminal);
    if (!sits.length) throw new RoomError(403, "This session sits in no Chat Room now. The user (or a member who may add sessions) seats a session in a room.");
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
