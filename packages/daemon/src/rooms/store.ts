/** Chat Room's rooms as they are kept (docs/chatroom-v0.md §1–§5): each room's name, topic and seats in one file, what
 *  was said in it in another that only grows. Under `<home>/rooms`, the user's alone to read. Who a seat is (which
 *  session, in what state) is not kept here: a seat names its terminal, and whoever shows the room asks the terminals.
 *
 *  A message addressed to a seat has a receipt for it until that seat has dealt with it: `sent` (written), `queued`
 *  (the seat is at work), `delivered` (in its hands), `ended` (it can not be given: the session is over). Dealt with,
 *  the receipt goes: a room shows only what has not arrived. */

import { randomBytes } from "node:crypto";
import { importFiles, RoomDb, type StoredMessage } from "./db.js";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, sep } from "node:path";
import { faceOf, type Face } from "./face.js";
import { avatarKeys, type Avatar } from "./avatars.js";
import { MAX_SECRETS, secretFrom, type RoomSecret } from "./secrets.js";
import { ALL, freeHandle, handleFrom, mentions, YOU } from "./names.js";

/** The most a session may say in one message: the rest belongs in a file. */
export const MAX_SESSION_TEXT = 800;
export const MAX_ROOMS = 100, MAX_SEATS = 16, MAX_NAME = 60, MAX_TOPIC = 300, MAX_TEXT = 16_000;
/** §9: the pinned notes, one text every member reads and writes; a message carries this many files at most. */
export const MAX_NOTES = 20_000, MAX_FILES = 10;
/** §7: the rounds between sessions the user is told of, and how many sessions one session may start. */
export const ROUNDS_LIMIT = 6, MAX_STARTED = 4;
/** §9: a room's shared folder is listed this far (files, and folders deep). */
export const MAX_LISTED = 500, MAX_DEPTH = 6;
/** The most one file put into a shared folder through the service (a picture from a phone) may be. */
export const MAX_PUT = 25 * 1024 * 1024;
/** Where every room's shared folder is, under the home: apart from what the rooms themselves are kept in, so that a
 *  session let into the folders is let into nothing else. */
export const filesRoot = (home: string): string => join(home, "room-files");

/** Puts a folder in the user's Trash under `name` (macOS: `~/.Trash`; elsewhere the desktop's own, with its note of
 *  where it was), where it can be taken back from. It stays where it is when that can not be done. */
export function toTrash(dir: string, name: string, at: number = Date.now()): void {
  const mac = process.platform === "darwin";
  const base = mac ? join(homedir(), ".Trash") : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "Trash");
  const files = mac ? base : join(base, "files");
  try {
    mkdirSync(files, { recursive: true, mode: 0o700 });
    const safe = name.replace(/[\/:\0\n\r]/g, " ").trim().slice(0, 120) || "AgentSwitch Room";
    let as = safe;
    for (let n = 2; existsSync(join(files, as)); n++) as = `${safe} ${n}`;
    renameSync(dir, join(files, as));
    if (!mac) {
      mkdirSync(join(base, "info"), { recursive: true, mode: 0o700 });
      writeFileSync(join(base, "info", `${as}.trashinfo`), `[Trash Info]\nPath=${encodeURI(dir)}\nDeletionDate=${new Date(at).toISOString().slice(0, 19)}\n`);
    }
  } catch { /* another disk, or no Trash: it stays */ }
}

/** A file in a room's shared folder: its path under the folder. */
export type RoomFile = { readonly path: string; readonly size: number; readonly modifiedAt: number };

export type Receipt = "sent" | "queued" | "delivered" | "ended";

/** A session as it was when it took its seat: what the room still says of it once its terminal is gone. */
export type SeatWas = {
  readonly agent: string; readonly name: string; readonly cwd: string; readonly model: string | null;
  readonly profile: string | null; readonly color?: string;
};

/** The agent's own session behind a seat, kept while its terminal lives (§6.2): what it takes to bring the same
 *  conversation back in a new terminal, and to know it again when it runs in another. The terminal's own record is
 *  gone when the service starts again; this is not. `cwd` is the folder it was started in — a session is resumed
 *  there, not where the agent has since gone. */
export type SeatSession = { readonly id: string; readonly cwd: string; readonly mode?: string; readonly model?: string; readonly effort?: string; readonly profile?: string };

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
  readonly session?: SeatSession;
  /** Muted by an admin or the user (docs/chatroom-v0.md §6.2): it still reads, is woken and works, but may not post
   *  or write the pinned notes. */
  readonly muted?: { readonly by: string; readonly at: number };
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
  /** Whether its sender waits for an answer: `none` — it is told for its knowledge, and answering only adds noise
   *  (a report, a notice); `answer` — it is a question or a request. Absent: the reader judges. */
  readonly expects?: "none" | "answer";
  /** The task of the room's list it is about (`T3`), as Zulip's topic (2026-11-24, user: 给消息加tag): one room holds
   *  several pieces of work at once, and a reader follows one. A reply is about what it answers unless it says. */
  readonly task?: number;
};

/** The room's pinned notes (§9): what the members agreed on — conventions, interfaces, what is left to do. */
export type Notes = { readonly text: string; readonly at: number; readonly by: string };

/** One piece of the room's work (§9 任务表): who does what, and how far it is, where every member sees it. */
/** `blocked`: its owner can not go on — waiting on someone or something, said in its note (2026-11-24). */
export type TaskState = "todo" | "doing" | "blocked" | "done";
export type Task = {
  /** Its number in this room: `T3`. Never reused. */
  readonly n: number;
  readonly title: string;
  readonly detail?: string;
  readonly state: TaskState;
  /** The seat doing it (done it). */
  readonly owner?: string;
  readonly by: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Tasks that come first, by number. */
  readonly after?: readonly number[];
  /** How it ended, in a line: the result, or the file that holds it. */
  readonly note?: string;
};

/** A member saying which files it is changing (§9): a word to the others, not a lock, and gone by itself at `until`. */
export type Claim = { readonly handle: string; readonly paths: readonly string[]; readonly why?: string; readonly at: number; readonly until: number };

export const MAX_TASKS = 200, MAX_TITLE = 200, MAX_DETAIL = 2000, MAX_NOTE = 1000, MAX_CLAIM_PATHS = 30, CLAIM_MINUTES = 30, MAX_CLAIM_MINUTES = 240;

/** The room's own record in its shared folder (store.ts `writeRecord`). */
export const RECORD_DIR = "_room";
const stamp = (at: number): string => { const t = new Date(at); const p = (n: number): string => String(n).padStart(2, "0"); return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`; };

/** How many of the newest messages keep who has read them. */
export const MAX_READS = 300;

export type SeatStats = { readonly wakes: number; readonly chars: number; readonly posts: number; readonly calls: number };

export type Room = {
  readonly id: string;
  readonly name: string;
  readonly topic: string;
  readonly createdAt: number;
  readonly createdBy: string;
  /** Messages are written and not given (§2 暂停). */
  readonly paused: boolean;
  /** The dispatch desk (调度台, 2026-11-24): the one room of the user and the dispatch session. Listed first; what the
   *  user says there is for the dispatch whether or not it is named. */
  readonly desk?: true;
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
  readonly tasks: readonly Task[];
  /** The last task's number; 0 before the first. */
  readonly lastTask: number;
  /** As written; the ones past their time are left out when read (`claims`). */
  readonly claims: readonly Claim[];
  /** What each seat has cost so far, as far as the rooms can count it (2026-11-23): how often it was woken and with
   *  how many characters, how many messages it posted, how many tool calls it made here. The tokens are the agent's
   *  own to say; these are what the room adds. */
  readonly stats: Readonly<Record<string, SeatStats>>;
  /** The same counts per task of the list (2026-11-24: what one piece of work cost): a wake given a message about
   *  it, a message about it, a tool call that named it. By task number. */
  readonly taskStats: Readonly<Record<string, SeatStats>>;
  /** Who has read which message (user, 2026-11-23: "哪个 session 已读未读"): message number → the seats that were
   *  given it whole, or read it themselves with room_read. Its sender is not listed (it wrote it). Kept for the last
   *  `MAX_READS` messages. */
  readonly reads: Readonly<Record<string, readonly string[]>>;
  /** The message from which reading is kept: what was said before a room first kept it counts as read by everyone
   *  (a room from before said "74 unread" to a member that had been given every one of them). */
  readonly readsFrom: number;
  /** Names seats went by before they were renamed, each with the name it is now: an `@old` still finds its seat. */
  readonly renames: Readonly<Record<string, string>>;
  /** What has not arrived: message number → handle → where it is. */
  readonly receipts: Readonly<Record<string, Readonly<Record<string, Receipt>>>>;
};

export class RoomError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, message: string) { super(message); }
}

const ID = /^[a-z0-9]{6,24}$/;

/** The seat a name written in a room means: a member called so now, else the one that was called so before it was
 *  renamed (`@old` still reaches it), else the name as it is. */
export function handleIn(room: Room, name: string): string {
  if (room.seats.some((s) => s.handle === name)) return name;
  return room.renames[name] ?? name;
}

export class RoomStore {
  private readonly dir: string;
  private rooms: Map<string, Room> | null = null;
  /** Rooms and what was said in them (rooms/db.ts). */
  private readonly db: RoomDb;

  private readonly filesDir: string;
  constructor(home: string, private readonly now: () => number = Date.now, private readonly trash: (dir: string, name: string) => void = toTrash) { this.dir = join(home, "rooms"); this.filesDir = filesRoot(home); this.db = new RoomDb(join(home, "rooms.db")); }

  /** A room's shared folder (§9), made when first asked for: what members hand each other as files — a report, a
   *  plan, an interface — is written here and a message only points at it. */
  folder(id: string): string {
    const dir = join(this.filesDir, this.get(id).id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Where a member's handover note is, when it has written one. */
  handoffPath(id: string, handle: string): string | null {
    const file = join(this.recordDir(id), `handoff-${handle}.md`);
    return existsSync(file) ? file : null;
  }

  /** A member's own handover note (§9 交接): what only it knows — what it was doing, how far it is, what comes next,
   *  what to watch out for — kept in the room's record for whoever takes its work over. Where it is. */
  handoff(id: string, handle: string, text: string): string {
    const room = this.get(id);
    const seat = this.member(room, handle);
    const clean = text.replace(/\r\n?/g, "\n").trim();
    if (!clean) throw new RoomError(400, "A handover note needs words.");
    if (clean.length > MAX_NOTES) throw new RoomError(400, `A handover note is ${MAX_NOTES} characters at most; put the rest in files and point at them.`);
    const dir = this.recordDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `handoff-${seat.handle}.md`);
    writeFileSync(file, `# Handover note of @${seat.handle}\n\nWritten ${stamp(this.now())}.\n\n${clean}\n`, { mode: 0o600 });
    return file;
  }

  /** A file in a room's shared folder by its path under it, as it is on the disk. Nothing outside the folder is
   *  reached: not by `..`, and not through a link. */
  fileAt(id: string, path: string): { readonly real: string; readonly size: number; readonly name: string } {
    const folder = realpathSync(this.folder(id));
    if (!path || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "" || part.startsWith(".")) || /[\0\n\r]/.test(path)) throw new RoomError(400, "bad path");
    let real: string;
    try { real = realpathSync(join(folder, path)); } catch { throw new RoomError(404, "这个文件不在共享文件夹里了"); }
    if (!real.startsWith(folder + sep)) throw new RoomError(403, "bad path");
    const stat = lstatSync(real);
    if (!stat.isFile()) throw new RoomError(400, "bad path");
    return { real, size: stat.size, name: basename(real) };
  }

  /** A file a message of the room came with, by the path it was sent with (one outside the shared folder too), for a
   *  screen not on this Mac (user #255: 我点不了远程发给我的附件). Only a path some message carries: nothing else of
   *  the Mac's disk is reached this way. */
  attachedAt(id: string, path: string): { readonly real: string; readonly size: number; readonly name: string } {
    if (!path.startsWith("/") || /[\0\n\r]/.test(path)) throw new RoomError(400, "bad path");
    if (!this.messages(id).some((m) => m.files?.includes(path))) throw new RoomError(404, "房间里没有发过这个文件");
    let stat;
    try { stat = lstatSync(path); } catch { throw new RoomError(404, "这个文件已经不在了"); }
    if (!stat.isFile()) throw new RoomError(400, "不是文件");
    return { real: path, size: stat.size, name: basename(path) };
  }

  /** A file put into a room's shared folder through the service (a picture picked on a phone): under its name, or
   *  that name with a number when one is there already. Where it is now. */
  putFile(id: string, name: string, bytes: Uint8Array): { readonly path: string; readonly name: string; readonly size: number } {
    const folder = this.folder(id);
    if (bytes.length > MAX_PUT) throw new RoomError(400, `文件太大（最多 ${MAX_PUT / 1024 / 1024} MB）`);
    // Its own name only: whatever stands before a slash is not ours to follow.
    const last = name.normalize("NFC").split(/[\\/]/).pop() ?? "";
    const clean = last.replace(/[\0\n\r:]/g, " ").replace(/^[.\s]+/, "").trim().slice(0, 120) || "file";
    const ext = extname(clean), stem = clean.slice(0, clean.length - ext.length);
    let as = clean;
    for (let n = 2; existsSync(join(folder, as)); n++) as = `${stem}-${n}${ext}`;
    writeFileSync(join(folder, as), bytes, { mode: 0o600, flag: "wx" });
    return { path: join(folder, as), name: as, size: bytes.length };
  }

  /** What is in a room's shared folder, the newest first. Links are not followed and names that begin with a dot are
   *  left out; `more`: there is more than is listed. */
  files(id: string): { readonly folder: string; readonly files: readonly RoomFile[]; readonly more: boolean } {
    const folder = this.folder(id);
    const found: RoomFile[] = [];
    let more = false;
    const walk = (dir: string, under: string, depth: number): void => {
      let names: string[];
      try { names = readdirSync(dir).sort(); } catch { return; }
      for (const name of names) {
        // The room's own record is not one of the members' files: said by itself, not listed among them.
        if (name.startsWith(".") || (depth === 1 && name === RECORD_DIR)) continue;
        let stat;
        try { stat = lstatSync(join(dir, name)); } catch { continue; }
        const path = under ? `${under}/${name}` : name;
        if (stat.isDirectory()) { if (depth < MAX_DEPTH) walk(join(dir, name), path, depth + 1); else more = true; }
        else if (stat.isFile()) { if (found.length < MAX_LISTED) found.push({ path, size: stat.size, modifiedAt: Math.round(stat.mtimeMs) }); else more = true; }
      }
    };
    walk(folder, "", 1);
    return { folder, files: found.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path)), more };
  }

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
    const rows = o.after === undefined
      ? (o.limit === undefined ? this.db.all(id) : this.db.tail(id, o.limit))
      : this.db.after(id, o.after, o.limit ?? Number.MAX_SAFE_INTEGER);
    return parsed(rows);
  }

  /** The `limit` before message `seq`, oldest first: the page above what is shown. */
  messagesBefore(id: string, seq: number, limit: number): Message[] { this.get(id); return parsed(this.db.before(id, seq, limit)); }

  /** The room's sealed secrets (secrets.ts), oldest first. */
  secrets(id: string): RoomSecret[] {
    this.get(id);
    return this.db.secrets(id).flatMap((b) => { try { return [JSON.parse(b) as RoomSecret]; } catch { return []; } });
  }

  /** Secrets added, all or none: each checked (a ciphertext only); one of the same name as one kept takes its place. */
  addSecrets(id: string, items: readonly unknown[]): RoomSecret[] {
    const kept = this.secrets(id);
    const made: RoomSecret[] = [];
    for (const raw of items) {
      const s = secretFrom(raw, this.now());
      if (typeof s === "string") throw new RoomError(400, s);
      made.push(s);
    }
    const names = new Set(made.map((s) => s.name));
    const replaced = kept.filter((s) => names.has(s.name));
    if (kept.length - replaced.length + made.length > MAX_SECRETS) throw new RoomError(409, `一个房间最多 ${MAX_SECRETS} 条密钥`);
    this.db.tx(() => {
      for (const s of replaced) this.db.dropSecret(id, s.id);
      for (const s of made) this.db.putSecret(id, s.id, s.addedAt, JSON.stringify(s));
    });
    return made;
  }

  removeSecret(id: string, secret: string): void {
    this.get(id);
    if (!this.db.dropSecret(id, secret)) throw new RoomError(404, "没有这条密钥");
  }

  /** A seat's avatar (avatars.ts): its session's, whatever room; null: none chosen (its face and its initials). */
  avatarOf(seat: Seat): Avatar | null {
    if (seat.kind !== "session") return null;
    for (const key of avatarKeys({ session: seat.session?.id ?? null, terminal: seat.terminal ?? null })) {
      const raw = this.db.avatar(key);
      if (raw) { try { return JSON.parse(raw) as Avatar; } catch { /* torn: as none */ } }
    }
    return null;
  }

  /** A session's avatar changed, one look or both: kept by its conversation (and its terminal, until the agent has
   *  said its conversation's id), so every room it sits in shows it, and a resume keeps it. */
  setAvatar(terminal: string, change: { readonly pixel?: Avatar["pixel"]; readonly classic?: Avatar["classic"] }): Avatar {
    const seats = this.roomsOf(terminal).map((s) => s.seat);
    if (!seats.length) throw new RoomError(404, "这个会话不在任何房间里");
    const was = this.avatarOf(seats[0]!) ?? { pixel: null, classic: null };
    const next: Avatar = { pixel: change.pixel === undefined ? was.pixel : change.pixel, classic: change.classic === undefined ? was.classic : change.classic };
    const session = seats.find((s) => s.session?.id)?.session?.id ?? null;
    for (const key of avatarKeys({ session, terminal })) this.db.putAvatar(key, JSON.stringify(next));
    return next;
  }

  /** Questions put to the user it has not answered yet (2026-11-24, 等你处理): addressed to the user, asking for an
   *  answer, said after the user last spoke in the room and not answered by a reply of the user's since. */
  questionsForYou(id: string): Message[] {
    const room = this.get(id);
    // Seen is dealt with (user #234: 我都已读了，为什么还是有待办): a question the user has read, or answered by
    // speaking after it, waits no more.
    const since = Math.max(this.db.lastFromYou(id, 0) ?? 0, room.readSeq);
    return parsed(this.db.after(id, since, 200)).filter((m) => m.from !== YOU && m.to.includes(YOU) && m.expects === "answer").slice(-20);
  }

  /** The last `limit` about one task, oldest first. */
  messagesOfTask(id: string, task: number, limit: number): Message[] { this.get(id); return parsed(this.db.taskTail(id, task, limit)); }

  /** The newest `limit` whose words contain `text`, newest first. */
  search(id: string, text: string, limit: number): Message[] { this.get(id); return parsed(this.db.search(id, text, limit)); }

  /** How many messages after `seq` are about each task. */
  countByTask(id: string, after: number): Map<number, number> { this.get(id); return this.db.byTask(id, after); }

  last(id: string): Message | null { const row = this.db.last(id); return row ? parsed([row])[0] ?? null : null; }

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
    return this.db.unread(id, room.readSeq);
  }

  // ---- rooms

  /** Whether a terminal's session may bring sessions in: its switch is on in a room it sits in (§6). */
  mayAdd(terminal: string): boolean { return this.roomsOf(terminal).some((s) => s.seat.canAdd); }

  create(o: { readonly name: string; readonly topic?: string; readonly by?: string; readonly desk?: boolean }): Room {
    if (this.all().size >= MAX_ROOMS) throw new RoomError(409, `房间最多 ${MAX_ROOMS} 个，先删掉不用的`);
    const name = clean(o.name, MAX_NAME);
    if (!name) throw new RoomError(400, "房间要有名字");
    let id = randomBytes(5).toString("hex");
    while (this.all().has(id)) id = randomBytes(5).toString("hex");
    const at = this.now();
    const you: Seat = { handle: YOU, kind: "user", face: null, joinedAt: at, addedBy: YOU, canAdd: true, byAgent: false };
    const room: Room = { id, name, topic: clean(o.topic ?? "", MAX_TOPIC), createdAt: at, createdBy: o.by ?? YOU, paused: false, ...(o.desk ? { desk: true as const } : {}), seats: [you], lastSeq: 0, readSeq: 0, roundsLimit: ROUNDS_LIMIT, roundsFrom: 0, notes: null, tasks: [], lastTask: 0, claims: [], stats: {}, taskStats: {}, reads: {}, readsFrom: 0, renames: {}, receipts: {} };
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
    const from = this.db.lastFromYou(id, room.roundsFrom) ?? room.roundsFrom;
    return this.db.rounds(id, from);
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

  /** A shared folder whose room is gone: away when empty, else into the Trash — what members wrote there may be the
   *  only copy, and the user can take it back. */
  private discard(id: string, name: string): void {
    const dir = join(this.filesDir, id);
    try { rmdirSync(dir); return; } catch { /* not there, or not empty */ }
    if (existsSync(dir)) this.trash(dir, `AgentSwitch Room ${name} ${id}`.replace(/\s+/g, " "));
  }

  /** At the start: shared folders no room has any more (left by a room removed before, or while the service was
   *  not running) go the same way. */
  sweep(): void {
    let names: string[];
    try { names = readdirSync(this.filesDir); } catch { return; }
    const rooms = this.all();
    for (const name of names) if (ID.test(name) && !rooms.has(name)) this.discard(name, "");
  }

  /** The sessions started for this room (an admin's `add` of a new one) that still sit here and in no other room:
   *  what dissolving the room ends with it. */
  startedFor(id: string): string[] {
    const room = this.get(id);
    const elsewhere = new Set<string>();
    for (const other of this.all().values()) if (other.id !== id) for (const s of other.seats) if (s.left === undefined && s.terminal) elsewhere.add(s.terminal);
    return room.seats.flatMap((s) => (s.starter && s.left === undefined && s.terminal && !elsewhere.has(s.terminal) ? [s.terminal] : []));
  }

  remove(id: string): void {
    const room = this.get(id);
    if (room.desk) throw new RoomError(409, "调度台不能解散：不要调度了，在设置 › Dispatch 里关掉它。");
    this.all().delete(id);
    this.db.dropRoom(id);
    this.dropRecordIfAlone(id);
    this.discard(id, room.name);
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
    // A name a seat had before it was renamed still reaches that seat: not given to a newcomer (2026-11-24: a new
    // session took the old name of one that had left, and what was written to it went to the old seat).
    const handle = freeHandle(handleFrom(o.was.name, handleFrom(o.was.agent)), new Set([...room.seats.map((s) => s.handle), ...Object.keys(room.renames)]));
    const face = faceOf(handle, room.seats.flatMap((s) => (s.face && s.left === undefined ? [s.face] : [])));
    const seat: Seat = { handle, kind: "session", terminal: o.terminal, face, joinedAt: this.now(), addedBy: o.by ?? YOU, canAdd: byAgent ? false : (o.canAdd ?? false), byAgent, was: o.was, ...(o.starter ? { starter: o.starter } : {}) };
    this.save({ ...room, seats: [...room.seats, seat] });
    return seat;
  }

  /** A seat leaves (the user, or an admin kicking it). What was on its way to it is dropped: nobody is there to take
   *  it. Muting goes with it: one brought back into the room afresh is not still muted. */
  unseat(id: string, handle: string, by: string = YOU): void {
    const room = this.get(id);
    const seat = this.seatOf(room, handle);
    if (seat.kind === "user") throw new RoomError(400, "你自己的席位不能移出");
    this.manager(room, by, seat);
    // What it was doing is free again, and it changes no files any more.
    const tasks = room.tasks.map((t) => (t.owner === seat.handle && t.state === "doing" ? (({ owner: _owner, ...rest }) => ({ ...rest, state: "todo" as const, updatedAt: this.now() }))(t) : t));
    this.save({ ...room, seats: room.seats.map((s) => {
      if (s !== seat) return s;
      const { muted: _was, ...rest } = s;
      return { ...rest, left: this.now() };
    }), receipts: without(room.receipts, seat.handle), tasks, claims: room.claims.filter((c) => c.handle !== seat.handle) });
  }

  /** Muted or unmuted by the user or an admin (`by`): it reads and works all the same, but may not post or write the
   *  notes (§6.2). The user cannot be muted; a session cannot mute itself; only the user mutes or unmutes an admin. */
  setMuted(id: string, by: string, handle: string, muted: boolean): Seat {
    const room = this.get(id);
    const seat = this.seatOf(room, handle);
    if (seat.kind === "user") throw new RoomError(400, "用户不能被禁言");
    if (seat.left !== undefined) throw new RoomError(403, "这个席位已经离开房间");
    this.manager(room, by, seat);
    if (muted) {
      const next = { ...seat, muted: { by: this.seatOf(room, by).handle, at: this.now() } };
      this.save({ ...room, seats: room.seats.map((s) => (s === seat ? next : s)) });
      return next;
    }
    const { muted: _was, ...rest } = seat;
    this.save({ ...room, seats: room.seats.map((s) => (s === seat ? rest : s)) });
    return rest;
  }

  /** What a seat has not read yet (§9 已读未读): said since it sat down, by another, and neither given to it whole
   *  nor read by it. Oldest first. Read once is the point: a session that reads the room is given these and not, each
   *  time, the latest twenty again. */
  unreadOf(id: string, handle: string): Message[] {
    const room = this.get(id);
    const seat = room.seats.find((s) => s.handle === handle);
    if (!seat) return [];
    const floor = room.lastSeq - MAX_READS;
    return this.messages(id, { after: Math.max(floor, room.readsFrom, 0) }).filter((m) => m.seq > floor && m.seq > room.readsFrom && m.at >= seat.joinedAt && m.from !== handle && !(room.reads[String(m.seq)]?.includes(handle)));
  }

  /** A seat has read these messages: given them whole, or read them itself. Kept in memory and written with the
   *  room's next change, like the counts. */
  markRead(id: string, handle: string, seqs: readonly number[]): void {
    const room = this.all().get(id);
    if (!room || !seqs.length) return;
    const reads: Record<string, readonly string[]> = { ...room.reads };
    let changed = false;
    for (const seq of seqs) {
      const had = reads[String(seq)] ?? [];
      if (had.includes(handle)) continue;
      reads[String(seq)] = [...had, handle];
      changed = true;
    }
    if (!changed) return;
    const floor = room.lastSeq - MAX_READS;
    for (const seq of Object.keys(reads)) if (Number(seq) <= floor) delete reads[seq];
    this.all().set(id, { ...room, reads });
  }

  /** Adds to what a seat has cost. Kept in memory and written with the room's next change: a count is not worth a
   *  write of its own, and one lost over a crash is no loss. */
  count(id: string, handle: string, add: Partial<SeatStats>, task?: number): void {
    const room = this.all().get(id);
    if (!room) return;
    const plus = (was: SeatStats | undefined): SeatStats => {
      const w = was ?? { wakes: 0, chars: 0, posts: 0, calls: 0 };
      return { wakes: w.wakes + (add.wakes ?? 0), chars: w.chars + (add.chars ?? 0), posts: w.posts + (add.posts ?? 0), calls: w.calls + (add.calls ?? 0) };
    };
    const onTask = task !== undefined && room.tasks.some((t) => t.n === task);
    this.all().set(id, { ...room, stats: { ...room.stats, [handle]: plus(room.stats[handle]) }, ...(onTask ? { taskStats: { ...room.taskStats, [String(task)]: plus(room.taskStats[String(task)]) } } : {}) });
  }

  /** The agent's session behind a seat, as its terminal says it now: kept for when the terminal is gone. */
  note(id: string, handle: string, session: SeatSession): void {
    const room = this.all().get(id);
    const seat = room?.seats.find((s) => s.handle === handle);
    if (!room || !seat || JSON.stringify(seat.session) === JSON.stringify(session)) return;
    this.save({ ...room, seats: room.seats.map((s) => (s === seat ? { ...s, session } : s)) });
  }

  /** A seat's terminal goes on under a new one (a resume, §6.2): its name, face, admin switch and mute stay. */
  rebind(id: string, handle: string, terminal: string, was: SeatWas): Seat {
    const room = this.get(id);
    const seat = this.seatOf(room, handle);
    if (seat.kind === "user") throw new RoomError(400, "用户没有会话");
    if (seat.left !== undefined) throw new RoomError(403, "这个席位已经离开房间");
    if (room.seats.some((s) => s !== seat && s.left === undefined && s.terminal === terminal)) throw new RoomError(409, "这个会话已经在房间里了");
    const next: Seat = { ...seat, terminal, was };
    // What its old terminal was given and never dealt with (it ended in the middle of a turn), and what came for it
    // while nobody was there, waits for it again: the same seat is back to take it.
    const receipts: Record<string, Record<string, Receipt>> = {};
    for (const [seq, of] of Object.entries(room.receipts)) receipts[seq] = of[seat.handle] === "delivered" || of[seat.handle] === "ended" ? { ...of, [seat.handle]: "sent" } : of;
    this.save({ ...room, seats: room.seats.map((s) => (s === seat ? next : s)), receipts });
    return next;
  }

  /** Who may manage `target` (mute, unmute, kick) — the user, or an admin: a seated session with Can Add Sessions
   *  that is not itself muted. A session may not manage itself, nor another admin; only the user may. */
  private manager(room: Room, by: string, target: Seat): Seat {
    const actor = this.seatOf(room, by);
    if (actor.left !== undefined) throw new RoomError(403, "这个席位已经离开房间");
    if (actor.kind === "user") return actor;
    if (!actor.canAdd) throw new RoomError(403, "Only the user or an admin (Can Add Sessions) may do that.");
    if (actor.muted) throw new RoomError(403, `@${actor.handle} is muted: it can not manage the room until the user or an admin unmutes it.`);
    if (actor.handle === target.handle) throw new RoomError(403, "A session can not manage itself; ask the user or another admin.");
    if (target.canAdd) throw new RoomError(403, "Only the user may mute, unmute or kick an admin.");
    return actor;
  }

  // ---- tasks

  private member(room: Room, handle: string): Seat {
    const seat = this.seatOf(room, handle);
    if (seat.left !== undefined) throw new RoomError(403, "这个席位已经离开房间");
    return seat;
  }

  private taskOf(room: Room, n: number): Task {
    const task = room.tasks.find((t) => t.n === n);
    if (!task) throw new RoomError(404, `There is no task T${n} in this room.`);
    return task;
  }

  /** A member adds a task. `owner`: whose it is from the start (it stays to do until that seat takes it). */
  addTask(id: string, by: string, o: { readonly title: string; readonly detail?: string; readonly after?: readonly number[]; readonly owner?: string }): Task {
    const room = this.get(id);
    const seat = this.member(room, by);
    const title = clean(o.title, MAX_TITLE);
    if (!title) throw new RoomError(400, "任务要有标题");
    if (room.tasks.length >= MAX_TASKS) throw new RoomError(409, `一个房间最多 ${MAX_TASKS} 个任务，先删掉做完的`);
    const detail = (o.detail ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_DETAIL);
    const after = [...new Set(o.after ?? [])].filter((n) => room.tasks.some((t) => t.n === n));
    const owner = o.owner === undefined ? undefined : this.member(room, o.owner.replace(/^@/, "").toLowerCase()).handle;
    const task: Task = { n: room.lastTask + 1, title, ...(detail ? { detail } : {}), state: "todo", ...(owner ? { owner } : {}), by: seat.handle, createdAt: this.now(), updatedAt: this.now(), ...(after.length ? { after } : {}) };
    this.save({ ...room, tasks: [...room.tasks, task], lastTask: task.n });
    if (owner && owner !== seat.handle) this.tell(id, seat.handle, [owner], `T${task.n} 给你：${title}`, task.n);
    return task;
  }

  /** The task list speaks for itself (2026-11-23): whoever is given a task, and whoever waits for one that is now
   *  done, is told in the room by the one that did it — no second message has to be written. A muted member's act
   *  tells nobody (it may not post). */
  private tell(id: string, from: string, to: readonly string[], text: string, task?: number): void {
    const here = new Set(this.get(id).seats.filter((s) => s.left === undefined && s.kind === "session").map((s) => s.handle));
    const whom = [...new Set(to)].filter((h) => h !== from && here.has(h));
    if (!whom.length) return;
    try { this.post(id, { from, text: `〔任务表〕${whom.map((h) => `@${h}`).join(" ")} ${text}`, to: whom, expects: "none", ...(task === undefined ? {} : { task }) }); } catch { /* muted, or the room is full of words: the list itself still says it */ }
  }

  /** A member changes a task. Taking it (`state: "doing"`) makes it that member's; one another member is doing is not
   *  taken from it by a session — the user may. `owner: null` gives it up. */
  setTask(id: string, by: string, n: number, o: { readonly state?: TaskState; readonly owner?: string | null; readonly title?: string; readonly detail?: string; readonly note?: string }): Task {
    const room = this.get(id);
    const seat = this.member(room, by);
    const task = this.taskOf(room, n);
    const held = (task.state === "doing" || task.state === "blocked") && task.owner !== undefined && task.owner !== seat.handle;
    if (held && seat.kind !== "user" && (o.state !== undefined || o.owner !== undefined)) throw new RoomError(409, `T${n} is being done by @${task.owner}. Take another, or ask @${task.owner} in the room.`);
    let owner: string | undefined = task.owner;
    if (o.owner === null) owner = undefined;
    else if (o.owner !== undefined) owner = this.member(room, o.owner.replace(/^@/, "").toLowerCase()).handle;
    let state = o.state ?? task.state;
    // A session that takes a task, or ends one nobody had, is its owner; one that puts it back gives it up. The
    // user changes the state and leaves whose it is alone.
    if (o.owner === undefined && seat.kind !== "user") {
      if (o.state === "doing" || o.state === "blocked" || (o.state === "done" && !owner)) owner = seat.handle;
      if (o.state === "todo") owner = undefined;
    }
    if (o.owner === null && state === "doing") state = "todo";
    const title = o.title === undefined ? task.title : clean(o.title, MAX_TITLE);
    if (!title) throw new RoomError(400, "任务要有标题");
    const detail = o.detail === undefined ? task.detail : o.detail.replace(/\r\n?/g, "\n").trim().slice(0, MAX_DETAIL) || undefined;
    const note = o.note === undefined ? task.note : o.note.replace(/\r\n?/g, "\n").trim().slice(0, MAX_NOTE) || undefined;
    if (state === "blocked" && task.state !== "blocked" && !note) throw new RoomError(400, `Say why T${n} is blocked: give a note (what it waits for).`);
    const next: Task = { n: task.n, title, ...(detail ? { detail } : {}), state, ...(owner ? { owner } : {}), by: task.by, createdAt: task.createdAt, updatedAt: this.now(), ...(task.after ? { after: task.after } : {}), ...(note ? { note } : {}) };
    const tasks = room.tasks.map((t) => (t === task ? next : t));
    this.save({ ...room, tasks });
    if (next.owner && next.owner !== task.owner) this.tell(id, seat.handle, [next.owner], `T${next.n} 给你：${next.title}`, next.n);
    // Stuck: the one that asked for it hears why, and so does the user (in the room) — someone has to unblock it.
    if (next.state === "blocked" && task.state !== "blocked") {
      const here = new Set(this.get(id).seats.filter((x) => x.left === undefined && x.kind === "session").map((x) => x.handle));
      const whom = [...new Set([next.by, YOU])].filter((h) => h !== seat.handle && (h === YOU || here.has(h)));
      try { this.post(id, { from: seat.handle, text: `〔任务表〕${whom.map((h) => `@${h}`).join(" ")} T${next.n} 卡住了：${next.note}`, to: whom, expects: "none", task: next.n }); } catch { /* muted: the list itself says it */ }
    }
    if (next.state === "done" && task.state !== "done") {
      // Those whose task waited for this one and waits for nothing now, and the member that asked for it.
      const freed = tasks.filter((t) => t.state !== "done" && t.owner && t.after?.includes(next.n) && t.after.every((a) => tasks.find((o) => o.n === a)?.state === "done"));
      const result = next.note ? `（${next.note}）` : "";
      for (const t of freed) this.tell(id, seat.handle, [t.owner!], `T${next.n} 做完了${result}，T${t.n} 可以开始：${t.title}`, t.n);
      if (!freed.some((t) => t.owner === next.by)) this.tell(id, seat.handle, [next.by], `T${next.n} 做完了${result}：${next.title}`, next.n);
    }
    return next;
  }

  /** The user, or the member that added it, takes a task off the list. */
  removeTask(id: string, by: string, n: number): void {
    const room = this.get(id);
    const seat = this.member(room, by);
    const task = this.taskOf(room, n);
    if (seat.kind !== "user" && task.by !== seat.handle) throw new RoomError(403, `Only the user or @${task.by}, who added it, removes T${n}. Mark it done instead.`);
    this.save({ ...room, tasks: room.tasks.filter((t) => t !== task) });
  }

  // ---- who is changing which files

  /** The words that still stand: not past their time. */
  claims(id: string): readonly Claim[] {
    const now = this.now();
    return this.get(id).claims.filter((c) => c.until > now);
  }

  /** A member says which files (or folders) it is changing for the next while, in place of what it said before; no
   *  paths: it changes none any more. `overlaps`: what others said about the same files — it is told, not stopped. */
  claim(id: string, by: string, o: { readonly paths: readonly string[]; readonly minutes?: number; readonly why?: string }): { readonly claim: Claim | null; readonly overlaps: readonly Claim[] } {
    const room = this.get(id);
    const seat = this.member(room, by);
    const now = this.now();
    const paths = [...new Set(o.paths.map((p) => p.trim().replace(/(.)\/+$/, "$1")).filter(Boolean))];
    if (paths.length > MAX_CLAIM_PATHS) throw new RoomError(400, `At most ${MAX_CLAIM_PATHS} paths; name a folder instead of its files.`);
    if (paths.some((p) => !p.startsWith("/") || p.length > 4096 || /[\n\r\0]/.test(p))) throw new RoomError(400, "Give absolute paths.");
    const others = room.claims.filter((c) => c.handle !== seat.handle && c.until > now);
    if (!paths.length) { this.save({ ...room, claims: others }); return { claim: null, overlaps: [] }; }
    const minutes = Math.min(Math.max(Math.round(o.minutes ?? CLAIM_MINUTES), 1), MAX_CLAIM_MINUTES);
    const why = o.why ? clean(o.why, MAX_TITLE) : "";
    const claim: Claim = { handle: seat.handle, paths, ...(why ? { why } : {}), at: now, until: now + minutes * 60_000 };
    this.save({ ...room, claims: [...others, claim] });
    const meets = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    return { claim, overlaps: others.map((c) => ({ ...c, paths: c.paths.filter((p) => paths.some((q) => meets(p, q))) })).filter((c) => c.paths.length) };
  }

  /** A seat takes another name (user, 2026-11-23: a session whose name says nothing of what it does renames itself).
   *  A seat's first name comes from what its session was called when it sat down — "你好", "agentswitch-浏览器连接失败"
   *  — and says nothing to whoever must pick the right member to address. The session itself or the user may change
   *  it. Everything the room keeps is carried over to the new name — what it said, what waits for it, its tasks,
   *  what it is changing, its counts — so the room reads as if it had always been called so; the old name is kept
   *  only to find it by (`@old` still reaches it). */
  rename(id: string, by: string, handle: string, wanted: string): Seat {
    const room = this.get(id);
    const seat = this.seatOf(room, handle);
    const actor = this.seatOf(room, by);
    if (seat.kind === "user") throw new RoomError(400, "用户的名字不能改");
    if (seat.left !== undefined) throw new RoomError(403, "这个席位已经离开房间");
    // Its name in the room is its own to change, the user's, and an admin's (as an admin mutes or kicks: not itself
    // through another, not another admin).
    if (actor.kind !== "user" && actor.handle !== seat.handle) this.manager(room, by, seat);
    const name = handleFrom(wanted, "");
    if (!name) throw new RoomError(400, "A name needs letters or digits.");
    if (name === seat.handle) return seat;
    const taken = new Set([...room.seats.map((s) => s.handle), ...Object.keys(room.renames).filter((old) => room.renames[old] !== seat.handle)]);
    if (name === YOU || name === ALL || taken.has(name) || freeHandle(name, new Set()) !== name) throw new RoomError(409, `The name @${name} is taken or reserved in this room; choose another.`);
    const old = seat.handle;
    const to = (h: string): string => (h === old ? name : h);
    const key = <T>(record: Readonly<Record<string, T>>): Record<string, T> => Object.fromEntries(Object.entries(record).map(([h, v]) => [to(h), v]));
    // What was said: the record on the disk is written anew, under the new name.
    const said = this.messages(id).map((m): Message => ({ ...m, from: to(m.from), to: m.to.map(to) }));
    this.db.tx(() => { for (const m of said) this.db.add(id, m, JSON.stringify(m)); });
    const next: Seat = { ...seat, handle: name };
    const stats = key(room.stats);
    this.all().set(id, { ...room, stats });
    this.save({
      ...room,
      seats: room.seats.map((s) => (s === seat ? next : { ...s, addedBy: to(s.addedBy), ...(s.muted ? { muted: { ...s.muted, by: to(s.muted.by) } } : {}) })),
      receipts: Object.fromEntries(Object.entries(room.receipts).map(([seq, of]) => [seq, key(of)])),
      tasks: room.tasks.map((t) => ({ ...t, by: to(t.by), ...(t.owner ? { owner: to(t.owner) } : {}) })),
      claims: room.claims.map((c) => ({ ...c, handle: to(c.handle) })),
      notes: room.notes ? { ...room.notes, by: to(room.notes.by) } : null,
      createdBy: to(room.createdBy),
      renames: { ...Object.fromEntries(Object.entries(room.renames).map(([was, now]) => [was, to(now)])), [old]: name },
      stats,
    });
    const after = this.all().get(id)!;
    this.all().set(id, { ...after, reads: Object.fromEntries(Object.entries(after.reads).map(([seq, who]) => [seq, who.map(to)])) });
    this.rewriteLog(this.get(id));
    return next;
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
    if (seat.muted) throw new RoomError(403, `@${seat.handle} is muted by @${seat.muted.by}: it can not write the notes until it is unmuted.`);
    const clean = text.replace(/\r\n?/g, "\n").trimEnd();
    if (clean.length > MAX_NOTES) throw new RoomError(400, `置顶笔记太长（最多 ${MAX_NOTES} 字）`);
    return this.save({ ...room, notes: clean ? { text: clean, at: this.now(), by: seat.handle } : null });
  }

  post(id: string, o: { readonly from: string; readonly text: string; readonly to?: readonly string[]; readonly replyTo?: number; readonly files?: readonly string[]; readonly expects?: "none" | "answer"; readonly task?: number }): Message {
    const room = this.get(id);
    const from = this.seatOf(room, o.from);
    if (from.left !== undefined) throw new RoomError(403, "这个席位已经离开房间");
    if (from.muted) throw new RoomError(403, `@${from.handle} is muted by @${from.muted.by}: it can not post until it is unmuted.`);
    const text = o.text.replace(/\r\n?/g, "\n").trim();
    // A picture alone says enough: words are needed only when nothing comes with them.
    if (!text && !(o.files ?? []).some((f) => f.trim())) throw new RoomError(400, "消息是空的");
    if (text.length > MAX_TEXT) throw new RoomError(400, `消息太长（最多 ${MAX_TEXT} 字）`);
    // A session says what came of it and where the rest is (2026-11-24, user: 臃肿的回复放到文件里): what is long
    // goes into the shared folder, and the message names the file. The user writes as long as the user likes.
    if (from.kind === "session" && [...text].length > MAX_SESSION_TEXT) throw new RoomError(400, `Too long for a message (${[...text].length} characters; at most ${MAX_SESSION_TEXT}). Write the full text into a file in the room's shared folder (${this.folder(id)}), then post the conclusion in a few lines and the file's path (\`files\`).`);
    if (o.replyTo !== undefined && !(Number.isInteger(o.replyTo) && o.replyTo >= 1 && o.replyTo <= room.lastSeq)) throw new RoomError(400, `没有 #${o.replyTo} 这条消息`);
    const files = [...new Set((o.files ?? []).map((f) => f.trim()).filter(Boolean))];
    if (files.length > MAX_FILES) throw new RoomError(400, `一条消息最多带 ${MAX_FILES} 个文件`);
    if (files.some((f) => !f.startsWith("/") || f.length > 4096 || /[\n\r\0]/.test(f))) throw new RoomError(400, "文件要写它在这个节点上的完整路径");
    // An answer is for the one it answers, whether or not it is named again (2026-11-23: the user answered a
    // session's message and then had to write a second one that was nothing but its name).
    const answered = o.replyTo === undefined ? undefined : this.messages(id, { after: o.replyTo - 1, limit: 1 })[0];
    if (o.task !== undefined && !room.tasks.some((t) => t.n === o.task)) throw new RoomError(400, `任务表里没有 T${o.task}`);
    const task = o.task ?? (answered && answered.seq === o.replyTo ? answered.task : undefined);
    // Only when it names nobody else (user #260: a session answered the user's message while asking another
    // session, and the question went to the user's 等你处理 too).
    const named = [...mentions(text), ...(o.to ?? []).map((n) => n.replace(/^@/, "").toLowerCase())];
    if (answered && answered.seq === o.replyTo && named.length === 0) named.push(answered.from);
    const here = room.seats.filter((s) => s.left === undefined && s.handle !== from.handle);
    for (let i = 0; i < named.length; i++) named[i] = handleIn(room, named[i]!);
    // `@all` is the user's alone (§4). Written by a session it is words and calls nobody: refusing the whole message
    // for it cost a session its report twice (2026-11-23), when it only spoke of the rule.
    // At the dispatch desk what the user says is for the dispatch, named or not (2026-11-24).
    const to = (named.includes(ALL) || (room.desk && named.length === 0)) && from.kind === "user"
      ? here.filter((s) => s.kind === "session").map((s) => s.handle)
      : here.filter((s) => named.includes(s.handle)).map((s) => s.handle);
    // The file of messages is written first: after a crash between the two it may be one ahead of the room's count.
    const message: Message = { seq: Math.max(room.lastSeq, this.db.last(id)?.seq ?? 0) + 1, from: from.handle, to, ...(o.replyTo === undefined ? {} : { replyTo: o.replyTo }), text, at: this.now(), ...(files.length ? { files } : {}), ...(o.expects ? { expects: o.expects } : {}), ...(task === undefined ? {} : { task }) };
    const waiting = to.filter((h) => h !== YOU);
    this.count(id, from.handle, { posts: 1 }, message.task);
    this.db.add(id, message, JSON.stringify(message));
    this.save({
      ...room, lastSeq: message.seq,
      // What the user says, the user has seen.
      readSeq: from.kind === "user" ? message.seq : room.readSeq,
      receipts: waiting.length ? { ...room.receipts, [message.seq]: Object.fromEntries(waiting.map((h) => [h, "sent" as Receipt])) } : room.receipts,
    });
    this.writeRecord(this.get(id), message);
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

  private lastAt(room: Room): number { return this.last(room.id)?.at ?? room.createdAt; }

  private all(): Map<string, Room> {
    if (this.rooms) return this.rooms;
    // The rooms kept as files before the database: read in once, the folder kept aside.
    if (!this.db.rooms().length) importFiles(this.db, this.dir, { room: roomFrom, message: messageFrom });
    const rooms = new Map<string, Room>();
    for (const state of this.db.rooms()) {
      try { const room = roomFrom(JSON.parse(state)); if (room) rooms.set(room.id, room); } catch { /* not a room */ }
    }
    return (this.rooms = rooms);
  }



  // ---- the room's record, in its shared folder

  private readonly recorded = new Map<string, string>();

  /** The room as files in its shared folder, `_room/` (user, 2026-11-23: a session that takes the work over must be
   *  able to at any time): what was said, the tasks, the pinned notes, who sits here — kept as they change, read
   *  with a session's own file tools (searched, read in part) instead of paged through a tool. Beside them each
   *  member's own handover note (`handoff-<name>.md`, written by itself): what only it knows. */
  recordDir(id: string): string { return join(this.filesDir, id, RECORD_DIR); }

  private writeRecord(room: Room, said?: Message): void {
    try {
      const dir = this.recordDir(room.id);
      const put = (name: string, text: string): void => {
        const key = `${room.id}/${name}`;
        if (this.recorded.get(key) === text && existsSync(join(dir, name))) return;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, name), text, { mode: 0o600 });
        this.recorded.set(key, text);
      };
      const here = room.seats.filter((s) => s.left === undefined);
      const state = (t: Task): string => (t.state === "todo" ? "to do" : t.state);
      put("README.md", [
        `# ${room.name}`, "", room.topic || "(no topic)", "",
        "This folder is the room's own record, kept by AgentSwitch as the room changes. Do not edit these files: they are written over.", "",
        "- `log.md` — everything said in the room, oldest first.",
        "- `tasks.md` — the task list: who does what, how far.",
        "- `notes.md` — the pinned notes: what was agreed.",
        "- `members.md` — who sits here.",
        "- `handoff-<name>.md` — a member's own handover note, written by that member: what it was doing, how far it is, what comes next, what to watch out for.", "",
        "Taking work over from another member: read `notes.md` and `tasks.md`, then that member's handover note, then search `log.md` for what concerns the task. Then take the task (room_tasks) and say so in the room.", "",
      ].join("\n"));
      put("tasks.md", [`# Tasks of ${room.name}`, "", ...(room.tasks.length ? room.tasks.map((t) => `## T${t.n} [${state(t)}${t.owner ? ` · @${t.owner}` : ""}] ${t.title}\n${t.after?.length ? `After: ${t.after.map((a) => `T${a}`).join(", ")}\n` : ""}Added by @${t.by}\n${t.detail ? `\n${t.detail}\n` : ""}${t.note ? `\nResult: ${t.note}\n` : ""}`) : ["No tasks."]), ""].join("\n"));
      put("notes.md", room.notes ? `# Pinned notes of ${room.name}\n\nLast written by @${room.notes.by}.\n\n${room.notes.text}\n` : `# Pinned notes of ${room.name}\n\nNone.\n`);
      put("members.md", [`# Members of ${room.name}`, "", ...here.map((s) => (s.kind === "user" ? "- @you — the user" : `- @${s.handle} — ${[s.was?.agent, s.was?.name ? `session "${s.was.name}"` : null, s.was?.cwd, s.canAdd ? "admin" : null, s.muted ? "muted" : null].filter(Boolean).join(" · ")}`)), ""].join("\n"));
      const line = (m: Message): string => `## #${m.seq} · ${stamp(m.at)}${m.task === undefined ? "" : ` · T${m.task}`} · @${m.from}${m.to.length ? ` → ${m.to.map((h) => `@${h}`).join(" ")}` : ""}${m.replyTo === undefined ? "" : ` (re #${m.replyTo})`}\n\n${m.text}\n${m.files?.length ? `\nFiles: ${m.files.join(", ")}\n` : ""}\n`;
      const log = join(dir, "log.md");
      if (said && existsSync(log)) appendFileSync(log, line(said), { mode: 0o600 });
      else if (said || !existsSync(log)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(log, `# What was said in ${room.name}\n\n${this.messages(room.id).map(line).join("")}`, { mode: 0o600 }); }
    } catch { /* the record is a convenience: the room itself is kept elsewhere */ }
  }

  /** The whole log written anew (after a rename: the names in it changed). */
  private rewriteLog(room: Room): void {
    try { rmSync(join(this.recordDir(room.id), "log.md"), { force: true }); } catch { /* not there */ }
    this.writeRecord(room);
  }

  /** A room that goes takes its record with it when the record is all its folder holds; with the members' own files
   *  there, the record stays among them and goes to the Trash with the folder. */
  private dropRecordIfAlone(id: string): void {
    try {
      const dir = join(this.filesDir, id);
      if (readdirSync(dir).every((name) => name === RECORD_DIR) && readdirSync(this.recordDir(id)).every((n) => ["README.md", "log.md", "tasks.md", "notes.md", "members.md"].includes(n))) rmSync(this.recordDir(id), { recursive: true, force: true });
    } catch { /* no folder */ }
  }

  private save(given: Room): Room {
    // The counts are added to in memory between two writes (`count`): the newest are the ones kept.
    const kept = this.all().get(given.id);
    const room: Room = { ...given, stats: kept?.stats ?? given.stats, taskStats: kept?.taskStats ?? given.taskStats, reads: kept?.reads ?? given.reads };
    this.all().set(room.id, room);
    this.db.putRoom(room.id, JSON.stringify(room));
    this.writeRecord(room);
    return room;
  }
}

/** Messages as the database keeps them, read back; one that does not read is left out. */
function parsed(rows: readonly StoredMessage[]): Message[] {
  const out: Message[] = [];
  for (const r of rows) { try { const m = messageFrom(JSON.parse(r.body)); if (m) out.push(m); } catch { /* not a message */ } }
  return out;
}

function statsFrom(v: unknown): Record<string, SeatStats> {
  const out: Record<string, SeatStats> = {};
  for (const [k, c] of Object.entries((v ?? {}) as Record<string, unknown>)) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    out[k] = { wakes: num(o.wakes) ? o.wakes : 0, chars: num(o.chars) ? o.chars : 0, posts: num(o.posts) ? o.posts : 0, calls: num(o.calls) ? o.calls : 0 };
  }
  return out;
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
  const e = o.session as Record<string, unknown> | undefined;
  const session = e && str(e.id) && str(e.cwd) ? { id: e.id, cwd: e.cwd, ...(str(e.mode) ? { mode: e.mode } : {}), ...(str(e.model) ? { model: e.model } : {}), ...(str(e.effort) ? { effort: e.effort } : {}), ...(str(e.profile) ? { profile: e.profile } : {}) } : undefined;
  const m = o.muted as Record<string, unknown> | undefined;
  const muted = m && str(m.by) && num(m.at) ? { by: m.by, at: m.at } : undefined;
  return {
    handle: o.handle, kind: o.kind, ...(str(o.terminal) ? { terminal: o.terminal } : {}), face, joinedAt: o.joinedAt,
    addedBy: str(o.addedBy) ? o.addedBy : YOU, canAdd: o.canAdd === true, byAgent: o.byAgent === true,
    ...(num(o.left) ? { left: o.left } : {}), ...(was ? { was } : {}), ...(str(o.starter) ? { starter: o.starter } : {}),
    ...(muted ? { muted } : {}), ...(session ? { session } : {}),
  };
}

function roomFrom(v: unknown): Room | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!str(o.id) || !ID.test(o.id) || !str(o.name) || !Array.isArray(o.seats)) return null;
  const seats = o.seats.flatMap((s) => { const seat = seatFrom(s); return seat ? [seat] : []; });
  if (!seats.some((s) => s.kind === "user")) return null;
  const n = o.notes as Record<string, unknown> | null | undefined;
  const tasks = (Array.isArray(o.tasks) ? o.tasks : []).flatMap((v): Task[] => {
    const t = v as Record<string, unknown> | null;
    if (!t || typeof t !== "object" || !num(t.n) || !str(t.title) || (t.state !== "todo" && t.state !== "doing" && t.state !== "blocked" && t.state !== "done")) return [];
    const after = Array.isArray(t.after) ? t.after.filter(num) : [];
    return [{ n: t.n, title: t.title, ...(str(t.detail) ? { detail: t.detail } : {}), state: t.state, ...(str(t.owner) ? { owner: t.owner } : {}), by: str(t.by) ? t.by : YOU, createdAt: num(t.createdAt) ? t.createdAt : 0, updatedAt: num(t.updatedAt) ? t.updatedAt : 0, ...(after.length ? { after } : {}), ...(str(t.note) ? { note: t.note } : {}) }];
  });
  const stats: Record<string, SeatStats> = {};
  for (const [handle, v] of Object.entries((o.stats ?? {}) as Record<string, unknown>)) {
    const c = v as Record<string, unknown> | null;
    if (c && typeof c === "object") stats[handle] = { wakes: num(c.wakes) ? c.wakes : 0, chars: num(c.chars) ? c.chars : 0, posts: num(c.posts) ? c.posts : 0, calls: num(c.calls) ? c.calls : 0 };
  }
  const claims = (Array.isArray(o.claims) ? o.claims : []).flatMap((v): Claim[] => {
    const c = v as Record<string, unknown> | null;
    if (!c || typeof c !== "object" || !str(c.handle) || !Array.isArray(c.paths) || !num(c.until)) return [];
    return [{ handle: c.handle, paths: c.paths.filter(str), ...(str(c.why) ? { why: c.why } : {}), at: num(c.at) ? c.at : 0, until: c.until }];
  });
  const receipts: Record<string, Record<string, Receipt>> = {};
  for (const [seq, of] of Object.entries((o.receipts ?? {}) as Record<string, unknown>)) {
    if (!/^\d+$/.test(seq) || !of || typeof of !== "object") continue;
    const kept = Object.fromEntries(Object.entries(of as Record<string, unknown>).filter(([, r]) => str(r) && RECEIPTS.has(r))) as Record<string, Receipt>;
    if (Object.keys(kept).length) receipts[seq] = kept;
  }
  return {
    id: o.id, name: o.name, topic: str(o.topic) ? o.topic : "", createdAt: num(o.createdAt) ? o.createdAt : 0, createdBy: str(o.createdBy) ? o.createdBy : YOU,
    paused: o.paused === true, ...(o.desk === true ? { desk: true as const } : {}), seats, lastSeq: num(o.lastSeq) ? o.lastSeq : 0, readSeq: num(o.readSeq) ? o.readSeq : 0,
    roundsLimit: num(o.roundsLimit) ? o.roundsLimit : ROUNDS_LIMIT, roundsFrom: num(o.roundsFrom) ? o.roundsFrom : 0, receipts,
    notes: n && str(n.text) && num(n.at) ? { text: n.text, at: n.at, by: str(n.by) ? n.by : YOU } : null,
    tasks, lastTask: Math.max(num(o.lastTask) ? o.lastTask : 0, ...tasks.map((t) => t.n)), claims, stats, taskStats: statsFrom(o.taskStats), readsFrom: num(o.readsFrom) ? o.readsFrom : (num(o.lastSeq) ? o.lastSeq : 0), reads: Object.fromEntries(Object.entries((o.reads ?? {}) as Record<string, unknown>).filter(([seq, v]) => /^\d+$/.test(seq) && Array.isArray(v)).map(([seq, v]) => [seq, (v as unknown[]).filter(str)])), renames: Object.fromEntries(Object.entries((o.renames ?? {}) as Record<string, unknown>).filter((e): e is [string, string] => str(e[1]))),
  };
}

function messageFrom(v: unknown): Message | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  // A message of files alone has no words: it is kept all the same.
  if (!num(o.seq) || !str(o.from) || typeof o.text !== "string" || !num(o.at)) return null;
  return { seq: o.seq, from: o.from, to: Array.isArray(o.to) ? o.to.filter(str) : [], ...(num(o.replyTo) ? { replyTo: o.replyTo } : {}), text: o.text, at: o.at, ...(Array.isArray(o.files) && o.files.some(str) ? { files: o.files.filter(str) } : {}), ...(o.expects === "none" || o.expects === "answer" ? { expects: o.expects } : {}), ...(num(o.task) ? { task: o.task } : {}) };
}
