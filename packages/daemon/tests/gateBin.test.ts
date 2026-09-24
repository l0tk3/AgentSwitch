import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realExecutors } from "../src/daemon.js";
import { defaultGate, gateBin, gateNotFound, VENV_GATE_BIN } from "../src/executors/gate.js";
import { which } from "../src/util/which.js";
import { realTargets } from "./helpers.js";

let dir: string;
/** An executable (or not) file at dir/rel; nothing ever runs it. */
const file = (rel: string, mode = 0o755): string => {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, mode);
  return path;
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentswitch-gatebin-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("secret-gate binary lookup: SECRET_GATE_BIN, then the repo venv, then PATH", () => {
  it("SECRET_GATE_BIN wins over the venv and PATH", () => {
    const explicit = file("explicit/secret-gate"), venv = file("venv/secret-gate");
    file("path/secret-gate");
    expect(gateBin({ SECRET_GATE_BIN: explicit, PATH: join(dir, "path") }, venv)).toBe(explicit);
  });

  it("a SECRET_GATE_BIN that does not exist finds nothing instead of falling back to another gate", () => {
    const venv = file("venv/secret-gate");
    expect(gateBin({ SECRET_GATE_BIN: join(dir, "missing"), PATH: join(dir, "path") }, venv)).toBeNull();
    expect(defaultGate({ SECRET_GATE_BIN: join(dir, "missing") }, venv)).toBeNull();
  });

  it("without SECRET_GATE_BIN the repo venv wins over PATH", () => {
    const venv = file("venv/secret-gate");
    file("path/secret-gate");
    expect(gateBin({ SECRET_GATE_BIN: "", PATH: join(dir, "path") }, venv)).toBe(venv);
  });

  it("without SECRET_GATE_BIN or the venv, secret-gate on PATH resolves to an absolute path", () => {
    const onPath = file("path/secret-gate");
    const gate = defaultGate({ PATH: ["relative", join(dir, "empty"), join(dir, "path")].join(delimiter), HOME: "/home/u" }, join(dir, "no-venv"));
    expect(gate).toMatchObject({ bin: onPath, home: "/home/u/.secret-gate" });
  });

  it("nothing anywhere: no gate", () => {
    expect(gateBin({ PATH: join(dir, "path") }, join(dir, "no-venv"))).toBeNull();
    expect(defaultGate({}, join(dir, "no-venv"))).toBeNull();
  });
});

describe("secret-gate not found", () => {
  it("names all three places, in lookup order", () => {
    const text = gateNotFound({}, "/repo/packages/secret-gate/.venv/bin/secret-gate");
    expect(text).toBe("secret-gate not found: $SECRET_GATE_BIN is not set, the repo venv /repo/packages/secret-gate/.venv/bin/secret-gate does not exist, and there is no `secret-gate` on $PATH");
    const explicit = gateNotFound({ SECRET_GATE_BIN: "/opt/missing" }, "/v");
    expect(explicit).toContain("$SECRET_GATE_BIN=/opt/missing does not exist");
    expect(explicit).toContain("repo venv /v");
    expect(explicit).toContain("`secret-gate` on $PATH");
    expect(gateNotFound({})).toContain(VENV_GATE_BIN);
  });

  it("real executors refuse to start with that message", () => {
    const saved = process.env.SECRET_GATE_BIN;
    process.env.SECRET_GATE_BIN = join(dir, "missing");
    try {
      expect(() => realExecutors(realTargets(), false)).toThrow(/SECRET_GATE_BIN=.*missing does not exist.*repo venv .*secret-gate` on \$PATH\): refusing to start real executors/);
    } finally {
      if (saved === undefined) delete process.env.SECRET_GATE_BIN; else process.env.SECRET_GATE_BIN = saved;
    }
  });
});

describe("which", () => {
  it("skips non-executable files, directories, empty and relative entries", () => {
    file("a/tool", 0o644);
    mkdirSync(join(dir, "b", "tool"), { recursive: true });
    file("rel/tool");  // reachable only through the relative entry, which must not count
    const good = file("c/tool");
    expect(which("tool", ["", relative(process.cwd(), join(dir, "rel")), join(dir, "a"), join(dir, "b"), join(dir, "c")].join(delimiter))).toBe(good);
    expect(which("tool", [join(dir, "a"), join(dir, "b")].join(delimiter))).toBeNull();
    expect(which("tool", undefined)).toBeNull();
  });
});

describe("resolveCommand (a catalog written on another Mac)", () => {
  it("keeps an existing absolute path, falls back to PATH for a missing one, looks bare names up", async () => {
    const { resolveCommand } = await import("../src/util/which.js");
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "which-"));
    const onPath = join(dir, "codex");
    writeFileSync(onPath, "#!/bin/sh\n"); chmodSync(onPath, 0o755);
    const other = join(dir, "other-codex");
    writeFileSync(other, "#!/bin/sh\n"); chmodSync(other, 0o755);
    expect(resolveCommand(other, "codex", dir)).toBe(other);
    expect(resolveCommand("/Applications/Missing.app/codex", "codex", dir)).toBe(onPath);
    expect(resolveCommand("/Applications/Missing.app/codex", "codex", "/nonexistent")).toBe("/Applications/Missing.app/codex");
    expect(resolveCommand(undefined, "codex", dir)).toBe(onPath);
    expect(resolveCommand("codex", "codex", "/nonexistent")).toBe("codex");
  });
});

describe("claudeBinary (the user's own Claude Code CLI)", () => {
  it("is unset unless CLAUDE_BIN names one, and resolves like other commands", async () => {
    const { claudeBinary } = await import("../src/daemon.js");
    expect(claudeBinary({})).toBeUndefined();
    expect(claudeBinary({ CLAUDE_BIN: "" })).toBeUndefined();
    expect(claudeBinary({ CLAUDE_BIN: "/definitely/missing/claude", PATH: "/nonexistent" })).toBe("/definitely/missing/claude");
  });

  it("a claude-code planner runs the same CLI as the executor, from a neutral directory", async () => {
    const { claudePlannerOptions } = await import("../src/daemon.js");
    expect(claudePlannerOptions("claude-opus-5-5", { CLAUDE_BIN: "/opt/me/claude", PATH: "/nonexistent" }))
      .toEqual({ model: "claude-opus-5-5", cwd: tmpdir(), executable: "/opt/me/claude" });
    expect(claudePlannerOptions("claude-opus-5-5", {})).toEqual({ model: "claude-opus-5-5", cwd: tmpdir() });
  });
});
