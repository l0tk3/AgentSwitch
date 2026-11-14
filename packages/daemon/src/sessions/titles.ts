/** The titles agents gave their own sessions while they ran in a terminal here (docs/terminal-v0.md §1 “名字”,
 *  2026-11-11). Claude Code sets its terminal's title to a line about what the session is doing; that line goes to the
 *  terminal and nowhere else — its record holds no title — so once the terminal ended, the session's row fell back to
 *  the first thing the user said in it, and Codex's rows never were anything else (user: 改成 记住 agent 给的标题 吧).
 *  The last title worth showing is kept here by agent and session, and the list of sessions reads it for one the user
 *  has not named in the agent itself.
 *
 *  One small file in AgentSwitch's own folder, the user's alone to read. A title is what the terminal's row already
 *  showed; nothing is asked of any model. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** `title` "": the session ran in a terminal here and its agent gave it no title worth showing. */
type Kept = { readonly title: string; readonly at: number; readonly custom?: string };
/** The newest so many are kept. */
const MAX_KEPT = 3000;
const MAX_TITLE = 200;
const WRITE_AFTER_MS = 1500;

export class SessionTitles {
  private readonly file: string;
  private kept: Map<string, Kept> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(home: string, private readonly now: () => number = Date.now) { this.file = join(home, "sessions", "titles.json"); }

  /** The title the agent gave session `id` last; null: none known. */
  get(harness: string, id: string): string | null { return this.all().get(`${harness}:${id}`)?.title || null; }

  custom(harness: string, id: string): string | null { return this.all().get(`${harness}:${id}`)?.custom || null; }

  rename(harness: string, id: string, name: string | null): void {
    if (!id) return;
    const key = `${harness}:${id}`, previous = this.all().get(key);
    this.all().set(key, { title: previous?.title ?? "", at: this.now(), ...(name ? { custom: name.slice(0, MAX_TITLE) } : {}) });
    this.later();
    this.flush();
  }

  /** Session `id` ran in a terminal the user started here (it is theirs wherever its folder is: sessions/monitor.ts). */
  ran(harness: string, id: string): boolean { return this.all().has(`${harness}:${id}`); }

  /** Session `id` runs in a terminal here now. */
  seen(harness: string, id: string): void {
    const all = this.all(), key = `${harness}:${id}`;
    if (!id || all.has(key)) return;
    all.set(key, { title: "", at: this.now() });
    this.later();
  }

  /** Session `id`'s agent calls it `title` now. */
  note(harness: string, id: string, title: string): void {
    const text = title.trim().slice(0, MAX_TITLE);
    if (!id || !text) return;
    const all = this.all(), key = `${harness}:${id}`;
    if (all.get(key)?.title === text) return;
    const custom = all.get(key)?.custom;
    all.delete(key);   // the newest last
    all.set(key, { title: text, at: this.now(), ...(custom ? { custom } : {}) });
    this.later();
  }

  private later(): void {
    const all = this.all();
    while (all.size > MAX_KEPT) all.delete(all.keys().next().value as string);
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, WRITE_AFTER_MS);
    this.timer.unref();
  }

  forget(harness: string, id: string): void {
    if (this.all().delete(`${harness}:${id}`)) this.flush();
  }

  /** What is kept is on disk now (the service is closing; a test). */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.kept) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.kept)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) { console.error(`sessions: titles not kept (${(err as Error).message})`); }
  }

  private all(): Map<string, Kept> {
    if (this.kept) return this.kept;
    const kept = new Map<string, Kept>();
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, { title?: unknown; at?: unknown; custom?: unknown }>;
      for (const [key, value] of Object.entries(doc)) if (typeof value?.title === "string") kept.set(key, { title: value.title.slice(0, MAX_TITLE), at: Number(value.at) || 0, ...(typeof value.custom === "string" ? { custom: value.custom.slice(0, MAX_TITLE) } : {}) });
    } catch { /* none kept yet, or not readable: begun again */ }
    return (this.kept = kept);
  }
}
