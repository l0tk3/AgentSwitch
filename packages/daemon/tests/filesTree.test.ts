/** The web console's Files column (ui/lib/filesTree.js, docs/files-v0.md §14): the tree's rows and order, where the
 *  keys move the selection, a path's parts, sizes. */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Entry = { name: string; kind: string; size: number; mtime: number; hidden: boolean; locked?: true; link?: { target: string; kind: string } };
type Level = { path: string; entries: Entry[]; more: number };
type Row = { path: string; entry?: Entry; depth: number; folder?: boolean; open?: boolean; more?: number };
type Tree = {
  isFolder: (e: Entry) => boolean;
  joinPath: (folder: string, name: string) => string;
  parentOf: (path: string) => string | null;
  within: (inner: string, outer: string) => boolean;
  sorted: (entries: Entry[], order?: string, hidden?: boolean) => Entry[];
  rowsOf: (root: string, levels: Record<string, Level>, open: Set<string>, o?: { order?: string; hidden?: boolean }) => Row[];
  moved: (rows: Row[], selected: string | null, delta: number) => string | null;
  leftOf: (rows: Row[], selected: string | null, root: string) => { close?: string; select?: string; up?: true };
  crumbs: (path: string, home: string) => { name: string; path: string }[];
  sizeWord: (bytes: number) => string;
  previewKind: (d: unknown) => string;
  refusalWords: (error: string) => string;
};
const T = (await import(join(resolve(import.meta.dirname, "..", "ui"), "lib/filesTree.js"))) as Tree;

const dir = (name: string, mtime = 0): Entry => ({ name, kind: "dir", size: 0, mtime, hidden: name.startsWith(".") });
const file = (name: string, mtime = 0, size = 10): Entry => ({ name, kind: "file", size, mtime, hidden: name.startsWith(".") });
const level = (path: string, entries: Entry[], more = 0): Level => ({ path, entries, more });

const LEVELS: Record<string, Level> = {
  "/w": level("/w", [dir("src", 5), dir(".git", 9), file("a.txt", 1), file("b.png", 7), file(".env", 8)]),
  "/w/src": level("/w/src", [file("main.ts", 3), file("old.ts", 2)], 4),
};
const paths = (rows: Row[]) => rows.map((r) => r.path);

describe("the files tree", () => {
  it("lists a folder's entries as the service ordered them, hidden ones only when asked", () => {
    expect(paths(T.rowsOf("/w", LEVELS, new Set()))).toEqual(["/w/src", "/w/a.txt", "/w/b.png"]);
    expect(paths(T.rowsOf("/w", LEVELS, new Set(), { hidden: true }))).toEqual(["/w/src", "/w/.git", "/w/a.txt", "/w/b.png", "/w/.env"]);
  });

  it("puts the newest first when ordered by time, folders still before files", () => {
    expect(paths(T.rowsOf("/w", LEVELS, new Set(), { order: "modified", hidden: true }))).toEqual(["/w/.git", "/w/src", "/w/.env", "/w/b.png", "/w/a.txt"]);
  });

  it("shows an open folder's entries a step in, and says how many the service left out", () => {
    const rows = T.rowsOf("/w", LEVELS, new Set(["/w/src"]));
    expect(rows.map((r) => [r.path.replace("\u0000", "#"), r.depth])).toEqual([["/w/src", 0], ["/w/src/main.ts", 1], ["/w/src/old.ts", 1], ["/w/src#more", 1], ["/w/a.txt", 0], ["/w/b.png", 0]]);
    expect(rows[0]).toMatchObject({ folder: true, open: true });
    expect(rows[3]!.more).toBe(4);
  });

  it("has no rows under an open folder that was not read yet, and none under a locked one", () => {
    expect(paths(T.rowsOf("/w", { "/w": LEVELS["/w"]! }, new Set(["/w/src"])))).toEqual(["/w/src", "/w/a.txt", "/w/b.png"]);
    const locked = { "/h": level("/h", [{ ...dir("keys"), locked: true as const }]), "/h/keys": level("/h/keys", [file("k")]) };
    const rows = T.rowsOf("/h", locked, new Set(["/h/keys"]));
    expect(paths(rows)).toEqual(["/h/keys"]);
    expect(rows[0]!.folder).toBe(false);
  });

  it("takes a link to a folder for a folder", () => {
    expect(T.isFolder({ ...file("l"), kind: "link", link: { target: "/x", kind: "dir" } })).toBe(true);
    expect(T.isFolder({ ...file("l"), kind: "link", link: { target: "/x", kind: "file" } })).toBe(false);
  });
});

describe("the keys", () => {
  const rows = T.rowsOf("/w", LEVELS, new Set(["/w/src"]));

  it("move a row at a time, stop at the ends and step over the row that only counts", () => {
    expect(T.moved(rows, null, 1)).toBe("/w/src");
    expect(T.moved(rows, null, -1)).toBe("/w/b.png");
    expect(T.moved(rows, "/w/src/old.ts", 1)).toBe("/w/a.txt");
    expect(T.moved(rows, "/w/a.txt", -1)).toBe("/w/src/old.ts");
    expect(T.moved(rows, "/w/b.png", 1)).toBe("/w/b.png");
    expect(T.moved(rows, "/w/src", -1)).toBe("/w/src");
    expect(T.moved([], null, 1)).toBeNull();
  });

  it("left closes an open folder, else goes to the folder above, and at the top takes the tree up", () => {
    expect(T.leftOf(rows, "/w/src", "/w")).toEqual({ close: "/w/src" });
    expect(T.leftOf(rows, "/w/src/main.ts", "/w")).toEqual({ select: "/w/src" });
    expect(T.leftOf(rows, "/w/a.txt", "/w")).toEqual({ up: true });
    expect(T.leftOf(rows, null, "/w")).toEqual({ up: true });
  });
});

describe("paths and words", () => {
  it("joins and parts paths, the root too", () => {
    expect(T.joinPath("/", "a")).toBe("/a");
    expect(T.joinPath("/a", "b")).toBe("/a/b");
    expect(T.parentOf("/a/b")).toBe("/a");
    expect(T.parentOf("/a")).toBe("/");
    expect(T.parentOf("/")).toBeNull();
    expect(T.within("/a/b", "/a")).toBe(true);
    expect(T.within("/ab", "/a")).toBe(false);
    expect(T.within("/a", "/")).toBe(true);
  });

  it("writes a path as parts to go to, the home folder as ~", () => {
    expect(T.crumbs("/Users/u/work/x", "/Users/u")).toEqual([{ name: "~", path: "/Users/u" }, { name: "work", path: "/Users/u/work" }, { name: "x", path: "/Users/u/work/x" }]);
    expect(T.crumbs("/Users/u", "/Users/u")).toEqual([{ name: "~", path: "/Users/u" }]);
    expect(T.crumbs("/tmp/x", "/Users/u")).toEqual([{ name: "/", path: "/" }, { name: "tmp", path: "/tmp" }, { name: "x", path: "/tmp/x" }]);
    expect(T.crumbs("/Users/uu/x", "/Users/u")[0]).toEqual({ name: "/", path: "/" });
  });

  it("says sizes as units", () => {
    expect([0, 812, 1400, 20_000_000, 3_200_000_000, 999_999].map(T.sizeWord)).toEqual(["0 B", "812 B", "1.4 KB", "20 MB", "3.2 GB", "1 MB"]);
  });

  it("knows what a preview is of, and says a refusal as a sentence", () => {
    expect(T.previewKind({ type: "text" })).toBe("text");
    expect(T.previewKind({ type: "image" })).toBe("image");
    expect(T.previewKind({ type: "pdf" })).toBe("other");
    expect(T.previewKind({ items: 3 })).toBe("folder");
    expect(T.previewKind({ locked: true, type: "text" })).toBe("none");
    expect(T.previewKind(null)).toBe("none");
    expect(T.refusalWords("locked")).toContain("凭据");
    expect(T.refusalWords("whatever")).toBe("无法读取。");
  });
});
