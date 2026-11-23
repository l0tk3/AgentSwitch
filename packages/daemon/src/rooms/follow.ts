/** Seats follow their sessions (docs/chatroom-v0.md §6.2). A seat names a terminal, and a terminal does not last: the
 *  service starts again, or the user closes it and resumes the session in another. The conversation is the same one;
 *  so the seat keeps the agent's own session id while its terminal lives, and when that terminal is gone and the same
 *  session runs in another, the seat goes there by itself — nobody has to bring it back. */

import type { RoomStore, SeatSession, SeatWas } from "./store.js";

/** A terminal as the rooms need to know it. */
export type Running = {
  readonly id: string;
  readonly exited: boolean;
  /** The agent's own session id, once it has said it. */
  readonly session: string | null;
  /** The session it was continued from; with `forked` it is a new session, not that one. */
  readonly resumedFrom: string | null;
  readonly forked: boolean;
  /** The folder it was started in. */
  readonly cwd: string;
  readonly mode?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly profile?: string;
  readonly was: SeatWas;
};

const sessionOf = (t: Running): SeatSession | null =>
  t.session ? { id: t.session, cwd: t.cwd, ...(t.mode ? { mode: t.mode } : {}), ...(t.model ? { model: t.model } : {}), ...(t.effort ? { effort: t.effort } : {}), ...(t.profile ? { profile: t.profile } : {}) } : null;

/** Looks at every seat once: one whose terminal lives has its session noted; one whose terminal is gone or has ended
 *  is moved to the terminal its session runs in now, if there is one. The rooms whose seats moved. */
export function follow(store: RoomStore, running: readonly Running[]): string[] {
  const byId = new Map(running.map((t) => [t.id, t]));
  const alive = running.filter((t) => !t.exited);
  const moved: string[] = [];
  for (const room of store.list()) {
    const taken = new Set(room.seats.flatMap((s) => (s.left === undefined && s.terminal ? [s.terminal] : [])));
    for (const seat of room.seats) {
      if (seat.kind !== "session" || seat.left !== undefined || !seat.terminal) continue;
      const now = byId.get(seat.terminal);
      if (now && !now.exited) {
        const session = sessionOf(now);
        if (session) store.note(room.id, seat.handle, session);
        continue;
      }
      const free = alive.filter((t) => !taken.has(t.id) && t.was.agent === seat.was?.agent);
      // The same session, by its id: running again, or continued (not forked) in another terminal.
      const id = seat.session?.id ?? now?.session ?? null;
      let next = id ? free.find((t) => t.session === id || (t.resumedFrom === id && !t.forked)) : undefined;
      // A seat taken before session ids were kept has only its agent and its name: taken when exactly one fits.
      if (!next && !id) {
        const same = free.filter((t) => t.was.name === seat.was?.name);
        if (same.length === 1) next = same[0];
      }
      if (!next) continue;
      try {
        store.rebind(room.id, seat.handle, next.id, next.was);
        const session = sessionOf(next);
        if (session) store.note(room.id, seat.handle, session);
        taken.add(next.id);
        moved.push(room.id);
      } catch { /* taken meanwhile: it stays ended */ }
    }
  }
  return [...new Set(moved)];
}
