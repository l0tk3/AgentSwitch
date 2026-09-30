/** The tree's git status (docs/terminal-v0.md §1 文件夹行的 git 状态, §4 GET /folders/git). */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitStatus, parseGitStatus } from "../src/terminals/gitStatus.js";

describe("git status of a folder", () => {
  it("reads the branch, the files changed and how far from its upstream", () => {
    expect(parseGitStatus([
      "# branch.oid 1a2b3c4d5e6f", "# branch.head feat/health", "# branch.upstream origin/feat/health", "# branch.ab +2 -4",
      "1 .M N... 100644 100644 100644 aaa bbb src/a.ts", "2 R. N... 100644 100644 100644 aaa bbb R100 b.ts\ta.ts", "? notes.md", "",
    ].join("\n"))).toEqual({ branch: "feat/health", changed: 3, ahead: 2, behind: 4 });
    // No upstream: nothing ahead or behind. A new repository: its branch before the first commit.
    expect(parseGitStatus("# branch.oid (initial)\n# branch.head main\n")).toEqual({ branch: "main", changed: 0, ahead: 0, behind: 0 });
    // Detached: the commit's short id.
    expect(parseGitStatus("# branch.oid 1a2b3c4d5e6f\n# branch.head (detached)\n")).toMatchObject({ branch: "1a2b3c4" });
    expect(parseGitStatus("")).toBeNull();
  });

  it("runs git itself, in a repository and not outside one", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-git-")));
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-nogit-")));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "a");
    writeFileSync(join(repo, "b.txt"), "b");
    const git = new GitStatus();
    expect(await git.summaries([repo, plain])).toEqual({ [repo]: { branch: "main", changed: 2, ahead: 0, behind: 0 } });
  });

  it("keeps a result a while, answers an old one at once and looks again behind it; a folder worked in looks again", async () => {
    let now = 0;
    const runs: string[] = [];
    let changed = 1;
    const git = new GitStatus({ freshMs: 1000, now: () => now, run: async (cwd) => { runs.push(cwd); return `# branch.head main\n${"? f\n".repeat(changed)}`; } });
    expect(await git.summaries(["/w/a"])).toEqual({ "/w/a": { branch: "main", changed: 1, ahead: 0, behind: 0 } });
    changed = 2;
    now = 500;
    expect((await git.summaries(["/w/a"]))["/w/a"]?.changed).toBe(1);
    expect(runs).toEqual(["/w/a"]);
    // Out of date: the old answer now, the new one on the next ask.
    now = 1500;
    expect((await git.summaries(["/w/a"]))["/w/a"]?.changed).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    expect((await git.summaries(["/w/a"]))["/w/a"]?.changed).toBe(2);
    expect(runs).toHaveLength(2);
    // An agent's tool call in a folder inside it: looked at again though fresh.
    changed = 3;
    git.invalidate("/w/a/src");
    await git.summaries(["/w/a"]);
    await new Promise((r) => setTimeout(r, 5));
    expect((await git.summaries(["/w/a"]))["/w/a"]?.changed).toBe(3);
  });

  it("runs a few at a time, and a slow repository shows nothing rather than holding the others", async () => {
    let running = 0, most = 0;
    const git = new GitStatus({
      parallel: 2,
      run: async (cwd) => {
        running++; most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, cwd === "/slow" ? 400 : 10));
        running--;
        return "# branch.head main\n";
      },
    });
    const out = await git.summaries(["/slow", "/a", "/b", "/c"], 100);
    expect(Object.keys(out).sort()).toEqual(["/a", "/b", "/c"]);
    expect(most).toBe(2);
  });
});
