/** Chat Room's rooms as they are kept (docs/chatroom-v0.md §1–§5): each room's name, topic and seats in one file, what
 *  was said in it in another that only grows. Under `<home>/rooms`, the user's alone to read. Who a seat is (which
 *  session, in what state) is not kept here: a seat names its terminal, and whoever shows the room asks the terminals.
 *
 *  A message addressed to a seat has a receipt for it until that seat has dealt with it: `sent` (written), `queued`
 *  (the seat is at work), `delivered` (in its hands), `ended` (it can not be given: the session is over). Dealt with,
 *  the receipt goes: a room shows only what has not arrived. */

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { faceOf, type Face } from "./face.js";
import { ALL, freeHandle, handleFrom, mentions, YOU } from "./names.js";

export const MAX_ROOMS = 100, MAX_SEATS = 16, MAX_NAME = 60, MAX_TOPIC = 300, MAX_TEXT = 16_000;
/** §9: the pinned notes, one text every member reads and writes; a message carries this many files at most. */
export const MAX_NOTES = 20_000, MAX_FILES = 10;
/** §7: the rounds between sessions the user is told of, and how many sessions one session may start. */
export const ROUNDS_LIMIT = 6, MAX_STARTED = 4;

export type Receipt = "sent" | "queued" | "delivered" | "ended";

/** A session as it was when it took its seat: what the room still says of it once its terminal is gone. */
export type SeatWas = {
  readonly agent: string; readonly name: string; readonly cwd: string; readonly model: string | null;
  readonly profile: string | null; readonly color?: string;
};

export type Seat = {
  /** What others write after `@`; never changes, never reused in this room. */
  readonly handle: string;
  readonly kind: "user" | "session";
  /** The terminal behind it, on this node. */
  readonly terminal?: string;
  readonly face: Face | null;
  readonly joinedAt: number;
  /** The seat that brought it in. */
  readonly addedBy: string;
  /** Chatroom Kit's one switch (§6): it may make rooms, bring sessions in, and read the lists that takes. */
  readonly canAdd: boolean;
  /** Started by another session: its switch stays off. */
  readonly byAgent: boolean;
  /** The terminal of the session that started it, when one did. */
  readonly starter?: string;
  /** When it left; its handle and face stay with what it said. */
  readonly left?: number;
  readonly was?: SeatWas;
};

export type Message = {
  readonly seq: number;
  readonly from: string;
  /** The seats it is for, by handle; empty: written into the room, waking nobody. */
  readonly to: readonly string[];
  readonly replyTo?: number;
  readonly text: string;
  readonly at: number;
  /** Files it comes with, by where they are on this node (§3 附件). */
  readonly files?: readonly string[];
};

/** The room's pinned notes (§9): what the members agreed on — conventions, interfaces, what is left to do. */
export type Notes = { readonly text: string; readonly at: number; readonly by: string };

export type Room = {
  readonly id: string;
  readonly name: string;
  readonly topic: string;
  readonly createdAt: number;
  readonly createdBy: string;
  /** Messages are written and not given (§2 暂停). */
  readonly paused: boolean;
  readonly seats: readonly Seat[];
  /** The last message's number; 0 before the first. */
  readonly lastSeq: number;
  /** The last one the user has seen. */
  readonly readSeq: number;
  /** Messages from one session to another, in a row with no word from the user, at which the user is told (§7). */
  readonly roundsLimit: number;
  /** The message up to which the user has seen the rounds go by (`OK`): counted from there again. */
  readonly roundsFrom: number;
  readonly notes: Notes | null;
  /** What has not arrived: message number → handle → where it is. */
  readonly receipts: Readonly<Record<string, Readonly<Record<string, Receipt>>>>;
};

export class RoomError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

const ID = /^[a-z0-9]{6,24}$/;

export class RoomStore {
  private readonly dir: string;
  private rooms: Map<string, Room> | null = null;
  private readonly said = new Map<string, Message[]>();

  constructor(home: string, private readonly now: () => number = Date.now) { this.dir = join(home, "rooms"); }

  // ---- reading

  /** The newest talked-in first. */
  list(): Room[] {
    return [...this.all().values()].sort((a, b) => this.lastAt(b) - this.lastAt(a));
  }

  get(id: string): Room {
    const room = this.all().get(id);
    if (!room) throw new RoomError(404, "没有这个房间");
    return room;
  }

  /** What was said, oldest first: after `after` when given, the last `limit` otherwise. */
  messages(id: string, o: { readonly after?: number; readonly limit?: number } = {}): Message[] {
    this.get(id);
    const all = this.messagesOf(id);
    const from = o.after === undefined ? all : all.filter((m) => m.seq > o.after!);
    return o.limit !== undefined && from.length > o.limit ? (o.after === undefined ? from.slice(-o.limit) : from.slice(0, o.limit)) : from;
  }

  last(id: string): Message | null { return this.messagesOf(id).at(-1) ?? null; }

  /** The rooms a terminal sits in (it has not left), with its seat there. */
  roomsOf(terminal: string): { readonly room: Room; readonly seat: Seat }[] {
    const found: { room: Room; seat: Seat }[] = [];
    for (const room of this.all().values()) {
      const seat = room.seats.find((s) => s.terminal === terminal && s.left === undefined);
      if (seat) found.push({ room, seat });
    }
    return found;
  }

  /** How many after what the user has seen, and whether one of them is for the user. */
  unread(id: string): { readonly count: number; readonly forYou: boolean } {
    const room = this.get(id);
    const fresh = this.messagesOf(id).filter((m) => m.seq > room.readSeq && m.from !== YOU);
    return { count: fresh.length, forYou: fresh.some((m) => m.to.includes(YOU)) };
  }

  // ---- rooms

  /** Whether a terminal's session may bring sessions in: its switch is on in a room it sits in (§6). */
  mayAdd(terminal: string): boolean { return this.roomsOf(terminal).some((s) => s.seat.canAdd); }

  create(o: { readonly name: string; readonly topic?: string; readonly by?: string }): Room {
    if (this.all().size >= MAX_ROOMS) throw new RoomError(409, `房间最多 ${MAX_ROOMS} 个，先删掉不用的`);
    const name = clean(o.name, MAX_NAME);
    if (!name) throw new RoomError(400, "房间要有名字");
    let id = randomBytes(5).toString("hex");
    while (this.all().has(id)) id = randomBytes(5).toString("hex");
    const at = this.now();
    const you: Seat = { handle: YOU, kind: "user", face: null, joinedAt: at, addedBy: YOU, canAdd: true, byAgent: false };
    const room: Room = { id, name, topic: clean(o.topic ?? "", MAX_TOPIC), createdAt: at, createdBy: o.by ?? YOU, paused: false, seats: [you], lastSeq: 0, readSeq: 0, roundsLimit: ROUNDS_LIMIT, roundsFrom: 0, notes: null, receipts: {} };
    this.save(room);
    return room;
  }

  update(id: string, o: { readonly name?: string; readonly topic?: string; readonly paused?: boolean; readonly roundsLimit?: number }): Room {
    const room = this.get(id);
    const name = o.name === undefined ? room.name : clean(o.name, MAX_NAME);
    if (!name) throw new RoomError(400, "房间要有名字");
    const roundsLimit = o.roundsLimit === undefined ? room.roundsLimit : Math.min(Math.max(Math.floor(o.roundsLimit), 2), 100);
    return this.save({ ...room, name, topic: o.topic === undefined ? room.topic : clean(o.topic, MAX_TOPIC), paused: o.paused ?? room.paused, roundsLimit });
  }

  /** How many messages one session sent another since the user last spoke or said `OK` (§7): at the room's limit the
   *  user is told; nothing stops. */
  rounds(id: string): number {
    const room = this.get(id);
    const all = this.messagesOf(id);
    let from = room.roundsFrom;
    for (const m of all) if (m.from === YOU && m.seq > from) from = m.seq;
    return all.filter((m) => m.seq > from && m.to.some((h) => h !== YOU)).length;
  }

  /** The user has seen the rounds go by: counted from here again. */
  roundsSeen(id: string): Room {
    const room = this.get(id);
    return room.roundsFrom === room.lastSeq ? room : this.save({ ...room, roundsFrom: room.lastSeq });
  }

  /** The sessions a terminal's session started that still sit in a room. */
  startedBy(terminal: string): number {
    const found = new Set<string>();
    for (const room of this.all().values()) for (const s of room.seats) if (s.starter === terminal && s.left === undefined && s.terminal) found.add(s.terminal);
    return found.size;
  }

  remove(id: string): void {
    this.get(id);
    this.all().delete(id);
    this.said.delete(id);
    rmSync(join(this.dir, `${id}.json`), { force: true });
    rmSync(join(this.dir, `${id}.jsonl`), { force: true });
  }

  // ---- seats

  /** A session takes a seat. One that sat here before takes its old seat again, name and face as they were. */
  seat(id: string, o: { readonly terminal: string; readonly was: SeatWas; readonly by?: string; readonly canAdd?: boolean; readonly byAgent?: boolean; readonly starter?: string }): Seat {
    const room = this.get(id);
    const old = room.seats.find((s) => s.terminal === o.terminal);
    if (old && old.left === undefined) throw new RoomError(409, `这个会话已经在房间里了（@${old.handle}）`);
    if (room.seats.filter((s) => s.left === undefined).length >= MAX_SEATS) throw new RoomError(409, `一个房间最多 ${MAX_SEATS} 个成员`);
    const byAgent = o.byAgent ?? old?.byAgent ?? false;
    if (old) {
      const { left: _left, ...rest } = old;
      const back: Seat = { ...rest, joinedAt: this.now(), addedBy: o.by ?? YOU, was: o.was, byAgent, canAdd: byAgent ? false : (o.canAdd ?? old.canAdd), ...(o.starter ? { starter: o.starter } : {}) };
      this.save({ ...room, seats: room.seats.map((s) => (s === old ? back : s)) });
      return back;
    }
    const handle = freeHandle(handleFrom(o.was.name, handleFrom(o.was.agent)), new Set(room.seats.map((s) => s.handle)));
    const face = faceOf(handle, room.seats.flatMap((s) => (s.face && s.left === undefined ? [s.face] : [])));
    const seat: Seat = { handle, kind: "session", terminal: o.terminal, face, joinedAt: this.now(), addedBy: o.by ?? YOU, canAdd: byAgent ? false : (o.canAdd ?? false), byAgent, was: o.was, ...(o.starter ? { starter: o.starter } : {}) };
    this.save({ ...room, seats: [...room.seats, seat] });
    return seat;
  }

  /** A seat leaves. What was on its way to it is dropped: nobody is there to take it. */
  unseat(id: string, handle: string): void {
    const room = this.get(id);
    const seat = this.seatOf(room, handle);
    if (seat.kind === "user") throw new RoomError(400, "你自己的席位不能移出");
    this.save({ ...room, seats: room.seats.map((s) => (s === seat ? { ...s, left: this.now() } : s)), receipts: without(room.receipts, handle) });
  }

  setCanAdd(id: string, handle: string, on: boolean): Seat {
    const room = this.get(id);
    const seat = this.seatOf(room, handle);
    if (seat.kind === "user") throw new RoomError(400, "你自己一直可以");
    if (on && seat.byAgent) throw new RoomError(403, "被别的会话拉起来的会话不能再拉会话");
    const next = { ...seat, canAdd: on };
    this.save({ ...room, seats: room.seats.map((s) => (s === seat ? next : s)) });
    return next;
  }

  /** What a seat is called by its session now is kept for when the terminal is gone. */
  remember(id: string, handle: string, was: SeatWas): void {
    const room = this.all().get(id);
    const seat = room?.seats.find((s) => s.handle === handle);
    if (!room || !seat || JSON.stringify(seat.was) === JSON.stringify(was)) return;
    this.save({ ...room, seats: room.seats.map((s) => (s === seat ? { ...s, was } : s)) });
  }

  // ---- messages

  /** A seat says something. Who it is for: the `@names` in the text and those in `to`, each a seat of this room that
   *  has not left; the sender itself and names nobody has are left out. `@all` is the user's alone (§4). */
  /** A member writes the pinned notes: the whole text, in place of what was there. */
  setNotes(id: string, by: string, text: string): Room {
    const room = this.get(id);
    const seat = this.seatOf(room, by);
    if (seat.left !== undefined) throw new RoomError(403, "这个席位已经离开房间");
    const clean = text.replace(/\r\n?/g, "\n").trimEnd();
    if (clean.length > MAX_NOTES) throw new RoomError(400, `置顶笔记太长（最多 ${MAX_NOTES} 字）`);
    return this.save({ ...room, notes: clean ? { text: clean, at: this.now(), by: seat.handle } : null });
  }

  post(id: string, o: { readonly from: string; readonly text: string; readonly to?: readonly string[]; readonly replyTo?: number; readonly files?: readonly string[] }): Message {
    const room = this.get(id);
    const from = this.seatOf(room, o.from);
    if (from.left !== undefined) throw new RoomError(403, "这个席位已经离开房间");
    const text = o.text.replace(/\r\n?/g, "\n").trim();
    if (!text) throw new RoomError(400, "消息是空的");
    if (text.length > MAX_TEXT) throw new RoomError(400, `消息太长（最多 ${MAX_TEXT} 字）`);
    if (o.replyTo !== undefined && !(Number.isInteger(o.replyTo) && o.replyTo >= 1 && o.replyTo <= room.lastSeq)) throw new RoomError(400, `没有 #${o.replyTo} 这条消息`);
    const files = [...new Set((o.files ?? []).map((f) => f.trim()).filter(Boolean))];
    if (files.length > MAX_FILES) throw new RoomError(400, `一条消息最多带 ${MAX_FILES} 个文件`);
    if (files.some((f) => !f.startsWith("/") || f.length > 4096 || /[\n\r\0]/.test(f))) throw new RoomError(400, "文件要写它在这个节点上的完整路径");
    const named = [...mentions(text), ...(o.to ?? []).map((n) => n.replace(/^@/, "").toLowerCase())];
    const here = room.seats.filter((s) => s.left === undefined && s.handle !== from.handle);
    if (named.includes(ALL) && from.kind !== "user") throw new RoomError(403, "@all 只有用户能用，请逐个 @ 需要的成员");
    const to = named.includes(ALL)
      ? here.filter((s) => s.kind === "session").map((s) => s.handle)
      : here.filter((s) => named.includes(s.handle)).map((s) => s.handle);
    // The file of messages is written first: after a crash between the two it may be one ahead of the room's count.
    const message: Message = { seq: Math.max(room.lastSeq, this.messagesOf(id).at(-1)?.seq ?? 0) + 1, from: from.handle, to, ...(o.replyTo === undefined ? {} : { replyTo: o.replyTo }), text, at: this.now(), ...(files.length ? { files } : {}) };
    const waiting = to.filter((h) => h !== YOU);
    this.messagesOf(id).push(message);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(this.dir, `${id}.jsonl`), `${JSON.stringify(message)}\n`, { mode: 0o600 });
    this.save({
      ...room, lastSeq: message.seq,
      // What the user says, the user has seen.
      readSeq: from.kind === "user" ? message.seq : room.readSeq,
      receipts: waiting.length ? { ...room.receipts, [message.seq]: Object.fromEntries(waiting.map((h) => [h, "sent" as Receipt])) } : room.receipts,
    });
    return message;
  }

  /** The user has seen up to `seq`. */
  read(id: string, seq: number): Room {
    const room = this.get(id);
    const upTo = Math.min(Math.max(Math.floor(seq), room.readSeq), room.lastSeq);
    return upTo === room.readSeq ? room : this.save({ ...room, readSeq: upTo });
  }

  /** Where a message is on its way to a seat; null: the seat has dealt with it. */
  setReceipt(id: string, seq: number, handle: string, state: Receipt | null): void {
    const room = this.get(id);
    const of = room.receipts[seq];
    if (!of || !(handle in of) || of[handle] === state) return;
    const { [handle]: _was, ...others } = of;
    const next = state ? { ...others, [handle]: state } : others;
    const { [seq]: _old, ...rest } = room.receipts;
    this.save({ ...room, receipts: Object.keys(next).length ? { ...rest, [seq]: next } : rest });
  }

  // ---- inside

  private seatOf(room: Room, handle: string): Seat {
    const seat = room.seats.find((s) => s.handle === handle.replace(/^@/, "").toLowerCase());
    if (!seat) throw new RoomError(404, `房间里没有 @${handle}`);
    return seat;
  }

  private lastAt(room: Room): number { return this.messagesOf(room.id).at(-1)?.at ?? room.createdAt; }

  private all(): Map<string, Room> {
    if (this.rooms) return this.rooms;
    const rooms = new Map<string, Room>();
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { /* none yet */ }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const room = roomFrom(JSON.parse(readFileSync(join(this.dir, name), "utf8")));
        if (room && `${room.id}.json` === name) rooms.set(room.id, room);
      } catch { /* a file that is not a room is left alone */ }
    }
    return (this.rooms = rooms);
  }

  private messagesOf(id: string): Message[] {
    const have = this.said.get(id);
    if (have) return have;
    const list: Message[] = [];
    let text = "";
    try { text = readFileSync(join(this.dir, `${id}.jsonl`), "utf8"); } catch { /* nothing said yet */ }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const m = messageFrom(JSON.parse(line)); if (m) list.push(m); } catch { /* a torn last line */ }
    }
    this.said.set(id, list);
    return list;
  }

  private save(room: Room): Room {
    this.all().set(room.id, room);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${room.id}.json`), tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(room, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    return room;
  }
}

function clean(text: string, max: number): string { return [...text.replace(/\s+/g, " ").trim()].slice(0, max).join(""); }

function without(receipts: Room["receipts"], handle: string): Room["receipts"] {
  const next: Record<string, Record<string, Receipt>> = {};
  for (const [seq, of] of Object.entries(receipts)) {
    const { [handle]: _gone, ...rest } = of;
    if (Object.keys(rest).length) next[seq] = rest;
  }
  return next;
}

const RECEIPTS = new Set<string>(["sent", "queued", "delivered", "ended"]);
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function seatFrom(v: unknown): Seat | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!str(o.handle) || (o.kind !== "user" && o.kind !== "session") || !num(o.joinedAt)) return null;
  const f = o.face as { rows?: unknown; color?: unknown } | null | undefined;
  const face = f && Array.isArray(f.rows) && f.rows.length === 5 && f.rows.every((r) => str(r) && /^[#.]{5}$/.test(r)) && num(f.color) ? { rows: f.rows as string[], color: Math.abs(Math.floor(f.color)) % 10 } : null;
  const w = o.was as Record<string, unknown> | undefined;
  const was = w && str(w.agent) && str(w.name) && str(w.cwd)
    ? { agent: w.agent, name: w.name, cwd: w.cwd, model: str(w.model) ? w.model : null, profile: str(w.profile) ? w.profile : null, ...(str(w.color) ? { color: w.color } : {}) } : null;
  return {
    handle: o.handle, kind: o.kind, ...(str(o.terminal) ? { terminal: o.terminal } : {}), face, joinedAt: o.joinedAt,
    addedBy: str(o.addedBy) ? o.addedBy : YOU, canAdd: o.canAdd === true, byAgent: o.byAgent === true,
    ...(num(o.left) ? { left: o.left } : {}), ...(was ? { was } : {}), ...(str(o.starter) ? { starter: o.starter } : {}),
  };
}

function roomFrom(v: unknown): Room | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!str(o.id) || !ID.test(o.id) || !str(o.name) || !Array.isArray(o.seats)) return null;
  const seats = o.seats.flatMap((s) => { const seat = seatFrom(s); return seat ? [seat] : []; });
  if (!seats.some((s) => s.kind === "user")) return null;
  const n = o.notes as Record<string, unknown> | null | undefined;
  const receipts: Record<string, Record<string, Receipt>> = {};
  for (const [seq, of] of Object.entries((o.receipts ?? {}) as Record<string, unknown>)) {
    if (!/^\d+$/.test(seq) || !of || typeof of !== "object") continue;
    const kept = Object.fromEntries(Object.entries(of as Record<string, unknown>).filter(([, r]) => str(r) && RECEIPTS.has(r))) as Record<string, Receipt>;
    if (Object.keys(kept).length) receipts[seq] = kept;
  }
  return {
    id: o.id, name: o.name, topic: str(o.topic) ? o.topic : "", createdAt: num(o.createdAt) ? o.createdAt : 0, createdBy: str(o.createdBy) ? o.createdBy : YOU,
    paused: o.paused === true, seats, lastSeq: num(o.lastSeq) ? o.lastSeq : 0, readSeq: num(o.readSeq) ? o.readSeq : 0,
    roundsLimit: num(o.roundsLimit) ? o.roundsLimit : ROUNDS_LIMIT, roundsFrom: num(o.roundsFrom) ? o.roundsFrom : 0, receipts,
    notes: n && str(n.text) && num(n.at) ? { text: n.text, at: n.at, by: str(n.by) ? n.by : YOU } : null,
  };
}

function messageFrom(v: unknown): Message | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!num(o.seq) || !str(o.from) || !str(o.text) || !num(o.at)) return null;
  return { seq: o.seq, from: o.from, to: Array.isArray(o.to) ? o.to.filter(str) : [], ...(num(o.replyTo) ? { replyTo: o.replyTo } : {}), text: o.text, at: o.at, ...(Array.isArray(o.files) && o.files.some(str) ? { files: o.files.filter(str) } : {}) };
}
