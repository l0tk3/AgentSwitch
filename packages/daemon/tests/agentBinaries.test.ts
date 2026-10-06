/** Which program each agent runs (docs/agents-v0.md §3): the Mac app's 设置 › Agents hands the daemon the chosen install
 *  in CLAUDE_BIN, CODEX_BIN, OPENCODE_BIN and PI_BIN; unset, the daemon looks where it always did. */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexBinary, terminalBinaries } from "../src/daemon.js";

function program(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

describe("the agents' programs", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-bins-")));
  const home = join(root, "home");
  const catalog = program(join(root, "ChatGPT.app"), "codex");
  const targets = { harnesses: { codex: { binary: catalog } } } as unknown as Parameters<typeof codexBinary>[0];
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ HOME: home, PATH: join(root, "bin"), ...extra });

  it("Codex: the chosen install when it is there, else the catalog's path, else the PATH", () => {
    const beta = program(join(root, "store/codex/beta/0.162.0-alpha.16"), "launch");
    expect(codexBinary(targets, env())).toBe(catalog);
    expect(codexBinary(targets, env({ CODEX_BIN: beta }))).toBe(beta);
    // A choice that is gone, or not a path, is not followed: the daemon looks where it always did.
    expect(codexBinary(targets, env({ CODEX_BIN: join(root, "store/codex/beta/gone/launch") }))).toBe(catalog);
    expect(codexBinary(targets, env({ CODEX_BIN: "codex" }))).toBe(catalog);
    const onPath = program(join(root, "bin"), "codex");
    expect(codexBinary({ harnesses: {} } as unknown as Parameters<typeof codexBinary>[0], env())).toBe(onPath);
  });

  it("a terminal starts what was chosen for each agent", () => {
    const pi = program(join(root, "chosen"), "pi");
    const claude = program(join(root, "chosen"), "claude");
    const codex = program(join(root, "chosen"), "codex");
    const opencode = program(join(root, "chosen"), "opencode");
    expect(terminalBinaries(targets, opencode, env({ PI_BIN: pi, CLAUDE_BIN: claude, CODEX_BIN: codex }))).toEqual({ "claude-code": claude, codex, opencode, pi });
    // Without choices: what is found. pi where its installer links it.
    const linked = program(join(home, ".local", "bin"), "pi");
    expect(terminalBinaries(targets, "", env()).pi).toBe(linked);
    expect(terminalBinaries(targets, "", env({ PI_BIN: join(root, "nowhere", "pi") })).pi).toBe(linked);
  });
});
