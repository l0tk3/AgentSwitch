/** A member taken back to before a room's message (rooms/rewind.ts; user #288, #290, #293): its record is cut as a new
 *  session, its terminal is closed and the new session goes on in another, where its seat sits — name, face, switches
 *  and all. What it was handed in the stretch taken back is on its way to it again; what it said there is marked
 *  「已退回」. Only Claude Code's (its record is known); only its conversation — its files go back only when the user
 *  asks (`filesOf`, `putBack`).
 *
 *  - recalling a message (撤回): its sender goes back to before it sent it, each member that had it to before it was
 *    handed it;
 *  - Claude's safeguard refused a member's reply to a room's message: it goes back to before that message, which is
 *    not given to it again, and its face carries a mark until the user has seen it. */

import { existsSync } from "node:fs";
import type { Ask } from "./roomOrg.js";
import { roomOrg } from "./roomOrg.js";
import { resumeSeat } from "../rooms/kit.js";
import { cutBeforeHanded, cutBeforeRefused, cutBeforeSent, filesBack, putFilesBack, readRecord, refusedLast, writeCut, type Cut, type FileBack } from "../rooms/rewind.js";
import { RoomError, type RoomStore, type Seat, type SeatSession, type SeatWas } from "../rooms/store.js";
import { YOU } from "../rooms/names.js";
import type { TerminalHost, TerminalInfo } from "../terminals/host.js";
import { tailLines } from "../sessions/jsonl.js";

export type RewindDeps = {
  readonly rooms: RoomStore;
  readonly host: () => TerminalHost | undefined;
  readonly callLocal?: Ask;
  /** Where a Claude Code session's record is, by its id. */
  readonly locate: (session: string) => string | null;
  /** The new session runs under the profile the old one did. */
  readonly noteProfile: (session: string, profile: string | null) => void;
  readonly sessionOf: (info: TerminalInfo) => SeatSession | null;
  readonly wasOf: (info: TerminalInfo) => SeatWas;
  readonly changed?: (roomId: string) => void;
};

export type Rewound = { readonly handle: string; readonly ok: true; readonly terminal: string; readonly again: readonly number[] } | { readonly handle: string; readonly ok: false; readonly error: string };

type How = { readonly kind: "handed" | "sent"; readonly seq: number } | { readonly kind: "refused" };

const BUSY = new Set<string>();

export class SeatRewind {
  /** Refused replies already dealt with, by their line's id. */
  private readonly refusals = new Set<string>();
  constructor(private readonly d: RewindDeps) {}

  private recordOf(seat: Seat): { readonly path: string; readonly session: SeatSession; readonly info: TerminalInfo | null } {
    const info = seat.terminal ? this.d.host()?.get(seat.terminal) ?? null : null;
    const session = (info ? this.d.sessionOf(info) : null) ?? seat.session ?? null;
    if (!session) throw new RoomError(409, `@${seat.handle} 没有记下会话，找不到它的对话记录。`);
    const path = (info && seat.terminal ? this.d.host()?.recordFileOf(seat.terminal) : null) ?? this.d.locate(session.id);
    if (!path || !existsSync(path)) throw new RoomError(409, `找不到 @${seat.handle} 的对话记录。`);
    return { path, session, info };
  }

  /** Takes one seat back. `skip`: messages not given to it again. */
  async rewind(roomId: string, handle: string, how: How, why: "recall" | "safeguard", skip: readonly number[] = []): Promise<Rewound & { readonly cut?: Cut }> {
    const key = `${roomId}:${handle}`;
    if (BUSY.has(key)) return { handle, ok: false, error: "正在退回" };
    BUSY.add(key);
    try {
      const room = this.d.rooms.get(roomId);
      const seat = room.seats.find((s) => s.handle === handle);
      if (!seat || seat.kind !== "session" || seat.left !== undefined) return { handle, ok: false, error: "不在房间里" };
      if ((seat.was?.agent ?? this.d.host()?.get(seat.terminal ?? "")?.harness) !== "claude-code") return { handle, ok: false, error: "只有 Claude Code 能退回" };
      if (!this.d.callLocal) return { handle, ok: false, error: "这个服务不能重开会话" };
      const { path, session, info } = this.recordOf(seat);
      const lines = readRecord(path);
      const cut = how.kind === "handed" ? cutBeforeHanded(lines, room.name, how.seq)
        : how.kind === "sent" ? cutBeforeSent(lines, room.name, how.seq)
        : (() => { const r = refusedLast(lines); return r ? cutBeforeRefused(lines, room.name, r.line) : null; })();
      if (!cut) return { handle, ok: false, error: how.kind === "refused" ? "它被拒的回复不是在回群里的消息" : "它的对话记录里没有这条消息" };
      if (cut.line === 0) return { handle, ok: false, error: "退回去对话就空了" };
      const made = writeCut(path, lines, cut.line);
      this.d.noteProfile(made.id, session.profile ?? null);
      const org = roomOrg(this.d.callLocal);
      if (seat.terminal && info && info.status !== "exited") await org.stop(seat.terminal);
      const next = { ...seat, session: { ...session, id: made.id } };
      const done = await resumeSeat(this.d.rooms, org, roomId, next, (t) => { const now = this.d.host()?.get(t); return now ? this.d.wasOf(now) : null; });
      this.d.rooms.note(roomId, handle, next.session);
      const left = new Set([...skip, ...(how.kind === "refused" ? cut.first : how.kind === "handed" || how.kind === "sent" ? [how.seq] : [])]);
      const again = cut.handed.filter((s) => !left.has(s));
      this.d.rooms.rewind(roomId, handle, cut.at, again, { at: Date.now(), why, seq: how.kind === "refused" ? cut.first[0] ?? 0 : how.seq, record: path, line: cut.line, marked: why === "safeguard" }, [...left]);
      this.d.changed?.(roomId);
      return { handle, ok: true, terminal: done.terminal, again, cut };
    } catch (err) {
      return { handle, ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally { BUSY.delete(key); }
  }

  /** 撤回 (user #288): the message is deleted, its sender goes back to before it sent it, each member it reached to
   *  before it was handed it. One that can not be taken back (another agent, it read it only with room_read) is told
   *  in a line to leave it aside. */
  async recall(roomId: string, seq: number): Promise<{ readonly reached: string[]; readonly withdrawn: string[]; readonly rewound: Rewound[]; readonly told?: number }> {
    const message = this.d.rooms.messages(roomId, { after: seq - 1, limit: 1 })[0];
    if (!message || message.seq !== seq) throw new RoomError(404, `没有 #${seq} 这条消息`);
    const done = this.d.rooms.deleteMessage(roomId, seq);
    const rewound: Rewound[] = [];
    const room = this.d.rooms.get(roomId);
    const isSession = (h: string) => room.seats.some((s) => s.handle === h && s.kind === "session" && s.left === undefined);
    if (message.from !== YOU && isSession(message.from)) rewound.push(strip(await this.rewind(roomId, message.from, { kind: "sent", seq }, "recall")));
    for (const h of done.reached) if (h !== message.from && isSession(h)) rewound.push(strip(await this.rewind(roomId, h, { kind: "handed", seq }, "recall")));
    const tell = rewound.filter((r) => !r.ok && r.handle !== message.from).map((r) => r.handle);
    let told: number | undefined;
    if (tell.length) told = this.d.rooms.post(roomId, { from: YOU, text: `〔撤回〕#${seq} 已被删除，请忽略它说的内容。`, to: tell, expects: "none" }).seq;
    this.d.changed?.(roomId);
    return { ...done, rewound, ...(told === undefined ? {} : { told }) };
  }

  /** A turn of `terminal`'s ended: if Claude's safeguard refused its last reply, and that reply answered a room's
   *  message, it goes back to before that message (once per refusal). True when it was refused (nothing is to be
   *  handed it now). */
  refused(terminal: string): boolean {
    const path = this.d.host()?.recordFileOf(terminal);
    if (!path || !existsSync(path)) return false;
    let tail: string[];
    try { tail = tailLines(path, 256 * 1024).map((l) => JSON.stringify(l)); } catch { return false; }
    const r = refusedLast(tail);
    if (!r || this.refusals.has(r.uuid)) return false;
    this.refusals.add(r.uuid);
    const sits = this.d.rooms.roomsOf(terminal);
    if (!sits.length) return false;
    void (async () => {
      for (const { room, seat } of sits) {
        const done = await this.rewind(room.id, seat.handle, { kind: "refused" }, "safeguard");
        if (!done.ok) continue;
        const what = done.cut?.first.length ? done.cut.first.map((n) => `#${n}`).join("、") : "群里的消息";
        try { this.d.rooms.post(room.id, { from: seat.handle, text: `〔退回〕我回复 ${what} 时触发了 Claude 的 safeguard，已自动退回到收到它之前，它不会再送给我。`, expects: "none" }); } catch { /* muted: the mark on its face still says it */ }
        this.d.changed?.(room.id);
        return;
      }
    })();
    return true;
  }

  /** What putting a seat's files back to before its last rewind would do. */
  filesOf(roomId: string, handle: string): FileBack[] {
    const r = this.rewoundOf(roomId, handle);
    return filesBack(readRecord(r.record), r.line);
  }

  /** Puts them back; `force`: also those changed since. */
  putBack(roomId: string, handle: string, force: boolean): string[] {
    const r = this.rewoundOf(roomId, handle);
    return putFilesBack(readRecord(r.record), r.line, force);
  }

  private rewoundOf(roomId: string, handle: string): NonNullable<Seat["rewound"]> {
    const seat = this.d.rooms.get(roomId).seats.find((s) => s.handle === handle);
    if (!seat?.rewound) throw new RoomError(404, `@${handle} 没有退回过`);
    if (!existsSync(seat.rewound.record)) throw new RoomError(409, "它原来的对话记录已经不在了");
    return seat.rewound;
  }
}

const strip = (r: Rewound & { readonly cut?: Cut }): Rewound => { const { cut: _c, ...rest } = r as Rewound & { cut?: Cut }; return rest as Rewound; };
