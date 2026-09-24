/** Cross-language contract for `secret-gate refs` (gate-next-v0 §1), opt-in: runs only when the secret-gate venv exists,
 *  with an isolated temporary SECRET_GATE_HOME (fresh keypair, fake values). Never touches ~/.secret-gate, no model. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gateRefsExecutor } from "../src/executors/gateRefs.js";
import type { ExecutionInput } from "../src/executors/types.js";
import { gateMinter } from "../src/secrets/minter.js";
import { gateRefs } from "../src/secrets/refs.js";

const binary = join(resolve(import.meta.dirname, "../../secret-gate"), ".venv/bin/secret-gate");
const REF = /^enc:ref:[A-Za-z0-9_-]{16}$/;
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

async function setup(): Promise<{ bin: string; home: string; tokens: string[] }> {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-refs-contract-")); homes.push(home);
  expect(spawnSync(binary, ["keygen"], { env: { ...process.env, SECRET_GATE_HOME: home }, encoding: "utf8" }).status).toBe(0);
  const minted = await gateMinter({ bin: binary, home })([
    { label: "fixture/mail", value: "fixture-password-1", kind: "secret", hosts: ["mail.fixture.example"], uses: ["http"] },
    { label: "fixture/erp", value: "fixture-password-2", kind: "secret", hosts: ["erp.fixture.example:8443"], uses: ["http"] },
  ]);
  const tokens = minted.map((m) => { if (!("token" in m)) throw new Error("fixture mint failed"); return m.token; });
  return { bin: binary, home, tokens };
}

describe.skipIf(!existsSync(binary))("daemon ↔ real `secret-gate refs` CLI contract", () => {
  it("register: one ref per token in order, stable within a scope, foreign tokens as error items; release closes the scope", async () => {
    const cfg = await setup();
    const refs = gateRefs(cfg);
    const scope = "fixtureScope_0123456789-abcdefghij";
    const foreign = `enc:v1:${"A".repeat(60)}`;
    const first = await refs.register(scope, [cfg.tokens[0]!, foreign, cfg.tokens[1]!]);
    expect(first).toHaveLength(3);
    expect(first[0]).toMatchObject({ ref: expect.stringMatching(REF), label: "fixture/mail" });
    expect(first[1]).toEqual({ error: expect.any(String) });
    expect(first[2]).toMatchObject({ ref: expect.stringMatching(REF), label: "fixture/erp" });
    const again = await refs.register(scope, [cfg.tokens[0]!]);
    expect(again[0]).toEqual(first[0]);
    const other = await refs.register("otherScope_0123456789-abcdefghijk", [cfg.tokens[0]!]);
    expect((other[0] as { ref: string }).ref).not.toBe((first[0] as { ref: string }).ref);
    expect(await refs.release(scope)).toBe(2);
    expect(await refs.release(scope)).toBe(0);
    const err = await refs.register(scope, [cfg.tokens[0]!]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("secret-gate refs register exited 2");
    expect(String(err)).not.toContain(scope);
  }, 20_000);

  it("the wrapper end to end: real refs reach the executor, ciphertext comes back, the scope is released", async () => {
    const cfg = await setup();
    const refs = gateRefs(cfg);
    const seen: ExecutionInput[] = [];
    const executor = gateRefsExecutor({ harness: "claude-code", async run(input) { seen.push(input); return { ok: true, exitCode: 0, lastText: `used ${input.brief.split(" ").at(-1)}` }; } }, { refs, health: async () => ({ ok: true }) });
    const input: ExecutionInput = { taskId: "contract", task: `log in with ${cfg.tokens[0]}`, brief: `log in with ${cfg.tokens[0]}`, cwd: "/tmp", model: "fixture", effort: null,
      handoffNote: null, context: null, knownTokens: new Set([cfg.tokens[0]!]), threadHome: null, resume: null, attachments: [], browser: false,
      signal: new AbortController().signal, emit: () => undefined, approve: async () => "deny", ask: async () => null };
    const outcome = await executor.run(input);
    const ref = seen[0]!.brief.split(" ").at(-1)!;
    expect(ref).toMatch(REF);
    expect(outcome.lastText).toBe(`used ${cfg.tokens[0]}`);
    expect(await refs.release(seen[0]!.gateScope!)).toBe(0);   // already released by the wrapper
  }, 20_000);
});
