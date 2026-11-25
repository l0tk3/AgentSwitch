/** `POST /uploads`: files a screen hands over are staged in the data directory (files/uploads.ts); a terminal's
 *  message then names them (`POST /terminals/:id/attach`). */

import type { Hono } from "hono";
import { MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD } from "../files/names.js";
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
}
