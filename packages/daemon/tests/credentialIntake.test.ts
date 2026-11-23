import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { echoRouter } from "../src/router/routers/echo.js";
import { fakeMinter, gateMinter, type MintEntry } from "../src/secrets/minter.js";
import { parseSealReply, planSeal, routerSealer, SEAL_SYSTEM, type FoundSecret } from "../src/secrets/sealer.js";

const seed = "JBSWY3DPEHPK3PXP"; // Public test vector, never a real credential.
const host = "admin.example:9443";
const text = `将2FA种子 ${seed} 录入 https://${host}/ 的种子字段`;
const found: FoundSecret = { value: seed, label: "admin/seed", field: "2FA seed", kind: "totp", hosts: [host], uses: ["otp"] };
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("credential intake purpose (gate-simple-v0 §1: no seed import)", () => {
  it("keeps the classification unchanged unless an explicit purpose is present", () => {
    const parsed = parseSealReply(JSON.stringify({ secrets: [found] }));
    expect(parsed.ok && parsed.secrets[0]).not.toHaveProperty("purpose");
    const [entry] = planSeal(text, [found]).entries;
    expect(entry).toEqual({ label: "admin/seed", field: "2FA seed", value: seed, kind: "totp", hosts: [host], uses: ["otp"] });
  });

  it("login verification is TOTP/otp whatever kind and uses the model wrote", () => {
    const planned = planSeal(`登录 https://${host}/ 并完成2FA，种子 ${seed}`, [{ ...found, purpose: "totp_code", kind: "secret", uses: ["http"] }]);
    expect(planned.entries[0]).toMatchObject({ kind: "totp", uses: ["otp"], purpose: "totp_code" });
  });

  it("an older reply asking for a seed import is read without it: no purpose, no grant, still a code-only token", async () => {
    const old = { ...found, purpose: "totp_seed_import", seed_import_hosts: [host], seed_import_evidence: text };
    const parsed = parseSealReply(JSON.stringify({ secrets: [old] }));
    expect(parsed.ok).toBe(true);
    const secret = parsed.ok ? parsed.secrets[0]! : null;
    expect(secret?.purpose).toBeUndefined();
    expect(secret).not.toHaveProperty("seed_import_hosts");
    let entries: readonly MintEntry[] = [];
    const result = await routerSealer(echoRouter([JSON.stringify({ secrets: [old] })]), async (input) => { entries = input; return fakeMinter()(input); }, () => "")(text);
    expect(result).toMatchObject({ ok: true, sealed: [{ kind: "totp", uses: ["otp"] }] });
    expect(entries).toEqual([{ label: "admin/seed", field: "2FA seed", value: seed, kind: "totp", hosts: [host], uses: ["otp"] }]);
    expect(JSON.stringify(result)).not.toContain(seed);
  });

  it("tells the model a seed is never sealed for http or fill", () => {
    expect(SEAL_SYSTEM).not.toContain("totp_seed_import");
    expect(SEAL_SYSTEM).not.toContain("seed_import");
    expect(SEAL_SYSTEM).toContain("Never change a seed into secret/http/fill");
  });

  it("passes entries to enc --batch exactly as planned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-mint-"));
    temporary.push(dir);
    const capture = join(dir, "captured.json");
    const binary = join(dir, "fake-gate");
    writeFileSync(binary, `#!/usr/bin/env node\nconst fs = require('node:fs'); const data = fs.readFileSync(0, 'utf8'); fs.writeFileSync(${JSON.stringify(capture)}, data); process.stdout.write(JSON.stringify(JSON.parse(data).map(e => ({label:e.label,token:'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA'}))));\n`);
    chmodSync(binary, 0o700);
    const entry: MintEntry = { label: "otp/seed", value: seed, kind: "totp", hosts: [host], uses: ["otp"] };
    await gateMinter({ bin: binary, home: dir })([entry]);
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual([entry]);
  });
});
