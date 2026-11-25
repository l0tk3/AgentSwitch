import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sweepDir } from "../src/files/artifacts.js";
import { contentType, safeName } from "../src/files/names.js";
import { moveFile, Uploads } from "../src/files/uploads.js";

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
  it("names content types", () => {
    expect(contentType("a.PNG")).toBe("image/png");
    expect(contentType("a.bin")).toBe("application/octet-stream");
  });
});

describe("uploads", () => {
  it("stages, moves into a folder under names of one word, de-duplicated, with absolute paths; rejects unknown ids", () => {
    const u = new Uploads(join(tmp(), "uploads"));
    const a = u.stage("shot.png", Buffer.from("png1"), "image/png");
    const b = u.stage("shot.png", Buffer.from("png2"), "image/png");
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ name: "shot.png", size: 4, type: "image/png" });
    const c = u.stage("my notes.md", Buffer.from("n"), "text/markdown");
    const dir = join(tmp(), "attach");
    const attached = u.moveToDir([a.id, b.id, c.id], dir);
    expect(attached.map((x) => x.path)).toEqual([join(dir, "shot.png"), join(dir, "shot-2.png"), join(dir, "my-notes.md")]);
    expect(readFileSync(join(dir, "shot-2.png"), "utf8")).toBe("png2");
    expect(existsSync(join(u.dir, a.id))).toBe(false);
    expect(() => u.moveToDir(["nope"], dir)).toThrow(/unknown upload/);
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

describe("moving a file", () => {
  it("copies it across file systems where a rename cannot (EXDEV), never over a file already there", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-move-"));
    const exdev = () => { throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); };
    writeFileSync(join(dir, "a.png"), "picture");
    moveFile(join(dir, "a.png"), join(dir, "b.png"), exdev);
    expect(readFileSync(join(dir, "b.png"), "utf8")).toBe("picture");
    expect(existsSync(join(dir, "a.png"))).toBe(false);
    writeFileSync(join(dir, "c.png"), "other");
    expect(() => moveFile(join(dir, "c.png"), join(dir, "b.png"), exdev)).toThrow(/EEXIST/);
    expect(readFileSync(join(dir, "b.png"), "utf8")).toBe("picture");
    // Any other failure is said as it is.
    expect(() => moveFile(join(dir, "c.png"), join(dir, "d.png"), () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); })).toThrow("EACCES");
    expect(existsSync(join(dir, "c.png"))).toBe(true);
  });
});
