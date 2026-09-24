/** The executor lifecycle helpers: the deadline + abort watch, the interrupted outcome, and owned process groups. */
import { execFileSync } from "node:child_process";
import { getEventListeners, once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interruptedOutcome, watchRunStop, type StopCause } from "../src/executors/lifecycle.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS } from "../src/core/limits.js";
import { spawnOwned, terminateProcess } from "../src/harness/processes.js";

afterEach(() => { vi.useRealTimers(); });

describe("watchRunStop", () => {
  it("stops at once for an already aborted signal", () => {
    const ctl = new AbortController(); ctl.abort();
    const causes: StopCause[] = [];
    const stop = watchRunStop(ctl.signal, null, (cause) => causes.push(cause));
    expect(causes).toEqual(["abort"]);
    expect(stop.timedOut).toBe(false);
    stop.dispose();
    expect(getEventListeners(ctl.signal, "abort")).toHaveLength(0);
  });

  it("stops once when the engine aborts, and not after dispose", () => {
    const ctl = new AbortController();
    const causes: StopCause[] = [];
    const stop = watchRunStop(ctl.signal, null, (cause) => causes.push(cause));
    expect(causes).toEqual([]);
    ctl.abort(); ctl.abort();
    expect(causes).toEqual(["abort"]);
    stop.dispose();
    expect(getEventListeners(ctl.signal, "abort")).toHaveLength(0);
  });

  it("marks the run timed out before stopping it at the deadline", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const seen: [StopCause, boolean][] = [];
    const stop = watchRunStop(new AbortController().signal, 50, (cause) => seen.push([cause, stop.timedOut]));
    vi.advanceTimersByTime(49);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([["timeout", true]]);
    expect(stop.timedOut).toBe(true);
    stop.dispose();
    expect(stop.timedOut).toBe(true);   // still readable once the run has settled
  });

  it("each cause stops the run independently: an abort does not cancel the deadline", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ctl = new AbortController();
    const causes: StopCause[] = [];
    const stop = watchRunStop(ctl.signal, 50, (cause) => causes.push(cause));
    ctl.abort();
    vi.advanceTimersByTime(50);
    expect(causes).toEqual(["abort", "timeout"]);
    stop.dispose();
  });

  it("dispose clears the deadline and the listener", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ctl = new AbortController();
    const causes: StopCause[] = [];
    const stop = watchRunStop(ctl.signal, 50, (cause) => causes.push(cause));
    expect(vi.getTimerCount()).toBe(1);
    stop.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100); ctl.abort();
    expect(causes).toEqual([]);
    expect(stop.timedOut).toBe(false);
  });

  it("null means no deadline", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = watchRunStop(new AbortController().signal, null, () => undefined);
    expect(vi.getTimerCount()).toBe(0);
    stop.dispose();
  });

  it("the shared default deadline is 30 minutes", () => {
    expect(DEFAULT_EXECUTOR_TIMEOUT_MS).toBe(30 * 60_000);
  });
});

describe("interruptedOutcome", () => {
  it("is never a success and never claims known effects; the adapter's fields are kept", () => {
    const base = { ok: true, exitCode: 0, lastText: "partial", sideEffects: { filesChanged: 1, commandsRun: 2, approvalsGranted: 0 }, sideEffectsKnown: true, tokens: 5, sessionId: "s" };
    expect(interruptedOutcome(base, { exitCode: null, stderr: "cancelled", timedOut: false })).toEqual({ ...base, ok: false, exitCode: null, stderr: "cancelled", timedOut: false, sideEffectsKnown: false });
    expect(interruptedOutcome(base)).toEqual({ ...base, ok: false, sideEffectsKnown: false });
    expect(interruptedOutcome(base, { ok: true, sideEffectsKnown: true })).toMatchObject({ ok: false, sideEffectsKnown: false });
  });
});

describe("spawnOwned", () => {
  it.skipIf(process.platform === "win32")("starts the harness as the leader of its own process group", async () => {
    const child = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      expect(child.pid).toBeGreaterThan(0);
      const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child.pid)], { encoding: "utf8" }).trim());
      expect(pgid).toBe(child.pid);
      const closed = once(child, "close");
      await terminateProcess(child, 25);
      await closed;
    } finally { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } }
  }, 5000);
});
