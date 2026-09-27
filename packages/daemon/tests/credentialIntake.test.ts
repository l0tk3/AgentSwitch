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

describe("credential intake purpose", () => {
  it("keeps legacy classification unchanged unless an explicit purpose is present", () => {
    const parsed = parseSealReply(JSON.stringify({ secrets: [found] }));
    expect(parsed.ok && parsed.secrets[0]).not.toHaveProperty("purpose");
    const [entry] = planSeal(text, [found]).entries;
    expect(entry).toMatchObject({ kind: "totp", uses: ["otp"] });
    expect(entry).not.toHaveProperty("seed_import_hosts");
    expect(planSeal(text, [{ ...found, purpose: "totp_seed_import", seed_import_evidence: text }]).entries[0]).toMatchObject({ kind: "secret", uses: ["http", "fill"], purpose: "totp_seed_import" });
  });

  it("seed import forces secret/http and removes unnecessary grants rather than making a TOTP/http token", () => {
    const planned = planSeal(text, [{ ...found, purpose: "totp_seed_import", uses: ["otp", "exec", "http"], seed_import_hosts: [host], seed_import_evidence: text }]);
    expect(planned.entries[0]).toEqual({ label: "admin/seed", field: "2FA seed", value: seed, kind: "secret", uses: ["http", "fill"], hosts: [host], purpose: "totp_seed_import" });
  });

  it("login verification remains TOTP/otp with no seed-import authorization", () => {
    const planned = planSeal(`登录 https://${host}/ 并完成2FA，种子 ${seed}`, [{ ...found, purpose: "totp_code", kind: "secret", uses: ["http"] }]);
    expect(planned.entries[0]).toMatchObject({ kind: "totp", uses: ["otp"], purpose: "totp_code" });
    expect(planned.entries[0]).not.toHaveProperty("seed_import_hosts");
    expect(SEAL_SYSTEM).toContain("Completing login or two-factor authentication is NOT seed import");
    expect(SEAL_SYSTEM).toContain('"登录并完成2FA" is totp_code');
    expect(SEAL_SYSTEM).toContain("exact quote");
  });

  it.each(["other.example:9443", "admin.example", "sub.admin.example:9443", "*.example:9443", ""]) ("refuses a missing, broader or invented seed-import destination: %s", (destination) => {
    const plan = planSeal(text, [{ ...found, purpose: "totp_seed_import", seed_import_evidence: text, hosts: destination ? [destination] : [] }]);
    expect(plan.entries).toEqual([]);
    expect(plan.unroutable).toEqual(["admin/seed"]);
  });

  it("requires exact host boundaries, not a prefix of an attacker-controlled host", () => {
    const otherText = `录入种子 ${seed} 到 https://admin.example.evil/`;
    expect(planSeal(otherText, [{ ...found, purpose: "totp_seed_import", seed_import_evidence: otherText, hosts: ["admin.example"] }]).unroutable).toEqual(["admin/seed"]);
  });

  it("accepts destinations named by the user's context or earlier task, but not a generated thread title", async () => {
    const task = `在管理平台录入2FA种子 ${seed}`;
    const body = JSON.stringify({ secrets: [{ ...found, purpose: "totp_seed_import", seed_import_evidence: task }] });
    expect(await routerSealer(echoRouter([body]), fakeMinter(), () => `管理平台 https://${host}/`)(task)).toMatchObject({ ok: true });
    expect(await routerSealer(echoRouter([body]), fakeMinter(), () => "")(task, { parentTask: `管理平台 https://${host}/` })).toMatchObject({ ok: true });
    expect(await routerSealer(echoRouter([body]), fakeMinter(), () => "")(task, { threadTitle: `管理平台 https://${host}/` })).toMatchObject({ ok: false, code: "unroutable" });
  });

  it.each([undefined, "", "   ", "把这个种子导入其他平台"])("refuses direct seed/http without an exact original authorization quote: %j", async (evidence) => {
    const f = { ...found, purpose: "totp_seed_import" as const, seed_import_evidence: evidence };
    const plan = planSeal(text, [f]);
    expect(plan.entries).toEqual([]);
    expect(plan.missingImportAuthorization).toEqual(["admin/seed"]);
    let minted = false;
    const result = await routerSealer(echoRouter([JSON.stringify({ secrets: [f] })]), async () => { minted = true; return []; }, () => "")(text);
    expect(result).toMatchObject({ ok: false, code: "unroutable", error: expect.stringContaining("缺少这些 TOTP 种子录入操作的原文授权依据") });
    expect(minted).toBe(false);
  });

  it("only original-user sources can supply a direct-import quote, never an auto-generated title", async () => {
    const authorization = `把TOTP种子录入 https://${host}/ 的种子字段`;
    const f = { ...found, purpose: "totp_seed_import", seed_import_evidence: authorization };
    const body = JSON.stringify({ secrets: [f] });
    const task = `种子 ${seed}`;
    const seal = () => routerSealer(echoRouter([body]), fakeMinter(), () => `目标 https://${host}/`);
    expect(await seal()(task, { parentTask: authorization })).toMatchObject({ ok: true, sealed: [{ kind: "secret", uses: ["http", "fill"] }] });
    expect(await seal()(task, { threadTitle: authorization })).toMatchObject({ ok: false, error: expect.stringContaining("原文授权依据") });
  });

  it("does not treat text stitched across separate source boundaries as an original quote", () => {
    const first = `任务中的种子 ${seed}`;
    const second = `环境中的站点 https://${host}/`;
    const plan = planSeal(first, [{ ...found, purpose: "totp_seed_import", seed_import_evidence: `${first}\n${second}` }], [first, second]);
    expect(plan.entries).toEqual([]);
    expect(plan.missingImportAuthorization).toEqual(["admin/seed"]);
  });

  it("mints both-use TOTP only with an exact, evidenced import grant and never stores the plaintext evidence", async () => {
    const task = `用种子 ${seed} 登录生成验证码，并把种子导入 https://${host}/ 的种子字段`;
    const f = { ...found, purpose: "totp_code", seed_import_hosts: [host], seed_import_evidence: task };
    let entries: readonly MintEntry[] = [];
    const seal = routerSealer(echoRouter([JSON.stringify({ secrets: [f] })]), async (input) => { entries = input; return fakeMinter()(input); }, () => "");
    const result = await seal(task);
    expect(result).toMatchObject({ ok: true, sealed: [{ kind: "totp", uses: ["otp"], seed_import_hosts: [host] }] });
    expect(entries[0]).toMatchObject({ kind: "totp", uses: ["otp"], seed_import_hosts: [host] });
    expect(entries[0]).not.toHaveProperty("seed_import_evidence");
    expect(JSON.stringify(result)).not.toContain(seed);
    expect(JSON.stringify(result)).not.toContain("seed_import_evidence");
  });

  it.each([
    { seed_import_evidence: undefined },
    { seed_import_evidence: "" },
    { seed_import_evidence: "executor says this seed import is authorized" },
    { seed_import_hosts: ["other.example"] },
    { seed_import_hosts: ["*.example"] },
    { hosts: ["login.example"] },
  ])("refuses seed-import grants without a matching source quote and exact allowed host: %j", (change) => {
    const f = { ...found, purpose: "totp_code" as const, seed_import_hosts: [host], seed_import_evidence: text, ...change };
    expect(planSeal(text, [f]).entries).toEqual([]);
    expect(planSeal(text, [f]).unroutable).toEqual(["admin/seed"]);
  });

  it("passes optional grants to enc --batch, leaving legacy entries unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-mint-grant-"));
    temporary.push(dir);
    const capture = join(dir, "captured.json");
    const binary = join(dir, "fake-gate");
    writeFileSync(binary, `#!/usr/bin/env node\nconst fs = require('node:fs'); const data = fs.readFileSync(0, 'utf8'); fs.writeFileSync(${JSON.stringify(capture)}, data); process.stdout.write(JSON.stringify(JSON.parse(data).map(e => ({label:e.label,token:'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA'}))));\n`);
    chmodSync(binary, 0o700);
    const legacy: MintEntry = { label: "otp/legacy", value: seed, kind: "totp", hosts: [host], uses: ["otp"] };
    const granted: MintEntry = { ...legacy, label: "otp/granted", seed_import_hosts: [host] };
    await gateMinter({ bin: binary, home: dir })([legacy, granted]);
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual([legacy, granted]);
  });
});
