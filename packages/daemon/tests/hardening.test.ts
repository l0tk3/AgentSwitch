import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCwd, defaultCwdRules } from "../src/api/cwdPolicy.js";

describe("hardening (audit 2026-09-22)", () => {
  it("cwd rules: relative, root, home, credential dirs, the daemon home and missing dirs are refused", () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-h-"));
    const rules = defaultCwdRules({ HOME: home, SECRET_GATE_HOME: join(home, ".secret-gate") }, join(home, ".agentswitch"));
    expect(checkCwd("relative/dir", rules)).toMatch(/absolute/);
    expect(checkCwd("/", rules)).toMatch(/too broad/);
    expect(checkCwd(home, rules)).toMatch(/too broad/);
    expect(checkCwd(join(home, ".ssh"), rules)).toMatch(/credentials/);
    expect(checkCwd(join(home, ".agentswitch", "work", "x"), rules)).toMatch(/daemon/);
    expect(checkCwd(join(home, "nope"), rules)).toMatch(/not an existing directory/);
    expect(checkCwd(tmpdir(), rules)).toMatch(/contains .*\.ssh/);   // it holds this home, so its credential dirs too
    expect(checkCwd(mkdtempSync(join(tmpdir(), "agentswitch-h-project-")), rules)).toBeNull();
  });
});
