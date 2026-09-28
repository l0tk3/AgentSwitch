/** The development console: one static page under ui/ that only uses the API. */

import type { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UI_DIR = resolve(fileURLToPath(new URL("../../ui/", import.meta.url)));
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

/** The terminal page's xterm.js (docs/terminal-v0.md), served from the daemon's own dependencies: no CDN. */
const VENDOR: Record<string, readonly [string, string]> = {
  "xterm.mjs": ["@xterm/xterm/lib/xterm.mjs", "text/javascript; charset=utf-8"],
  "xterm.css": ["@xterm/xterm/css/xterm.css", "text/css; charset=utf-8"],
  "addon-fit.mjs": ["@xterm/addon-fit/lib/addon-fit.mjs", "text/javascript; charset=utf-8"],
  "addon-unicode11.mjs": ["@xterm/addon-unicode11/lib/addon-unicode11.mjs", "text/javascript; charset=utf-8"],
  "addon-web-links.mjs": ["@xterm/addon-web-links/lib/addon-web-links.mjs", "text/javascript; charset=utf-8"],
};

export function vendorFile(name: string): { body: string; type: string } | null {
  const entry = VENDOR[name];
  if (!entry) return null;
  try {
    return { body: readFileSync(createRequire(import.meta.url).resolve(entry[0]), "utf8"), type: entry[1] };
  } catch {
    return null;
  }
}

/** The pages load only their own scripts (the terminal page can reach the Mac app's bridge): nothing inline, nothing from
 *  elsewhere, never framed. Inline styles and blob/data images (attachment previews) are the pages' own. */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const page = (type: string) => ({ "content-type": type, "cache-control": "no-cache", ...(type.startsWith("text/html") ? { "content-security-policy": CSP } : {}) });

export function mountUi(app: Hono): void {
  app.get("/", (c) => c.redirect("/ui"));
  app.get("/ui/vendor/:name", (c) => {
    const f = vendorFile(c.req.param("name"));
    return f ? c.body(f.body, 200, { "content-type": f.type, "cache-control": "max-age=3600" }) : c.notFound();
  });
  app.get("/ui", (c) => c.body(uiFile("/index.html")!.body, 200, page("text/html; charset=utf-8")));
  app.get("/ui/*", (c) => {
    const f = uiFile(c.req.path.slice("/ui".length));
    return f ? c.body(f.body, 200, page(f.type)) : c.notFound();
  });
}
