import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { probeRateLimits } from "../src/executors/claude.js";
import { buildDaemon, defaultConfig } from "../src/daemon.js";
import { claudeQuota } from "../src/quota/claude.js";
import { labelForMinutes, RateLimitCache, remainingFromWindows } from "../src/quota/windows.js";
import { codexQuota, parseRateLimits } from "../src/quota/codex.js";
import { deepseekQuota, findDeepSeekKey, parseBalance } from "../src/quota/deepseek.js";
import { QuotaService } from "../src/quota/index.js";
import type { QuotaProvider } from "../src/quota/types.js";

describe("quota parsing", () => {
  it("codex rateLimits → remaining from the worst window", () => {
    const r = parseRateLimits({ rateLimits: { primary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 1 }, secondary: { usedPercent: 40 }, planType: "pro", credits: { balance: "0" } } });
    expect(r.remaining).toBeCloseTo(0.6);
    expect(r.detail).toMatchObject({ planType: "pro", windows: [{ label: "7d", usedPercent: 13 }, { label: "?", usedPercent: 40 }] });
    expect(parseRateLimits({ rateLimits: { primary: { usedPercent: 100 } } }).remaining).toBe(0);
    expect(parseRateLimits({ rateLimits: {} }).remaining).toBeNull();
    expect(parseRateLimits({ primary: { usedPercent: 50 } }).remaining).toBe(0.5);
  });

  it("deepseek balance → usable (1) or not (0); empty = unknown", () => {
    const body = { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "25.00", granted_balance: "0", topped_up_balance: "25.00" }] };
    expect(parseBalance(body)).toMatchObject({ remaining: 1, detail: { is_available: true } });
    expect(parseBalance({ is_available: true, balance_infos: [{ total_balance: "0" }] }).remaining).toBe(0);
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

  it("codex detail exposes labelled windows (5h / 7d)", () => {
    const r = parseRateLimits({ rateLimits: { primary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 5 }, secondary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 6 } } });
    expect(r.detail.windows).toEqual([{ label: "7d", usedPercent: 13, resetsAt: 5 }, { label: "5h", usedPercent: 60, resetsAt: 6 }]);
    expect(labelForMinutes(90)).toBe("90m");
    expect(labelForMinutes(undefined)).toBe("?");
  });

  it("claude: windows from rate_limit events win over the token count; probe fills an empty cache", async () => {
    const cache = new RateLimitCache(() => 1000);
    const noProbe = await claudeQuota({ cache }).read();
    expect(noProbe.remaining).toBeNull();          // nothing seen yet: unknown, which the floor treats as available
    expect(noProbe.source).toContain("no windows seen yet");
    let probes = 0;
    const probe = async () => { probes++; return [{ rateLimitType: "five_hour", utilization: 0.4, resetsAt: 99 }, { rateLimitType: "seven_day", utilization: 12, resetsAt: 100 }, { rateLimitType: "overage" }]; };
    const q = claudeQuota({ cache, probe });
    const r = await q.read();
    expect(probes).toBe(1);
    expect(r.detail.windows).toEqual([{ label: "5h", usedPercent: 40, resetsAt: 99 }, { label: "7d", usedPercent: 12, resetsAt: 100 }]);
    expect(r.remaining).toBe(0.6);
    expect(r.source).toContain("subscription windows");
    await q.read();            // cached: no probe
    await q.read(true);        // force but fresh: no probe
    expect(probes).toBe(1);
    cache.record({ rateLimitType: "five_hour", status: "rejected" });
    expect(remainingFromWindows(cache.list())).toBe(0);
    // the shape the CLI actually sends: unifiedWindows, no top-level utilization
    const real = new RateLimitCache(() => 1);
    real.record({ status: "allowed", resetsAt: 1789974000, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.13, resetsAt: 1789974000 }, seven_day: { utilization: 0.12, resetsAt: 1790485200 } } });
    expect(real.list()).toEqual([{ label: "5h", usedPercent: 13, resetsAt: 1789974000 }, { label: "7d", usedPercent: 12, resetsAt: 1790485200 }]);
    expect(remainingFromWindows(real.list())).toBe(0.87);
    real.record({ status: "allowed" });   // nothing usable: no change
    expect(real.list()).toHaveLength(2);
    const failing = claudeQuota({ cache: new RateLimitCache(), probe: async () => { throw new Error("offline"); } });
    expect((await failing.read()).error).toBe("probe: offline");
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

describe("quota refresh deadlines", () => {
  it("the quota HTTP route returns even when a provider never finishes", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-quota-api-"));
    const quota = new QuotaService([{ harness: "stuck", read: async () => new Promise(() => undefined) }], 1000, Date.now, 25);
    const daemon = buildDaemon(defaultConfig({ AGENTSWITCH_HOME: home, AGENTSWITCH_ROUTER: "echo", AGENTSWITCH_EXECUTORS: "echo", AGENTSWITCH_TERMINALS: "0", AGENTSWITCH_BROWSER_HOST: "0" }), { quota });
    vi.useFakeTimers();
    try {
      const pending = daemon.app.request("/quota");
      await vi.advanceTimersByTimeAsync(25);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([expect.objectContaining({ harness: "stuck", remaining: null, error: "quota timed out after 25 ms" })]);
      expect((await daemon.app.request("/healthz")).status).toBe(200);
    } finally { vi.useRealTimers(); daemon.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it("bounds a provider that ignores abort, isolates errors, and releases the shared refresh", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const never: QuotaProvider = { harness: "stuck", read: async (_force, signal) => { signals.push(signal!); return new Promise(() => undefined); } };
      const svc = new QuotaService([never,
        { harness: "bad", read: async () => { throw new Error("unavailable"); } },
        { harness: "good", read: async () => ({ remaining: 0.7, detail: {}, source: "test", error: null }) },
      ], 1000, Date.now, 25);
      const one = svc.refresh(), joined = svc.refresh();
      await vi.advanceTimersByTimeAsync(25);
      const result = await one;
      expect(await joined).toEqual(result);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
      expect(result).toEqual([
        expect.objectContaining({ harness: "stuck", remaining: null, error: "quota timed out after 25 ms" }),
        expect.objectContaining({ harness: "bad", remaining: null, error: "unavailable" }),
        expect.objectContaining({ harness: "good", remaining: 0.7, error: null }),
      ]);
      const next = svc.refresh(true);
      await vi.advanceTimersByTimeAsync(25);
      await next;
      expect(signals).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("keeps previous readings on timeout and ignores a late result after a newer refresh", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let finishLate!: (value: Awaited<ReturnType<QuotaProvider["read"]>>) => void;
      const value = (remaining: number) => ({ remaining, detail: { fixture: true }, source: "test", error: null });
      const provider: QuotaProvider = { harness: "test", read: async () => {
        calls++;
        if (calls === 2) return new Promise((resolve) => { finishLate = resolve; });
        return value(calls === 1 ? 0.4 : 0.8);
      } };
      const svc = new QuotaService([provider], 1000, Date.now, 10);
      await svc.refresh();
      const stuck = svc.refresh(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(await stuck).toEqual([expect.objectContaining({ remaining: 0.4, source: "test", error: "quota timed out after 10 ms" })]);
      await svc.refresh(true);
      finishLate(value(0.1));
      await vi.advanceTimersByTimeAsync(0);
      expect(svc.map()).toEqual({ test: 0.8 });
    } finally { vi.useRealTimers(); }
  });

  it("aborts DeepSeek fetch and forwards cancellation to the Claude probe", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const pending = <T>(signal: AbortSignal) => new Promise<T>((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      const svc = new QuotaService([
        deepseekQuota({ key: "fixture", fetchImpl: async (_url, init) => pending<Response>(init!.signal as AbortSignal) }),
        claudeQuota({ cache: new RateLimitCache(), probe: async (signal) => pending(signal!) }),
      ], 1000, Date.now, 10);
      const refresh = svc.refresh();
      await vi.advanceTimersByTimeAsync(10);
      expect(await refresh).toHaveLength(2);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it.each(["codex", "claude"] as const)("stops a hung %s quota child without calling a model", async (harness) => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-quota-child-"));
    const executable = join(dir, "fake-agent.cjs"), pidFile = join(dir, "pid");
    // A real local process that never emits a protocol response. It cannot reach a model or the network.
    // The pid is renamed into place so a reader never sees a half-written file (an empty pid would mean process group 0).
    writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));\nfs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const readPid = () => existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) || 0 : 0;
    const provider = harness === "codex" ? codexQuota({ binary: executable })
      : claudeQuota({ cache: new RateLimitCache(), probe: (signal) => probeRateLimits(undefined, executable, signal) });
    // The deadline expires once the child is known to be running, never on a race with its start-up.
    let expire: (() => void) | undefined;
    const svc = new QuotaService([provider], 1000, Date.now, 2000, (_ms, fire) => { expire = fire; return () => undefined; });
    try {
      const refresh = svc.refresh();
      const pid = await vi.waitFor(() => { const pid = readPid(); expect(pid).toBeGreaterThan(0); return pid; }, { timeout: 15_000, interval: 10 })
        .catch(async (error) => { expire?.(); throw new Error(`${String(error)}; reading=${JSON.stringify(await refresh)}`); });
      expect(expire).toBeDefined();
      expire!();
      expect(await refresh).toEqual([expect.objectContaining({ error: "quota timed out after 2000 ms" })]);
      // Codex kills at once; the Claude SDK sends SIGTERM after its own close grace. The bound only limits a failure.
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 20_000, interval: 20 });
    } finally {
      const pid = readPid();
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);
});
