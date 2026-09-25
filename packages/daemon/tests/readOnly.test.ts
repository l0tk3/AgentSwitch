/** Commands a read-only step runs without asking (2026-09-25): a repository summary could not run `git log` because the
 *  floor refused every approval and Claude asks for every command. Only plain readers; anywhere but a protected folder. */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReadOnlyCommand, shellCommandOf } from "../src/executors/readOnly.js";
import type { ProtectedPaths } from "../src/executors/protected.js";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-ro-")));
const env = { HOME: "/Users/u" };
const prot: ProtectedPaths = { roots: ["/Users/u/.agentswitch", "/Users/u/.secret-gate"], exempt: [], readDenied: ["/Users/u/.secret-gate"] };
const ro = (command: string) => isReadOnlyCommand(command, cwd, prot, env);

describe("read-only commands", () => {
  it("reading the repository runs: git history, status, diffs, listings, searches, pipes into readers", () => {
    for (const c of [
      "git log --oneline -n 30 --date=short --pretty=format:'%h %ad %an %s' 2>&1",
      "git status --short --branch",
      "git --no-pager diff HEAD~3 --stat",
      "git show HEAD:README.md | head -40",
      "git branch -a", "git tag --list", "git remote -v", "git config --get user.name", "git stash list",
      `git -C ${cwd} log -n 5`,
      "ls -la && wc -l src/*.ts",
      "grep -rn 'TODO' src | sort | uniq -c | head",
      "find . -name '*.md' -maxdepth 2",
      "cat package.json 2>/dev/null; echo done",
      "cd packages/daemon && git log -n 3",
      "ps aux | grep node",
      // Other folders of the Mac too (user decision the same day): like Claude Code on it.
      "git -C /Users/u/Desktop/other log -n 5", "cat /etc/hosts", "cd /tmp && ls", "ls ~/Documents", "cat ../outside.txt",
    ]) expect(ro(c), c).toBe(true);
  });

  it("anything that writes, runs something else or names a protected folder still asks", () => {
    for (const c of [
      "git log > log.txt", "git log >> log.txt", "echo x > README.md", "cat a | tee b",
      "git commit -am x", "git branch new-branch", "git tag v1", "git remote add o url", "git config user.name x",
      "git stash", "git -c alias.log='!rm -rf .' log", "git log --output=out.txt",
      "find . -name '*.tmp' -delete", "find . -exec rm {} \\;",
      "echo $(rm -rf x)", "echo `id`", "cat <(ls)", "sleep 5 &", "rm -rf build", "sed -i s/a/b/ f", "npm test",
      "PATH=/tmp/evil:$PATH git log", "sort -o out.txt in.txt",
      "cat ~/.secret-gate/keys/default.key", "ls /Users/u/.agentswitch", "grep -r x \"$HOME/.secret-gate\"",
      "echo 'unterminated",
    ]) expect(ro(c), c).toBe(false);
  });

  it("reads the command out of a Bash approval only", () => {
    expect(shellCommandOf("Bash: git log -n 3")).toBe("git log -n 3");
    expect(shellCommandOf("Edit outside cwd: /x")).toBeNull();
    expect(shellCommandOf("OpenCode access outside cwd: /x/*")).toBeNull();
  });
});
