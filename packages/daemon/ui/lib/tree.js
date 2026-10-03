// The terminal page's list as a directory tree (docs/terminal-v0.md §1): folders with their running terminals and
// their earlier sessions. Pure, apart from the page, so the daemon's tests build it (tests/terminalTree.test.ts); the
// iPhone's TerminalTree.swift follows the same rules.

/** `/Users/<name>/x` as `~/x` (not `/Users/Shared`, which is no one's home). */
export const tilde = (p) => p.replace(/^\/Users\/(?!Shared(?:\/|$))[^/]+(?=\/|$)/, "~");
/** A path's last component ("AgentSwitch"). */
export const folderOf = (p) => p.split("/").filter(Boolean).pop() || p;
/** When a UUIDv7 id (Codex's) was made, in ms; null for any other id. */
export function uuidTime(id) {
  const hex = String(id).replace(/-/g, "");
  return /^[0-9a-f]{32}$/i.test(hex) && hex[12] === "7" ? parseInt(hex.slice(0, 12), 16) : null;
}

/** The folder above; `/` above a path with no other slash (a malformed record's `foo` or `foo/bar` ends there too). */
const parentOf = (p) => { const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };
/** Paths as a directory tree sorts them, case aside, numbers by value; one fixed locale, so the page sorts as the
 *  iPhone does whatever language the Mac is in. */
const byPath = (a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true });
/** The places directly in your home (macOS's own folders), not projects. */
const PLACES = new Set(["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public", "Applications"]);
/** Folders near the top hold only what sits directly in them: two levels from the top of the disk (`/`, `/Users`,
 *  your home, `/private/tmp`) and the places in your home (`~/Desktop`): a session started in one of them does not
 *  gather every project below it. */
const shallow = (p) => {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 || (parts.length === 3 && parts[0] === "Users" && PLACES.has(parts[2]));
};

/** Folders with their running terminals and their earlier sessions, as a directory tree. The order is fixed
 *  (2026-09-30, user: 目录树顺序应该是固定的，现在会根据活跃状态顺序乱跳): folders by path; in a folder its terminals in the
 *  order they were opened, then its sessions newest-begun first, then the folders under it. Work going on moves
 *  nothing; a new terminal or session only comes in at its place.
 *
 *  Which folders show and where (2026-10-03, user: 怎么分别显示了两个worktop；有共同的祖父节点时并没能正确显示，比如“靶场”
 *  就在 /WorkSpace/Worktop/培训/靶场 下，但是显示起来是独立的): every folder with terminals or sessions of its own, and
 *  every folder two or more of those sit directly in. Each sits in the nearest of these above it, named by the path
 *  from there (`培训/靶场`); a folder with sessions of its own that also holds others is one line. At the top a folder
 *  goes by its own name, a repeated one with its parent's (`x/app`).
 *
 *  Each folder: `{ cwd, label, own, terminals, sessions, children }`; `own` is false for one that only gathers others. */
export function folderTree(terminals, sessions) {
  const own = ownItems(terminals, sessions);
  const direct = new Map();
  for (const cwd of own.keys()) if (cwd !== "/") direct.set(parentOf(cwd), (direct.get(parentOf(cwd)) ?? 0) + 1);
  const shown = new Set([...own.keys(), ...[...direct].filter(([, n]) => n > 1).map(([p]) => p)]);
  const paths = [...shown].sort(byPath);
  const children = new Map();
  const roots = [];
  for (const p of paths) {
    const holder = holderOf(p, shown);
    if (holder === null) roots.push(p);
    else children.set(holder, [...(children.get(holder) ?? []), p]);
  }
  const make = (cwd, label) => ({
    cwd,
    label,
    own: own.has(cwd),
    terminals: own.get(cwd)?.terminals ?? [],
    sessions: own.get(cwd)?.sessions ?? [],
    children: (children.get(cwd) ?? []).map((c) => make(c, relative(c, cwd))),
  });
  const names = roots.map((p) => folderOf(tilde(p)));
  return roots.map((p, i) => make(p, names.filter((n) => n === names[i]).length > 1 ? tilde(p).split("/").filter(Boolean).slice(-2).join("/") || "/" : names[i]));
}

/** A folder's line: its name and a slash (the top of the disk is `/` alone). */
export const slashed = (label) => (label.endsWith("/") ? label : `${label}/`);

/** The nearest shown folder above `path`, or null at the top. */
function holderOf(path, shown) {
  if (path === "/") return null;
  for (let p = parentOf(path), direct = true; ; p = parentOf(p), direct = false) {
    if (shown.has(p) && (direct || !shallow(p))) return p;
    if (p === "/") return null;
  }
}

const relative = (path, holder) => (holder === "/" ? path.replace(/^\//, "") : path.slice(holder.length + 1));

/** Each folder's own terminals (as opened) and sessions (newest-begun first). A session already open here (or the one
 *  a fork was made from, or the record a Codex terminal is writing) is not listed again. A new Codex terminal says its
 *  record's id only after its first turn: until then, a Codex record made in its folder since it started is taken to
 *  be its own (Codex ids are UUIDv7, with the time). An ended terminal no longer holds its session: the session is
 *  listed (and can be continued) again. */
function ownItems(terminals, sessions) {
  const running = terminals.filter((t) => t.status !== "exited");
  const held = new Set(running.flatMap((t) => [t.agentSessionId, t.resumedFrom]).filter(Boolean));
  const openForks = new Set(running.filter((t) => t.forked).map((t) => t.resumedFrom));
  const ownRecord = (s) => s.harness === "codex" && (openForks.has(s.forkedFrom) || running.some((t) =>
    t.harness === "codex" && !t.agentSessionId && t.cwd === s.cwd && (uuidTime(s.id) ?? 0) >= t.createdAt - 3000));
  const listed = sessions.filter((s) => !held.has(s.id) && !ownRecord(s));
  // Grouped by hand: Map.groupBy needs Safari 17.4, and the Mac window's WebKit is macOS 14.0's at the oldest.
  const terminalsIn = groupBy(terminals);
  const sessionsIn = groupBy(listed);
  const cwds = new Set([...terminalsIn.keys(), ...sessionsIn.keys()]);
  return new Map([...cwds].map((cwd) => [cwd, {
    terminals: [...(terminalsIn.get(cwd) ?? [])].sort((a, b) => a.createdAt - b.createdAt),
    sessions: [...(sessionsIn.get(cwd) ?? [])]
      .sort((a, b) => (b.startedAt ?? b.updatedAt) - (a.startedAt ?? a.updatedAt) || byPath(a.id, b.id)),
  }]));
}

/** Items by their folder. */
function groupBy(items) {
  const by = new Map();
  for (const x of items) {
    const list = by.get(x.cwd);
    if (list) list.push(x); else by.set(x.cwd, [x]);
  }
  return by;
}

/** A folder's terminals, then those of the folders under it, in the tree's order; the same for sessions. */
export const everyTerminal = (f) => [...f.terminals, ...f.children.flatMap(everyTerminal)];
export const everySession = (f) => [...f.sessions, ...f.children.flatMap(everySession)];

/** Every folder, depth first, with its name as a search shows it: under the names of the folders it sits in
 *  (`Worktop/培训/靶场`). */
export function everyFolder(folders, above = "") {
  return folders.flatMap((f) => {
    const name = above ? `${above}/${f.label}` : f.label;
    return [{ folder: f, name }, ...everyFolder(f.children, name)];
  });
}

/** `path` and every folder above it, nearest first: the folders to open so it shows. */
export function foldersAbove(path) {
  const out = [path];
  for (let p = path; p !== "/"; ) { p = parentOf(p); out.push(p); }
  return out;
}
