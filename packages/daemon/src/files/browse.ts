/** The Files column's view of this node's disk (docs/files-v0.md §7): one folder's level, one entry's details, the start
 *  of a text file — read only, nothing here writes. The same code answers this node's own screens, a phone and another
 *  node; what differs is who asks (`Viewer`): a paired device sees what this node's switch and that device's scope let
 *  it (§7.5), this node's own screens see everything but the places AgentSwitch keeps its credentials (§7.3).
 *
 *  Every check is made on where a path really is (`realpath`, then the canonical comparisons of core/paths.ts), so a
 *  symbolic link answers for its target: one into a locked place is locked, one out of a scope is out of it. A path is
 *  taken only absolute and as written plainly: no `..`, no `.`, no doubled slash. */

import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, type Dirent, type Stats } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize } from "node:path";
import { canonicalPath, fileId, isWithin, lineage } from "../core/paths.js";

/** How much of a paired device's reach on this node's files (docs/files-v0.md §7.5). */
export type ScopeMode = "home" | "all" | "folders" | "none";
export type FileScope = { readonly mode: ScopeMode; readonly folders?: readonly string[] };
/** A device paired before scopes existed, or given none: its home folder and everything under it. */
export const DEFAULT_SCOPE: FileScope = { mode: "home" };
/** Folders one device's scope may name. */
export const MAX_SCOPE_FOLDERS = 32;

/** AgentSwitch's own credential places: the executors' read-denied table (executors/protected.ts `ProtectedPaths`). */
export type DeniedPlaces = { readonly readDenied?: readonly string[] };
/** Who asks. `scope` null: this node's own screens (the local listener). */
export type Viewer = { readonly denied: DeniedPlaces; readonly home: string; readonly scope: FileScope | null };

export type EntryKind = "dir" | "file" | "link" | "other";
export type Entry = {
  readonly name: string;
  readonly kind: EntryKind;
  /** Bytes; a folder's is 0. A link's are its target's. */
  readonly size: number;
  /** Last modified, ms since the epoch. */
  readonly mtime: number;
  /** Its name starts with a dot. */
  readonly hidden: boolean;
  /** Shown a step fainter: what tools keep (`.git`, `node_modules`, …). */
  readonly dim?: true;
  /** One of AgentSwitch's own credential places: its name only, nothing more of it is given. */
  readonly locked?: true;
  /** Not to be renamed or moved to the Trash here (docs/files-v0.md §12.2): it holds one of AgentSwitch's places (the
   *  home folder, `~/.agentswitch`), or it is right under `/`. Screens leave those items out of its menu. */
  readonly fixed?: true;
  /** A symbolic link: where it points, and what is there. */
  readonly link?: { readonly target: string; readonly kind: "dir" | "file" | "other" | "missing" };
};

export type Level = {
  readonly path: string;
  readonly parent: string | null;
  readonly home: string;
  readonly entries: readonly Entry[];
  /** How many more there are than the limit let through. */
  readonly more: number;
  /** How many hidden ones were left out (asked without `hidden`). */
  readonly hiddenCount: number;
  /** Only what leads into the device's scope is listed here (the levels above its folders). */
  readonly scoped?: true;
};

export type FileType = "text" | "image" | "pdf" | "audio" | "video" | "archive" | "binary";
export type Details = Entry & {
  readonly path: string;
  /** Where it really is, when that is not `path`. */
  readonly real?: string;
  readonly type?: FileType;
  /** A text file's lines, counted when it is small enough to read whole (`LINES_UP_TO`). */
  readonly lines?: number;
  /** A folder's entries, hidden ones included. */
  readonly items?: number;
  /** It may hold a password or a key (§7.3): shown and previewed as anything else, asked about before an agent gets it. */
  readonly sensitive?: { readonly reason: SensitiveReason };
};

export type Refusal = "bad-path" | "not-found" | "not-folder" | "folder" | "locked" | "scope" | "permission";
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Refusal };

export const DEFAULT_LIMIT = 2000;
export const MAX_LIMIT = 10_000;
/** The start of a text file a preview gives. */
export const PREVIEW_BYTES = 64 * 1024;
/** What decides text or not: the first this many bytes. */
const SNIFF_BYTES = 8 * 1024;
/** A text file this small has its lines counted. */
export const LINES_UP_TO = 256 * 1024;

const DIM = new Set([".git", "node_modules", ".build", "DerivedData", "__pycache__", ".venv", ".DS_Store", ".next", ".turbo", ".cache"]);

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = <T>(error: Refusal): Result<T> => ({ ok: false, error });

/** The path asked for, or null when it is not one taken: `~` and `~/…` are the home folder; anything else must be
 *  absolute and plain (no `..`, `.`, doubled slash or control character). A trailing slash is let go. Absent: home. */
export function askedPath(raw: string | undefined, home: string): string | null {
  if (raw === undefined || raw === "") return home;
  let p = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
  if (!isAbsolute(p) || /[\x00-\x1f\x7f]/.test(p) || p.length > 4096) return null;
  if (p.length > 1) p = p.replace(/\/+$/, "") || "/";
  return normalize(p) === p ? p : null;
}

/** Where `p` really is, or the refusal for it. */
function realOf(p: string): Result<string> {
  try { return ok(canonicalPath(realpathSync.native(p))); }
  catch (err) { return no(errno(err)); }
}

function errno(err: unknown): Refusal {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" ? "permission" : code === "ENOTDIR" ? "not-folder" : "not-found";
}

/** `/` and what is right under it, and every folder holding one of AgentSwitch's credential places: what the Files
 *  column never renames or moves (files/change.ts `fixedPlace` is the same rule, with the locked places themselves). */
export function holdsFixed(real: string, viewer: Viewer): boolean {
  if (real === "/" || dirname(real) === "/") return true;
  return (viewer.denied.readDenied ?? []).some((r) => isWithin(canonicalPath(r), real) || isWithin(r, real));
}

/** True when `real` is one of AgentSwitch's credential places or inside one. */
export function isLocked(real: string, viewer: Viewer): boolean {
  const chain = lineage(real);
  return (viewer.denied.readDenied ?? []).some((r) => isWithin(real, r, chain));
}

/** The scope's folders as they really are; `null` for all of the disk. */
function scopeRoots(viewer: Viewer): readonly string[] | null {
  const s = viewer.scope;
  if (!s || s.mode === "all") return null;
  if (s.mode === "none") return [];
  const folders = s.mode === "home" ? [viewer.home] : (s.folders ?? []);
  return folders.map((f) => canonicalPath(f));
}

/** Inside the scope (or no scope). */
export function inScope(real: string, viewer: Viewer): boolean {
  const roots = scopeRoots(viewer);
  if (roots === null) return true;
  const chain = lineage(real);
  return roots.some((r) => isWithin(real, r, chain));
}

/** Above one of the scope's folders: the way into it. */
function leadsIn(real: string, viewer: Viewer): boolean {
  const roots = scopeRoots(viewer);
  return roots !== null && roots.some((r) => isWithin(r, real));
}

/** Where a viewer starts: home, or the first folder of its scope. */
export function startOf(viewer: Viewer): string {
  const s = viewer.scope;
  return s?.mode === "folders" && s.folders?.length ? s.folders[0]! : viewer.home;
}

/** The checks every read makes of a path: there, not locked, in the viewer's scope. `leading` lets a folder above the
 *  scope through (its listing is narrowed to the way in). */
function reach(p: string, viewer: Viewer, leading = false): Result<{ readonly real: string; readonly scoped: boolean }> {
  // Asked by a name inside a locked place (a link in it pointing out): the place is not walked into for it either.
  if (p !== "/") { const up = realOf(dirname(p)); if (up.ok && isLocked(up.value, viewer)) return no("locked"); }
  const real = realOf(p);
  if (!real.ok) return real;
  if (isLocked(real.value, viewer)) return no("locked");
  if (inScope(real.value, viewer)) return ok({ real: real.value, scoped: false });
  if (leading && leadsIn(real.value, viewer)) return ok({ real: real.value, scoped: true });
  return no("scope");
}

/** The identities (device and inode) of the locked places that exist: a listed entry is one of them when its own
 *  identity is (a hard link to a locked file too). */
function lockedIds(viewer: Viewer): ReadonlySet<string> {
  return new Set((viewer.denied.readDenied ?? []).map(fileId).filter((x): x is string => x !== null));
}

const idOf = (st: Stats): string => `${st.dev}:${st.ino}`;
const kindOf = (st: Stats): EntryKind => (st.isDirectory() ? "dir" : st.isFile() ? "file" : st.isSymbolicLink() ? "link" : "other");

/** One entry of a folder by its own `lstat`. */
function entryOf(dir: string, name: string, viewer: Viewer, locked: ReadonlySet<string>): Entry | null {
  const full = join(dir, name);
  let st: Stats;
  try { st = lstatSync(full); } catch { return null; }
  const hidden = name.startsWith(".");
  const dim = DIM.has(name) ? { dim: true as const } : {};
  if (st.isSymbolicLink()) {
    let target = "";
    try { target = realpathSync.native(full); } catch { /* dangling */ }
    let tst: Stats | null = null;
    try { tst = target ? statSync(target) : null; } catch { tst = null; }
    const tkind = !tst ? "missing" : tst.isDirectory() ? "dir" : tst.isFile() ? "file" : "other";
    const isLockedTarget = !!target && isLocked(canonicalPath(target), viewer);
    if (isLockedTarget) return { name, kind: "link", size: 0, mtime: 0, hidden, ...dim, locked: true };
    return { name, kind: "link", size: tst?.isFile() ? tst.size : 0, mtime: tst ? tst.mtimeMs : st.mtimeMs, hidden, ...dim, link: { target: target || safeReadlink(full), kind: tkind } };
  }
  if (locked.has(idOf(st))) return { name, kind: kindOf(st), size: 0, mtime: 0, hidden, ...dim, locked: true };
  return { name, kind: kindOf(st), size: st.isFile() ? st.size : 0, mtime: st.mtimeMs, hidden, ...dim };
}

function safeReadlink(p: string): string {
  try { return readlinkSync(p); } catch { return ""; }
}

const isFolderEntry = (e: Entry): boolean => e.kind === "dir" || (e.kind === "link" && e.link?.kind === "dir");
const sortKey = (name: string): string => name.replace(/^\.+/, "");
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
/** Folders first, then by name as Finder orders them (numbers by value, case and accents aside, leading dots aside). */
export function byFinderOrder(a: Entry, b: Entry): number {
  return Number(isFolderEntry(b)) - Number(isFolderEntry(a)) || collator.compare(sortKey(a.name), sortKey(b.name)) || collator.compare(a.name, b.name);
}

/** One folder's level. Read by its names and kinds first (one call however big the folder), ordered, cut at the
 *  limit; only what is shown is looked at further. Above a device's folders only the way in is kept: the names of the
 *  next folder towards each, and links that lead in. */
export function listLevel(p: string, viewer: Viewer, opts: { readonly hidden?: boolean; readonly limit?: number } = {}): Result<Level> {
  const where = reach(p, viewer, true);
  if (!where.ok) return no(where.error);
  try { if (!statSync(p).isDirectory()) return no("not-folder"); } catch (err) { return no(errno(err)); }
  let dirents: Dirent[];
  try { dirents = readdirSync(p, { withFileTypes: true }); } catch (err) { return no(errno(err)); }
  if (where.value.scoped) {
    const ways = waysIn(where.value.real, viewer);
    dirents = dirents.filter((d) => d.isSymbolicLink() ? linkLeadsIn(join(p, d.name), viewer) : ways.has(d.name.toLowerCase()));
  }
  const shown = opts.hidden ? dirents : dirents.filter((d) => !d.name.startsWith("."));
  const folderish = (d: Dirent): boolean => d.isDirectory() || (d.isSymbolicLink() && isDirAt(join(p, d.name)));
  const keyed = shown.map((d) => ({ d, folder: folderish(d) }));
  keyed.sort((x, y) => Number(y.folder) - Number(x.folder) || collator.compare(sortKey(x.d.name), sortKey(y.d.name)) || collator.compare(x.d.name, y.d.name));
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const locked = lockedIds(viewer);
  const realDir = where.value.real;
  const entries = keyed.slice(0, limit).map(({ d }) => entryOf(p, d.name, viewer, locked)).filter((e): e is Entry => e !== null)
    .map((e) => (!e.locked && holdsFixed(realDir === "/" ? `/${e.name}` : join(realDir, e.name), viewer) ? { ...e, fixed: true as const } : e));
  const parent = p === "/" ? null : dirname(p);
  return ok({ path: p, parent, home: viewer.home, entries, more: Math.max(0, keyed.length - limit), hiddenCount: dirents.length - shown.length, ...(where.value.scoped ? { scoped: true as const } : {}) });
}

const isDirAt = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** In a folder above some of the scope's folders (`real`, as it really is): the names, lower-cased, of its entries on
 *  the way to them. */
function waysIn(real: string, viewer: Viewer): ReadonlySet<string> {
  const base = real === "/" ? "/" : real.toLowerCase() + "/";
  return new Set((scopeRoots(viewer) ?? []).map((r) => r.toLowerCase()).filter((r) => r.startsWith(base)).map((r) => r.slice(base.length).split("/")[0]!).filter(Boolean));
}

function linkLeadsIn(p: string, viewer: Viewer): boolean {
  const real = realOf(p);
  return real.ok && !isLocked(real.value, viewer) && (inScope(real.value, viewer) || leadsIn(real.value, viewer));
}

/** One entry's details. */
export function details(p: string, viewer: Viewer): Result<Details> {
  const where = reach(p, viewer, true);
  if (!where.ok) return no(where.error);
  const name = p === "/" ? "/" : basename(p);
  const entry = p === "/" ? rootEntry() : entryOf(dirname(p), name, viewer, lockedIds(viewer));
  if (!entry) return no("not-found");
  if (entry.locked) return no("locked");
  const real = where.value.real;
  // The item itself where it is (a link is not followed for this): its folder as it really is, and its name.
  const up = p === "/" ? null : realOf(dirname(p));
  const own = p === "/" ? "/" : join(up?.ok ? up.value : dirname(p), name);
  const base: Details = { ...entry, path: p, ...(real !== canonicalPath(p) || entry.kind === "link" ? { real } : {}), ...(holdsFixed(own, viewer) ? { fixed: true as const } : {}) };
  let st: Stats;
  try { st = statSync(p); } catch (err) { return no(errno(err)); }
  if (st.isDirectory()) {
    let items = 0;
    try { items = readdirSync(p).length; } catch { /* unreadable: no count */ }
    return ok({ ...base, items });
  }
  if (!st.isFile()) return ok(base);
  const type = typeOf(p, st.size);
  const lines = type === "text" && st.size <= LINES_UP_TO ? countLines(p) : undefined;
  const why = sensitiveReason(real, viewer.home);
  return ok({ ...base, type, ...(lines !== undefined ? { lines } : {}), ...(why ? { sensitive: { reason: why } } : {}) });
}

function rootEntry(): Entry {
  const st = statSync("/");
  return { name: "/", kind: "dir", size: 0, mtime: st.mtimeMs, hidden: false };
}

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".avif", ".ico", ".icns"]);
const AUDIO = new Set([".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".aif", ".aiff", ".opus"]);
const VIDEO = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"]);
const ARCHIVE = new Set([".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".dmg", ".pkg", ".iso", ".zst"]);

/** What kind of file: by its name for pictures, PDFs, sound, video and archives; otherwise text unless its first
 *  `SNIFF_BYTES` have a NUL or are not UTF-8. */
export function typeOf(p: string, size: number): FileType {
  const ext = extname(p).toLowerCase();
  if (IMAGE.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (AUDIO.has(ext)) return "audio";
  if (VIDEO.has(ext)) return "video";
  if (ARCHIVE.has(ext)) return "archive";
  if (size === 0) return "text";
  const head = readHead(p, SNIFF_BYTES);
  return head && looksLikeText(head, head.length < SNIFF_BYTES) ? "text" : "binary";
}

/** No NUL, and UTF-8 — allowing a character cut at the end unless `whole` (the buffer is all of the file). */
export function looksLikeText(buf: Buffer, whole = false): boolean {
  if (buf.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf, { stream: !whole }); return true; } catch { return false; }
}

function readHead(p: string, bytes: number): Buffer | null {
  let fd: number;
  try { fd = openSync(p, "r"); } catch { return null; }
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } catch { return null; } finally { closeSync(fd); }
}

function countLines(p: string): number | undefined {
  const buf = readHead(p, LINES_UP_TO);
  if (!buf) return undefined;
  if (!buf.length) return 0;
  let n = 0;
  for (const b of buf) if (b === 0x0a) n++;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

export type TextPreview = { readonly text: string; readonly truncated: boolean; readonly lines?: number; readonly size: number };

/** The start of a text file (`PREVIEW_BYTES`), cut at a whole character. */
export function textPreview(p: string, viewer: Viewer): Result<TextPreview> {
  const d = details(p, viewer);
  if (!d.ok) return no(d.error);
  if (d.value.kind === "dir" || (d.value.kind === "link" && d.value.link?.kind === "dir")) return no("folder");
  const buf = readHead(p, PREVIEW_BYTES) ?? Buffer.alloc(0);
  const text = new TextDecoder("utf-8").decode(buf, { stream: true });
  return ok({ text, truncated: d.value.size > buf.length, ...(d.value.lines !== undefined ? { lines: d.value.lines } : {}), size: d.value.size });
}

/** A file whose bytes may be given: there, a file, not locked, in scope. */
export function readable(p: string, viewer: Viewer): Result<{ readonly real: string; readonly size: number; readonly mtime: number }> {
  const where = reach(p, viewer);
  if (!where.ok) return no(where.error);
  let st: Stats;
  try { st = statSync(where.value.real); } catch (err) { return no(errno(err)); }
  if (st.isDirectory()) return no("folder");
  if (!st.isFile()) return no("not-found");
  return ok({ real: where.value.real, size: st.size, mtime: st.mtimeMs });
}

/** Whether `p` may be given to an agent as an attachment by this viewer (docs/files-v0.md §7.1): there, not locked, in
 *  scope. A folder may be given too. */
export function attachable(p: string, viewer: Viewer): Refusal | null {
  const where = reach(p, viewer);
  return where.ok ? null : where.error;
}

/** Why a file may hold a password or a key (docs/files-v0.md §7.3), or null. By where it is and its name only: the
 *  contents are not read for it. */
export type SensitiveReason = "ssh" | "gnupg" | "keychain" | "cloud" | "login" | "env" | "key";

const HOME_FILES: readonly (readonly [string, SensitiveReason])[] = [
  [".aws/credentials", "cloud"], [".netrc", "login"], [".git-credentials", "login"], [".npmrc", "login"], [".pypirc", "login"],
  [".docker/config.json", "login"], [".kube/config", "cloud"], [".config/gh/hosts.yml", "login"],
  // The agents' own logins (docs/agents-v0.md).
  [".codex/auth.json", "login"], [".claude/.credentials.json", "login"], [".local/share/opencode/auth.json", "login"], [".pi/agent/auth.json", "login"], [".grok/auth.json", "login"],
];
const HOME_FOLDERS: readonly (readonly [string, SensitiveReason])[] = [[".ssh", "ssh"], [".gnupg", "gnupg"], ["Library/Keychains", "keychain"]];
/** In `~/.ssh`, what is not a key. */
const SSH_PLAIN = /(\.pub|^config|^known_hosts(\.old)?|^authorized_keys)$/;
const ENV_EXAMPLE = /^\.env\.(example|sample|template|dist)$/i;

export function sensitiveReason(real: string, home: string): SensitiveReason | null {
  const name = basename(real);
  const h = canonicalPath(home);
  const lower = real.toLowerCase();
  const under = (rel: string): boolean => { const root = join(h, rel).toLowerCase(); return lower === root || lower.startsWith(root + "/"); };
  for (const [rel, why] of HOME_FOLDERS) {
    if (under(rel)) return rel === ".ssh" && SSH_PLAIN.test(name) ? null : why;
  }
  for (const [rel, why] of HOME_FILES) if (lower === join(h, rel).toLowerCase()) return why;
  if (name === ".env" || (/^\.env\./i.test(name) && !ENV_EXAMPLE.test(name))) return "env";
  if (/\.(pem|key|p12|pfx|keychain-db|keystore|jks)$/i.test(name) || /^id_(rsa|ecdsa|ed25519|dsa)(_sk)?$/.test(name)) return "key";
  return null;
}
