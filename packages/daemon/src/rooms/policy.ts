/** Which models an admin may start a session on, under which profile (docs/chatroom-v0.md §6.2, user 2026-11-23: an
 *  admin that brings sessions in picks the profile and the model, and must not be free to reach for a low-end model
 *  again and again). The user turns a model off for a profile; everything else is allowed. It binds only sessions
 *  that a session starts (`room_add`): what the user starts is the user's own choice. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class RoomPolicy {
  private readonly file: string;
  private off: Record<string, string[]> | null = null;

  constructor(private readonly home: string) { this.file = join(home, "room-models.json"); }

  private all(): Record<string, string[]> {
    if (this.off) return this.off;
    const read: Record<string, string[]> = {};
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { off?: unknown };
      for (const [key, list] of Object.entries((raw.off ?? {}) as Record<string, unknown>)) if (Array.isArray(list)) read[key] = list.filter((m): m is string => typeof m === "string" && !!m);
    } catch { /* none set yet */ }
    return (this.off = read);
  }

  /** The models turned off for admins under a profile of an agent. */
  offFor(agent: string, profile: string): readonly string[] { return this.all()[`${agent}.${profile}`] ?? []; }

  allows(agent: string, profile: string, model: string): boolean { return !this.offFor(agent, profile).includes(model); }

  set(agent: string, profile: string, off: readonly string[]): readonly string[] {
    const next = { ...this.all() };
    const clean = [...new Set(off.map((m) => m.trim()).filter(Boolean))].slice(0, 200);
    if (clean.length) next[`${agent}.${profile}`] = clean; else delete next[`${agent}.${profile}`];
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ off: next }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.off = next;
    return clean;
  }
}
