/** Uploads are staged, then moved into <cwd>/in/ by POST /tasks. Downloads come from the artifacts store once an
 *  ephemeral cwd is gone, otherwise from the task's own <cwd>/in/ (attachments) and <cwd>/out/ (deliverables) only:
 *  never the rest of a user-chosen cwd, never through a symlink or hard link, never from a place that holds
 *  credentials (the cwd rules are applied again to the cwd and to the resolved file). */

import type { Hono } from "hono";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { listTree, resolveInside } from "../files/artifacts.js";
import { ATTACH_DIR, contentType, isImage, MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD, OUT_DIR } from "../files/names.js";
import type { Task } from "../engine/types.js";
import { checkStoredCwd, deniedRootOf, isWorkDir, physicalPath } from "./cwdPolicy.js";
import type { ApiDeps } from "./shared.js";

/** A downloaded file is data, never a page of this origin: an SVG or HTML deliverable opened directly runs no script. */
const DOWNLOAD_HEADERS = {
  "cache-control": "private, no-cache",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
} as const;

/** Where a task's files are read from: each dir a real directory (not a symlink), listed paths prefixed. `owned` = the
 *  daemon made the directory (artifacts store, a work dir under workRoot), so the cwd rules do not apply to it. */
type Source = { readonly root: "artifacts" | "cwd"; readonly dirs: readonly { readonly prefix: string; readonly dir: string }[]; readonly owned: boolean };

const realDir = (p: string): boolean => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
/** A hard link makes a file from anywhere look like one of the task's own. */
const singleLink = (p: string): boolean => { try { return lstatSync(p).nlink === 1; } catch { return false; } };
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

function taskSource(deps: ApiDeps, task: Task): Source | null {
  const art = join(deps.artifactsDir, task.id);
  if (realDir(art)) return { root: "artifacts", dirs: [{ prefix: "", dir: physicalPath(art) }], owned: true };
  if (!isDir(task.cwd) || checkStoredCwd(task.cwd, deps.cwdRules, deps.workRoot)) return null;
  const cwd = physicalPath(task.cwd);
  const owned = isWorkDir(cwd, deps.workRoot);
  const dirs = [ATTACH_DIR, OUT_DIR].filter((name) => realDir(join(cwd, name))).map((name) => ({ prefix: `${name}/`, dir: join(cwd, name) }));
  return { root: "cwd", dirs, owned };
}

/** The real path of `rel` in the source, or null: outside in/ and out/, a directory, escaping through a symlink,
 *  hard-linked from elsewhere, or inside a denied root. */
function sourceFile(deps: ApiDeps, src: Source, rel: string): string | null {
  const d = src.dirs.find((x) => rel.startsWith(x.prefix));
  const file = d ? resolveInside(d.dir, rel.slice(d.prefix.length)) : null;
  if (!file) return null;
  let real: string;
  try { real = realpathSync.native(file); } catch { return null; }
  if (!singleLink(real)) return null;
  if (!src.owned && deniedRootOf(real, deps.cwdRules)) return null;
  return real;
}

export function mountFiles(app: Hono, deps: ApiDeps): void {
  app.post("/uploads", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "multipart form expected" }, 400);
    const entries = [...form.values()].filter((v): v is File => v instanceof File);
    if (!entries.length) return c.json({ error: "no files" }, 400);
    if (entries.length > MAX_FILES_PER_UPLOAD) return c.json({ error: `at most ${MAX_FILES_PER_UPLOAD} files per upload` }, 400);
    const big = entries.find((f) => f.size > MAX_FILE_BYTES);
    if (big) return c.json({ error: `${big.name} exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB` }, 413);
    const files = [];
    for (const f of entries) files.push(deps.uploads.stage(f.name, Buffer.from(await f.arrayBuffer()), f.type));
    return c.json({ files });
  });

  app.get("/tasks/:id/files", (c) => {
    const task = deps.store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const src = taskSource(deps, task);
    const files = src ? src.dirs.flatMap((d) => listTree(d.dir).filter((f) => singleLink(join(d.dir, f.path))).map((f) => ({ ...f, path: d.prefix + f.path }))) : [];
    return c.json({ root: src?.root ?? null, files });
  });

  app.get("/tasks/:id/files/*", (c) => {
    const task = deps.store.getTask(c.req.param("id"));
    const src = task ? taskSource(deps, task) : null;
    if (!src) return c.notFound();
    const marker = "/files/";
    let rel: string;
    try { rel = decodeURIComponent(c.req.path.slice(c.req.path.indexOf(marker) + marker.length)); } catch { return c.notFound(); }
    const file = sourceFile(deps, src, rel);
    if (!file) return c.notFound();
    const name = rel.split("/").pop() ?? "file";
    const disposition = `${isImage(name) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`;
    return c.body(readFileSync(file), 200, { ...DOWNLOAD_HEADERS, "content-type": contentType(name), "content-disposition": disposition });
  });
}
