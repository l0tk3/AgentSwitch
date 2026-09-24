import { describe, expect, it } from "vitest";
import { askJson, type Parse } from "../src/router/ask.js";
import { echoRouter } from "../src/router/routers/echo.js";
import type { Router } from "../src/core/modelCall.js";

const parse: Parse<{ ok: true }> = (text) => (text === "{}" ? { ok: true, value: { ok: true } } : { ok: false, error: "not {}" });
const req = { system: "s", cwd: "/tmp", body: () => "task" };

/** A router whose every call rejects with the given text, without any signal being aborted. */
function failing(message: string): { readonly router: Router; readonly calls: () => number } {
  let calls = 0;
  return { router: { name: "failing", async route() { calls++; throw new Error(message); } }, calls: () => calls };
}

describe("askJson failure kinds", () => {
  it("its own deadline is a timeout and ends the ask without a retry", async () => {
    const r = await askJson(echoRouter(["{}"], { delayMs: 5_000 }), req, parse, 20);
    expect(r).toMatchObject({ value: null, tries: 1, failureKind: "timeout", error: "router timed out" });
  });

  it("the caller's abort is a cancellation and ends the ask without a retry", async () => {
    const outer = new AbortController();
    const asked = askJson(echoRouter(["{}"], { delayMs: 5_000 }), req, parse, 5_000, outer.signal);
    setTimeout(() => outer.abort(new Error("stop")), 10);
    expect(await asked).toMatchObject({ value: null, tries: 1, failureKind: "cancelled" });
  });

  it.each(["upstream timed out", "turn cancelled"])("a router error that only says %j is a service error and gets the retry", async (message) => {
    const f = failing(message);
    const r = await askJson(f.router, req, parse, 5_000);
    expect(f.calls()).toBe(2);
    expect(r).toMatchObject({ value: null, tries: 2, failureKind: "service_error", error: message });
  });
});
