/** What a snapshot is read from (docs/terminal-v0.md §2 "快照"): the headless terminal as its screen shows it — no line
 *  longer than the screen is wide.
 *
 *  After the screen narrows, xterm.js keeps each line's cells past the new right edge (to show them again if it widens;
 *  the normal screen reflows, the alternate one does not), and the serialize addon writes a row up to the line's length,
 *  not the screen's width. So a snapshot taken after a narrowing carried the old, wider rows: drawn on a screen of the
 *  new width they wrapped, every row onto two lines, the old frame showing through the new one (2026-09-30, OpenCode
 *  garbled on the phone). This view hands the addon every line cut at the screen's width; it reads through the public
 *  API only, and changes nothing in the terminal. */

import type headless from "@xterm/headless";

type Terminal = InstanceType<typeof headless.Terminal>;
type Buffer = Terminal["buffer"]["active"];
type Line = NonNullable<ReturnType<Buffer["getLine"]>>;

export function screenView(term: Terminal): Terminal {
  const line = (l: Line): Line => new Proxy(l, {
    get: (target, key) => (key === "length" ? Math.min(target.length, term.cols) : Reflect.get(target, key)),
  });
  const buffer = (b: Buffer): Buffer => new Proxy(b, {
    get: (target, key) => {
      if (key !== "getLine") return Reflect.get(target, key);
      return (y: number) => { const l = target.getLine(y); return l && line(l); };
    },
  });
  const buffers = new Proxy(term.buffer, {
    get: (target, key) => (key === "active" || key === "normal" || key === "alternate" ? buffer(target[key]) : Reflect.get(target, key)),
  });
  return new Proxy(term, { get: (target, key) => (key === "buffer" ? buffers : Reflect.get(target, key)) });
}
