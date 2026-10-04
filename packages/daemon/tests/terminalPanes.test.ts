/** The terminal page's split panes (ui/lib/panes.js, docs/terminal-v0.md §1 分屏): the tree of splits, what a drop
 *  does, the lines' limits, what is kept across a restart. */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Pane = { k: "pane"; id: number; term: string | null; was?: { harness: string; session: string; title: string } };
type Split = { k: "split"; id: number; dir: "row" | "col"; ratio: number; a: Node; b: Node };
type Node = Pane | Split;
type Rect = { x: number; y: number; w: number; h: number };
type Placed = { panes: { id: number; term: string | null; r: Rect }[]; lines: { id: number; dir: string; r: Rect; box: Rect }[] };
type Panes = {
  MAX_PANES: number; MIN_W: number; MIN_H: number; GAP: number;
  single: (term?: string | null) => Pane;
  panesOf: (n: Node) => Pane[];
  paneShowing: (n: Node, term: string | null) => Pane | null;
  show: (n: Node, id: number, term: string | null) => Node;
  split: (n: Node, id: number, side: string, term?: string | null) => { root: Node; pane: number } | null;
  close: (n: Node, id: number) => Node;
  drop: (n: Node, term: string, id: number, zone: string) => { root: Node; pane: number } | null;
  resize: (n: Node, id: number, ratio: number) => Node;
  least: (n: Node, axis: "w" | "h") => number;
  place: (n: Node, r: Rect) => Placed;
  ratioAt: (n: Node, id: number, box: Rect, at: number) => number;
  zoneOf: (r: Rect, x: number, y: number, count: number) => { zone: string; r: Rect; full: boolean };
  neighbor: (placed: Placed["panes"], id: number, dir: [number, number]) => number | null;
  settle: (n: Node, terminals: { id: string; harness: string; agentSessionId?: string | null; name?: string }[], o?: { closing?: boolean }) => Node;
  restore: (v: unknown) => Node | null;
};
const P = (await import(join(resolve(import.meta.dirname, "..", "ui"), "lib/panes.js"))) as Panes;

const terms = (n: Node) => P.panesOf(n).map((p) => p.term);
const BOX: Rect = { x: 0, y: 0, w: 1001, h: 601 };
/** t1 | (t2 over t3). */
function three(): Node {
  const a = P.split(P.single("t1"), 1, "right", "t2")!;
  return P.split(a.root, a.pane, "bottom", "t3")!.root;
}

describe("split panes", () => {
  it("starts as one pane and splits beside the pane asked, the new one holding the terminal", () => {
    const one = P.single("t1");
    expect(terms(one)).toEqual(["t1"]);
    const right = P.split(one, 1, "right", "t2")!;
    expect(terms(right.root)).toEqual(["t1", "t2"]);
    expect(P.paneShowing(right.root, "t2")!.id).toBe(right.pane);
    expect(terms(P.split(one, 1, "left", "t2")!.root)).toEqual(["t2", "t1"]);
    expect((P.split(one, 1, "top")!.root as Split).dir).toBe("col");
    expect(terms(P.split(one, 1, "bottom")!.root)).toEqual(["t1", null]);
    expect(P.split(one, 9, "right")).toBeNull();
    expect(one).toEqual(P.single("t1"));   // every change is a new tree
  });

  it("holds at most four panes", () => {
    let root: Node = P.single("t1");
    for (let i = 2; i <= P.MAX_PANES; i++) root = P.split(root, P.panesOf(root)[0]!.id, "right", `t${i}`)!.root;
    expect(P.panesOf(root)).toHaveLength(4);
    expect(P.split(root, P.panesOf(root)[0]!.id, "right")).toBeNull();
    expect(new Set([...P.panesOf(root).map((p) => p.id)]).size).toBe(4);
  });

  it("a terminal is in one pane at most: shown in another, it leaves the first, which closes", () => {
    const root = three();
    const [p1, , p3] = P.panesOf(root);
    const moved = P.show(root, p1!.id, "t3");
    expect(terms(moved)).toEqual(["t3", "t2"]);
    expect(terms(P.show(root, p3!.id, null))).toEqual(["t1", "t2", null]);
    expect(terms(P.show(root, p1!.id, "t1"))).toEqual(["t1", "t2", "t3"]);
  });

  it("closing a pane gives its room to its sibling; the last pane is only emptied", () => {
    const root = three();
    const [p1, p2] = P.panesOf(root);
    expect(terms(P.close(root, p2!.id))).toEqual(["t1", "t3"]);
    const left = P.close(root, p1!.id) as Split;
    expect(left.dir).toBe("col");
    expect(terms(left)).toEqual(["t2", "t3"]);
    expect(P.close(P.single("t1"), 1)).toEqual({ k: "pane", id: 1, term: null });
    expect(P.close(root, 99)).toBe(root);
  });

  it("a drop in the middle shows the terminal there; on an edge it splits that side; out of another pane, that one closes", () => {
    const root = three();
    const [p1, p2] = P.panesOf(root);
    expect(terms(P.drop(root, "t9", p1!.id, "center")!.root)).toEqual(["t9", "t2", "t3"]);
    const split = P.drop(root, "t9", p2!.id, "left")!;
    expect(terms(split.root)).toEqual(["t1", "t9", "t2", "t3"]);
    expect(P.paneShowing(split.root, "t9")!.id).toBe(split.pane);
    // t3 dragged onto t1's right edge: its own pane closes, three panes stay.
    const moved = P.drop(root, "t3", p1!.id, "right")!;
    expect(terms(moved.root)).toEqual(["t1", "t3", "t2"]);
    expect(P.drop(root, "t1", p1!.id, "center")).toBeNull();   // onto itself
    expect(P.drop(root, "t9", 99, "center")).toBeNull();
  });

  it("places panes and lines in the rect, one pixel between panes", () => {
    const placed = P.place(three(), BOX);
    expect(placed.panes.map((p) => p.r)).toEqual([
      { x: 0, y: 0, w: 500, h: 601 }, { x: 501, y: 0, w: 500, h: 300 }, { x: 501, y: 301, w: 500, h: 300 },
    ]);
    expect(placed.lines.map((l) => [l.dir, l.r])).toEqual([["row", { x: 500, y: 0, w: 1, h: 601 }], ["col", { x: 501, y: 300, w: 500, h: 1 }]]);
    expect(placed.lines[1]!.box).toEqual({ x: 501, y: 0, w: 500, h: 601 });
  });

  it("a line dragged keeps every pane at its least size", () => {
    const root = three() as Split;
    expect(P.least(root, "w")).toBe(2 * P.MIN_W + P.GAP);
    expect(P.least(root, "h")).toBe(2 * P.MIN_H + P.GAP);
    expect(P.ratioAt(root, root.id, BOX, 500)).toBeCloseTo(0.5);
    expect(P.ratioAt(root, root.id, BOX, 10)).toBeCloseTo(P.MIN_W / 1000);
    expect(P.ratioAt(root, root.id, BOX, 990)).toBeCloseTo(1 - P.MIN_W / 1000);
    const inner = root.b as Split;
    expect(P.ratioAt(root, inner.id, { x: 501, y: 0, w: 500, h: 601 }, 20)).toBeCloseTo(P.MIN_H / 600);
    // No room for both: half each rather than a share below the least.
    expect(P.ratioAt(root, root.id, { x: 0, y: 0, w: 400, h: 601 }, 100)).toBe(0.5);
    expect((P.resize(root, inner.id, 0.3) as Split).b).toMatchObject({ ratio: 0.3 });
    expect((P.resize(root, 99, 0.3))).toBe(root);
  });

  it("a drop lands on the nearest edge within a quarter of the pane, else the middle; no room or four panes: the middle", () => {
    const r: Rect = { x: 100, y: 50, w: 800, h: 400 };
    expect(P.zoneOf(r, 500, 250, 1)).toMatchObject({ zone: "center", r, full: false });
    expect(P.zoneOf(r, 880, 250, 1)).toEqual({ zone: "right", r: { x: 500, y: 50, w: 400, h: 400 }, full: false });
    expect(P.zoneOf(r, 110, 250, 1).zone).toBe("left");
    expect(P.zoneOf(r, 500, 60, 1)).toEqual({ zone: "top", r: { x: 100, y: 50, w: 800, h: 200 }, full: false });
    expect(P.zoneOf(r, 500, 440, 1).zone).toBe("bottom");
    expect(P.zoneOf(r, 880, 250, P.MAX_PANES)).toMatchObject({ zone: "center", full: true });
    expect(P.zoneOf({ ...r, w: 500 }, 590, 250, 1).zone).toBe("center");   // too narrow for two
    expect(P.zoneOf({ ...r, h: 300 }, 500, 340, 1).zone).toBe("center");   // too low for two
  });

  it("finds the pane next door by direction", () => {
    const { panes } = P.place(three(), BOX);
    const [p1, p2, p3] = panes.map((p) => p.id);
    expect(P.neighbor(panes, p1!, [1, 0])).toBe(p2);
    expect(P.neighbor(panes, p2!, [-1, 0])).toBe(p1);
    expect(P.neighbor(panes, p2!, [0, 1])).toBe(p3);
    expect(P.neighbor(panes, p3!, [0, -1])).toBe(p2);
    expect(P.neighbor(panes, p1!, [-1, 0])).toBeNull();
    expect(P.neighbor(panes, 99, [1, 0])).toBeNull();
  });

  it("keeps the session of a pane whose terminal is gone, or closes the pane while the page is open", () => {
    const live = [{ id: "t1", harness: "claude-code", agentSessionId: "s-1", name: "发布前检查" }, { id: "t2", harness: "codex", agentSessionId: null }, { id: "t3", harness: "codex", agentSessionId: "s-3", name: "构建" }];
    const noted = P.settle(three(), live);
    expect(P.panesOf(noted).map((p) => p.was?.session ?? null)).toEqual(["s-1", null, "s-3"]);
    expect(P.settle(noted, live)).toBe(noted);   // nothing new: the same tree
    // The service restarted: every terminal gone, the panes stay with what to go on with.
    const after = P.settle(noted, []);
    expect(P.panesOf(after)).toMatchObject([{ term: null, was: { harness: "claude-code", session: "s-1", title: "发布前检查" } }, { term: null }, { term: null, was: { session: "s-3" } }]);
    // One closed while the page is open: its pane closes; the last pane is emptied.
    expect(terms(P.settle(noted, live.slice(0, 2), { closing: true }))).toEqual(["t1", "t2"]);
    expect(terms(P.settle(P.single("t9"), [], { closing: true }))).toEqual([null]);
    // Shown again, the pane forgets the old session.
    expect(P.panesOf(P.show(after, P.panesOf(after)[0]!.id, "t7"))[0]).toEqual({ k: "pane", id: P.panesOf(after)[0]!.id, term: "t7" });
  });

  it("reads back only a well-formed tree", () => {
    const root = P.settle(three(), [{ id: "t1", harness: "claude-code", agentSessionId: "s-1", name: "a" }]);
    expect(P.restore(JSON.parse(JSON.stringify(root)))).toEqual(root);
    expect(P.restore(null)).toBeNull();
    expect(P.restore({ k: "pane", id: 0, term: "t1" })).toBeNull();
    expect(P.restore({ k: "split", id: 2, dir: "row", ratio: 1.2, a: P.single("a"), b: { k: "pane", id: 3, term: "b" } })).toBeNull();
    expect(P.restore({ k: "split", id: 2, dir: "row", ratio: 0.5, a: P.single("a"), b: { k: "pane", id: 1, term: "b" } })).toBeNull();   // an id twice
    expect(P.restore({ k: "split", id: 2, dir: "row", ratio: 0.5, a: P.single("a"), b: { k: "pane", id: 3, term: "a" } })).toBeNull();   // a terminal twice
    expect(P.restore({ k: "split", id: 2, dir: "diag", ratio: 0.5, a: P.single("a"), b: { k: "pane", id: 3, term: "b" } })).toBeNull();
    let five: Node = P.single("t1");
    for (let i = 2; i <= 4; i++) five = P.split(five, 1, "right", `t${i}`)!.root;
    const extra = { k: "split", id: 50, dir: "col", ratio: 0.5, a: five, b: { k: "pane", id: 51, term: "t5" } };
    expect(P.restore(extra)).toBeNull();
    expect(P.restore({ k: "pane", id: 4, term: 7, was: { harness: 1 } })).toEqual({ k: "pane", id: 4, term: null });
  });
});
