import { afterEach, describe, expect, it, vi } from "vitest";
import { echoRouter } from "../src/router/routers/echo.js";
import type { Router, RouterReply } from "../src/core/modelCall.js";
import { fakeMinter, type Minter, type MintResult } from "../src/secrets/minter.js";
import { parseSealReply, planSeal, routerSealer, sealMessage, type FoundSecret } from "../src/secrets/sealer.js";

const token = "enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA";
const secret = "only-a-fake-test-password";
const text = `Use ${secret} on https://admin.example.test`;
const found: FoundSecret = { value: secret, label: "admin/pass", field: "password", kind: "secret", hosts: ["admin.example.test"], uses: ["http"] };
const reply = (secrets: readonly FoundSecret[] = [found]): RouterReply => ({ text: JSON.stringify({ secrets }), elapsedMs: 0 });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
afterEach(() => vi.useRealTimers());

describe("sealer compact history view", () => {
  it("replaces only historical ciphertext, keeps shared identity and all surrounding text, and leaves the current message intact", () => {
    const oldToken = `enc:v1:${"A".repeat(16000)}`;
    const otherToken = `enc:v1:${"B".repeat(16000)}`;
    const authorization = "明确将种子录入 https://admin.example.test:8443/ 的2FA种子字段";
    const notes = "保留原始背景。".repeat(2000);
    const environment = `  管理平台 https://admin.example.test:8443/\npassword: ${oldToken}\n${authorization}\n${notes}  `;
    const parentTask = `login password ${oldToken}; seed [purpose=totp_code]: ${otherToken}\n以前任务结尾保留`;
    const current = `新消息原样 ${oldToken}\n原文结尾`;
    const message = sealMessage(current, environment, { parentTask, threadTitle: "管理平台操作" });
    expect(message).toContain(`  管理平台 https://admin.example.test:8443/\npassword: [existing-sealed:1]\n${authorization}\n${notes}  `);
    expect(message).toContain("login password [existing-sealed:1]; seed [purpose=totp_code]: [existing-sealed:2]\n以前任务结尾保留");
    expect(message).not.toContain(otherToken);
    expect(message.split(oldToken)).toHaveLength(2); // Only the untouched current message still contains it.
    expect(message.endsWith(`Task text:\n<<<\n${current}\n>>>`)).toBe(true);
  });

  it("checks import authorization against original evidence, never a compacted placeholder quote", async () => {
    const seed = "JBSWY3DPEHPK3PXP"; // Public fixture only.
    const authorization = `将新种子录入 https://admin.example.test 的种子字段，旧凭据 ${token}`;
    const current = `新种子 ${seed}`;
    const imported: FoundSecret = { ...found, value: seed, purpose: "totp_seed_import", seed_import_evidence: authorization };
    const router = echoRouter([reply([imported]).text]);
    expect(await routerSealer(router, fakeMinter(), () => authorization)(current)).toMatchObject({ ok: true, sealed: [{ purpose: "totp_seed_import", uses: ["http", "fill"] }] });
    expect(router.calls[0]!.task).not.toContain(token);
    const minter = vi.fn(fakeMinter());
    const synthetic = { ...imported, seed_import_evidence: authorization.replace(token, "[existing-sealed:1]") };
    expect(await routerSealer(echoRouter([reply([synthetic]).text]), minter, () => authorization)(current)).toMatchObject({ ok: false, code: "unroutable", error: expect.stringContaining("原文授权依据") });
    expect(minter).not.toHaveBeenCalled();
    expect(planSeal(`Use ${token} or [existing-sealed:1]`, [{ ...found, value: token }, { ...found, value: "[existing-sealed:1]" }]).entries).toEqual([]);
  });

  it("still asks the model to inspect an ordinary message with no obvious credential", async () => {
    const router = echoRouter([reply([]).text]);
    const minter = vi.fn(fakeMinter());
    const result = await routerSealer(router, minter, () => "")("请把标题改成中文");
    expect(result).toMatchObject({ ok: true, text: "请把标题改成中文", sealed: [] });
    expect(router.calls).toHaveLength(1);
  });
});

describe("sealer end-to-end deadline", () => {
  it("does not invoke environment, model or mint for an already cancelled request", async () => {
    const route = vi.fn<Router["route"]>(async () => reply()), minter = vi.fn(fakeMinter()), environment = vi.fn(() => "");
    const controller = new AbortController(); controller.abort(new Error(secret));
    expect(await routerSealer({ name: "fake", route }, minter, environment)(text, {}, controller.signal)).toMatchObject({ ok: false, code: "unavailable", error: "敏感信息检查已取消，请重新发送。" });
    expect(route).not.toHaveBeenCalled(); expect(minter).not.toHaveBeenCalled(); expect(environment).not.toHaveBeenCalled();
  });

  it("returns on deadline even when the model ignores abort, and never mints its late reply", async () => {
    vi.useFakeTimers();
    const model = deferred<RouterReply>(), minter = vi.fn(fakeMinter());
    let signal: AbortSignal | undefined;
    const router: Router = { name: "ignores-abort", route: (_input, received) => { signal = received; return model.promise; } };
    const running = routerSealer(router, minter, () => "", 50)(text);
    await vi.advanceTimersByTimeAsync(50);
    expect(await running).toMatchObject({ ok: false, code: "unavailable", error: "敏感信息检查超时，请稍后重试。", ms: 50 });
    expect(signal?.aborted).toBe(true);
    model.resolve(reply());
    await vi.advanceTimersByTimeAsync(0);
    expect(minter).not.toHaveBeenCalled();
  });

  it("shares one deadline across model and mint rather than restarting the timer for encryption", async () => {
    vi.useFakeTimers();
    const model = deferred<RouterReply>(), mint = deferred<readonly MintResult[]>();
    const minter = vi.fn<Minter>(() => mint.promise);
    const running = routerSealer({ name: "fake", route: () => model.promise }, minter, () => "", 50)(text);
    await vi.advanceTimersByTimeAsync(30); model.resolve(reply());
    await vi.advanceTimersByTimeAsync(0);
    expect(minter).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(await running).toMatchObject({ ok: false, code: "unavailable", error: "敏感信息检查超时，请稍后重试。", ms: 50 });
    mint.resolve([{ label: found.label, token }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await running).toMatchObject({ ok: false });
  });

  it("cancels during model work before mint and handles a late model rejection", async () => {
    const model = deferred<RouterReply>(), minter = vi.fn(fakeMinter()), controller = new AbortController();
    const running = routerSealer({ name: "fake", route: () => model.promise }, minter, () => "")(text, {}, controller.signal);
    controller.abort(new Error(secret));
    expect(await running).toMatchObject({ ok: false, code: "unavailable", error: "敏感信息检查已取消，请重新发送。" });
    model.reject(new Error(secret));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(minter).not.toHaveBeenCalled();
  });

  it("does not return a late success when synchronous mint/assembly work consumes the remaining wall time", async () => {
    vi.useFakeTimers();
    const minter: Minter = async () => [{ label: found.label, get token() { vi.setSystemTime(Date.now() + 100); return token; } }];
    const result = await routerSealer(echoRouter([reply().text]), minter, () => "", 50)(text);
    expect(result).toMatchObject({ ok: false, code: "unavailable", error: "敏感信息检查超时，请稍后重试。" });
  });

  it("does not renew the deadline for a whole-record retry", async () => {
    vi.useFakeTimers();
    const record = "fake-name|fake-password|fake-seed", first = deferred<RouterReply>(), retry = deferred<RouterReply>();
    const route = vi.fn<Router["route"]>().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => retry.promise);
    const minter = vi.fn(fakeMinter());
    const running = routerSealer({ name: "fake", route }, minter, () => "", 50)(record);
    await vi.advanceTimersByTimeAsync(30); first.resolve(reply([{ ...found, value: record }]));
    await vi.advanceTimersByTimeAsync(0); expect(route).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20); expect(await running).toMatchObject({ ok: false, code: "unavailable", ms: 50 });
    retry.resolve(reply([])); await vi.advanceTimersByTimeAsync(0);
    expect(minter).not.toHaveBeenCalled();
  });
});

describe("sealer safe failures", () => {
  it("never includes model replies, parsing excerpts, minter diagnostics or labels in API-facing errors", async () => {
    const failures = [
      await routerSealer(echoRouter([`No JSON: ${secret}`]), fakeMinter(), () => "")(text),
      await routerSealer({ name: "fake", route: async () => { throw new Error(secret); } }, fakeMinter(), () => "")(text),
      await routerSealer(echoRouter([reply().text]), async () => { throw new Error(secret); }, () => "")(text),
      await routerSealer(echoRouter([reply().text]), async () => [{ label: secret, error: secret }], () => "")(text),
      await routerSealer(echoRouter([reply([{ ...found, label: secret, hosts: [] }]).text]), fakeMinter(), () => "")(text),
    ];
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(!failure.ok && failure.error).toMatch(/[\u4e00-\u9fff]/);
    }
    expect(parseSealReply(`bad ${secret}`)).toEqual({ ok: false, error: "敏感信息识别回复格式无效。" });
    expect(parseSealReply(`{"secrets":[${secret}`)).toEqual({ ok: false, error: "敏感信息识别回复格式无效。" });
  });

  it("refuses missing or malformed mint results rather than producing an invalid success", async () => {
    for (const minter of [async () => [], async () => [{ label: found.label, token: secret }]]) {
      expect(await routerSealer(echoRouter([reply().text]), minter, () => "")(text)).toMatchObject({ ok: false, code: "unavailable", error: "凭据加密暂时不可用，请稍后重试。" });
    }
  });
});
