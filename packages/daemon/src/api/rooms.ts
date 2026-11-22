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
import type { SeatCard, SeatLive, SeatState } from "../rooms/state.js";

export type { SeatCard, SeatState } from "../rooms/state.js";
import type { TerminalHost, TerminalInfo } from "../terminals/host.js";
import { parseBody, versionedJson, type ApiDeps } from "./shared.js";

export type SeatView = {
  readonly handle: string; readonly kind: "user" | "session"; readonly terminal: string | null;
  readonly face: Seat["face"]; readonly joinedAt: number; readonly addedBy: string;
  readonly canAdd: boolean; readonly byAgent: boolean; readonly left: number | null;
  readonly state: SeatState | null; readonly card: SeatCard | null;
  /** Its session has the Chatroom Kit (§6): it can speak in the room and be woken. False for one started before
   *  there was a Kit, until it is resumed; null for the user. */
  readonly kit: boolean | null;
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

/** A terminal as a seat is now, for the rooms' own work (delivery, the Kit). */
export function seatLive(info: TerminalInfo | null): SeatLive | null {
  return info ? { state: seatState(info), card: { ...wasOf(info), mode: info.modeNow ?? info.mode, node: null } } : null;
}

export function seatView(seat: Seat, host: TerminalHost | undefined, kit?: (terminal: string) => boolean): SeatView {
  const info = seat.terminal ? host?.get(seat.terminal) ?? null : null;
  const base = { handle: seat.handle, kind: seat.kind, terminal: seat.terminal ?? null, face: seat.face, joinedAt: seat.joinedAt, addedBy: seat.addedBy, canAdd: seat.canAdd, byAgent: seat.byAgent, left: seat.left ?? null };
  if (seat.kind === "user") return { ...base, state: null, card: null, kit: null };
  const was = info ? wasOf(info) : seat.was ?? null;
  return { ...base, state: seatState(info), card: was ? { ...was, mode: info ? info.modeNow ?? info.mode : null, node: null } : null, kit: seat.terminal && info && kit ? kit(seat.terminal) : false };
}

const Create = z.object({ name: z.string().max(MAX_NAME * 4), topic: z.string().max(MAX_TOPIC * 4).optional(), terminals: z.array(z.string().min(1).max(100)).max(16).optional() }).strict();
const Update = z.object({ name: z.string().max(MAX_NAME * 4).optional(), topic: z.string().max(MAX_TOPIC * 4).optional(), paused: z.boolean().optional() }).strict();
const AddSeat = z.object({ terminal: z.string().min(1).max(100), canAdd: z.boolean().optional() }).strict();
const SetSeat = z.object({ canAdd: z.boolean() }).strict();
const Say = z.object({ text: z.string().max(MAX_TEXT * 2), replyTo: z.number().int().positive().optional() }).strict();
const Read = z.object({ seq: z.number().int().nonnegative() }).strict();
/** What a terminal's own programs ask (the Kit's tool server, the agent's waiting program). */
const Asked = z.discriminatedUnion("op", [
  z.object({ op: z.literal("tools") }),
  z.object({ op: z.literal("watch"), version: z.string().max(2000) }),
  z.object({ op: z.literal("call"), name: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()).optional() }),
  z.object({ op: z.literal("wait") }),
]);
/** How long a `watch` is held, and how often it looks. */
const WATCH_MS = 5 * 60_000, WATCH_STEP_MS = 1500;

/** How many messages a room is read with when no `after` is given. */
const PAGE = 200;

export function mountRooms(app: Hono, deps: ApiDeps): void {
  const rooms = deps.rooms;
  if (!rooms) return;
  const host = (): TerminalHost | undefined => deps.terminals?.host;
  const hasKit = (terminal: string): boolean => deps.roomKit?.has(terminal) ?? false;

  const refused = (c: { json: (body: unknown, status: 400 | 403 | 404 | 409) => Response }, err: unknown): Response => {
    if (err instanceof RoomError) return c.json({ error: err.message }, err.status);
    throw err;
  };

  const seatsOf = (room: Room): SeatView[] => room.seats.map((seat) => {
    const view = seatView(seat, host(), hasKit);
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
      return c.json({ seat: seatView(made, host(), hasKit) }, 201);
    } catch (err) { return refused(c, err); }
  });

  app.patch("/rooms/:id/seats/:handle", async (c) => {
    const body = await parseBody(c, SetSeat);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try { return c.json({ seat: seatView(rooms.setCanAdd(c.req.param("id"), c.req.param("handle"), body.data.canAdd), host(), hasKit) }); } catch (err) { return refused(c, err); }
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

  // A terminal's own programs: the Kit's tool server (terminals/roomKitClient.ts) and the agent's waiting program
  // (hookClient.ts `wait`). Not on the remote allowlist; let through the local token check like the hook, and proven
  // the same way: by the terminal's own hook token. Which session asks is that terminal's — it never says so itself.
  app.post("/terminals/room", async (c) => {
    const kit = deps.roomKit, delivery = deps.roomDelivery, terminals = host();
    const id = c.req.header("x-agentswitch-terminal") ?? "";
    const token = /^Bearer\s+(\S+)\s*$/.exec(c.req.header("authorization") ?? "")?.[1];
    const body = await parseBody(c, Asked);
    if (!token || !body.ok || !kit || !delivery || !terminals) return c.json({ error: "bad room call" }, 400);
    try { terminals.profileOf(id, token); } catch { return c.json({ error: "unknown terminal or hook token" }, 403); }
    const asked = body.data;
    if (asked.op === "wait") return c.json(await delivery.wait(id, c.req.raw.signal));
    kit.met(id);
    if (asked.op === "tools") return c.json({ tools: kit.tools(id), version: kit.version(id) });
    if (asked.op === "call") {
      const answer = kit.call(id, asked.name, asked.args ?? {});
      return c.json(answer);
    }
    // Held until the tools this terminal has are others than the ones it knows of, or a while has passed.
    const until = Date.now() + (deps.roomWatchMs ?? WATCH_MS);
    while (kit.version(id) === asked.version && Date.now() < until && !c.req.raw.signal.aborted) await new Promise((r) => setTimeout(r, Math.min(WATCH_STEP_MS, deps.roomWatchMs ?? WATCH_STEP_MS)));
    return c.json({ version: kit.version(id) });
  });

  app.post("/rooms/:id/read", async (c) => {
    const body = await parseBody(c, Read);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try { const room = rooms.read(c.req.param("id"), body.data.seq); return c.json({ readSeq: room.readSeq }); } catch (err) { return refused(c, err); }
  });
}
