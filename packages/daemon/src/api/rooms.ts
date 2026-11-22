/** Chat Room for the screens (docs/chatroom-v0.md §2, §10): the rooms, a room with its seats and what was said, the
 *  user making rooms, seating sessions that run on this node, and speaking. Who a seat is now — its agent, model,
 *  profile, folder, and its state in the room's words (§6.1) — is read from its terminal each time; a seat whose
 *  terminal is gone shows as it was when it sat down, `exited`.
 *
 *  The screens ask again and again: every list is under a version of its content (`versionedJson`), so an unchanged
 *  room costs nothing. */

import type { Hono } from "hono";
import { z } from "zod";
import { MAX_NAME, MAX_TEXT, MAX_TOPIC, RoomError, type Message, type Room, type Seat, type SeatWas } from "../rooms/store.js";
import { YOU } from "../rooms/names.js";
import type { TerminalHost, TerminalInfo } from "../terminals/host.js";
import { parseBody, versionedJson, type ApiDeps } from "./shared.js";

/** A seat's state in the room (§6.1). The first four are the terminal's own; the rest say what is wrong with it. */
export type SeatState = "busy" | "waiting" | "idle" | "exited" | "reconnecting" | "limited" | "signed_out" | "blocked" | "error" | "offline";

/** A seat's card (§1 名片): no account, no address. */
export type SeatCard = SeatWas & {
  /** How it asks, in its agent's own word. */
  readonly mode: string | null;
  /** The node it runs on; null: this one. */
  readonly node: string | null;
};

export type SeatView = {
  readonly handle: string; readonly kind: "user" | "session"; readonly terminal: string | null;
  readonly face: Seat["face"]; readonly joinedAt: number; readonly addedBy: string;
  readonly canAdd: boolean; readonly byAgent: boolean; readonly left: number | null;
  readonly state: SeatState | null; readonly card: SeatCard | null;
};

const TROUBLE_NOTICE = "trouble";

/** A terminal's state in the room's words. What its screen says of reaching its service again comes first: it is at
 *  work or resting all the same, and can not answer. */
export function seatState(info: TerminalInfo | null): SeatState {
  if (!info || info.status === "exited") return "exited";
  if (info.notices.some((n) => n.id === TROUBLE_NOTICE)) return "reconnecting";
  return info.status === "working" ? "busy" : info.status;
}

function wasOf(info: TerminalInfo): SeatWas {
  return { agent: info.harness, name: info.name, cwd: info.workdir, model: info.modelNow ?? info.model, profile: info.profile?.name ?? null, ...(info.profile?.color ? { color: info.profile.color } : {}) };
}

export function seatView(seat: Seat, host: TerminalHost | undefined): SeatView {
  const info = seat.terminal ? host?.get(seat.terminal) ?? null : null;
  const base = { handle: seat.handle, kind: seat.kind, terminal: seat.terminal ?? null, face: seat.face, joinedAt: seat.joinedAt, addedBy: seat.addedBy, canAdd: seat.canAdd, byAgent: seat.byAgent, left: seat.left ?? null };
  if (seat.kind === "user") return { ...base, state: null, card: null };
  const was = info ? wasOf(info) : seat.was ?? null;
  return { ...base, state: seatState(info), card: was ? { ...was, mode: info ? info.modeNow ?? info.mode : null, node: null } : null };
}

const Create = z.object({ name: z.string().max(MAX_NAME * 4), topic: z.string().max(MAX_TOPIC * 4).optional(), terminals: z.array(z.string().min(1).max(100)).max(16).optional() }).strict();
const Update = z.object({ name: z.string().max(MAX_NAME * 4).optional(), topic: z.string().max(MAX_TOPIC * 4).optional(), paused: z.boolean().optional() }).strict();
const AddSeat = z.object({ terminal: z.string().min(1).max(100), canAdd: z.boolean().optional() }).strict();
const SetSeat = z.object({ canAdd: z.boolean() }).strict();
const Say = z.object({ text: z.string().max(MAX_TEXT * 2), replyTo: z.number().int().positive().optional() }).strict();
const Read = z.object({ seq: z.number().int().nonnegative() }).strict();

/** How many messages a room is read with when no `after` is given. */
const PAGE = 200;

export function mountRooms(app: Hono, deps: ApiDeps): void {
  const rooms = deps.rooms;
  if (!rooms) return;
  const host = (): TerminalHost | undefined => deps.terminals?.host;

  const refused = (c: { json: (body: unknown, status: 400 | 403 | 404 | 409) => Response }, err: unknown): Response => {
    if (err instanceof RoomError) return c.json({ error: err.message }, err.status);
    throw err;
  };

  const seatsOf = (room: Room): SeatView[] => room.seats.map((seat) => {
    const view = seatView(seat, host());
    // What it is called now is kept for the day its terminal is gone.
    if (seat.terminal && view.card && seat.left === undefined && host()?.get(seat.terminal)) {
      const { mode: _mode, node: _node, ...was } = view.card;
      rooms.remember(room.id, seat.handle, was);
    }
    return view;
  });

  const summary = (room: Room) => {
    const last = rooms.last(room.id);
    const unread = rooms.unread(room.id);
    const seats = room.seats.filter((s) => s.left === undefined);
    return {
      id: room.id, name: room.name, topic: room.topic, paused: room.paused, createdAt: room.createdAt,
      members: seats.length,
      faces: seats.filter((s) => s.kind === "session").slice(0, 4).map((s) => ({ handle: s.handle, face: s.face })),
      last: last ? { seq: last.seq, from: last.from, text: last.text.slice(0, 200), at: last.at } : null,
      unread: unread.count, forYou: unread.forYou,
    };
  };

  const whole = (room: Room, messages: readonly Message[]) => ({
    room: { id: room.id, name: room.name, topic: room.topic, paused: room.paused, createdAt: room.createdAt, createdBy: room.createdBy, lastSeq: room.lastSeq, readSeq: room.readSeq },
    seats: seatsOf(room), messages, receipts: room.receipts,
  });

  const seat = (roomId: string, terminal: string, canAdd: boolean | undefined): Seat => {
    const info = host()?.get(terminal);
    if (!info) throw new RoomError(404, "这个节点上没有这个会话");
    if (info.status === "exited") throw new RoomError(409, "这个会话已经结束，恢复之后再拉进来");
    return rooms.seat(roomId, { terminal, was: wasOf(info), ...(canAdd === undefined ? {} : { canAdd }) });
  };

  app.get("/rooms", (c) => versionedJson(c, { rooms: rooms.list().map(summary) }));

  app.post("/rooms", async (c) => {
    const body = await parseBody(c, Create);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const room = rooms.create({ name: body.data.name, ...(body.data.topic === undefined ? {} : { topic: body.data.topic }) });
      const problems: string[] = [];
      for (const terminal of body.data.terminals ?? []) {
        try { seat(room.id, terminal, undefined); } catch (err) { if (err instanceof RoomError) problems.push(err.message); else throw err; }
      }
      return c.json({ ...whole(rooms.get(room.id), []), problems }, 201);
    } catch (err) { return refused(c, err); }
  });

  app.get("/rooms/:id", (c) => {
    try {
      const room = rooms.get(c.req.param("id"));
      const after = Number(c.req.query("after"));
      const messages = Number.isInteger(after) && after >= 0 ? rooms.messages(room.id, { after, limit: PAGE * 5 }) : rooms.messages(room.id, { limit: PAGE });
      return versionedJson(c, whole(room, messages));
    } catch (err) { return refused(c, err); }
  });

  app.patch("/rooms/:id", async (c) => {
    const body = await parseBody(c, Update);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const o = body.data;
      const room = rooms.update(c.req.param("id"), { ...(o.name === undefined ? {} : { name: o.name }), ...(o.topic === undefined ? {} : { topic: o.topic }), ...(o.paused === undefined ? {} : { paused: o.paused }) });
      deps.roomsChanged?.(room.id);
      return c.json({ room: summary(room) });
    } catch (err) { return refused(c, err); }
  });

  app.delete("/rooms/:id", (c) => {
    try { rooms.remove(c.req.param("id")); return c.json({ ok: true }); } catch (err) { return refused(c, err); }
  });

  app.post("/rooms/:id/seats", async (c) => {
    const body = await parseBody(c, AddSeat);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const made = seat(c.req.param("id"), body.data.terminal, body.data.canAdd);
      deps.roomsChanged?.(c.req.param("id"));
      return c.json({ seat: seatView(made, host()) }, 201);
    } catch (err) { return refused(c, err); }
  });

  app.patch("/rooms/:id/seats/:handle", async (c) => {
    const body = await parseBody(c, SetSeat);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try { return c.json({ seat: seatView(rooms.setCanAdd(c.req.param("id"), c.req.param("handle"), body.data.canAdd), host()) }); } catch (err) { return refused(c, err); }
  });

  app.delete("/rooms/:id/seats/:handle", (c) => {
    try { rooms.unseat(c.req.param("id"), c.req.param("handle")); return c.json({ ok: true }); } catch (err) { return refused(c, err); }
  });

  // The user speaks. Only the user's words come in here: a session speaks through its own channel (Chatroom Kit).
  app.post("/rooms/:id/messages", async (c) => {
    const body = await parseBody(c, Say);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const id = c.req.param("id");
      const message = rooms.post(id, { from: YOU, text: body.data.text, ...(body.data.replyTo === undefined ? {} : { replyTo: body.data.replyTo }) });
      deps.roomsChanged?.(id);
      return c.json({ message, receipts: rooms.get(id).receipts[message.seq] ?? {} }, 201);
    } catch (err) { return refused(c, err); }
  });

  app.post("/rooms/:id/read", async (c) => {
    const body = await parseBody(c, Read);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try { const room = rooms.read(c.req.param("id"), body.data.seq); return c.json({ readSeq: room.readSeq }); } catch (err) { return refused(c, err); }
  });
}
