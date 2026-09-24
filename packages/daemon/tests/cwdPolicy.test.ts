/** Where a task may run: the cwd rules compare what the OS will open, so an ancestor of a denied root, a symlink, `..`
 *  after a symlink and the other spellings of the same directory are all refused (security review 2026-09-24). */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCwd, defaultCwdRules, deniedRootOf, physicalPath, type CwdRules } from "../src/api/cwdPolicy.js";

/** A fake home under the temp dir with a few credential dirs, a daemon home and a project. */
function world(): { base: string; home: string; project: string; rules: CwdRules } {
  const base = mkdtempSync(join(tmpdir(), "agentswitch-cwd-"));
  const home = join(base, "Users", "me");
  for (const d of [".ssh", ".secret-gate", ".agentswitch", "Library", "proj"]) mkdirSync(join(home, d), { recursive: true });
  const rules = defaultCwdRules({ HOME: home, SECRET_GATE_HOME: join(home, ".secret-gate") }, join(home, ".agentswitch"));
  return { base, home, project: join(home, "proj"), rules };
}

describe("cwd rules", () => {
  it("accept a project directory, including through a symlink that stays harmless", () => {
    const w = world();
    expect(checkCwd(w.project, w.rules)).toBeNull();
    symlinkSync(w.project, join(w.base, "proj-link"));
    expect(checkCwd(join(w.base, "proj-link"), w.rules)).toBeNull();
  });

  it("refuse an ancestor of a denied root: the home's parent, the temp dir above it, the filesystem root", () => {
    const w = world();
    expect(checkCwd(dirname(w.home), w.rules)).toMatch(/contains .*\.ssh/);
    expect(checkCwd(w.base, w.rules)).toMatch(/contains/);
    expect(checkCwd(tmpdir(), w.rules)).toMatch(/contains/);
    expect(checkCwd(w.home, w.rules)).toMatch(/too broad/);
    expect(checkCwd("/", w.rules)).toMatch(/too broad/);
  });

  it("refuse a denied root and anything under it, however it is spelled", () => {
    const w = world();
    expect(checkCwd(join(w.home, ".secret-gate"), w.rules)).toMatch(/under .*\.secret-gate/);
    mkdirSync(join(w.home, ".ssh", "keys"));
    expect(checkCwd(join(w.home, ".ssh", "keys"), w.rules)).toMatch(/under .*\.ssh/);
    expect(checkCwd(join(w.project, "..", ".ssh"), w.rules)).toMatch(/under .*\.ssh/);
    expect(checkCwd(`${w.home}//.ssh/`, w.rules)).toMatch(/under .*\.ssh/);
  });

  it("follow symlinks the way the OS does: into a denied root, onto an ancestor, `..` after a symlink", () => {
    const w = world();
    const links = mkdtempSync(join(tmpdir(), "agentswitch-cwd-links-"));
    symlinkSync(join(w.home, ".ssh"), join(links, "ssh"));
    symlinkSync(dirname(w.home), join(links, "users"));
    symlinkSync("/", join(links, "root"));          // like /Volumes/Macintosh HD -> /
    symlinkSync(join(w.home, ".ssh", "."), join(links, "deep"));
    expect(checkCwd(join(links, "ssh"), w.rules)).toMatch(/under .*\.ssh/);
    expect(checkCwd(join(links, "users"), w.rules)).toMatch(/contains/);
    expect(checkCwd(join(links, "root"), w.rules)).toMatch(/too broad/);
    // Lexically links/deep/.. is links (harmless); the OS resolves deep first and lands on the home.
    expect(checkCwd(join(links, "deep") + "/..", w.rules)).toMatch(/too broad/);
    // A denied root reached through a symlinked parent of the home is still the same directory.
    expect(checkCwd(join(links, "users", "me", ".agentswitch"), w.rules)).toMatch(/under .*\.agentswitch/);
  });

  it("refuse the root-level resolution prefixes and a missing directory", () => {
    const w = world();
    expect(checkCwd("/.nofollow", w.rules)).toMatch(/special/);
    expect(checkCwd("/.vol/1/2", w.rules)).toMatch(/special/);
    expect(checkCwd(join(w.project, "missing"), w.rules)).toMatch(/not an existing directory/);
    expect(checkCwd("relative", w.rules)).toMatch(/absolute/);
  });

  it.runIf(existsSync("/Volumes/Macintosh HD"))("macOS: the boot volume link is the filesystem root", () => {
    expect(checkCwd("/Volumes/Macintosh HD", defaultCwdRules())).toMatch(/too broad/);
    expect(checkCwd("/Volumes/Macintosh HD/Users", defaultCwdRules())).toMatch(/contains/);
  });

  it.runIf(existsSync("/System/Volumes/Data/Users"))("macOS: the data volume's firmlinks and case variants are the same directories", () => {
    const rules = defaultCwdRules();
    const home = process.env.HOME!;
    expect(checkCwd("/System/Volumes/Data", rules)).toMatch(/contains/);
    expect(checkCwd("/System/Volumes/Data/Users", rules)).toMatch(/contains/);
    expect(checkCwd(`/System/Volumes/Data${home}`, rules)).toMatch(/too broad/);
    expect(checkCwd("/USERS", rules)).toMatch(/contains/);
    if (existsSync(join(home, "Library"))) expect(checkCwd(`/System/Volumes/Data${home}/Library`, rules)).toMatch(/under/);
  });

  it("deniedRootOf names the root a file lies in, by path or through a symlink", () => {
    const w = world();
    const links = mkdtempSync(join(tmpdir(), "agentswitch-cwd-files-"));
    symlinkSync(join(w.home, ".secret-gate"), join(links, "gate"));
    expect(deniedRootOf(join(w.home, ".secret-gate", "key"), w.rules)).toBe(join(w.home, ".secret-gate"));
    expect(deniedRootOf(join(links, "gate", "key"), w.rules)).toBe(join(w.home, ".secret-gate"));
    expect(deniedRootOf(join(w.project, "out", "a.txt"), w.rules)).toBeNull();
  });

  it("physicalPath resolves the existing part and keeps the missing rest", () => {
    const base = mkdtempSync(join(tmpdir(), "agentswitch-cwd-phys-"));
    expect(physicalPath(join(base, "a", "b"))).toBe(join(realpathSync(base), "a", "b"));
    expect(physicalPath(base)).toBe(realpathSync(base));
  });
});
