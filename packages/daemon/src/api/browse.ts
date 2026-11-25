/** The Files column's routes (docs/files-v0.md §7.1): `GET /files` (one folder's level), `/files/stat` (one entry),
 *  `/files/preview` (the start of a text file), `/files/thumbnail` (a picture's small copy) and `/files/content` (the
 *  bytes, with ranges). All read only. This node's own screens see everything but AgentSwitch's own credential places;
 *  a paired device (a phone, another node) only while this node lets paired devices read its files, and only inside
 *  its scope (§7.5). A paired device's reads of contents leave one line each in `$AGENTSWITCH_HOME/files/audit.jsonl`
 *  (device, path, bytes; never what was read). */

import type { Context, Hono } from "hono";
import { appendFileSync, createReadStream, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { remoteCaller } from "../core/caller.js";
import type { ProtectedPaths } from "../core/protected.js";
import { askedPath, details, listLevel, readable, startOf, textPreview, type FileScope, type Refusal, type Viewer } from "../files/browse.js";
import { contentType } from "../files/names.js";
import type { Running, Trasher } from "../files/change.js";
import type { Thumbnails } from "../files/thumbnails.js";
import { versionedJson } from "./shared.js";

/** The most of one file a paired phone is given in one answer: its Quick Look of a file (which itself stops at
 *  25 MB), and a file it shares on, to save on the phone (docs/files-v0.md §12.3). A paired node (another Mac, a Linux
 *  node) has no such limit: a Mac's Files column downloads whole files from it (docs/files-v0.md §13). */
export const MAX_REMOTE_CONTENT = 200 * 1024 * 1024;
/** The platforms paired nodes name themselves by (nodes/nodes.ts `nodePlatform`); anything else is a phone. */
const NODE_PLATFORMS = new Set(["macos", "linux"]);

export type FileAccess = {
  /** The user's home folder: where a viewer starts, what `Home Folder` scopes and `~` mean. */
  readonly home: string;
  /** AgentSwitch's own credential places: the executors' read-denied table (executors/protected.ts). */
  readonly denied: ProtectedPaths;
  /** Whether paired devices may read files here now, may change them (absent: may), each one's scope, and what kind
   *  of device each is (its platform as it paired; absent or unknown: taken for a phone). */
  readonly remote: () => { readonly on: boolean; readonly changes?: boolean; readonly scopeOf: (deviceId: string) => FileScope; readonly platformOf?: (deviceId: string) => string | undefined };
  readonly thumbnails?: Thumbnails;
  readonly audit?: FileAudit;
  /** Where what is moved to the Trash goes (files/change.ts `systemTrash` when absent). */
  readonly trash?: Trasher;
  /** The terminals running now and their folders: a folder holding one is asked about before it moves. */
  readonly running?: () => readonly Running[];
};

/** One line per read of a file's contents by a paired device, and per change from anywhere (docs/files-v0.md §12.5). */
export class FileAudit {
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}
  record(entry: { readonly device: string; readonly action: string; readonly path: string; readonly bytes?: number; readonly to?: string }): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify({ ts: this.now(), ...entry })}\n`, { mode: 0o600 });
    } catch { /* auditing never breaks a read */ }
  }
}

/** Who asks, as `files/browse.ts` takes it; "files-off" when it is a paired device and they may not read files. */
export function viewerFor(access: FileAccess, env: unknown): Viewer | "files-off" {
  const caller = remoteCaller(env);
  if (!caller) return { denied: access.denied, home: access.home, scope: null };
  const remote = access.remote();
  return remote.on ? { denied: access.denied, home: access.home, scope: remote.scopeOf(caller.deviceId) } : "files-off";
}

const STATUS: Record<Refusal | "files-off" | "not-text" | "no-thumbnail" | "too-large", 400 | 403 | 404 | 413 | 415 | 416> = {
  "bad-path": 400, "not-folder": 400, folder: 400, "not-found": 404, locked: 403, scope: 403, permission: 403, "files-off": 403,
  "not-text": 415, "no-thumbnail": 415, "too-large": 413,
};
const refuse = (c: Context, error: keyof typeof STATUS, more: Record<string, unknown> = {}) => c.json({ error, ...more }, STATUS[error]);

/** A downloaded file is data, never a page of this origin. */
const CONTENT_HEADERS = {
  "cache-control": "private, no-cache",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
} as const;

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` of a file `size` long; null for no range, "bad" for one that cannot be served. */
export function rangeOf(header: string | undefined, size: number): { readonly start: number; readonly end: number } | null | "bad" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  let start: number, end: number;
  if (m[1] === "") { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start > end || start >= size ? "bad" : { start, end };
}

export function mountBrowse(app: Hono, access: FileAccess): void {
  /** The viewer and the path asked for, or the answer that refuses. */
  const asked = (c: Context): { viewer: Viewer; path: string | null } | Response => {
    const viewer = viewerFor(access, c.env);
    if (viewer === "files-off") return refuse(c, "files-off");
    const raw = c.req.query("path");
    const path = raw === undefined || raw === "" ? null : askedPath(raw, access.home);
    if (raw !== undefined && raw !== "" && path === null) return refuse(c, "bad-path");
    return { viewer, path };
  };
  const audit = (c: Context, action: "preview" | "thumbnail" | "content", path: string, bytes: number) => {
    const caller = remoteCaller(c.env);
    if (caller) access.audit?.record({ device: caller.deviceId, action, path, bytes });
  };

  app.get("/files", (c) => {
    const a = asked(c);
    if (a instanceof Response) return a;
    const limit = Number(c.req.query("limit"));
    const level = listLevel(a.path ?? startOf(a.viewer), a.viewer, { hidden: c.req.query("hidden") === "1", ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}) });
    // Asked again every few seconds while a folder is open: an unchanged level is a 304.
    return level.ok ? versionedJson(c, level.value) : refuse(c, level.error);
  });

  app.get("/files/stat", (c) => {
    const a = asked(c);
    if (a instanceof Response) return a;
    const d = details(a.path ?? startOf(a.viewer), a.viewer);
    return d.ok ? c.json(d.value) : refuse(c, d.error);
  });

  app.get("/files/preview", (c) => {
    const a = asked(c);
    if (a instanceof Response) return a;
    if (!a.path) return refuse(c, "bad-path");
    const d = details(a.path, a.viewer);
    if (!d.ok) return refuse(c, d.error);
    if (d.value.items !== undefined) return refuse(c, "folder");
    if (d.value.type !== "text") return refuse(c, "not-text", { type: d.value.type ?? null });
    const p = textPreview(a.path, a.viewer);
    if (!p.ok) return refuse(c, p.error);
    audit(c, "preview", a.path, Buffer.byteLength(p.value.text));
    return c.json(p.value);
  });

  app.get("/files/thumbnail", async (c) => {
    const a = asked(c);
    if (a instanceof Response) return a;
    if (!a.path) return refuse(c, "bad-path");
    const d = details(a.path, a.viewer);
    if (!d.ok) return refuse(c, d.error);
    if (d.value.type !== "image") return refuse(c, "no-thumbnail");
    const r = readable(a.path, a.viewer);
    if (!r.ok) return refuse(c, r.error);
    const t = await access.thumbnails?.of(r.value.real, r.value.size, r.value.mtime);
    if (!t) return refuse(c, "no-thumbnail");
    audit(c, "thumbnail", a.path, t.bytes.length);
    return c.body(new Uint8Array(t.bytes), 200, { ...CONTENT_HEADERS, "content-type": t.type, "content-length": String(t.bytes.length) });
  });

  app.get("/files/content", (c) => {
    const a = asked(c);
    if (a instanceof Response) return a;
    if (!a.path) return refuse(c, "bad-path");
    const r = readable(a.path, a.viewer);
    if (!r.ok) return refuse(c, r.error);
    const { real, size, mtime } = r.value;
    const range = rangeOf(c.req.header("range"), size);
    if (range === "bad") return c.body(null, 416, { "content-range": `bytes */${size}` });
    const length = range ? range.end - range.start + 1 : size;
    const caller = remoteCaller(c.env);
    if (caller && length > MAX_REMOTE_CONTENT && !NODE_PLATFORMS.has(access.remote().platformOf?.(caller.deviceId) ?? "")) return refuse(c, "too-large", { limit: MAX_REMOTE_CONTENT, size });
    const name = basename(a.path);
    const headers: Record<string, string> = {
      ...CONTENT_HEADERS, "content-type": contentType(name), "content-length": String(length), "accept-ranges": "bytes",
      "last-modified": new Date(mtime).toUTCString(), "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${size}` } : {}),
    };
    audit(c, "content", a.path, length);
    if (length === 0) return c.body(null, range ? 206 : 200, headers);
    const body = Readable.toWeb(createReadStream(real, range ? { start: range.start, end: range.end } : {})) as ReadableStream<Uint8Array>;
    return c.body(body, range ? 206 : 200, headers);
  });
}
