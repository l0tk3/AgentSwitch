// The terminal page's split panes (docs/terminal-v0.md §1 分屏, 2026-10-03, user: 有时候我希望同时调度多个终端窗口，所以
// 想加一个分屏协作功能，可以用鼠标调整分屏的大小，然后指定选择目录树里的某个session到指定分屏里; demo
// docs/design/implemented/split.html): the terminal area as a binary tree of splits, as iTerm2's and tmux's panes are.
//   pane  { k: "pane", id, term, was? }           term: the terminal it shows (null: empty); was: the session to go on with
//   split { k: "split", id, dir, ratio, a, b }    dir "row": a left of b; "col": a above b; ratio: a's share
// Every change returns a new tree. A terminal is in one pane at most. Nothing here touches the page.

export const MAX_PANES = 4;
/** The least a pane may be, in CSS px: about 40 × 8 cells and its header. */
export const MIN_W = 300, MIN_H = 160;
/** The line between two panes. */
export const GAP = 1;

export const single = (term = null) => ({ k: "pane", id: 1, term });
export const panesOf = (n, out = []) => (n.k === "pane" ? out.push(n) : (panesOf(n.a, out), panesOf(n.b, out)), out);
export const paneOf = (root, id) => panesOf(root).find((p) => p.id === id) ?? null;
export const paneShowing = (root, term) => (term ? panesOf(root).find((p) => p.term === term) ?? null : null);
const ids = (n) => (n.k === "pane" ? [n.id] : [n.id, ...ids(n.a), ...ids(n.b)]);
const nextId = (root) => Math.max(...ids(root)) + 1;
/** The tree with `fn`'s answer for each node it changes; what does not change stays the same object. */
const map = (n, fn) => {
  const r = fn(n);
  if (r !== n || n.k === "pane") return r;
  const a = map(n.a, fn), b = map(n.b, fn);
  return a === n.a && b === n.b ? n : { ...n, a, b };
};
const pane = (p, fields) => { const { was, ...rest } = p; return { ...rest, ...fields }; };

/** `term` in pane `id` (null empties it). Shown in another pane, it leaves that one, which closes. */
export function show(root, id, term) {
  let next = root;
  const from = paneShowing(root, term);
  if (from && from.id !== id) next = close(next, from.id);
  return map(next, (n) => (n.k === "pane" && n.id === id ? pane(n, { term }) : n));
}

/** A new pane beside pane `id` (`side`: left | right | top | bottom) holding `term`; null when the panes are all used or
 *  the pane is not there. Returns the tree and the new pane's id. */
export function split(root, id, side, term = null) {
  if (panesOf(root).length >= MAX_PANES || !paneOf(root, id)) return null;
  const fresh = { k: "pane", id: nextId(root), term };
  const dir = side === "left" || side === "right" ? "row" : "col", first = side === "left" || side === "top";
  const made = { k: "split", id: fresh.id + 1, dir, ratio: 0.5 };
  return { root: map(root, (n) => (n.k === "pane" && n.id === id ? { ...made, a: first ? fresh : n, b: first ? n : fresh } : n)), pane: fresh.id };
}

/** Without pane `id`: its sibling takes the room. The last pane stays (emptied). */
export function close(root, id) {
  if (root.k === "pane") return root.id === id ? pane(root, { term: null }) : root;
  const cut = (n) => {
    if (n.k === "pane") return n.id === id ? null : n;
    const a = cut(n.a), b = cut(n.b);
    if (!a) return b;
    if (!b) return a;
    return a === n.a && b === n.b ? n : { ...n, a, b };
  };
  return cut(root);
}

/** `term` let go on pane `id`: its middle (`center`) shows it there, an edge splits that side for it. Dragged out of
 *  another pane, that one closes. Returns the tree and the pane it is in; null when nothing changes. */
export function drop(root, term, id, zone) {
  const from = paneShowing(root, term);
  if (!paneOf(root, id) || (from && from.id === id)) return null;
  if (zone === "center") return { root: show(root, id, term), pane: id };
  const without = from ? close(root, from.id) : root;
  return split(without, id, zone, term);
}

/** A split's share for its first pane. */
export const resize = (root, id, ratio) => map(root, (n) => (n.k === "split" && n.id === id ? { ...n, ratio } : n));

/** The least room a subtree needs along an axis ("w" | "h"): panes side by side need both widths and the line. */
export function least(n, axis) {
  if (n.k === "pane") return axis === "w" ? MIN_W : MIN_H;
  const along = (n.dir === "row") === (axis === "w");
  return along ? least(n.a, axis) + least(n.b, axis) + GAP : Math.max(least(n.a, axis), least(n.b, axis));
}

/** Where each pane and each line between panes goes in rect `r` ({x, y, w, h}); a line's `box` is the split's own rect. */
export function place(n, r, out = { panes: [], lines: [] }) {
  if (n.k === "pane") { out.panes.push({ id: n.id, term: n.term, r }); return out; }
  if (n.dir === "row") {
    const w = Math.round((r.w - GAP) * n.ratio);
    place(n.a, { x: r.x, y: r.y, w, h: r.h }, out);
    out.lines.push({ id: n.id, dir: n.dir, r: { x: r.x + w, y: r.y, w: GAP, h: r.h }, box: r });
    place(n.b, { x: r.x + w + GAP, y: r.y, w: r.w - w - GAP, h: r.h }, out);
  } else {
    const h = Math.round((r.h - GAP) * n.ratio);
    place(n.a, { x: r.x, y: r.y, w: r.w, h }, out);
    out.lines.push({ id: n.id, dir: n.dir, r: { x: r.x, y: r.y + h, w: r.w, h: GAP }, box: r });
    place(n.b, { x: r.x, y: r.y + h + GAP, w: r.w, h: r.h - h - GAP }, out);
  }
  return out;
}

/** The share a line dragged to `at` (px from its split's start, along its axis) gives the first pane: every pane on
 *  both sides keeps its least size. */
export function ratioAt(root, id, box, at) {
  const find = (n) => (n.k === "pane" ? null : n.id === id ? n : find(n.a) ?? find(n.b));
  const n = find(root);
  if (!n) return 0.5;
  const axis = n.dir === "row" ? "w" : "h", total = (axis === "w" ? box.w : box.h) - GAP;
  if (total <= 0) return n.ratio;
  const lo = least(n.a, axis) / total, hi = 1 - least(n.b, axis) / total;
  return lo > hi ? 0.5 : Math.min(Math.max(at / total, lo), hi);
}

/** Where a drop at (x, y) lands in a pane's rect `r`: within a quarter of an edge it splits that side (the half shown),
 *  else, or with no room for two panes there, or with the panes all used (`full`), the middle. */
export function zoneOf(r, x, y, count) {
  const d = { left: (x - r.x) / r.w, right: 1 - (x - r.x) / r.w, top: (y - r.y) / r.h, bottom: 1 - (y - r.y) / r.h };
  const [edge, near] = Object.entries(d).sort((a, b) => a[1] - b[1])[0];
  const across = edge === "left" || edge === "right";
  const room = across ? r.w >= 2 * MIN_W + GAP : r.h >= 2 * MIN_H + GAP;
  const full = count >= MAX_PANES;
  if (near > 0.25 || !room || full) return { zone: "center", r, full: near <= 0.25 && full };
  const half = { left: { ...r, w: r.w / 2 }, right: { ...r, x: r.x + r.w / 2, w: r.w / 2 }, top: { ...r, h: r.h / 2 }, bottom: { ...r, y: r.y + r.h / 2, h: r.h / 2 } };
  return { zone: edge, r: half[edge], full: false };
}

/** The pane next to `id` in a direction ([-1, 0] left, [1, 0] right, [0, -1] up, [0, 1] down), by the centres of the
 *  placed panes; null at the edge. */
export function neighbor(placed, id, [dx, dy]) {
  const cur = placed.find((p) => p.id === id);
  if (!cur) return null;
  const centre = (r) => [r.x + r.w / 2, r.y + r.h / 2];
  const [cx, cy] = centre(cur.r);
  const beyond = placed.filter((p) => { const [x, y] = centre(p.r); return p.id !== id && (dx ? Math.sign(x - cx) === dx : Math.sign(y - cy) === dy); });
  beyond.sort((p, q) => { const [px, py] = centre(p.r), [qx, qy] = centre(q.r); return Math.hypot(px - cx, py - cy) - Math.hypot(qx - cx, qy - cy); });
  return beyond[0]?.id ?? null;
}

/** The tree as the terminals are now. A pane whose terminal is gone is emptied and keeps the session it ran (`was`), to
 *  go on with; with `closing` it closes instead while other panes remain (a terminal closed while the page is open).
 *  A pane showing a terminal notes its session as it learns it. `terminals`: [{id, harness, agentSessionId, name}]. */
export function settle(root, terminals, { closing = false } = {}) {
  const byId = new Map(terminals.map((t) => [t.id, t]));
  let next = root;
  for (const p of panesOf(root)) {
    if (!p.term) continue;
    const t = byId.get(p.term);
    if (t) {
      const was = t.agentSessionId ? { harness: t.harness, session: t.agentSessionId, title: t.name ?? "" } : null;
      if (was && JSON.stringify(was) !== JSON.stringify(p.was ?? null)) next = map(next, (n) => (n.k === "pane" && n.id === p.id ? { ...n, was } : n));
    } else if (closing && panesOf(next).length > 1) {
      next = close(next, p.id);
    } else {
      next = map(next, (n) => (n.k === "pane" && n.id === p.id ? { ...n, term: null } : n));
    }
  }
  return next;
}

/** A tree read back from what the page kept (localStorage): null unless it is one — panes and splits with whole ids, no
 *  id or terminal twice, at most MAX_PANES panes, ratios within (0, 1). */
export function restore(value) {
  const seen = new Set(), terms = new Set();
  let count = 0;
  const read = (n) => {
    if (!n || typeof n !== "object" || !Number.isInteger(n.id) || n.id < 1 || seen.has(n.id)) return null;
    seen.add(n.id);
    if (n.k === "pane") {
      count++;
      const term = typeof n.term === "string" && n.term ? n.term : null;
      if (term) { if (terms.has(term)) return null; terms.add(term); }
      const w = n.was;
      const was = w && typeof w.harness === "string" && typeof w.session === "string" ? { harness: w.harness, session: w.session, title: typeof w.title === "string" ? w.title : "" } : null;
      return { k: "pane", id: n.id, term, ...(was ? { was } : {}) };
    }
    if (n.k !== "split" || (n.dir !== "row" && n.dir !== "col") || typeof n.ratio !== "number" || !(n.ratio > 0 && n.ratio < 1)) return null;
    const a = read(n.a), b = a && read(n.b);
    return a && b ? { k: "split", id: n.id, dir: n.dir, ratio: n.ratio, a, b } : null;
  };
  const root = read(value);
  return root && count <= MAX_PANES ? root : null;
}
