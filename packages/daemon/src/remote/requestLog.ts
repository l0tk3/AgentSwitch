/** The daemon log's line for each write a paired device makes (docs/app-v0.md §6), with the requests that come many a
 *  second while someone types, scrolls, points or resizes taken together: the first of them in a minute is a line as
 *  any other, the rest of that minute one more line saying how many there were. A Mac typing into a Linux node's
 *  terminal had put a line a keystroke into the journal (2026-10-13). A request that failed is always a line of its own. */

/** Typing, scrolling, pointing and resizing, in a terminal or a browser tab (the shared browser's or a profile's). */
const STREAMED = /^\/(?:terminals\/[^/]+\/(?:write|keys|resize|redraw)|(?:profile-browser\/[^/]+\/)?browser\/tabs\/[^/]+\/(?:input|viewport))$/;
export const STREAMED_WINDOW_MS = 60_000;

export type Schedule = (fn: () => void, ms: number) => void;
const unrefTimer: Schedule = (fn, ms) => { setTimeout(fn, ms).unref(); };

export class RemoteRequestLog {
  /** Per device, method and path: how many more came since its line, until its minute is over. */
  private readonly open = new Map<string, number>();

  constructor(private readonly log: (line: string) => void, private readonly schedule: Schedule = unrefTimer, private readonly windowMs = STREAMED_WINDOW_MS) {}

  /** `why`: what the service answered a refused request with (its `error`), on one line and cut short. */
  write(device: string, method: string, path: string, status: number, why?: string): void {
    const what = `remote: device ${device} ${method} ${path}`;
    if (status >= 400 || !STREAMED.test(path)) { this.log(`${what} → ${status}${status >= 400 && why ? ` (${why.replace(/\s+/g, " ").slice(0, 160)})` : ""}`); return; }
    const more = this.open.get(what);
    if (more !== undefined) { this.open.set(what, more + 1); return; }
    this.log(`${what} → ${status}`);
    this.open.set(what, 0);
    this.schedule(() => {
      const n = this.open.get(what) ?? 0;
      this.open.delete(what);
      if (n > 0) this.log(`${what} ×${n} more in that minute`);
    }, this.windowMs);
  }
}
