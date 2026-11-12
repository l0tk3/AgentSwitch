/** The web console's Files column (docs/files-v0.md §14): the rules its tree is drawn by — the rows of the folders
 *  open, their order, where a key moves the selection, a path's parts, what a row says of its file. No page here:
 *  ui/lib/filesColumn.js draws, tests/filesTree.test.ts reads this alone. The Mac's column keeps the same rules in
 *  AgentSwitchMacCore/Files/FilesLayout.swift. */

export const SORTS = ["name", "modified"];

/** A folder, or a link to one: what a row opens rather than previews. */
export const isFolder = (e) => e.kind === "dir" || (e.kind === "link" && e.link?.kind === "dir");

export function joinPath(folder, name) {
  return folder === "/" ? `/${name}` : `${folder}/${name}`;
}

/** The folder a path is in; null for `/`. */
export function parentOf(path) {
  if (path === "/" || !path.startsWith("/")) return null;
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}

/** `inner` is `outer` or under it. */
export function within(inner, outer) {
  return inner === outer || inner.startsWith(outer === "/" ? "/" : `${outer}/`);
}

/** One level's entries as shown: hidden ones left out unless asked, folders first, then by name as the service
 *  ordered them (`name`) or the newest first (`modified`). */
export function sorted(entries, order = "name", hidden = false) {
  const shown = entries.filter((e) => hidden || !e.hidden);
  if (order !== "modified") return shown;
  return shown.map((e, i) => [e, i]).sort(([a, i], [b, j]) => Number(isFolder(b)) - Number(isFolder(a)) || b.mtime - a.mtime || i - j).map(([e]) => e);
}

/** The tree's rows, top to bottom: `root`'s entries, and under each open folder its own, a step in. `levels` is what
 *  has been read (path → the service's level); an open folder not read yet has no rows under it. A level cut short
 *  by the service's limit ends with a row that says how many more (`more`). */
export function rowsOf(root, levels, open, { order = "name", hidden = false } = {}) {
  const rows = [];
  const walk = (folder, depth) => {
    const level = levels[folder];
    if (!level) return;
    for (const entry of sorted(level.entries, order, hidden)) {
      const path = joinPath(folder, entry.name);
      const folderRow = isFolder(entry) && !entry.locked;
      const isOpen = folderRow && open.has(path);
      rows.push({ path, entry, depth, folder: folderRow, open: isOpen });
      if (isOpen) walk(path, depth + 1);
    }
    if (level.more > 0) rows.push({ path: `${folder}\u0000more`, more: level.more, depth });
  };
  walk(root, 0);
  return rows;
}

/** The row `delta` steps from the selected one (the first or the last when nothing is selected); rows that only say
 *  "more" are stepped over. Null when there is no row to be on. */
export function moved(rows, selected, delta) {
  const real = rows.filter((r) => !r.more);
  if (!real.length) return null;
  const at = real.findIndex((r) => r.path === selected);
  if (at < 0) return (delta > 0 ? real[0] : real[real.length - 1]).path;
  return real[Math.max(0, Math.min(real.length - 1, at + delta))].path;
}

/** What ← does on the selected row: an open folder closes; anything else goes to the folder it is in, and at the
 *  tree's top level the tree itself goes up one folder. */
export function leftOf(rows, selected, root) {
  const row = rows.find((r) => r.path === selected);
  if (row?.open) return { close: row.path };
  const up = selected ? parentOf(selected) : null;
  if (up && up !== root && within(up, root)) return { select: up };
  return { up: true };
}

/** A path as the parts its line shows, each one a folder to go to: `~` for the home folder and what is under it. */
export function crumbs(path, home) {
  const parts = [];
  const underHome = home && home !== "/" && within(path, home);
  const base = underHome ? home : "/";
  parts.push({ name: underHome ? "~" : "/", path: base });
  const rest = path.slice(base.length).split("/").filter(Boolean);
  let at = base;
  for (const name of rest) { at = joinPath(at, name); parts.push({ name, path: at }); }
  return parts;
}

/** A size as a unit: 0 B, 812 B, 1.4 KB, 20 MB, 3.2 GB. */
export function sizeWord(bytes) {
  if (!(bytes >= 0)) return "";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes, u = -1;
  do { n /= 1000; u += 1; } while (n >= 999.5 && u < units.length - 1);
  return `${n >= 99.5 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")} ${units[u]}`;
}

/** What a preview shows for a file of this type, by what the service says it is (`/files/stat`'s `type`). */
export function previewKind(details) {
  if (!details || details.locked) return "none";
  if (details.items !== undefined) return "folder";
  if (details.type === "text") return "text";
  if (details.type === "image") return "image";
  return "other";
}

/** Why the service refused, as a sentence (api/browse.ts `refuse`). */
export function refusalWords(error) {
  return {
    "not-found": "这个位置已不存在。",
    "not-folder": "这不是文件夹。",
    locked: "这是 AgentSwitch 保存凭据的位置，不显示内容。",
    permission: "没有读取权限。",
    scope: "这个位置不在允许查看的范围内。",
    "files-off": "这个节点没有开放文件查看。",
    "bad-path": "路径无效。",
  }[error] ?? "无法读取。";
}
