/** Uploads are staged, then moved into <cwd>/in/ by POST /tasks; downloads come from the artifacts store once an
 *  ephemeral cwd is gone, otherwise from the cwd itself. */

import type { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listTree, resolveInside } from "../files/artifacts.js";
import { contentType, isImage, MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD } from "../files/names.js";
import type { ApiDeps } from "./shared.js";

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

  const fileRoot = (id: string): { root: "artifacts" | "cwd"; dir: string } | null => {
    const task = deps.store.getTask(id);
    if (!task) return null;
    const art = join(deps.artifactsDir, task.id);
    if (existsSync(art)) return { root: "artifacts", dir: art };
    return existsSync(task.cwd) ? { root: "cwd", dir: task.cwd } : null;
  };

  app.get("/tasks/:id/files", (c) => {
    const task = deps.store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const r = fileRoot(task.id);
    return c.json({ root: r?.root ?? null, files: r ? listTree(r.dir) : [] });
  });

  app.get("/tasks/:id/files/*", (c) => {
    const r = fileRoot(c.req.param("id"));
    if (!r) return c.notFound();
    let rel: string;
    try { rel = decodeURIComponent(c.req.path.split("/files/")[1] ?? ""); } catch { return c.notFound(); }
    const file = resolveInside(r.dir, rel);
    if (!file) return c.notFound();
    const name = rel.split("/").pop() ?? "file";
    const disposition = `${isImage(name) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`;
    return c.body(readFileSync(file), 200, { "content-type": contentType(name), "content-disposition": disposition, "cache-control": "private, no-cache" });
  });

}
