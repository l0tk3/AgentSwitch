/** Chat Room for the screens (docs/chatroom-v0.md §2, §10): the rooms, a room with its seats and what was said, the
 *  user making rooms, seating sessions that run on this node, and speaking. Who a seat is now — its agent, model,
 *  profile, folder, and its state in the room's words (§6.1) — is read from its terminal each time; a seat whose
 *  terminal is gone shows as it was when it sat down, `exited`.
 *
 *  The screens ask again and again: every list is under a version of its content (`versionedJson`), so an unchanged
 *  room costs nothing. */

import { existsSync, readFileSync } from "node:fs";
import type { Hono } from "hono";
import { z } from "zod";
import { contentType } from "../files/names.js";
import { MAX_NAME, MAX_PUT, MAX_TEXT, MAX_TOPIC, RoomError, type Message, type Room, type Seat, type SeatSession, type SeatStats, type SeatWas } from "../rooms/store.js";
import type { Running } from "../rooms/follow.js";
import { resumeEnded, resumeSeat } from "../rooms/kit.js";
import { YOU } from "../rooms/names.js";
import type { SeatCard, SeatLive, SeatState } from "../rooms/state.js";

export type { SeatCard, SeatState } from "../rooms/state.js";
import type { TerminalHost, TerminalInfo } from "../terminals/host.js";
import { roomOrg } from "./roomOrg.js";
import { parseBody, versionedJson, type ApiDeps } from "./shared.js";

export type SeatView = {
  readonly handle: string; readonly kind: "user" | "session"; readonly terminal: string | null;
  readonly face: Seat["face"]; readonly joinedAt: number; readonly addedBy: string;
  readonly canAdd: boolean; readonly byAgent: boolean; readonly left: number | null;
  /** Muted by an admin or the user (§6.2): it reads and works but may not post or write the notes. */
  readonly muted: boolean; readonly mutedBy: string | null;
  readonly state: SeatState | null; readonly card: SeatCard | null;
  /** How many of the room's messages it has not read yet (said since it sat down, by others); null for the user. */
  readonly unread: number | null;
  /** What its own screen asks now, when it shows a list to choose from (Claude Code's "trust this folder?" at its
   *  start): the question and the rows. Answered with `POST /terminals/:id/choices`, or for all at once with
   *  `POST /rooms/:id/trust`. Null: nothing. */
  readonly asks: { readonly title: string; readonly options: readonly string[]; readonly selected: number; readonly trust: boolean } | null;
  /** What the seat has cost so far as the room counts it (store.ts `SeatStats`); null for the user. */
  readonly stats: SeatStats | null;
  /** Its session has the Chatroom Kit (§6): it can speak in the room and be woken. False for one started before
   *  there was a Kit, until it is resumed; null for the user. */
  readonly kit: boolean | null;
};

const TROUBLE_NOTICE = "trouble";
/** Agents that list their tools once, at their start. */
const LISTS_ONCE: ReadonlySet<string> = new Set(["codex", "opencode"]);

/** A terminal's state in the room's words. What its screen says of reaching its service again comes first: it is at
 *  work or resting all the same, and can not answer. */
export function seatState(info: TerminalInfo | null): SeatState {
  if (!info || info.status === "exited") return "exited";
  if (info.notices.some((n) => n.id === TROUBLE_NOTICE)) return "reconnecting";
  // Its own screen asks something (a list to choose from: "trust this folder?" at its start): it needs the user.
  if (info.choices && info.status !== "working") return "waiting";
  return info.status === "working" ? "busy" : info.status;
}

function wasOf(info: TerminalInfo): SeatWas {
  return { agent: info.harness, name: info.name, cwd: info.workdir, model: info.modelNow ?? info.model, profile: info.profile?.name ?? null, ...(info.profile?.color ? { color: info.profile.color } : {}) };
}

/** The row that says yes to "do you trust this folder?", when that is what a terminal's screen asks; null: it asks
 *  something else, or nothing. Only this one question is ever answered for several sessions at once. */
export function trustYes(info: TerminalInfo): { readonly pick: number; readonly label: string } | null {
  const asked = info.choices;
  if (!asked || !/\btrust\b/i.test(`${asked.title} ${asked.text ?? ""}`)) return null;
  const pick = asked.options.findIndex((o) => /^yes\b/i.test(o.label.trim()));
  return pick < 0 ? null : { pick, label: asked.options[pick]!.label };
}

/** The agent's session behind a terminal, as a seat keeps it (§6.2); null until the agent has said its id. */
export function sessionOf(info: TerminalInfo): SeatSession | null {
  if (!info.agentSessionId) return null;
  // As it is now, where that is known: the model it said it is on last (a `/model` since its start), and bypass when
  // it has gone there. Its other modes are the agent's own words, which a start does not take: the one it began in.
  const model = info.modelNow ?? info.model, mode = /bypass/i.test(info.modeNow ?? "") ? "bypass" : info.mode;
  return { id: info.agentSessionId, cwd: info.cwd, mode, ...(model ? { model } : {}), ...(info.effort ? { effort: info.effort } : {}), ...(info.profile?.id ? { profile: info.profile.id } : {}) };
}

/** A terminal as the rooms follow it (rooms/follow.ts). */
export function runningOf(info: TerminalInfo): Running {
  const session = sessionOf(info);
  return { id: info.id, exited: info.status === "exited", session: info.agentSessionId, resumedFrom: info.resumedFrom, forked: info.forked, cwd: info.cwd, was: wasOf(info), ...(session?.mode ? { mode: session.mode } : {}), ...(session?.model ? { model: session.model } : {}), ...(session?.effort ? { effort: session.effort } : {}), ...(session?.profile ? { profile: session.profile } : {}) };
}

/** A terminal as a seat is now, for the rooms' own work (delivery, the Kit). */
export function seatLive(info: TerminalInfo | null): SeatLive | null {
  return info ? { state: seatState(info), card: { ...wasOf(info), mode: info.modeNow ?? info.mode, node: null } } : null;
}

export function seatView(seat: Seat, host: TerminalHost | undefined, kit?: (terminal: string) => boolean, stats?: SeatStats, unread = 0): SeatView {
  const info = seat.terminal ? host?.get(seat.terminal) ?? null : null;
  const base = { handle: seat.handle, kind: seat.kind, terminal: seat.terminal ?? null, face: seat.face, joinedAt: seat.joinedAt, addedBy: seat.addedBy, canAdd: seat.canAdd, byAgent: seat.byAgent, left: seat.left ?? null, muted: seat.muted !== undefined, mutedBy: seat.muted?.by ?? null };
  if (seat.kind === "user") return { ...base, state: null, card: null, kit: null, stats: null, asks: null, unread: null };
  const was = info ? wasOf(info) : seat.was ?? null;
  return { ...base, state: seatState(info), card: was ? { ...was, mode: info ? info.modeNow ?? info.mode : null, node: null } : null, kit: seat.terminal && info && kit ? kit(seat.terminal) : false, stats: stats ?? { wakes: 0, chars: 0, posts: 0, calls: 0 }, unread,
    asks: info?.choices && info.status !== "exited" ? { title: info.choices.title, options: info.choices.options.map((o) => o.label), selected: info.choices.selected, trust: trustYes(info) !== null } : null };
}

const Create = z.object({ name: z.string().max(MAX_NAME * 4), topic: z.string().max(MAX_TOPIC * 4).optional(), terminals: z.array(z.string().min(1).max(100)).max(16).optional() }).strict();
const Update = z.object({ name: z.string().max(MAX_NAME * 4).optional(), topic: z.string().max(MAX_TOPIC * 4).optional(), paused: z.boolean().optional(), roundsLimit: z.number().int().min(2).max(100).optional() }).strict();
const AddSeat = z.object({ terminal: z.string().min(1).max(100), canAdd: z.boolean().optional() }).strict();
const SetSeat = z.object({ canAdd: z.boolean().optional(), muted: z.boolean().optional(), name: z.string().min(1).max(100).optional() }).strict()
  .refine((o) => o.canAdd !== undefined || o.muted !== undefined || o.name !== undefined, "nothing to change");
const Say = z.object({ text: z.string().max(MAX_TEXT * 2), replyTo: z.number().int().positive().optional(), files: z.array(z.string().min(1).max(4096)).max(10).optional(), expects: z.enum(["none", "answer"]).optional() }).strict();
const WriteNotes = z.object({ text: z.string().max(100_000) }).strict();
const Read = z.object({ seq: z.number().int().nonnegative() }).strict();
/** What a terminal's own programs ask (the Kit's tool server, the agent's waiting program). */
const Asked = z.discriminatedUnion("op", [
  z.object({ op: z.literal("tools") }),
  z.object({ op: z.literal("watch"), version: z.string().max(2000) }),
  z.object({ op: z.literal("call"), name: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()).optional() }),
  z.object({ op: z.literal("wait") }),
]);
/** How long a `watch` is held, and how often it looks. */
const WATCH_MS = 3 * 60_000, WATCH_STEP_MS = 1500;

/** How many messages a room is read with when no `after` is given. */
const PAGE = 200;

export function mountRooms(app: Hono, deps: ApiDeps): void {
  const rooms = deps.rooms;
  if (!rooms) return;
  const host = (): TerminalHost | undefined => deps.terminals?.host;
  const hasKit = (terminal: string): boolean => deps.roomKit?.has(terminal) ?? false;

  const refused = (c: { json: (body: unknown, status: 400 | 403 | 404 | 409 | 503) => Response }, err: unknown): Response => {
    if (err instanceof RoomError) return c.json({ error: err.message }, err.status);
    throw err;
  };

  const seatsOf = (room: Room): SeatView[] => room.seats.map((seat) => {
    const view = seatView(seat, host(), hasKit, room.stats[seat.handle], seat.kind === "session" && seat.left === undefined ? rooms.unreadOf(room.id, seat.handle).length : 0);
    // What it is called now is kept for the day its terminal is gone.
    if (seat.terminal && view.card && seat.left === undefined && host()?.get(seat.terminal)) {
      const { mode: _mode, node: _node, ...was } = view.card;
      rooms.remember(room.id, seat.handle, was);
    }
    return view;
  });

  const roundsOf = (room: Room): number | null => { const n = rooms.rounds(room.id); return n >= room.roundsLimit ? n : null; };

  const summary = (room: Room) => {
    const last = rooms.last(room.id);
    const unread = rooms.unread(room.id);
    const seats = room.seats.filter((s) => s.left === undefined);
    return {
      id: room.id, name: room.name, topic: room.topic, paused: room.paused, createdAt: room.createdAt,
      members: seats.length,
      // The sessions seated here: a session sits in one room at a time, so a screen that offers sessions to seat
      // shows these as taken.
      terminals: seats.flatMap((s) => (s.terminal ? [s.terminal] : [])),
      faces: seats.filter((s) => s.kind === "session").slice(0, 4).map((s) => ({ handle: s.handle, face: s.face })),
      last: last ? { seq: last.seq, from: last.from, text: last.text.slice(0, 200), at: last.at } : null,
      unread: unread.count, forYou: unread.forYou,
      // Sessions have been talking among themselves for this many messages with no word from the user (§7); null
      // under the room's limit.
      rounds: roundsOf(room),
      // §9: how the room's work stands.
      tasks: { todo: room.tasks.filter((t) => t.state === "todo").length, doing: room.tasks.filter((t) => t.state === "doing").length, done: room.tasks.filter((t) => t.state === "done").length },
    };
  };

  const whole = (room: Room, messages: readonly Message[]) => ({
    room: { id: room.id, name: room.name, topic: room.topic, paused: room.paused, createdAt: room.createdAt, createdBy: room.createdBy, lastSeq: room.lastSeq, readSeq: room.readSeq, rounds: roundsOf(room), roundsLimit: room.roundsLimit },
    seats: seatsOf(room), messages, receipts: room.receipts, notes: room.notes, folder: rooms.folder(room.id), tasks: room.tasks, claims: rooms.claims(room.id), reads: room.reads,
  });

  const seat = (roomId: string, terminal: string, canAdd: boolean | undefined): Seat => {
    const info = host()?.get(terminal);
    if (!info) throw new RoomError(404, "这个节点上没有这个会话");
    if (info.status === "exited") throw new RoomError(409, "这个会话已经结束，恢复之后再拉进来");
    return rooms.seat(roomId, { terminal, was: wasOf(info), ...(canAdd === undefined ? {} : { canAdd }) });
  };

  app.get("/rooms", (c) => versionedJson(c, { rooms: rooms.list().map(summary) }));

  // Which models a session may start a session on, per profile (rooms/policy.ts): every agent's models and profiles,
  // and for each profile the models the user has turned off. Before `/rooms/:id`: "models" is not a room.
  app.get("/rooms/models", async (c) => {
    if (!deps.callLocal || !deps.roomPolicy) return c.json({ error: "not available" }, 503);
    const [terminals, profiles] = await Promise.all([deps.callLocal("GET", "/terminals"), deps.callLocal("GET", "/profiles")]);
    const models = ((terminals.body as { models?: Record<string, { id: string; name: string; older?: boolean }[]> }).models) ?? {};
    const agents = ((profiles.body as { agents?: Record<string, { current?: string; profiles?: { id: string; name: string }[] }> }).agents) ?? {};
    return c.json({ agents: Object.fromEntries(Object.entries(models).map(([agent, list]) => [agent, {
      models: list.filter((m) => m.older !== true).map((m) => ({ id: m.id, name: m.name })),
      current: agents[agent]?.current ?? null,
      profiles: (agents[agent]?.profiles ?? []).map((p) => ({ id: p.id, name: p.name, off: deps.roomPolicy!.offFor(agent, p.id) })),
    }])) });
  });

  app.put("/rooms/models/:agent/:profile", async (c) => {
    if (!deps.roomPolicy) return c.json({ error: "not available" }, 503);
    const body = await parseBody(c, z.object({ off: z.array(z.string().min(1).max(200)).max(200) }).strict());
    if (!body.ok) return c.json({ error: body.error }, 400);
    return c.json({ off: deps.roomPolicy.set(c.req.param("agent"), c.req.param("profile"), body.data.off) });
  });

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

  // §9: what is in the room's shared folder.
  app.get("/rooms/:id/files", (c) => {
    try { return c.json(rooms.files(c.req.param("id"))); } catch (err) { return refused(c, err); }
  });

  // A file of the shared folder itself, for a screen that is not on this Mac (a phone shows a picture a member put
  // there): the room's own folder only, whatever the phone may see of the Mac's other files.
  app.get("/rooms/:id/files/content", (c) => {
    try {
      const file = rooms.fileAt(c.req.param("id"), c.req.query("path") ?? "");
      if (file.size > MAX_PUT) return c.json({ error: "too-large", size: file.size, limit: MAX_PUT }, 413);
      const bytes = readFileSync(file.real);
      return c.body(new Uint8Array(bytes), 200, { "content-type": contentType(file.name), "content-length": String(bytes.length), "cache-control": "private, no-cache", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" });
    } catch (err) { return refused(c, err); }
  });

  // A file put into the shared folder from such a screen (a picture picked on a phone), as its bytes; where it is
  // now is what a message then comes with.
  app.put("/rooms/:id/files/content", async (c) => {
    try {
      const id = c.req.param("id");
      rooms.get(id);
      const said = Number(c.req.header("content-length") ?? NaN);
      if (Number.isFinite(said) && said > MAX_PUT) return c.json({ error: "too-large", limit: MAX_PUT }, 413);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.length > MAX_PUT) return c.json({ error: "too-large", limit: MAX_PUT }, 413);
      if (!bytes.length) return c.json({ error: "empty file" }, 400);
      return c.json(rooms.putFile(id, c.req.query("name") ?? "", bytes), 201);
    } catch (err) { return refused(c, err); }
  });

  app.patch("/rooms/:id", async (c) => {
    const body = await parseBody(c, Update);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const o = body.data;
      const room = rooms.update(c.req.param("id"), { ...(o.name === undefined ? {} : { name: o.name }), ...(o.topic === undefined ? {} : { topic: o.topic }), ...(o.paused === undefined ? {} : { paused: o.paused }), ...(o.roundsLimit === undefined ? {} : { roundsLimit: o.roundsLimit }) });
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
    try {
      const id = c.req.param("id"), handle = c.req.param("handle").replace(/^@/, "").toLowerCase();
      if (body.data.canAdd !== undefined) rooms.setCanAdd(id, handle, body.data.canAdd);
      if (body.data.muted !== undefined) rooms.setMuted(id, YOU, handle, body.data.muted);
      const named = body.data.name === undefined ? handle : rooms.rename(id, YOU, handle, body.data.name).handle;
      const seat = rooms.get(id).seats.find((s) => s.handle === named);
      if (!seat) throw new RoomError(404, `房间里没有 @${handle}`);
      return c.json({ seat: seatView(seat, host(), hasKit) });
    } catch (err) { return refused(c, err); }
  });

  // Resume the session behind an ended seat (§6.2): the same conversation goes on in a new terminal, and the seat keeps
  // its name, face and admin switch. Only the user's screens and admins bring one back; an admin does it with room_manage.
  app.post("/rooms/:id/seats/:handle/resume", async (c) => {
    try {
      const id = c.req.param("id"), handle = c.req.param("handle").replace(/^@/, "").toLowerCase();
      const room = rooms.get(id);
      const seat = room.seats.find((s) => s.handle === handle);
      if (!seat) throw new RoomError(404, `房间里没有 @${handle}`);
      if (seat.kind === "user") throw new RoomError(400, "用户没有会话");
      if (seat.left !== undefined) throw new RoomError(403, "这个席位已经离开房间");
      const info = seat.terminal ? host()?.get(seat.terminal) ?? null : null;
      if (info && info.status !== "exited") throw new RoomError(409, "这个会话还在运行。");
      if (!deps.callLocal) throw new RoomError(503, "这个服务不能恢复会话。");
      // What its terminal says while its record is still here, else what the seat kept: the record is gone once the
      // service has started again, and a seat must be resumable all the same.
      const kept = info?.agentSessionId ? { ...seat, session: sessionOf(info)! } : seat;
      if (!kept.session) throw new RoomError(409, "这个席位是在记下会话 id 之前入座的，找不回它的对话。把它移出房间，再从 Add 把会话重新拉进来。");
      const done = await resumeSeat(rooms, roomOrg(deps.callLocal), id, kept, (terminal) => { const now = host()?.get(terminal); return now ? wasOf(now) : null; });
      const after = host()?.get(done.terminal) ?? null;
      deps.roomsChanged?.(id);
      return c.json({ seat: seatView(done.seat, host(), hasKit), terminal: after ? { id: after.id, status: after.status } : { id: done.terminal } }, 201);
    } catch (err) { return refused(c, err); }
  });

  // A seat leaves. `?close=end`: its terminal is closed too (its conversation kept); `?close=delete`: and its
  // conversation's record deleted (§6.2 结束、删除). The user may do this to any seat.
  app.delete("/rooms/:id/seats/:handle", async (c) => {
    try {
      const id = c.req.param("id"), handle = c.req.param("handle").replace(/^@/, "").toLowerCase(), close = c.req.query("close");
      if (close !== undefined && close !== "end" && close !== "delete") return c.json({ error: "close is end or delete" }, 400);
      const seat = rooms.get(id).seats.find((s) => s.handle === handle);
      if (seat?.left === undefined) rooms.unseat(id, handle);
      let closed = false;
      if (close && seat?.terminal && deps.callLocal) closed = await roomOrg(deps.callLocal).stop(seat.terminal, close === "delete");
      deps.roomsChanged?.(id);
      return c.json({ ok: true, closed });
    } catch (err) { return refused(c, err); }
  });

  // Every member whose session has ended is brought back (§6.2 批量恢复); each says how it went.
  app.post("/rooms/:id/resume", async (c) => {
    try {
      const id = c.req.param("id");
      rooms.get(id);
      if (!deps.callLocal) throw new RoomError(503, "这个服务不能恢复会话。");
      // What a terminal's record says of its session while it is still here is kept first: the seat resumes from that.
      for (const seat of rooms.get(id).seats) {
        const info = seat.terminal && seat.left === undefined ? host()?.get(seat.terminal) ?? null : null;
        const session = info ? sessionOf(info) : null;
        if (session) rooms.note(id, seat.handle, session);
      }
      const done = await resumeEnded(rooms, roomOrg(deps.callLocal), id, (t) => { const info = host()?.get(t); return info ? info.status : null; }, (t) => { const now = host()?.get(t); return now ? wasOf(now) : null; });
      deps.roomsChanged?.(id);
      return c.json({ resumed: done.filter((d) => !d.error).map((d) => d.handle), failed: done.filter((d) => d.error) });
    } catch (err) { return refused(c, err); }
  });

  // "Do you trust this folder?" answered yes for every member whose screen asks exactly that (§6.2): a session just
  // started in a folder its agent was never in stops there, and a room may hold several. Nothing else a screen asks
  // is answered here.
  app.post("/rooms/:id/trust", (c) => {
    try {
      const id = c.req.param("id");
      const terminals = host();
      const trusted: string[] = [];
      for (const seat of rooms.get(id).seats) {
        if (seat.kind !== "session" || seat.left !== undefined || !seat.terminal || !terminals) continue;
        const info = terminals.get(seat.terminal);
        const yes = info ? trustYes(info) : null;
        if (!yes) continue;
        try { terminals.choose(seat.terminal, yes.pick, yes.label); trusted.push(seat.handle); } catch { /* its screen moved on */ }
      }
      deps.roomsChanged?.(id);
      return c.json({ trusted });
    } catch (err) { return refused(c, err); }
  });

  // The user speaks. Only the user's words come in here: a session speaks through its own channel (Chatroom Kit).
  app.post("/rooms/:id/messages", async (c) => {
    const body = await parseBody(c, Say);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const id = c.req.param("id");
      // A file is named by where it is on this node; one that is not there is not sent.
      const gone = (body.data.files ?? []).find((f) => !existsSync(f));
      if (gone) return c.json({ error: `文件不存在：${gone}` }, 400);
      const message = rooms.post(id, { from: YOU, text: body.data.text, ...(body.data.files ? { files: body.data.files } : {}), ...(body.data.replyTo === undefined ? {} : { replyTo: body.data.replyTo }), ...(body.data.expects ? { expects: body.data.expects } : {}) });
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
    // Codex and OpenCode list an MCP server's tools when they start and do not list them again when told they
    // changed (2026-11-23: a Codex session seated after it started had no room tools at all): theirs are always there.
    const always = LISTS_ONCE.has(terminals.get(id)?.harness ?? "");
    if (asked.op === "tools") return c.json({ tools: kit.tools(id, always), version: kit.version(id, always) });
    if (asked.op === "call") {
      const answer = await kit.call(id, asked.name, asked.args ?? {});
      return c.json(answer);
    }
    // Held until the tools this terminal has are others than the ones it knows of, or a while has passed.
    const until = Date.now() + (deps.roomWatchMs ?? WATCH_MS);
    while (kit.version(id, always) === asked.version && Date.now() < until && !c.req.raw.signal.aborted) await new Promise((r) => setTimeout(r, Math.min(WATCH_STEP_MS, deps.roomWatchMs ?? WATCH_STEP_MS)));
    return c.json({ version: kit.version(id, always) });
  });

  // The task list (§9): the user adds, changes and removes, as a session does with its tool.
  app.post("/rooms/:id/tasks", async (c) => {
    const body = await parseBody(c, z.object({ title: z.string(), detail: z.string().optional(), owner: z.string().optional(), after: z.array(z.number().int()).optional() }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const o = body.data, id = c.req.param("id");
      const task = rooms.addTask(id, YOU, { title: o.title, ...(o.detail === undefined ? {} : { detail: o.detail }), ...(o.owner === undefined ? {} : { owner: o.owner }), ...(o.after === undefined ? {} : { after: o.after }) });
      deps.roomsChanged?.(id);
      return c.json({ task }, 201);
    } catch (err) { return refused(c, err); }
  });

  app.patch("/rooms/:id/tasks/:n", async (c) => {
    const body = await parseBody(c, z.object({ state: z.enum(["todo", "doing", "done"]).optional(), owner: z.string().nullable().optional(), title: z.string().optional(), detail: z.string().optional(), note: z.string().optional() }));
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const o = body.data, id = c.req.param("id");
      const task = rooms.setTask(id, YOU, Number(c.req.param("n")), { ...(o.state === undefined ? {} : { state: o.state }), ...(o.owner === undefined ? {} : { owner: o.owner }), ...(o.title === undefined ? {} : { title: o.title }), ...(o.detail === undefined ? {} : { detail: o.detail }), ...(o.note === undefined ? {} : { note: o.note }) });
      deps.roomsChanged?.(id);
      return c.json({ task });
    } catch (err) { return refused(c, err); }
  });

  app.delete("/rooms/:id/tasks/:n", (c) => {
    try { const id = c.req.param("id"); rooms.removeTask(id, YOU, Number(c.req.param("n"))); deps.roomsChanged?.(id); return c.json({ ok: true }); } catch (err) { return refused(c, err); }
  });

  // The pinned notes (§9): the user writes the whole text, as a session does with its tool.
  app.put("/rooms/:id/notes", async (c) => {
    const body = await parseBody(c, WriteNotes);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try { const room = rooms.setNotes(c.req.param("id"), YOU, body.data.text); deps.roomsChanged?.(room.id); return c.json({ notes: room.notes }); } catch (err) { return refused(c, err); }
  });

  // The user has seen the sessions' rounds go by (`OK`): counted from here again. Nothing was stopped.
  app.post("/rooms/:id/rounds/ok", (c) => {
    try { rooms.roundsSeen(c.req.param("id")); return c.json({ ok: true }); } catch (err) { return refused(c, err); }
  });

  app.post("/rooms/:id/read", async (c) => {
    const body = await parseBody(c, Read);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try { const room = rooms.read(c.req.param("id"), body.data.seq); return c.json({ readSeq: room.readSeq }); } catch (err) { return refused(c, err); }
  });
}
