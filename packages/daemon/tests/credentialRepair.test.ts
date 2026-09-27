/** The real loopback broker with fake router/gate: no cloud models or business-site requests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/engine/store.js";
import { credentialRepairExecutor } from "../src/executors/credentialRepair.js";
import type { ExecutionInput, Executor } from "../src/executors/types.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { CredentialRepairError, repairCredential, type CredentialGate, type CredentialIssue, type ReissuedCredential } from "../src/secrets/credentialRepair.js";
import { exactHost } from "../src/util/host.js";

const old = "enc:v1:OldFixtureToken000000000000000000";
const fresh = "enc:v1:NewFixtureToken000000000000000000";
const host = "internal.example:8400";
const taskText = `请把这条邮箱的 TOTP 种子录入 ${host}，然后生成验证码登录。${old}`;
const issue: CredentialIssue = { token: old, host, purpose: "totp_seed_import" };
const result: ReissuedCredential = { token: fresh, label: "mail/2fa", kind: "secret", hosts: [host], uses: ["fill", "http"], seed_import_hosts: [] };
const material = () => ({ task: taskText, context: "", cwd: "/tmp", knownTokens: new Set([old]) });
const authorized = () => echoRouter([JSON.stringify({ allow: true, evidence: [{ source: "task", quote: `请把这条邮箱的 TOTP 种子录入 ${host}` }] })]);
const gate = (): CredentialGate => ({
  describe: vi.fn(async () => ({ label: "mail/2fa", kind: "totp" as const, hosts: [host], uses: ["otp"], seed_import_hosts: [host] })),
  reissue: vi.fn(async () => result),
});
const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function execution() {
  const store = new Store({ dbPath: ":memory:" }); stores.push(store);
  const task = store.createTask({ task: taskText, cwd: "/tmp" });
  const input: ExecutionInput = { taskId: task.id, task: taskText, brief: taskText, cwd: "/tmp", model: "fixture", effort: null, handoffNote: null, context: null, knownTokens: new Set([old]), threadHome: null, resume: null, attachments: [], browser: true, signal: new AbortController().signal, emit: (type, payload) => { store.appendEvent(task.id, type, payload); }, approve: async () => "deny", ask: async () => null };
  return { store, input };
}
async function request(input: ExecutionInput, body: unknown = issue, key = input.credentialRepair!.key) {
  const response = await fetch(input.credentialRepair!.url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("credential repair authorization", () => {
  it("requires both the sealed seed-import grant and an exact user-source citation", async () => {
    const gateway = gate(), router = authorized();
    expect(await repairCredential(issue, material(), { gate: gateway, router }, new AbortController().signal)).toEqual(result);
    expect(gateway.reissue).toHaveBeenCalledWith(issue, expect.any(AbortSignal));
    expect(router.calls).toHaveLength(1);
  });

  it.each(["unknown_token", "new_host", "missing_grant", "wrong_kind"])("refuses %s before asking any model or minting", async (why) => {
    const gateway = gate(), router = authorized(), input = material();
    if (why === "unknown_token") input.knownTokens.clear();
    if (why === "missing_grant") gateway.describe = vi.fn(async () => ({ label: "mail/2fa", kind: "totp" as const, hosts: [host], uses: ["otp"], seed_import_hosts: [] }));
    if (why === "wrong_kind") gateway.describe = vi.fn(async () => ({ ...result }));
    await expect(repairCredential({ ...issue, ...(why === "new_host" ? { host: "elsewhere.example:8400" } : {}) }, input, { gate: gateway, router }, new AbortController().signal)).rejects.toBeInstanceOf(CredentialRepairError);
    expect(router.calls).toHaveLength(0);
    expect(gateway.reissue).not.toHaveBeenCalled();
  });

  it.each([
    { allow: false, evidence: [] },
    { allow: true, evidence: [] },
    { allow: true, evidence: [{ source: "task", quote: "invented permission" }] },
  ])("does not mint when router evidence is missing or false", async (decision) => {
    const gateway = gate();
    await expect(repairCredential(issue, material(), { gate: gateway, router: echoRouter([JSON.stringify(decision)]) }, new AbortController().signal)).rejects.toThrow();
    expect(gateway.reissue).not.toHaveBeenCalled();
  });

  it("rejects broad targets and a gate result that would still generate an OTP", async () => {
    for (const value of ["*.example", "https://internal.example", "user@internal.example", "internal.example/path", "internal.example:0", "internal.example:65536"]) expect(exactHost(value)).toBeNull();
    const gateway = gate(); gateway.reissue = async () => ({ ...result, kind: "totp" });
    await expect(repairCredential(issue, material(), { gate: gateway, router: authorized() }, new AbortController().signal)).rejects.toThrow("超出申请范围");
  });

  it("does not expand an exact seed-import grant to a different port", async () => {
    const gateway = gate(), router = authorized();
    gateway.describe = async () => ({ label: "mail/2fa", kind: "totp", hosts: ["internal.example"], uses: ["otp"], seed_import_hosts: ["internal.example"] });
    await expect(repairCredential(issue, material(), { gate: gateway, router }, new AbortController().signal)).rejects.toThrow("原密文未授权种子导入");
    expect(router.calls).toHaveLength(0);
    expect(gateway.reissue).not.toHaveBeenCalled();
  });
});

describe("credential repair execution bridge", () => {
  it("routes feedback in the same execution, deduplicates concurrent requests, and persists a scoped receipt", async () => {
    const { store, input } = execution(), gateway = gate(), router = authorized();
    let endpoint = "", runs = 0;
    const executor: Executor = { harness: "fixture", async run(current) {
      runs++; endpoint = current.credentialRepair!.url;
      expect((await request(current, issue, "wrong")).status).toBe(403);
      expect((await request(current, { ...issue, token: fresh })).status).toBe(403);
      const [one, two] = await Promise.all([request(current), request(current)]);
      expect(one).toEqual(two);
      expect(one.body).toMatchObject({ ok: true, token: fresh, kind: "secret", hosts: [host] });
      expect(current.knownTokens.has(fresh)).toBe(true);
      expect(input.knownTokens.has(fresh)).toBe(true);
      expect(current.knownTokens.has(old)).toBe(true); // OTP use remains available.
      return { ok: true, lastText: "Only the failed fill was retried." };
    } };
    const wrapped = credentialRepairExecutor(executor, { store, gate: gateway, router });
    expect((await wrapped.run(input)).ok).toBe(true);
    expect(runs).toBe(1);
    expect(router.calls).toHaveLength(1);
    expect(gateway.reissue).toHaveBeenCalledTimes(1);
    expect(store.eventsSince(input.taskId).map((e) => e.payload.status)).toEqual(["requested", "repaired"]);
    await expect(fetch(endpoint)).rejects.toThrow();

    const next: Executor = { harness: "fixture", async run(current) {
      expect(current.task).toBe(taskText);
      expect(current.knownTokens.has(old)).toBe(true);
      expect(current.knownTokens.has(fresh)).toBe(true);
      expect(current.handoffNote).toContain(`destination ${host}: ${fresh}`);
      expect((await request(current)).body.token).toBe(fresh);
      return { ok: true };
    } };
    await credentialRepairExecutor(next, { store, gate: gateway, router }).run({ ...input, knownTokens: new Set([old]) });
    expect(gateway.reissue).toHaveBeenCalledTimes(1);
  });

  it("bounds a router ignoring cancellation and never mints after its late reply", async () => {
    const { store, input } = execution(), gateway = gate();
    let resolve!: (value: { text: string; elapsedMs: number }) => void;
    const router = { name: "stalled", route: () => new Promise<{ text: string; elapsedMs: number }>((done) => { resolve = done; }) };
    const executor: Executor = { harness: "fixture", async run(current) {
      expect((await request(current)).body).toMatchObject({ ok: false, error: "凭据修复已取消或超时" });
      resolve({ text: JSON.stringify({ allow: true, evidence: [{ source: "task", quote: taskText }] }), elapsedMs: 0 });
      await new Promise((done) => setImmediate(done));
      expect(gateway.reissue).not.toHaveBeenCalled();
      return { ok: true };
    } };
    await credentialRepairExecutor(executor, { store, gate: gateway, router, timeoutMs: 25 }).run(input);
    expect(store.eventsSince(input.taskId).map((e) => e.payload.status)).toEqual(["requested", "denied"]);
  });

  it("returns a clear refusal for legacy OTP-only tokens and does not ask the model repeatedly", async () => {
    const { store, input } = execution(), gateway = gate(), router = authorized();
    gateway.describe = async () => ({ label: "mail/2fa", kind: "totp", hosts: [host], uses: ["otp"], seed_import_hosts: [] });
    const executor: Executor = { harness: "fixture", async run(current) {
      expect((await request(current)).body.error).toContain("原密文未授权种子导入");
      expect((await request(current)).body.error).toContain("原密文未授权种子导入");
      return { ok: true };
    } };
    await credentialRepairExecutor(executor, { store, gate: gateway, router }).run(input);
    expect(router.calls).toHaveLength(0);
    expect(gateway.reissue).not.toHaveBeenCalled();
    expect(store.eventsSince(input.taskId)).toHaveLength(2);
  });
});
