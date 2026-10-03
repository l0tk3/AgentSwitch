/** The terminal page's directory tree (ui/lib/tree.js, docs/terminal-v0.md §1); the iPhone's TerminalTreeTests check
 *  the same rules. */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Terminal = { id: string; cwd: string; createdAt: number; status: string; harness: string; agentSessionId?: string; resumedFrom?: string; forked?: boolean };
type Session = { id: string; cwd: string; harness: string; updatedAt: number; startedAt?: number | undefined; forkedFrom?: string | undefined };
type Folder = { cwd: string; label: string; own: boolean; terminals: Terminal[]; sessions: Session[]; children: Folder[] };
type Tree = {
  folderTree: (t: Terminal[], s: Session[]) => Folder[];
  everyFolder: (f: Folder[]) => { folder: Folder; name: string }[];
  everyTerminal: (f: Folder) => Terminal[];
  everySession: (f: Folder) => Session[];
  foldersAbove: (p: string) => string[];
  slashed: (label: string) => string;
  tilde: (p: string) => string;
};
const tree = (await import(join(resolve(import.meta.dirname, "..", "ui"), "lib/tree.js"))) as Tree;

const term = (id: string, cwd: string, createdAt: number, more: Partial<Terminal> = {}): Terminal =>
  ({ id, cwd, createdAt, status: "idle", harness: "claude-code", ...more });
const session = (id: string, cwd: string, updatedAt = 1, startedAt?: number, more: Partial<Session> = {}): Session =>
  ({ id, cwd, harness: "claude-code", updatedAt, startedAt, ...more });
/** The tree as `name/` lines, two spaces a level, own items as `· id`. */
const lines = (folders: Folder[], depth = 0): string[] => folders.flatMap((f) => [
  `${"  ".repeat(depth)}${f.label}/`,
  ...[...f.terminals, ...f.sessions].map((x) => `${"  ".repeat(depth + 1)}· ${x.id}`),
  ...lines(f.children, depth + 1),
]);

const W = "/Users/u/Desktop/WorkSpace";

describe("the terminal list's directory tree", () => {
  // 2026-09-30, user: 目录树顺序应该是固定的，现在会根据活跃状态顺序乱跳.
  it("keeps a fixed order: folders by path, terminals as opened, sessions as begun", () => {
    const terminals = [term("t2", "/Users/u/Work/api", 20), term("t1", "/Users/u/Code/AgentSwitch", 10), term("t3", "/Users/u/Work/api", 30)];
    const sessions = [session("s1", "/Users/u/Work/web", 999, 100), session("s2", "/Users/u/Docs/Notes", 500, 400),
      session("s3", "/Users/u/Code/AgentSwitch", 50, 40), session("s4", "/Users/u/Code/AgentSwitch", 9_999, 30)];
    const folders = tree.folderTree(terminals, sessions);
    expect(lines(folders)).toEqual([
      "AgentSwitch/", "  · t1", "  · s3", "  · s4",
      "Notes/", "  · s2",
      "Work/", "  api/", "    · t2", "    · t3", "  web/", "    · s1",
    ]);
    expect(folders[2]?.own).toBe(false);
    expect(folders.flatMap(tree.everyTerminal).map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    const later = tree.folderTree(terminals, sessions.map((s) => ({ ...s, updatedAt: s.updatedAt + 50_000 })));
    expect(lines(later)).toEqual(lines(folders));
  });

  // 2026-10-03, user: 怎么分别显示了两个worktop.
  it("shows a folder with sessions of its own that also holds others as one line", () => {
    const folders = tree.folderTree([], [session("own", `${W}/Worktop`), session("c1", `${W}/Worktop/Codex`), session("c2", `${W}/Worktop/Claude`)]);
    expect(lines(folders)).toEqual(["Worktop/", "  · own", "  Claude/", "    · c2", "  Codex/", "    · c1"]);
    expect(folders[0]?.own).toBe(true);
  });

  // 2026-10-03, user: 有共同的祖父节点时并没能正确显示，比如“靶场”就在 /WorkSpace/Worktop/培训/靶场 下，但是显示起来是独立的.
  it("puts a folder in the nearest folder above it that the list shows, named by the path from there", () => {
    const sessions = [
      session("a1", `${W}/Projects/AgentSwitch`), session("a2", `${W}/Projects/AgentSwitch/packages/secret-gate`),
      session("m1", `${W}/Projects/MailLab`), session("w1", `${W}/Worktop`), session("c1", `${W}/Worktop/Claude`),
      session("v1", `${W}/Worktop/Claude/CVP_bypass`), session("x1", `${W}/Worktop/Codex`), session("r1", `${W}/Worktop/培训/靶场`),
      session("d1", "/Users/u/Documents/工作文章/CBwork"),
    ];
    expect(lines(tree.folderTree([], sessions))).toEqual([
      "Projects/", "  AgentSwitch/", "    · a1", "    packages/secret-gate/", "      · a2", "  MailLab/", "    · m1",
      "Worktop/", "  · w1", "  Claude/", "    · c1", "    CVP_bypass/", "      · v1", "  Codex/", "    · x1", "  培训/靶场/", "    · r1",
      "CBwork/", "  · d1",
    ]);
  });

  it("lets a folder that only gathers others hold the deeper ones too", () => {
    const sessions = [session("c1", `${W}/Worktop/Codex`), session("c2", `${W}/Worktop/Claude`), session("r1", `${W}/Worktop/培训/靶场`)];
    const folders = tree.folderTree([], sessions);
    expect(lines(folders)).toEqual(["Worktop/", "  Claude/", "    · c2", "  Codex/", "    · c1", "  培训/靶场/", "    · r1"]);
    expect(tree.everyFolder(folders).map((f) => f.name)).toEqual(["Worktop", "Worktop/Claude", "Worktop/Codex", "Worktop/培训/靶场"]);
    expect(folders.flatMap(tree.everySession).map((s) => s.id)).toEqual(["c2", "c1", "r1"]);
  });

  it("adds no folder over projects that only share a grandparent", () => {
    const sessions = [session("a", `${W}/Projects/A`), session("b", `${W}/Projects/B`), session("c", `${W}/Worktop/C`), session("d", `${W}/Worktop/D`)];
    expect(tree.folderTree([], sessions).map((f) => f.label)).toEqual(["Projects", "Worktop"]);
  });

  it("lets your home folder hold only what sits directly in it", () => {
    const sessions = [session("h", "/Users/u"), session("n", "/Users/u/notes"), session("p", `${W}/Projects/A`), session("t", "/private/tmp/x/y")];
    expect(lines(tree.folderTree([], sessions))).toEqual(["y/", "  · t", "~/", "  · h", "  notes/", "    · n", "A/", "  · p"]);
  });

  // 2026-10-03 review: two sessions started in ~/Desktop made it hold every project below it.
  it("lets the places in your home hold only what sits directly in them", () => {
    const sessions = [session("d", "/Users/u/Desktop"), session("a", `${W}/Projects/A`), session("b", `${W}/Projects/B`), session("n", "/Users/u/Desktop/notes")];
    expect(lines(tree.folderTree([], sessions))).toEqual(["Desktop/", "  · d", "  notes/", "    · n", "Projects/", "  A/", "    · a", "  B/", "    · b"]);
  });

  it("ends at the top for a malformed folder, and draws the top of the disk as /", () => {
    const folders = tree.folderTree([], [session("r", "foo/bar"), session("s", "foo"), session("t", "/")]);
    expect(folders.map((f) => f.label)).toEqual(["/"]);
    expect(lines(folders)).toEqual(["//", "  · t", "  foo/", "    · s", "    bar/", "      · r"]);
    expect(tree.slashed("/")).toBe("/");
    expect(tree.slashed("Worktop")).toBe("Worktop/");
    expect(tree.tilde("/Users/Shared/Projects/app")).toBe("/Users/Shared/Projects/app");
    expect(tree.tilde("/Users/u/Projects/app")).toBe("~/Projects/app");
  });

  it("tells repeated names at the top apart by their parent", () => {
    const folders = tree.folderTree([], [session("a", "/Users/u/x/app", 2), session("b", "/Users/u/y/app", 1)]);
    expect(folders.map((f) => f.label)).toEqual(["x/app", "y/app"]);
  });

  it("does not list a session a running terminal holds, and lists it again once that terminal ends", () => {
    const open = term("t1", "/p/q", 1, { agentSessionId: "s1" });
    const ended = term("t2", "/p/q", 2, { status: "exited", agentSessionId: "s2" });
    const fresh = term("t3", "/p/q", 1_000, { harness: "codex" });
    const record = session("019a0000-0000-7000-8000-000000000000", "/p/q", 5, undefined, { harness: "codex" });
    const folders = tree.folderTree([open, ended, fresh], [session("s1", "/p/q", 5), session("s2", "/p/q", 4), record]);
    expect(folders[0]?.sessions.map((s) => s.id)).toEqual(["s2"]);
  });

  it("names a folder and every folder above it, to open them", () => {
    expect(tree.foldersAbove("/a/b")).toEqual(["/a/b", "/a", "/"]);
  });
});
