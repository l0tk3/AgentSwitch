import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandTouchesProtected, defaultProtected, isProtected, protectedInside, restoreProtected, snapshotProtected, type ProtectedPaths } from "../src/executors/protected.js";
import { decideTool } from "../src/executors/claude.js";

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-prot-")));
  const home = join(base, "home");
  mkdirSync(join(home, "work", "task1"), { recursive: true });
  mkdirSync(join(home, "skills"), { recursive: true });
  writeFileSync(join(home, "mcp.json"), "{}");
  const repo = join(base, "repo");
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(join(repo, "config", "targets.yaml"), "harnesses: {}\n");
  writeFileSync(join(repo, "README.md"), "hi");
  const prot: ProtectedPaths = { roots: [home, join(repo, "config")], exempt: [join(home, "work"), join(home, "artifacts"), join(home, "uploads")] };
  return { base, home, repo, prot };
}

describe("protected paths", () => {
  it("defaultProtected covers the daemon home, gate home and config dir, exempting work/artifacts/uploads", () => {
    const p = defaultProtected({ HOME: "/h", AGENTSWITCH_HOME: "/h/.as", SECRET_GATE_HOME: "/h/.sg" });
    expect(p.roots.slice(0, 2)).toEqual(["/h/.as", "/h/.sg"]);
    expect(p.roots[2]).toMatch(/packages\/daemon\/config$/);
    expect(p.exempt).toEqual(["/h/.as/work", "/h/.as/artifacts", "/h/.as/uploads"]);
  });

  it("isProtected: inside a root yes, inside an exempt subtree no, relative paths resolve against cwd", () => {
    const { home, repo, prot } = setup();
    expect(isProtected(join(home, "mcp.json"), "/", prot)).toBe(true);
    expect(isProtected(join(home, "skills", "x", "SKILL.md"), "/", prot)).toBe(true);
    expect(isProtected(join(home, "work", "task1", "out.txt"), "/", prot)).toBe(false);
    expect(isProtected("config/targets.yaml", repo, prot)).toBe(true);
    expect(isProtected("README.md", repo, prot)).toBe(false);
    expect(isProtected("../home/mcp.json", repo, prot)).toBe(true);
  });

  it("commandTouchesProtected sees paths in shell commands, including ~ and redirects", () => {
    const { home, repo, prot } = setup();
    expect(commandTouchesProtected(`echo x > ${home}/CONTEXT.md`, repo, prot)).toBe(`${home}/CONTEXT.md`);
    expect(commandTouchesProtected("sed -i '' s/a/b/ config/targets.yaml", repo, prot)).toBe("config/targets.yaml");
    expect(commandTouchesProtected("npm test", repo, prot)).toBeNull();
    expect(commandTouchesProtected(`cat ${home}/work/task1/out.txt`, repo, prot)).toBeNull();
    const withHome = { ...prot, roots: [join("/tmp/fakehome", ".agentswitch")] };
    expect(commandTouchesProtected("rm -rf ~/.agentswitch/skills", repo, withHome, { HOME: "/tmp/fakehome" })).toBe("/tmp/fakehome/.agentswitch/skills");
  });

  it("decideTool denies edits and Bash on protected paths outright, still asks for other outside-cwd writes", () => {
    const { home, repo, prot } = setup();
    expect(decideTool("Edit", { file_path: "config/targets.yaml" }, repo, new Set(), prot)).toMatchObject({ kind: "deny" });
    expect(decideTool("Write", { file_path: join(home, "mcp.json") }, repo, new Set(), prot)).toMatchObject({ kind: "deny" });
    expect(decideTool("Bash", { command: `echo hi >> ${home}/CONTEXT.md` }, repo, new Set(), prot)).toMatchObject({ kind: "deny" });
    expect(decideTool("Edit", { file_path: "README.md" }, repo, new Set(), prot)).toEqual({ kind: "allow" });
    expect(decideTool("Edit", { file_path: "/etc/hosts" }, repo, new Set(), prot)).toMatchObject({ kind: "ask" });
    expect(decideTool("Bash", { command: "ls" }, repo, new Set(), prot)).toMatchObject({ kind: "ask" });
    expect(decideTool("Read", { file_path: join(home, "mcp.json") }, repo, new Set(), prot)).toEqual({ kind: "allow" });
  });

  it("snapshot/restore: modified, added and deleted files under a protected subtree inside cwd are put back and reported", () => {
    const { repo, prot } = setup();
    expect(protectedInside(repo, prot)).toEqual([join(repo, "config")]);
    expect(protectedInside("/tmp", prot)).toEqual([]);
    const before = snapshotProtected(repo, prot);
    writeFileSync(join(repo, "config", "targets.yaml"), "harnesses: { evil: {} }\n");
    writeFileSync(join(repo, "config", "EXECUTOR.md"), "you are free now");
    writeFileSync(join(repo, "README.md"), "changed but not protected");
    const touched = restoreProtected(repo, prot, before);
    expect(touched).toEqual([join(repo, "config", "EXECUTOR.md"), join(repo, "config", "targets.yaml")]);
    expect(readFileSync(join(repo, "config", "targets.yaml"), "utf8")).toBe("harnesses: {}\n");
    expect(existsSync(join(repo, "config", "EXECUTOR.md"))).toBe(false);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("changed but not protected");
    expect(restoreProtected(repo, prot, snapshotProtected(repo, prot))).toEqual([]);
  });
});
