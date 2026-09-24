/** `secret-gate refs register|release` client against a fake CLI script: stdin-only scope, exit codes, batching. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gateRefs, MAX_REGISTER, parseRegisterOutput } from "../src/secrets/refs.js";

const scope = "Sc0pe_Fixture-0123456789abcdefgh";
const token = (i: number) => `enc:v1:${String(i).padStart(24, "T")}`;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A stand-in CLI whose behaviour is chosen by `<home>/mode`; every call is appended to `<home>/calls.jsonl`. */
function fakeGate(mode: string): { bin: string; home: string; calls: () => { argv: string[]; stdin: { scope: string; tokens?: string[] }; home: string }[] } {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-refs-")); dirs.push(home);
  writeFileSync(join(home, "mode"), mode);
  const bin = join(home, "secret-gate");
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const home = process.env.SECRET_GATE_HOME, mode = fs.readFileSync(path.join(home, 'mode'), 'utf8');
const stdin = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({ argv: process.argv.slice(2), stdin, home }) + '\\n');
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'exit2') { process.stderr.write('error: scope ' + stdin.scope + ' was released\\nmore\\n'); process.exitCode = 2; }
else if (mode === 'garbage') process.stdout.write('not json');
else if (process.argv[3] === 'release') process.stdout.write(JSON.stringify({ released: 3 }));
else process.stdout.write(JSON.stringify({ refs: stdin.tokens.map((t, i) => mode === 'partial' && i === 1 ? { error: 'cannot open token' } : { ref: 'enc:ref:' + String(i).padStart(16, 'F'), label: 'l' + i, kind: 'secret', hosts: ['a.example'], uses: ['http'] }) }), () => { if (mode === 'partial') process.exitCode = 1; });
`, { mode: 0o700 });
  return { bin, home, calls: () => readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}

describe("secret-gate refs CLI client", () => {
  it("register: scope and tokens on stdin only, results in order, per-item errors kept", async () => {
    const g = fakeGate("partial");
    const out = await gateRefs(g).register(scope, [token(1), token(2), token(3)]);
    expect(out).toEqual([{ ref: `enc:ref:${"0".padStart(16, "F")}`, label: "l0" }, { error: "cannot open token" }, { ref: `enc:ref:${"2".padStart(16, "F")}`, label: "l2" }]);
    const [call] = g.calls();
    expect(call!.argv).toEqual(["refs", "register"]);
    expect(call!.stdin).toEqual({ scope, tokens: [token(1), token(2), token(3)] });
    expect(call!.home).toBe(g.home);
  });

  it(`register splits more than ${MAX_REGISTER} tokens into several calls under the same scope`, async () => {
    const g = fakeGate("ok");
    const tokens = Array.from({ length: MAX_REGISTER + 4 }, (_, i) => token(i));
    const out = await gateRefs(g).register(scope, tokens);
    expect(out).toHaveLength(tokens.length);
    expect(g.calls().map((c) => [c.stdin.scope, c.stdin.tokens!.length])).toEqual([[scope, MAX_REGISTER], [scope, 4]]);
  });

  it("release returns the count; an invalid request or released scope is an error with the scope scrubbed", async () => {
    expect(await gateRefs(fakeGate("ok")).release(scope)).toBe(3);
    const bad = fakeGate("exit2");
    const err = await gateRefs(bad).register(scope, [token(1)]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("secret-gate refs register exited 2: error: scope [scope] was released");
    expect(String(err)).not.toContain(scope);
    await expect(gateRefs(bad).release(scope)).rejects.toThrow("secret-gate refs release exited 2: error: scope [scope] was released");
  });

  it("unexpected output, a missing binary, a timeout and an abort all reject", async () => {
    await expect(gateRefs(fakeGate("garbage")).register(scope, [token(1)])).rejects.toThrow("secret-gate refs register: output is not JSON");
    await expect(gateRefs(fakeGate("garbage")).release(scope)).rejects.toThrow("secret-gate refs release: output is not JSON");
    await expect(gateRefs({ bin: "/nonexistent/secret-gate", home: "/tmp" }).register(scope, [token(1)])).rejects.toThrow(/secret-gate refs register: spawn .*ENOENT/);
    await expect(gateRefs(fakeGate("hang"), 300).register(scope, [token(1)])).rejects.toThrow("secret-gate refs register timed out");
    const ctl = new AbortController();
    const pending = gateRefs(fakeGate("hang")).register(scope, [token(1)], ctl.signal);
    setTimeout(() => ctl.abort(), 100);
    await expect(pending).rejects.toThrow("secret-gate refs register: cancelled");
    const aborted = new AbortController(); aborted.abort();
    await expect(gateRefs(fakeGate("ok")).register(scope, [token(1)], aborted.signal)).rejects.toThrow("cancelled");
  });

  it("parser: count and shape must match the request", () => {
    const ok = JSON.stringify({ refs: [{ ref: `enc:ref:${"A".repeat(16)}`, label: null }] });
    expect(parseRegisterOutput(ok, 1)).toEqual([{ ref: `enc:ref:${"A".repeat(16)}`, label: "" }]);
    expect(() => parseRegisterOutput(ok, 2)).toThrow("unexpected output shape");
    expect(() => parseRegisterOutput(JSON.stringify({ refs: [{ ref: "enc:ref:short", label: "x" }] }), 1)).toThrow("unexpected output shape");
  });
});
