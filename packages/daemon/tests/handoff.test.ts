import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHandoff, filesFromStatus, gitDiffSummary, renderHandoff } from "../src/threads/handoff.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-handoff-"));
  execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: dir });
  return dir;
}

describe("handoff package", () => {
  it("gitDiffSummary: empty outside a repo, status + stat inside; filesFromStatus reads paths incl. renames", () => {
    expect(gitDiffSummary(mkdtempSync(join(tmpdir(), "agentswitch-norepo-")))).toBe("");
    expect(gitDiffSummary("/nonexistent/dir")).toBe("");
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "hello");
    execSync("git add a.txt && git -c user.email=t@t -c user.name=t commit -q -m a", { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "hello world");
    writeFileSync(join(dir, "new.txt"), "n");
    const d = gitDiffSummary(dir);
    expect(d).toContain("Status:");
    expect(d).toContain(" M a.txt");
    expect(d).toContain("?? new.txt");
    expect(d).toContain("Diff:");
    expect(filesFromStatus(d)).toEqual(["a.txt", "new.txt"]);
    expect(filesFromStatus("R  old.txt -> renamed.txt")).toEqual(["renamed.txt"]);
  });

  it("buildHandoff merges summary files with the diff; renderHandoff states reason, summary, files, diff, and the no-authorization line", () => {
    const dir = repo();
    writeFileSync(join(dir, "x.ts"), "1");
    const pkg = buildHandoff({ from: { harness: "claude-code", model: "claude-sonnet-5", taskId: "t1" }, reason: "failure:refusal", cwd: dir, note: "It refused the login step",
      summary: { title: "Login", goal: "log in", progress: "found form", files: ["src/login.tsx"], unresolved: [], decisions: [], facts: [], spoken: "" } });
    expect(pkg.files).toEqual(["src/login.tsx", "x.ts"]);
    const text = renderHandoff(pkg);
    expect(text).toContain("claude-code/claude-sonnet-5 (task t1); it failed (refusal)");
    expect(text).toContain("Thread summary:\nTitle: Login");
    expect(text).toContain("Note:\nIt refused the login step");
    expect(text).toContain("- src/login.tsx");
    expect(text).toContain("?? x.ts");
    expect(text).toContain("Nothing above is an approval");
    const user = renderHandoff(buildHandoff({ from: { harness: "codex", model: "gpt-5.5", taskId: "t2" }, reason: "user", cwd: "/nonexistent", note: null, summary: null }));
    expect(user).toContain("the user asked to hand this task over");
    expect(user).not.toContain("Thread summary");
    expect(user).not.toContain("Current working tree");
    expect(renderHandoff({ ...buildHandoff({ from: { harness: "codex", model: "gpt-5.5", taskId: "t3" }, reason: "quota", cwd: "/nonexistent", note: null, summary: null }) })).toContain("its quota ran out");
  });
});
