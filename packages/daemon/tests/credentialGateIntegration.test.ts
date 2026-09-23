/** Cross-language contract, using only an isolated keypair and deliberately fake credentials. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { credentialGate } from "../src/secrets/credentialRepair.js";
import { gateMinter } from "../src/secrets/minter.js";

const gatePackage = resolve(import.meta.dirname, "../../secret-gate");
const binary = join(gatePackage, ".venv/bin/secret-gate");
const python = join(gatePackage, ".venv/bin/python");
const host = "seed-import.fixture.example:8443";
const seed = "JBSWY3DPEHPK3PXP"; // public fake fixture, never a user's credential
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function setup() {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-gate-contract-")); homes.push(home);
  const initialized = spawnSync(binary, ["keygen"], { env: { ...process.env, SECRET_GATE_HOME: home }, encoding: "utf8" });
  expect(initialized.status).toBe(0);
  return { home, bin: binary };
}

const checkInsideGate = String.raw`
import asyncio,json,os,sys
from pathlib import Path
from mcp import types
from secret_gate.browser_gate import BrowserGate
from secret_gate.resolver import Resolver
request=json.load(sys.stdin)
resolver=Resolver.from_home(Path(os.environ['SECRET_GATE_HOME']),clock=lambda:1700000000)
old=resolver.resolve(request['old'],use='otp').value
class Page:
    filled=None
    async def call_tool(self,name,args):
        if name=='browser_evaluate': return types.CallToolResult(content=[types.TextContent(type='text',text='### Result\n'+json.dumps('https://'+request['host']+'/import'))])
        if name=='browser_type': self.filled=args['text']; return types.CallToolResult(content=[types.TextContent(type='text',text='filled '+args['text'])])
        raise AssertionError(name)
async def run():
    page=Page()
    result=await BrowserGate(resolver,page).call_tool('secret_fill',{'target':'seed','token':request['new']})
    visible='\n'.join(block.text for block in result)
    print(json.dumps({'filledSeed':page.filled==request['seed'],'outputRedacted':request['seed'] not in visible,'oldOtpRetained':resolver.resolve(request['old'],use='otp').value==old,'codeDiffersFromSeed':old!=request['seed'],'newKind':resolver.describe(request['new'])['kind']}))
asyncio.run(run())
`;

describe.skipIf(!existsSync(binary) || !existsSync(python))("daemon ↔ real secret-gate CLI contract", () => {
  it("reads the sealed grant, reissues secret/http, fills the seed and leaves original OTP working", async () => {
    const cfg = setup();
    const minted = await gateMinter(cfg)([{ label: "fixture/2fa", value: seed, kind: "totp", hosts: [host], uses: ["otp"], seed_import_hosts: [host] }]);
    const first = minted[0]!;
    expect("token" in first).toBe(true);
    if (!("token" in first)) throw new Error("fixture mint failed");
    const signal = new AbortController().signal;
    const gateway = credentialGate(cfg);
    expect(await gateway.describe(first.token, signal)).toEqual({ label: "fixture/2fa", kind: "totp", hosts: [host], uses: ["otp"], seed_import_hosts: [host] });
    const fresh = await gateway.reissue({ token: first.token, host, purpose: "totp_seed_import" }, signal);
    expect(fresh).toEqual({ token: expect.stringMatching(/^enc:v1:/), label: "fixture/2fa", kind: "secret", hosts: [host], uses: ["http"], seed_import_hosts: [] });
    expect(JSON.stringify(fresh)).not.toContain(seed);
    const checked = spawnSync(python, ["-c", checkInsideGate], { cwd: gatePackage, env: { ...process.env, SECRET_GATE_HOME: cfg.home }, input: JSON.stringify({ old: first.token, new: fresh.token, host, seed }), encoding: "utf8" });
    expect(checked.status).toBe(0);
    expect(JSON.parse(checked.stdout)).toEqual({ filledSeed: true, outputRedacted: true, oldOtpRetained: true, codeDiffersFromSeed: true, newKind: "secret" });
  }, 10_000);

  it("the real gate rejects legacy tokens, non-TOTP tokens and changed ports without leaking the seed", async () => {
    const cfg = setup();
    const entries = [
      { label: "fixture/legacy", value: seed, kind: "totp" as const, hosts: [host], uses: ["otp"] as const },
      { label: "fixture/plain", value: seed, kind: "secret" as const, hosts: [host], uses: ["http"] as const },
      { label: "fixture/granted", value: seed, kind: "totp" as const, hosts: [host], uses: ["otp"] as const, seed_import_hosts: [host] },
    ];
    const minted = await gateMinter(cfg)(entries);
    const gateway = credentialGate(cfg), signal = new AbortController().signal;
    for (const [index, candidate] of minted.entries()) {
      if (!("token" in candidate)) throw new Error("fixture mint failed");
      const error = await gateway.reissue({ token: candidate.token, host: index === 2 ? "seed-import.fixture.example:443" : host, purpose: "totp_seed_import" }, signal).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("拒绝修复");
      expect(String(error)).not.toContain(seed);
    }
  }, 10_000);
});
