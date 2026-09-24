import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectOut, listTree, resolveInside, sweepDir } from "../src/files/artifacts.js";
import { ATTACH_DIR, contentType, isImage, OUT_DIR, safeName } from "../src/files/names.js";
import { attachmentsNote } from "../src/files/notes.js";
import { Uploads } from "../src/files/uploads.js";

const tmp = () => mkdtempSync(join(tmpdir(), "agentswitch-files-"));

describe("names", () => {
  it("keeps the basename, drops control chars and leading dots, caps length", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("a b\u0000c.png")).toBe("a b_c.png");
    expect(safeName(".env")).toBe("_env");
    expect(safeName("")).toBe("file");
    expect(safeName("x".repeat(300) + ".txt").length).toBeLessThanOrEqual(120);
    expect(safeName("截图 2026-09-21.png")).toBe("截图 2026-09-21.png");
  });
  it("classifies images and content types", () => {
    expect(isImage("a.PNG")).toBe(true);
    expect(isImage("a.pdf")).toBe(false);
    expect(contentType("a.png")).toBe("image/png");
    expect(contentType("a.bin")).toBe("application/octet-stream");
    expect(ATTACH_DIR).toBe("in");
    expect(OUT_DIR).toBe("out");
  });
});

describe("uploads", () => {
  it("stages, moves into <cwd>/in with de-duplicated names, rejects unknown ids", () => {
    const u = new Uploads(join(tmp(), "uploads"));
    const a = u.stage("shot.png", Buffer.from("png1"), "image/png");
    const b = u.stage("shot.png", Buffer.from("png2"), "image/png");
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ name: "shot.png", size: 4, type: "image/png" });
    const cwd = tmp();
    const attached = u.moveInto([a.id, b.id], cwd);
    expect(attached.map((x) => x.path)).toEqual(["in/shot.png", "in/shot-2.png"]);
    expect(readFileSync(join(cwd, "in", "shot-2.png"), "utf8")).toBe("png2");
    expect(existsSync(join(u.dir, a.id))).toBe(false);
    expect(() => u.moveInto(["nope"], cwd)).toThrow(/unknown upload/);
  });
  it("sweeps stale staging dirs", () => {
    const u = new Uploads(join(tmp(), "uploads"));
    const a = u.stage("x.txt", Buffer.from("x"), "text/plain");
    const old = new Date(Date.now() - 3 * 86400_000);
    utimesSync(join(u.dir, a.id), old, old);
    expect(sweepDir(u.dir, 86400_000)).toEqual([a.id]);
    expect(existsSync(join(u.dir, a.id))).toBe(false);
  });
});

describe("artifacts", () => {
  it("lists a tree without .git/node_modules and confines paths", () => {
    const root = tmp();
    mkdirSync(join(root, "out", "deep"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "out", "deep", "r.md"), "# r");
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, ".git", "HEAD"), "ref");
    writeFileSync(join(root, "node_modules", "x", "i.js"), "1");
    expect(listTree(root).map((f) => f.path)).toEqual(["a.txt", "out/deep/r.md"]);
    expect(listTree(root)[1]).toMatchObject({ size: 3 });
    expect(resolveInside(root, "out/deep/r.md")).toBe(join(root, "out", "deep", "r.md"));
    expect(resolveInside(root, "../x")).toBeNull();
    expect(resolveInside(root, "out/deep/../../../x")).toBeNull();
    expect(resolveInside(root, "missing.txt")).toBeNull();
    expect(resolveInside(root, "out")).toBeNull();   // directories are not downloadable
  });
  it("copies out/ into the artifacts dir and reports the count", () => {
    const cwd = tmp();
    const dest = join(tmp(), "artifacts", "t1");
    expect(collectOut(cwd, dest)).toBe(0);
    expect(existsSync(dest)).toBe(false);
    mkdirSync(join(cwd, "out", "img"), { recursive: true });
    writeFileSync(join(cwd, "out", "report.md"), "r");
    writeFileSync(join(cwd, "out", "img", "p.png"), "p");
    expect(collectOut(cwd, dest)).toBe(2);
    expect(readFileSync(join(dest, "img", "p.png"), "utf8")).toBe("p");
  });
  it("keeps only the task's own files: no symlink, hard link or symlinked out/ reaches the artifacts store", () => {
    const outside = tmp();
    writeFileSync(join(outside, "id_ed25519"), "KEY");
    const cwd = tmp();
    mkdirSync(join(cwd, "out"));
    writeFileSync(join(cwd, "out", "report.md"), "r");
    symlinkSync(join(outside, "id_ed25519"), join(cwd, "out", "key"));
    symlinkSync(outside, join(cwd, "out", "dir"));
    linkSync(join(outside, "id_ed25519"), join(cwd, "out", "hard"));
    const dest = join(tmp(), "artifacts", "t2");
    expect(collectOut(cwd, dest)).toBe(1);
    expect(listTree(dest).map((f) => f.path)).toEqual(["report.md"]);
    expect(existsSync(join(dest, "key")) || existsSync(join(dest, "dir")) || existsSync(join(dest, "hard"))).toBe(false);

    const linked = tmp();
    symlinkSync(outside, join(linked, "out"));
    expect(collectOut(linked, join(tmp(), "artifacts", "t3"))).toBe(0);
  });
});

describe("attachments note", () => {
  it("is empty without attachments and lists paths with sizes otherwise", () => {
    expect(attachmentsNote([])).toBe("");
    const note = attachmentsNote([{ name: "a.png", path: "in/a.png", size: 245760, type: "image/png" }, { name: "s.pdf", path: "in/s.pdf", size: 1200, type: "application/pdf" }]);
    expect(note).toContain("in/a.png (240 KB, image/png)");
    expect(note).toContain("in/s.pdf (1.2 KB, application/pdf)");
    expect(note).toContain("./out/");
  });
});
