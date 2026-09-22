/** The development console: one static page under ui/ that only uses the API. */

import type { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const UI_DIR = resolve(new URL("../../ui/", import.meta.url).pathname);
const UI_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

/** A file under ui/ by its URL path, or null when it does not exist or escapes the directory. */
export function uiFile(urlPath: string): { body: string; type: string } | null {
  let rel: string;
  try { rel = decodeURIComponent(urlPath); } catch { return null; }
  const file = resolve(UI_DIR, "." + (rel === "" || rel === "/" ? "/index.html" : rel));
  if (file !== UI_DIR && !file.startsWith(UI_DIR + sep)) return null;
  const type = UI_TYPES[extname(file)];
  if (!type || !existsSync(file) || !statSync(file).isFile()) return null;
  return { body: readFileSync(file, "utf8"), type };
}

export function mountUi(app: Hono): void {
  app.get("/", (c) => c.redirect("/ui"));
  app.get("/ui", (c) => c.body(uiFile("/index.html")!.body, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }));
  app.get("/ui/*", (c) => {
    const f = uiFile(c.req.path.slice("/ui".length));
    return f ? c.body(f.body, 200, { "content-type": f.type, "cache-control": "no-cache" }) : c.notFound();
  });
}
