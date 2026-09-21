import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeHomeEnv } from "../src/executors/claude.js";

describe("harness private homes", () => {
  it("claudeHomeEnv: no thread → nothing; a thread → CLAUDE_CONFIG_DIR under <home>/claude (0700) and the keychain override", () => {
    expect(claudeHomeEnv(null)).toEqual({});
    const home = mkdtempSync(join(tmpdir(), "agentswitch-ch-"));
    const env = claudeHomeEnv(home);
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: join(home, "claude"), CLAUDE_SECURESTORAGE_CONFIG_DIR: "" });
    expect(existsSync(join(home, "claude"))).toBe(true);
    expect(statSync(join(home, "claude")).mode & 0o777).toBe(0o700);
  });
});
