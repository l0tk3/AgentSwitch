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

  it("decideTool denies edits and Bash on protected paths outright; other folders of the Mac are open (2026-09-25)", () => {
    const { home, repo, prot } = setup();
    expect(decideTool("Edit", { file_path: "config/targets.yaml" }, repo, new Set(), prot)).toMatchObject({ kind: "deny" });
    expect(decideTool("Write", { file_path: join(home, "mcp.json") }, repo, new Set(), prot)).toMatchObject({ kind: "deny" });
    expect(decideTool("Bash", { command: `echo hi >> ${home}/CONTEXT.md` }, repo, new Set(), prot)).toMatchObject({ kind: "deny" });
    expect(decideTool("Edit", { file_path: "README.md" }, repo, new Set(), prot)).toEqual({ kind: "allow" });
    expect(decideTool("Edit", { file_path: "/etc/hosts" }, repo, new Set(), prot)).toEqual({ kind: "allow" });
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

describe("read-denied paths (2026-09-24)", () => {
  // The gate's private key, the browser session profiles and the remote TLS key are credentials: an executor may not even
  // read them. Before this, Claude's Read/Glob/Grep/LS were allowed everywhere.
  it("defaultProtected read-denies the gate home, the browser profiles and the remote listener's key", () => {
    const p = defaultProtected({ HOME: "/h", AGENTSWITCH_HOME: "/h/.as", SECRET_GATE_HOME: "/h/.sg" });
    expect(p.readDenied).toEqual(["/h/.sg", "/h/.as/browser-profiles", "/h/.as/remote", "/h/.as/local-token"]);
  });

  it("Claude's read tools are refused there, whatever form the path takes; elsewhere they stay allowed", () => {
    const { base, home, repo } = setup();
    const gate = join(base, "gate");
    mkdirSync(join(gate, "keys"), { recursive: true });
    const prot: ProtectedPaths = { roots: [home, gate], exempt: [join(home, "work")], readDenied: [gate, join(home, "browser-profiles")] };
    for (const [tool, input] of [
      ["Read", { file_path: join(gate, "keys", "default.key") }],
      ["Read", { file_path: "../gate/keys/default.key" }],
      ["Grep", { pattern: "BEGIN", path: gate }],
      ["Glob", { pattern: `${gate}/**/*` }],
      ["Glob", { pattern: "*", path: join(home, "browser-profiles", "slot-1") }],
      ["LS", { path: join(home, "browser-profiles") }],
      ["NotebookRead", { notebook_path: join(gate, "x.ipynb") }],
    ] as const) {
      expect(decideTool(tool, input as Record<string, unknown>, repo, new Set(), prot), `${tool} ${JSON.stringify(input)}`).toMatchObject({ kind: "deny" });
    }
    expect(decideTool("Read", { file_path: join(repo, "README.md") }, repo, new Set(), prot)).toEqual({ kind: "allow" });
    expect(decideTool("Grep", { pattern: "x" }, repo, new Set(), prot)).toEqual({ kind: "allow" });
    expect(decideTool("Read", { file_path: join(home, "mcp.json") }, repo, new Set(), prot)).toEqual({ kind: "allow" });   // write-protected, not read-denied
  });
});

describe("OpenCode read denies", () => {
  it("every read-denied root is a read deny in the executor config", async () => {
    const { opencodeExecConfig } = await import("../src/executors/opencode.js");
    const prot: ProtectedPaths = { roots: ["/h/.as"], exempt: [], readDenied: ["/h/.sg", "/h/.as/browser-profiles"] };
    const config = opencodeExecConfig(null, "/p", false, { protected: prot }) as { permission: { read: Record<string, string> } };
    expect(config.permission.read).toMatchObject({ "/h/.sg": "deny", "/h/.sg/*": "deny", "/h/.as/browser-profiles": "deny", "/h/.as/browser-profiles/*": "deny", "*": "allow" });
  });
});

describe("protected roots with a space in the path (the Mac app's home, 2026-09-24)", () => {
  // Executors wrote `Application\ Support/AgentSwitch` and "…/Application Support/AgentSwitch" in shell commands; the
  // whitespace split missed both, so the protected home was readable and writable from the shell.
  const home = "/Users/u/Library/Application Support/AgentSwitch";
  const prot: ProtectedPaths = { roots: [home], exempt: [`${home}/work`], readDenied: [] };
  const env = { HOME: "/Users/u" };

  it("sees escaped, quoted and ~ forms of the path in a command", () => {
    for (const command of [
      "cat /Users/u/Library/Application\\ Support/AgentSwitch/CONTEXT.md",
      "cd /Users/u/Library/Application\\ Support/AgentSwitch/tasks/; for f in *.jsonl; do head -1 \"$f\"; done",
      "ls -la \"/Users/u/Library/Application Support/AgentSwitch/\"",
      "ls '/Users/u/Library/Application Support/AgentSwitch'",
      "cat ~/Library/Application\\ Support/AgentSwitch/CONTEXT.md",
      "tar czf x.tgz \"$HOME/Library/Application Support/AgentSwitch\"",
    ]) expect(commandTouchesProtected(command, "/tmp", prot, env), command).not.toBeNull();
    expect(commandTouchesProtected("ls /Users/u/Library/Application\\ Support/AgentSwitch/work/t1", "/tmp", prot, env)).toBeNull();
    expect(commandTouchesProtected("echo 'Application Support' && ls ~/Desktop", "/tmp", prot, env)).toBeNull();
  });

  it("OpenCode's shell denies cover the escaped and ~ forms too", async () => {
    const { protectedDeny } = await import("../src/executors/opencodeShared.js");
    const deny = protectedDeny(prot, env);
    expect(deny.bash).toMatchObject({
      "*/Users/u/Library/Application Support/AgentSwitch*": "deny",
      "*/Users/u/Library/Application\\ Support/AgentSwitch*": "deny",
      "*~/Library/Application Support/AgentSwitch*": "deny",
      "*~/Library/Application\\ Support/AgentSwitch*": "deny",
      "*$HOME/Library/Application Support/AgentSwitch*": "deny",
    });
  });
});

/** OpenCode 2.0.8's pattern match (from its binary): `\` read as `/` on both sides, `*` spans anything, case-sensitive. */
function opencodeMatch(value: string, pattern: string): boolean {
  let re = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (re.endsWith(" .*")) re = `${re.slice(0, -3)}( .*)?`;
  return new RegExp(`^${re}$`, "s").test(value.replaceAll("\\", "/"));
}
/** OpenCode takes the last rule that matches; undefined = none of ours, its default applies. */
const lastMatch = (rules: Record<string, string>, value: string): string | undefined =>
  Object.entries(rules).filter(([p]) => opencodeMatch(value, p)).pop()?.[1];

describe("shell commands that name a root inside a quoted string, an option or a continued line (review, 2026-09-24)", () => {
  // The quote-aware word split made a quoted string one word, so a root inside `sh -c "…"` or a `python3 -c` string
  // was no longer seen; the old regex had caught these.
  const home = "/Users/u/Library/Application Support/AgentSwitch";
  const gate = "/Users/u/.secret-gate";
  const prot: ProtectedPaths = { roots: [home, gate], exempt: [`${home}/work`], readDenied: [gate, `${home}/remote`] };
  const env = { HOME: "/Users/u" };

  it("finds the root anywhere in the command", () => {
    for (const command of [
      "sh -c \"rm -rf ~/.secret-gate/keys\"",
      "python3 -c \"print(open('/Users/u/.secret-gate/keys/default.key').read())\"",
      "node -e \"require('fs').readFileSync('/Users/u/Library/Application Support/AgentSwitch/CONTEXT.md')\"",
      "echo \"$(cat ~/.secret-gate/keys/x)\"",
      "curl --cacert=/Users/u/.secret-gate/ca.pem https://x",
      "KEY=~/.secret-gate/keys/x; cat $KEY",
      "cat \"${HOME}/.secret-gate/keys/default.key\"",
      "cat \"$HOME\"/.secret-gate/keys/default.key",
      "cat ~/Library/\"Application Support\"/AgentSwitch/CONTEXT.md",
      "tar czf b.tgz \\\n~/.secret-gate",
      "cat ~/.Secret-Gate/keys/default.key",
    ]) expect(commandTouchesProtected(command, "/tmp", prot, env), command).not.toBeNull();
  });

  it("an exempt subtree or a look-alike name stays allowed", () => {
    for (const command of [
      "sh -c \"ls ~/Library/Application\\ Support/AgentSwitch/work/t1\"",
      "ls /Users/u/.secret-gate-backup",
      "cat packages/secret-gate/README.md",
    ]) expect(commandTouchesProtected(command, "/tmp", prot, env), command).toBeNull();
  });

  it("OpenCode's shell denies catch ${HOME}, a quoted $HOME and a quoted segment", async () => {
    const { protectedDeny } = await import("../src/executors/opencodeShared.js");
    const { bash } = protectedDeny(prot, env);
    for (const command of [
      "cat \"${HOME}/.secret-gate/keys/default.key\"",
      "cat \"$HOME\"/.secret-gate/keys/default.key",
      "cat ~/Library/\"Application Support\"/AgentSwitch/CONTEXT.md",
      "cat \"$HOME/Library/Application Support\"/AgentSwitch/CONTEXT.md",
      "cat ~/Library/Application\\ Support/AgentSwitch/CONTEXT.md",
      "sh -c \"cat ~/.secret-gate/keys/x\"",
    ]) expect(lastMatch(bash, command), command).toBe("deny");
    for (const command of ["ls ~/Desktop", "cat packages/secret-gate/README.md", "cat config/targets.yaml"]) expect(lastMatch(bash, command), command).toBeUndefined();
  });

  it("OpenCode may not work in a root (cd, workdir): external_directory denies it; every other folder, exempt subtrees and skills are open", async () => {
    const { opencodeExecConfig } = await import("../src/executors/opencodeShared.js");
    const skills = `${home}/opencode/skills`;
    const config = opencodeExecConfig(null, "/p", false, { protected: prot, skillsDir: skills }) as { permission: { external_directory: Record<string, string> } };
    const rules = config.permission.external_directory;
    expect(rules["*"]).toBe("allow");
    expect(lastMatch(rules, home)).toBe("deny");
    expect(lastMatch(rules, `${home}/*`)).toBe("deny");
    expect(lastMatch(rules, `${gate}/keys/*`)).toBe("deny");
    expect(lastMatch(rules, `${home}/work/t1/*`)).toBe("allow");
    expect(lastMatch(rules, `${skills}/demo/*`)).toBe("allow");
    expect(lastMatch(rules, "/Users/u/Desktop/*")).toBe("allow");
  });
});

describe("a Claude search above a credential store (review, 2026-09-24)", () => {
  it("Grep rooted at an ancestor of a read-denied root is refused; Glob there only lists names and stays allowed", () => {
    const { base, home, repo } = setup();
    const gate = join(base, "gate");
    mkdirSync(join(gate, "keys"), { recursive: true });
    const prot: ProtectedPaths = { roots: [home, gate], exempt: [join(home, "work")], readDenied: [gate] };
    expect(decideTool("Grep", { pattern: "PRIVATE KEY", path: base, output_mode: "content" }, repo, new Set(), prot)).toMatchObject({ kind: "deny", reason: expect.stringContaining("narrower") });
    expect(decideTool("Glob", { pattern: "*", path: base }, repo, new Set(), prot)).toEqual({ kind: "allow" });
    expect(decideTool("Grep", { pattern: "x", path: repo }, repo, new Set(), prot)).toEqual({ kind: "allow" });
  });
});
