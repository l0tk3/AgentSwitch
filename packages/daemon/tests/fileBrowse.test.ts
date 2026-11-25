/** The Files column's reads (docs/files-v0.md §7): one level, one entry, a preview, the bytes; AgentSwitch's own
 *  credential places locked; files that may hold a password told; a paired device held to this node's switch and to its
 *  scope. On a made-up disk in a temporary folder. */

import { appendFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { FileAudit, MAX_REMOTE_CONTENT, mountBrowse, rangeOf, viewerFor, type FileAccess } from "../src/api/browse.js";
import { markRemote } from "../src/core/caller.js";
import type { ProtectedPaths } from "../src/core/protected.js";
import { askedPath, attachable, byFinderOrder, details, listLevel, sensitiveReason, textPreview, typeOf, type FileScope, type Viewer } from "../src/files/browse.js";
import { Thumbnails } from "../src/files/thumbnails.js";
import { remoteAllowed } from "../src/remote/routes.js";

/** A disk: `/root/Users/you` is home, with AgentSwitch's credential places under `.agentswitch` and `.secret-gate`. */
function disk() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-browse-")));
  const home = join(root, "Users", "you");
  const p = (...parts: string[]) => join(home, ...parts);
  for (const d of ["Projects/lumen/src", "Projects/lumen/node_modules", "Projects/harbor", "Documents", ".agentswitch/nodes", ".agentswitch/terminals", ".secret-gate", ".ssh", ".codex"]) mkdirSync(p(d), { recursive: true });
  mkdirSync(join(root, "Users", "Shared"), { recursive: true });
  writeFileSync(p("Projects/lumen/src/app.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(p("Projects/lumen/src/file10.ts"), "x");
  writeFileSync(p("Projects/lumen/src/file9.ts"), "x");
  writeFileSync(p("Projects/lumen/.env"), "SECRET=1\n");
  writeFileSync(p("Projects/lumen/.env.example"), "SECRET=\n");
  writeFileSync(p("Projects/lumen/logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(p("Projects/lumen/blob.bin"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(p("Projects/lumen/latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in Latin-1: not UTF-8
  writeFileSync(p("Documents/plan.md"), "# plan\n");
  writeFileSync(p(".agentswitch/local-token"), "secret-token");
  writeFileSync(p(".agentswitch/nodes/peers.json"), "{}");
  writeFileSync(p(".agentswitch/terminals/audit.jsonl"), "");
  writeFileSync(p(".secret-gate/key"), "k");
  writeFileSync(p(".ssh/id_ed25519"), "key");
  writeFileSync(p(".ssh/id_ed25519.pub"), "pub");
  writeFileSync(p(".ssh/config"), "Host x");
  writeFileSync(p(".codex/auth.json"), "{}");
  // A hard link to the token, a link into a locked place, a link out to Documents, and one to nowhere.
  linkSync(p(".agentswitch/local-token"), p("Projects/token-copy"));
  symlinkSync(p(".secret-gate"), p("Projects/gate-link"));
  symlinkSync(p("Documents"), p("Projects/lumen/docs-link"));
  symlinkSync(p("Projects/lumen/.env"), p("Projects/env-link"));
  symlinkSync(p("nowhere"), p("Projects/dangling"));
  const denied: ProtectedPaths = { roots: [], exempt: [], readDenied: [p(".secret-gate"), p(".agentswitch/nodes"), p(".agentswitch/local-token")] };
  const viewer = (scope: FileScope | null = null): Viewer => ({ denied, home, scope });
  return { root, home, p, denied, viewer };
}

const names = (r: ReturnType<typeof listLevel>): string[] => (r.ok ? r.value.entries.map((e) => e.name) : [`<${r.error}>`]);

describe("the path asked for", () => {
  it("is absolute and plain; ~ is home; a trailing slash is let go", () => {
    expect(askedPath("~", "/Users/you")).toBe("/Users/you");
    expect(askedPath("~/Projects", "/Users/you")).toBe("/Users/you/Projects");
    expect(askedPath(undefined, "/Users/you")).toBe("/Users/you");
    expect(askedPath("/Users/you/", "/h")).toBe("/Users/you");
    expect(askedPath("/", "/h")).toBe("/");
    for (const bad of ["Projects", "./x", "/Users/../etc", "/Users/./you", "//Users", "/a//b", "/a\nb", "/a\u0000b"]) expect(askedPath(bad, "/h")).toBeNull();
  });
});

describe("one folder's level", () => {
  it("folders first, then by name as Finder orders it; hidden ones only when asked, and counted", () => {
    const d = disk();
    const lumen = listLevel(d.p("Projects/lumen"), d.viewer());
    expect(names(lumen)).toEqual(["docs-link", "node_modules", "src", "blob.bin", "latin1.txt", "logo.png"]);
    expect(lumen.ok && lumen.value.hiddenCount).toBe(2);
    expect(names(listLevel(d.p("Projects/lumen"), d.viewer(), { hidden: true }))).toEqual(["docs-link", "node_modules", "src", "blob.bin", ".env", ".env.example", "latin1.txt", "logo.png"]);
    expect(names(listLevel(d.p("Projects/lumen/src"), d.viewer()))).toEqual(["app.ts", "file9.ts", "file10.ts"]);
    const nm = lumen.ok ? lumen.value.entries.find((e) => e.name === "node_modules") : undefined;
    expect(nm).toMatchObject({ kind: "dir", dim: true });
    const link = lumen.ok ? lumen.value.entries.find((e) => e.name === "docs-link") : undefined;
    expect(link).toMatchObject({ kind: "link", link: { target: d.p("Documents"), kind: "dir" } });
    expect(lumen.ok && lumen.value.parent).toBe(d.p("Projects"));
    expect(byFinderOrder({ name: "b", kind: "file", size: 0, mtime: 0, hidden: false }, { name: "A", kind: "dir", size: 0, mtime: 0, hidden: false })).toBeGreaterThan(0);
  });

  it("stops at the limit and says how many more", () => {
    const d = disk();
    const r = listLevel(d.p("Projects/lumen/src"), d.viewer(), { limit: 2 });
    expect(names(r)).toEqual(["app.ts", "file9.ts"]);
    expect(r.ok && r.value.more).toBe(1);
  });

  it("lists AgentSwitch's credential places by name and lock only, however they are reached, and does not open them", () => {
    const d = disk();
    const home = listLevel(d.home, d.viewer(), { hidden: true });
    expect(home.ok && home.value.entries.find((e) => e.name === ".secret-gate")).toEqual({ name: ".secret-gate", kind: "dir", size: 0, mtime: 0, hidden: true, locked: true });
    const as = listLevel(d.p(".agentswitch"), d.viewer(), { hidden: true });
    expect(as.ok && as.value.entries.filter((e) => e.locked).map((e) => e.name).sort()).toEqual(["local-token", "nodes"]);
    expect(as.ok && as.value.entries.find((e) => e.name === "terminals")?.locked).toBeUndefined();
    const projects = listLevel(d.p("Projects"), d.viewer());
    const by = (n: string) => (projects.ok ? projects.value.entries.find((e) => e.name === n) : undefined);
    // A hard link to the token is the token; a link into the gate's folder is the gate's folder.
    expect(by("token-copy")).toMatchObject({ locked: true, size: 0 });
    expect(by("gate-link")).toMatchObject({ kind: "link", locked: true });
    expect(by("gate-link")?.link).toBeUndefined();
    expect(by("dangling")).toMatchObject({ kind: "link", link: { kind: "missing" } });
    for (const p of [d.p(".secret-gate"), d.p("Projects/gate-link"), d.p(".agentswitch/nodes")]) expect(names(listLevel(p, d.viewer()))).toEqual(["<locked>"]);
    expect(details(d.p("Projects/token-copy"), d.viewer())).toEqual({ ok: false, error: "locked" });
    expect(details(d.p(".secret-gate/key"), d.viewer())).toEqual({ ok: false, error: "locked" });
    expect(textPreview(d.p(".agentswitch/local-token"), d.viewer())).toEqual({ ok: false, error: "locked" });
  });

  it("says what is not there and what is not a folder", () => {
    const d = disk();
    expect(names(listLevel(d.p("nope"), d.viewer()))).toEqual(["<not-found>"]);
    expect(names(listLevel(d.p("Documents/plan.md"), d.viewer()))).toEqual(["<not-folder>"]);
  });
});

describe("one entry", () => {
  it("tells text from the rest by name for pictures and the like, by its first bytes otherwise; counts a text file's lines", () => {
    const d = disk();
    expect(typeOf(d.p("Projects/lumen/logo.png"), 4)).toBe("image");
    expect(typeOf(d.p("Projects/lumen/blob.bin"), 4)).toBe("binary");
    expect(typeOf(d.p("Projects/lumen/latin1.txt"), 4)).toBe("binary");
    const app = details(d.p("Projects/lumen/src/app.ts"), d.viewer());
    expect(app).toMatchObject({ ok: true, value: { name: "app.ts", kind: "file", type: "text", lines: 2, size: 40 } });
    expect(details(d.p("Projects/lumen/src"), d.viewer())).toMatchObject({ ok: true, value: { kind: "dir", items: 3 } });
    expect(details("/", d.viewer())).toMatchObject({ ok: true, value: { name: "/", kind: "dir" } });
  });

  it("says a file may hold a password by where it is and its name, a link by its target", () => {
    const d = disk();
    const why = (rel: string) => { const r = details(d.p(rel), d.viewer()); return r.ok ? r.value.sensitive?.reason ?? null : r.error; };
    expect(why("Projects/lumen/.env")).toBe("env");
    expect(why("Projects/lumen/.env.example")).toBeNull();
    expect(why(".ssh/id_ed25519")).toBe("ssh");
    expect(why(".ssh/id_ed25519.pub")).toBeNull();
    expect(why(".ssh/config")).toBeNull();
    expect(why(".codex/auth.json")).toBe("login");
    expect(why("Projects/env-link")).toBe("env");
    expect(why("Projects/lumen/src/app.ts")).toBeNull();
    expect(sensitiveReason("/any/where/server.pem", d.home)).toBe("key");
    expect(sensitiveReason("/any/where/id_rsa", d.home)).toBe("key");
    expect(sensitiveReason(join(d.home, "Library", "Keychains", "login.keychain-db"), d.home)).toBe("keychain");
  });

  it("gives the start of a text file, cut at a whole character, and refuses the rest", () => {
    const d = disk();
    const big = d.p("Projects/lumen/big.txt");
    // 64 KB of "é" (two bytes each) and one more: the cut falls in the middle of none.
    writeFileSync(big, "a" + "é".repeat(40_000));
    const r = textPreview(big, d.viewer());
    expect(r.ok && r.value.truncated).toBe(true);
    expect(r.ok && r.value.text.length).toBe(1 + (64 * 1024 - 1) / 2 - 0.5);
    expect(r.ok && r.value.text.endsWith("é")).toBe(true);
    expect(textPreview(d.p("Projects/lumen/src/app.ts"), d.viewer())).toMatchObject({ ok: true, value: { truncated: false, lines: 2 } });
    expect(textPreview(d.p("Projects/lumen/src"), d.viewer())).toEqual({ ok: false, error: "folder" });
  });
});

describe("a paired device's scope (docs/files-v0.md §7.5)", () => {
  it("its home folder: everything under it; above it only the way in", () => {
    const d = disk();
    const v = d.viewer({ mode: "home" });
    const users = listLevel(join(d.root, "Users"), v);
    expect(names(users)).toEqual(["you"]);
    expect(users.ok && users.value.scoped).toBe(true);
    expect(names(listLevel(d.p("Projects/lumen/src"), v))).toEqual(["app.ts", "file9.ts", "file10.ts"]);
    expect(names(listLevel(join(d.root, "Users", "Shared"), v))).toEqual(["<scope>"]);
    expect(details(join(d.root, "Users", "Shared"), v)).toEqual({ ok: false, error: "scope" });
  });

  it("some folders: only the way to them above them, all of them inside; a link out of them is out", () => {
    const d = disk();
    const v = d.viewer({ mode: "folders", folders: [d.p("Projects/lumen")] });
    expect(names(listLevel(d.home, v, { hidden: true }))).toEqual(["Projects"]);
    // A link here that leads into the scope is a way in too.
    expect(names(listLevel(d.p("Projects"), v))).toEqual(["lumen", "env-link"]);
    expect(names(listLevel(d.p("Projects/lumen"), v))).toContain("src");
    expect(names(listLevel(d.p("Documents"), v))).toEqual(["<scope>"]);
    expect(names(listLevel(d.p("Projects/lumen/docs-link"), v))).toEqual(["<scope>"]);
    expect(attachable(d.p("Projects/lumen/src/app.ts"), v)).toBeNull();
    expect(attachable(d.p("Documents/plan.md"), v)).toBe("scope");
    // A link from outside into the scope is let in: what it reaches is inside.
    expect(attachable(d.p("Projects/env-link"), v)).toBeNull();
  });

  it("none: nothing; all: everything but the locked places", () => {
    const d = disk();
    expect(names(listLevel(d.home, d.viewer({ mode: "none" })))).toEqual(["<scope>"]);
    expect(attachable(d.p("Documents/plan.md"), d.viewer({ mode: "none" }))).toBe("scope");
    expect(names(listLevel(join(d.root, "Users"), d.viewer({ mode: "all" })))).toEqual(["Shared", "you"]);
    expect(attachable(d.p(".secret-gate/key"), d.viewer({ mode: "all" }))).toBe("locked");
    expect(attachable(d.p(".agentswitch/local-token"), d.viewer())).toBe("locked");
  });
});

describe("the routes", () => {
  function served(over: Partial<FileAccess> & { on?: boolean; scope?: FileScope } = {}) {
    const d = disk();
    const auditPath = join(d.root, "audit.jsonl");
    const access: FileAccess = {
      home: d.home, denied: d.denied, audit: new FileAudit(auditPath),
      remote: () => ({ on: over.on ?? true, scopeOf: () => over.scope ?? { mode: "home" } }),
      thumbnails: new Thumbnails(async (_input, out) => { writeFileSync(out, Buffer.from("jpeg")); return true; }),
      ...over,
    };
    const app = new Hono();
    mountBrowse(app, access);
    const phone = markRemote({}, { deviceId: "phone-1" });
    const get = (path: string, opts: { remote?: boolean; headers?: Record<string, string> } = {}) => app.request(path, { headers: opts.headers ?? {} }, opts.remote ? phone : undefined);
    const q = (p: string) => encodeURIComponent(p);
    return { d, app, get, q, auditPath };
  }

  it("are on the remote list, read only; a device's scope is set on this node alone", () => {
    for (const p of ["/files", "/files/stat", "/files/preview", "/files/thumbnail", "/files/content"]) {
      expect(remoteAllowed("GET", p)).toBe(true);
      expect(remoteAllowed("POST", p)).toBe(false);
    }
    expect(remoteAllowed("PUT", "/devices/x/files")).toBe(false);
    expect(remoteAllowed("GET", "/settings/mesh")).toBe(false);
  });

  it("list a level, unchanged as a 304; start at home; refuse a path not plainly written", async () => {
    const s = served();
    const res = await s.get(`/files?path=${s.q(s.d.p("Projects/lumen"))}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: { name: string }[]; home: string };
    expect(body.entries.map((e) => e.name)).toContain("src");
    const again = await s.get(`/files?path=${s.q(s.d.p("Projects/lumen"))}`, { headers: { "if-none-match": res.headers.get("etag")! } });
    expect(again.status).toBe(304);
    expect(((await (await s.get("/files")).json()) as { path: string }).path).toBe(s.d.home);
    expect((await s.get(`/files?path=${s.q("/a/../b")}`)).status).toBe(400);
    expect(await (await s.get(`/files?path=${s.q(s.d.p(".secret-gate"))}`)).json()).toEqual({ error: "locked" });
  });

  it("hold a paired device to the node's switch and to its scope", async () => {
    const off = served({ on: false });
    const r = await off.get(`/files?path=${off.q(off.d.home)}`, { remote: true });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "files-off" });
    expect((await off.get(`/files?path=${off.q(off.d.home)}`)).status).toBe(200);
    const some = served({ scope: { mode: "folders", folders: [] } });
    const lumen = some.d.p("Projects/lumen");
    const scoped = served({ scope: { mode: "folders", folders: [lumen] } });
    expect(((await (await scoped.get("/files", { remote: true })).json()) as { path: string }).path).toBe(lumen);
    expect(await (await scoped.get(`/files/stat?path=${scoped.q(scoped.d.p("Documents/plan.md"))}`, { remote: true })).json()).toEqual({ error: "scope" });
    expect(viewerFor({ home: "/h", denied: { roots: [], exempt: [] }, remote: () => ({ on: true, scopeOf: (id) => ({ mode: id === "a" ? "all" : "none" }) }) }, markRemote({}, { deviceId: "a" }))).toMatchObject({ scope: { mode: "all" } });
  });

  it("preview text, give a picture's small copy, and refuse the wrong kind", async () => {
    const s = served();
    const app = await s.get(`/files/preview?path=${s.q(s.d.p("Projects/lumen/src/app.ts"))}`);
    expect(await app.json()).toEqual({ text: "export const a = 1;\nexport const b = 2;\n", truncated: false, lines: 2, size: 40 });
    const blob = await s.get(`/files/preview?path=${s.q(s.d.p("Projects/lumen/blob.bin"))}`);
    expect(blob.status).toBe(415);
    expect(await blob.json()).toEqual({ error: "not-text", type: "binary" });
    const thumb = await s.get(`/files/thumbnail?path=${s.q(s.d.p("Projects/lumen/logo.png"))}`, { remote: true });
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await thumb.arrayBuffer()).toString()).toBe("jpeg");
    expect((await s.get(`/files/thumbnail?path=${s.q(s.d.p("Projects/lumen/src/app.ts"))}`)).status).toBe(415);
  });

  it("give the bytes, a range of them, and to a paired device no more than the limit; its reads are audited, by size only", async () => {
    const s = served();
    const file = s.d.p("Projects/lumen/src/app.ts");
    const whole = await s.get(`/files/content?path=${s.q(file)}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(await whole.text()).toBe(readFileSync(file, "utf8"));
    const part = await s.get(`/files/content?path=${s.q(file)}`, { headers: { range: "bytes=7-11" }, remote: true });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 7-11/40");
    expect(await part.text()).toBe("const");
    expect((await s.get(`/files/content?path=${s.q(file)}`, { headers: { range: "bytes=99-" } })).status).toBe(416);
    expect((await s.get(`/files/content?path=${s.q(s.d.p("Projects/lumen/src"))}`)).status).toBe(400);
    const big = s.d.p("Projects/lumen/huge.bin");
    writeFileSync(big, "");
    truncateSync(big, MAX_REMOTE_CONTENT + 1);
    const refused = await s.get(`/files/content?path=${s.q(big)}`, { remote: true });
    expect(refused.status).toBe(413);
    expect((await s.get(`/files/content?path=${s.q(big)}`, { headers: { range: "bytes=0-9" }, remote: true })).status).toBe(206);
    // A paired node (a Mac downloading from this one, docs/files-v0.md §13) is given the whole file; a device of no
    // known platform is taken for a phone.
    const nodes = served({ remote: () => ({ on: true, scopeOf: () => ({ mode: "home" }), platformOf: (id) => ({ "mac-2": "macos", "box-1": "linux" }[id]) }) });
    const bigThere = nodes.d.p("Projects/lumen/huge.bin");
    writeFileSync(bigThere, "");
    truncateSync(bigThere, MAX_REMOTE_CONTENT + 1);
    for (const [device, status] of [["mac-2", 200], ["box-1", 200], ["phone-1", 413]] as const) {
      const whole = await nodes.app.request(`/files/content?path=${s.q(bigThere)}`, { headers: {} }, markRemote({}, { deviceId: device }));
      expect(whole.status, device).toBe(status);
      await whole.body?.cancel();
    }
    const lines = readFileSync(s.auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([
      expect.objectContaining({ device: "phone-1", action: "content", path: file, bytes: 5 }),
      expect.objectContaining({ device: "phone-1", action: "content", path: big, bytes: 10 }),
    ]);
    expect(readFileSync(s.auditPath, "utf8")).not.toContain("const");
    appendFileSync(s.auditPath, "");
  });

  it("read a range header as the standard says", () => {
    expect(rangeOf(undefined, 10)).toBeNull();
    expect(rangeOf("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(rangeOf("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(rangeOf("bytes=2-100", 10)).toEqual({ start: 2, end: 9 });
    expect(rangeOf("bytes=5-2", 10)).toBe("bad");
    expect(rangeOf("bytes=10-", 10)).toBe("bad");
    expect(rangeOf("bytes=0-1,4-5", 10)).toBe("bad");
  });
});
