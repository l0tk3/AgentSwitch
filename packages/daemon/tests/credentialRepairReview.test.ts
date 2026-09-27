/** Independent boundary regressions: fake ciphertext, fake models, loopback broker only. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/engine/store.js";
import { credentialRepairExecutor } from "../src/executors/credentialRepair.js";
import type { ExecutionInput } from "../src/executors/types.js";
import { repairCredential, type CredentialMetadata, type ReissuedCredential } from "../src/secrets/credentialRepair.js";

const original = `enc:v1:${"A".repeat(32)}`;
const fresh = `enc:v1:${"B".repeat(32)}`;
const repaired = `enc:v1:${"C".repeat(32)}`;
const otherRepair = `enc:v1:${"D".repeat(32)}`;
const host = "admin.example.test";
const otherHost = "second.example.test";
const taskText = `将 ${original} 的 TOTP 种子导入 ${host} 和 ${otherHost} 的种子字段，随后仍用原凭据生成验证码登录。`;
const metadata: CredentialMetadata = { label: "fake fixture", kind: "totp", hosts: [host, otherHost], uses: ["otp"], seed_import_hosts: [host, otherHost] };
const issued = (destination = host, token = repaired): ReissuedCredential => ({ label: "fake fixture", kind: "secret", token, hosts: [destination], uses: ["fill", "http"], seed_import_hosts: [] });
const fixtures: { store: Store; dir: string }[] = [];

afterEach(() => {
  for (const { store, dir } of fixtures.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function build() {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-credential-review-"));
  const store = new Store({ dbPath: ":memory:", threadsDir: join(dir, "threads") });
  fixtures.push({ store, dir });
  const task = store.createTask({ task: taskText, cwd: dir });
  const known = new Set([original]);
  const gate = { describe: vi.fn(async () => metadata), reissue: vi.fn(async () => issued()) };
  const router = { name: "review-fake", route: vi.fn(async () => ({ text: JSON.stringify({ allow: true, evidence: [{ source: "task", quote: taskText }] }), elapsedMs: 0 })) };
  const input: ExecutionInput = {
    taskId: task.id, task: taskText, brief: taskText, cwd: dir, model: "fake", effort: null,
    handoffNote: "Retain the original OTP token", context: `OTP source: ${original}`, knownTokens: known,
    threadHome: null, resume: null, attachments: [], browser: true, signal: new AbortController().signal,
    emit: (type, payload) => { store.appendEvent(task.id, type, payload); },
    approve: async () => "deny", ask: async () => null,
  };
  async function run(check: (received: ExecutionInput) => Promise<void>, actualInput = input) {
    const executor = credentialRepairExecutor({ harness: "fake", async run(received) { await check(received); return { ok: true }; } }, { gate, router, store });
    return executor.run(actualInput);
  }
  return { store, task, known, gate, router, input, run };
}

async function request(input: ExecutionInput, token = original, destination = host) {
  expect(input.credentialRepair).toBeDefined();
  const response = await fetch(input.credentialRepair!.url, {
    method: "POST", headers: { authorization: `Bearer ${input.credentialRepair!.key}`, "content-type": "application/json" },
    body: JSON.stringify({ token, host: destination, purpose: "totp_seed_import" }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("credential repair review boundaries", () => {
  it("recognizes a newly sealed user answer in the existing executor and repair broker", async () => {
    const f = build();
    await f.run(async (input) => {
      const answer = await input.ask([{ id: "seed", header: "凭据", text: "补充已授权种子的密文", options: [], multi: false, secret: true }]);
      expect(answer).toEqual({ seed: [fresh] });
      expect(input.knownTokens.has(fresh)).toBe(true);
      expect(await request(input, fresh)).toMatchObject({ status: 200, body: { ok: true, token: repaired } });
    }, { ...f.input, ask: async () => { f.known.add(fresh); return { seed: [fresh] }; } });
    expect(f.gate.describe).toHaveBeenCalledWith(fresh, expect.any(AbortSignal));
  });

  it("shares repaired tokens back into the supervisor's original known-token set", async () => {
    const f = build();
    await f.run(async (input) => {
      expect((await request(input)).body.ok).toBe(true);
      expect(f.known.has(repaired)).toBe(true);
      expect(f.known.has(original)).toBe(true);
    });
  });

  it("keeps OTP inputs and distinct host receipts across later dispatches", async () => {
    const f = build();
    for (const [destination, token] of [[host, repaired], [otherHost, otherRepair]] as const) {
      f.store.appendEvent(f.task.id, "credential_repair", { status: "repaired", originalToken: original, ...issued(destination, token), host: destination, purpose: "totp_seed_import" });
    }
    await f.run(async (input) => {
      expect(input.task).toBe(f.input.task);
      expect(input.brief).toBe(f.input.brief);
      expect(input.context).toBe(f.input.context);
      expect(input.handoffNote).toContain(`${host}: ${repaired}`);
      expect(input.handoffNote).toContain(`${otherHost}: ${otherRepair}`);
      expect(input.knownTokens.has(original)).toBe(true);
      expect((await request(input)).body.token).toBe(repaired);
      expect((await request(input, original, otherHost)).body.token).toBe(otherRepair);
    });
    expect(f.router.route).not.toHaveBeenCalled();
    expect(f.gate.describe).not.toHaveBeenCalled();
    expect(f.gate.reissue).not.toHaveBeenCalled();
  });

  it("does not forward unknown short Chinese diagnostics to replies or persisted events", async () => {
    const f = build();
    const diagnostic = "凭据服务错误：FAKE_PLAINTEXT_SEED_123";
    f.gate.describe.mockRejectedValueOnce(new Error(diagnostic));
    await f.run(async (input) => {
      const reply = await request(input);
      expect(reply.body.ok).toBe(false);
      expect(JSON.stringify(reply)).not.toContain("FAKE_PLAINTEXT_SEED_123");
      expect(JSON.stringify(f.store.eventsSince(f.task.id))).not.toContain("FAKE_PLAINTEXT_SEED_123");
    });
    expect(f.router.route).not.toHaveBeenCalled();
  });

  it("does not ask the router when describe finishes after cancellation", async () => {
    const f = build();
    let resolveDescription!: (value: CredentialMetadata) => void;
    f.gate.describe.mockImplementationOnce(() => new Promise((resolve) => { resolveDescription = resolve; }));
    const controller = new AbortController();
    const result = repairCredential({ token: original, host, purpose: "totp_seed_import" }, { task: taskText, context: "", cwd: f.input.cwd, knownTokens: f.known }, f, controller.signal);
    controller.abort();
    resolveDescription(metadata);
    await expect(result).rejects.toThrow("取消");
    expect(f.router.route).not.toHaveBeenCalled();
    expect(f.gate.reissue).not.toHaveBeenCalled();
  });

  it("deduplicates equivalent destination casing before calling the router and gate", async () => {
    const f = build();
    await f.run(async (input) => {
      const [upper, lower] = await Promise.all([request(input, original, host.toUpperCase()), request(input)]);
      expect(upper.body).toEqual(lower.body);
      expect(lower.body.ok).toBe(true);
    });
    expect(f.router.route).toHaveBeenCalledTimes(1);
    expect(f.gate.reissue).toHaveBeenCalledTimes(1);
    expect(f.gate.reissue).toHaveBeenCalledWith({ token: original, host, purpose: "totp_seed_import" }, expect.any(AbortSignal));
  });
});
