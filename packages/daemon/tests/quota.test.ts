import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { probeRateLimits } from "../src/quota/claudeProbe.js";
import { labelForMinutes, RateLimitCache } from "../src/quota/windows.js";
import { codexQuota, parseRateLimits } from "../src/quota/codex.js";

describe("quota parsing", () => {
  it("codex rateLimits → remaining from the worst window", () => {
    const r = parseRateLimits({ rateLimits: { primary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 1 }, secondary: { usedPercent: 40 }, planType: "pro", credits: { balance: "0" } } });
    expect(r.remaining).toBeCloseTo(0.6);
    expect(r.detail).toMatchObject({ planType: "pro", windows: [{ label: "7d", usedPercent: 13 }, { label: "?", usedPercent: 40 }] });
    expect(parseRateLimits({ rateLimits: { primary: { usedPercent: 100 } } }).remaining).toBe(0);
    expect(parseRateLimits({ rateLimits: {} }).remaining).toBeNull();
    expect(parseRateLimits({ primary: { usedPercent: 50 } }).remaining).toBe(0.5);
  });

  it("codex detail exposes labelled windows (5h / 7d)", () => {
    const r = parseRateLimits({ rateLimits: { primary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 5 }, secondary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 6 } } });
    expect(r.detail.windows).toEqual([{ label: "7d", usedPercent: 13, resetsAt: 5 }, { label: "5h", usedPercent: 60, resetsAt: 6 }]);
    expect(labelForMinutes(90)).toBe("90m");
    expect(labelForMinutes(undefined)).toBe("?");
  });

  it("Claude's rate-limit windows as its events say them: used per window", () => {
    const cache = new RateLimitCache(() => 1000);
    for (const info of [{ rateLimitType: "five_hour", utilization: 0.4, resetsAt: 99 }, { rateLimitType: "seven_day", utilization: 12, resetsAt: 100 }, { rateLimitType: "overage" }]) cache.record(info);
    expect(cache.list()).toEqual([{ label: "5h", usedPercent: 40, resetsAt: 99 }, { label: "7d", usedPercent: 12, resetsAt: 100 }]);
    cache.record({ rateLimitType: "five_hour", status: "rejected" });
    expect(cache.list()[0]).toMatchObject({ label: "5h", usedPercent: 100 });
    // the shape the CLI actually sends: unifiedWindows, no top-level utilization
    const real = new RateLimitCache(() => 1);
    real.record({ status: "allowed", resetsAt: 1789974000, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.13, resetsAt: 1789974000 }, seven_day: { utilization: 0.12, resetsAt: 1790485200 } } });
    expect(real.list()).toEqual([{ label: "5h", usedPercent: 13, resetsAt: 1789974000 }, { label: "7d", usedPercent: 12, resetsAt: 1790485200 }]);
    real.record({ status: "allowed" });   // nothing usable: no change
    expect(real.list()).toHaveLength(2);
  });
});

describe("a quota child that hangs", () => {
  it.each(["codex", "claude"] as const)("stops a hung %s quota child without calling a model", async (harness) => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-quota-child-"));
    const executable = join(dir, "fake-agent.cjs"), pidFile = join(dir, "pid");
    // A real local process that never emits a protocol response. It cannot reach a model or the network.
    // The pid is renamed into place so a reader never sees a half-written file (an empty pid would mean process group 0).
    writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid));\nfs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const readPid = () => existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) || 0 : 0;
    // Stopped once the child is known to be running, never on a race with its start-up.
    const stop = new AbortController();
    const reading = harness === "codex" ? codexQuota({ binary: executable }).read(true, stop.signal).then((r) => r.error, (e: Error) => e.message)
      : probeRateLimits(undefined, executable, stop.signal).then(() => null, (e: Error) => e.message || "stopped");
    try {
      const pid = await vi.waitFor(() => { const pid = readPid(); expect(pid).toBeGreaterThan(0); return pid; }, { timeout: 15_000, interval: 10 });
      stop.abort(new Error("quota timed out"));
      expect(await reading).toBeTruthy();
      // Codex kills at once; the Claude SDK sends SIGTERM after its own close grace. The bound only limits a failure.
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 20_000, interval: 20 });
    } finally {
      const pid = readPid();
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);
});
