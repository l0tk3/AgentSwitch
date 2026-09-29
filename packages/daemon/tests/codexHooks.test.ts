import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_HOOK_EVENTS, CodexHookTrust, codexHookArgs } from "../src/terminals/codexHooks.js";
import { agentLauncher } from "../src/terminals/launch.js";

const FAKE = resolve(import.meta.dirname, "fixtures", "fakeCodexAppServer.mjs");

describe("Codex hooks in AgentSwitch's terminals", () => {
  it("gives every event the hook command, the permission one a long wait, tool events a matcher", () => {
    const args = codexHookArgs('"/n" "/h.js"', 10, 1800);
    expect(args.filter((a) => a === "-c")).toHaveLength(CODEX_HOOK_EVENTS.length);
    expect(args).toContain('hooks.PermissionRequest=[{matcher="*",hooks=[{type="command",command="\\"/n\\" \\"/h.js\\"",timeout=1800}]}]');
    expect(args).toContain('hooks.Stop=[{hooks=[{type="command",command="\\"/n\\" \\"/h.js\\"",timeout=10}]}]');
  });

  it("has the user's Codex trust them once, through Codex; a changed hook is trusted again; an old Codex is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-codex-trust-"));
    const state = join(dir, "state.json");
    const env = { ...process.env, FAKE_CODEX_STATE: state };
    const args = codexHookArgs('"/n" "/h.js"', 10, 1800);
    const lines: string[] = [];
    const trust = new CodexHookTrust({ binary: FAKE, args, env, log: (l) => lines.push(l) });
    expect(trust.trusted).toBe(false);
    expect(await trust.ensure()).toBe(true);
    expect(trust.trusted).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(state, "utf8")))).toHaveLength(CODEX_HOOK_EVENTS.length);
    expect(lines.join("\n")).toContain("trusted 6");
    // trusted already: nothing written
    writeFileSync(state, readFileSync(state));
    const again = new CodexHookTrust({ binary: FAKE, args, env, log: (l) => lines.push(l) });
    lines.length = 0;
    expect(await again.ensure()).toBe(true);
    expect(lines).toEqual([]);
    // the hook command changed (the app moved): its hashes are trusted afresh
    const moved = new CodexHookTrust({ binary: FAKE, args: codexHookArgs('"/n" "/elsewhere/h.js"', 10, 1800), env, log: () => undefined });
    expect(await moved.ensure()).toBe(true);
    // a Codex without hooks: not trusted, and said why
    const old = new CodexHookTrust({ binary: FAKE, args, env: { ...env, FAKE_CODEX_MODE: "old" }, log: (l) => lines.push(l) });
    expect(await old.ensure()).toBe(false);
    expect(old.trusted).toBe(false);
    expect(lines.join("\n")).toContain("too old for hooks");
  });

  it("a Codex terminal gets the hooks, and its status from them, only once they are trusted", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-codex-launch-"));
    let trusted = false;
    const launch = agentLauncher({ binaries: { codex: "/bin/codex" }, gate: null, hookUrl: () => "http://127.0.0.1:1", stateDir: dir, node: "/n", hookScript: "/h.js", env: {}, codexHooks: () => trusted });
    const req = { id: "t1", harness: "codex" as const, cwd: dir, hookToken: "tok", mode: "manual" as const, cols: 80, rows: 24 };
    const before = launch(req);
    expect(before.hooks).toBe(false);
    expect(before.args.some((a) => a.startsWith("hooks."))).toBe(false);
    trusted = true;
    const after = launch(req);
    expect(after.hooks).toBe(true);
    expect(after.args.filter((a) => a.startsWith("hooks."))).toEqual(codexHookArgs('"/n" "/h.js"', 10, 1800).filter((a) => a !== "-c"));
  });
});
