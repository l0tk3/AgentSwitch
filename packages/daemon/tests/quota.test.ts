import { describe, expect, it } from "vitest";
import { Store } from "../src/engine/store.js";
import { claudeQuota } from "../src/quota/claude.js";
import { parseRateLimits } from "../src/quota/codex.js";
import { deepseekQuota, findDeepSeekKey, parseBalance } from "../src/quota/deepseek.js";
import { QuotaService } from "../src/quota/index.js";

describe("quota parsing", () => {
  it("codex rateLimits → remaining from the worst window", () => {
    const r = parseRateLimits({ rateLimits: { primary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 1 }, secondary: { usedPercent: 40 }, planType: "pro", credits: { balance: "0" } } });
    expect(r.remaining).toBeCloseTo(0.6);
    expect(r.detail).toMatchObject({ planType: "pro", primary: { usedPercent: 13 } });
    expect(parseRateLimits({ rateLimits: { primary: { usedPercent: 100 } } }).remaining).toBe(0);
    expect(parseRateLimits({ rateLimits: {} }).remaining).toBeNull();
    expect(parseRateLimits({ primary: { usedPercent: 50 } }).remaining).toBe(0.5);
  });

  it("deepseek balance → fraction of a full scale; unavailable = 0; empty = unknown", () => {
    const body = { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "25.00", granted_balance: "0", topped_up_balance: "25.00" }] };
    expect(parseBalance(body, 50)).toMatchObject({ remaining: 0.5, detail: { is_available: true } });
    expect(parseBalance({ ...body, is_available: false }).remaining).toBe(0);
    expect(parseBalance({ balance_infos: [{ total_balance: "999" }] }).remaining).toBe(1);
    expect(parseBalance({}).remaining).toBeNull();
  });

  it("deepseek provider handles missing key, HTTP errors and success", async () => {
    expect((await deepseekQuota({ key: null }).read()).error).toContain("no DeepSeek API key");
    const bad = deepseekQuota({ key: "k", fetchImpl: async () => new Response("", { status: 401 }) });
    expect((await bad.read()).error).toBe("HTTP 401");
    const calls: string[] = [];
    const good = deepseekQuota({ key: "k", baseUrl: "http://x", fetchImpl: async (url, init) => { calls.push(`${url} ${(init?.headers as Record<string, string>).Authorization}`); return Response.json({ is_available: true, balance_infos: [{ total_balance: "50" }] }); } });
    expect((await good.read()).remaining).toBe(1);
    expect(calls).toEqual(["http://x/user/balance Bearer k"]);
    const boom = deepseekQuota({ key: "k", fetchImpl: async () => { throw new Error("offline"); } });
    expect((await boom.read()).error).toBe("offline");
  });

  it("findDeepSeekKey prefers the env var and tolerates a missing store", () => {
    expect(findDeepSeekKey({ DEEPSEEK_API_KEY: "sk-x" }, "/nonexistent.db")).toBe("sk-x");
    expect(findDeepSeekKey({}, "/nonexistent.db")).toBeNull();
  });

  it("claude local count against a daily budget", async () => {
    const store = new Store({ dbPath: ":memory:" });
    const t = store.createTask({ task: "x", cwd: "/" });
    store.updateTask(t.id, { harness: "claude-code" });
    store.appendEvent(t.id, "done", { tokens: 250 });
    const r = await claudeQuota(store, { dailyTokenBudget: 1000 }).read();
    expect(r.remaining).toBe(0.75);
    expect(r.detail).toMatchObject({ usedTokens24h: 250 });
    store.close();
  });

  it("QuotaService caches within the TTL, force-refreshes, and maps only known readings", async () => {
    let reads = 0;
    let now = 0;
    const svc = new QuotaService([
      { harness: "codex", read: async () => { reads++; return { remaining: 0.3, detail: {}, source: "s", error: null }; } },
      { harness: "opencode", read: async () => ({ remaining: null, detail: {}, source: "s", error: "no key" }) },
    ], 1000, () => now);
    expect(svc.current()).toEqual([]);
    await svc.refresh();
    await svc.refresh();
    expect(reads).toBe(1);
    now = 2000;
    await svc.refresh();
    expect(reads).toBe(2);
    await svc.refresh(true);
    expect(reads).toBe(3);
    expect(svc.map()).toEqual({ codex: 0.3 });
  });
});
