import { describe, expect, it } from "vitest";
import { route } from "../src/router/route.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();
const deps = (router: ReturnType<typeof echoRouter>, over: Partial<Parameters<typeof route>[1]> = {}) => ({ targets, router, quota: {}, running: {}, ...over });
const req = { task: "在 packages/daemon 里加一个 router 模块并写测试", cwd: "/tmp/x" };

describe("route()", () => {
  it("happy path: router decision validated and executed as-is", async () => {
    const r = echoRouter([decisionJson()]);
    const out = await route(req, deps(r));
    expect(out.source).toBe("router");
    expect(out.verdict).toMatchObject({ ok: true, harness: "codex", model: "gpt-6-astra", chosen: "router" });
    expect(out.attempts).toBe(1);
    expect(r.calls[0]!.system).toContain("gpt-6-astra: cost top");
    expect(r.calls[0]!.task).toContain("Working directory: /tmp/x");
  });

  it("invalid JSON is retried once with the error, then falls back to the default policy", async () => {
    const r = echoRouter(["nonsense", "{\"harness\": 1}"]);
    const out = await route(req, deps(r));
    expect(out.attempts).toBe(2);
    expect(r.calls[1]!.previousError).toMatch(/^no JSON object in reply; reply began: /);
    expect(r.calls[1]!.task).toContain("previous reply was rejected");
    expect(out.source).toBe("default");
    expect(out.verdict).toMatchObject({ ok: true, harness: "claude-code", model: "claude-sonnet-5", chosen: "pin" });
    expect(out.routerError).toContain("brief");
  });

  it("a bad first reply then a good one succeeds", async () => {
    const r = echoRouter(["oops", decisionJson({ harness: "claude-code", model: "claude-opus-5", effort: null })]);
    const out = await route(req, deps(r));
    expect(out.source).toBe("router");
    expect(out.verdict).toMatchObject({ ok: true, model: "claude-opus-5" });
  });

  it("timeout does not retry and uses the default policy", async () => {
    const slow = echoRouter([decisionJson()], { delayMs: 5_000 });
    const fast = { ...targets, router: { ...targets.router, timeout_ms: 30 } };
    const out = await route(req, deps(slow, { targets: fast }));
    expect(out.routerError).toMatch(/timed out/);
    expect(out.attempts).toBe(1);
    expect(out.source).toBe("default");
    expect(out.verdict.ok).toBe(true);
  });

  it("router decision that fails the floor is reported as default-sourced", async () => {
    const r = echoRouter([decisionJson({ harness: "gemini", fallbacks: [] })]);
    const out = await route(req, deps(r));
    expect(out.source).toBe("default");
    expect(out.verdict).toMatchObject({ ok: true, harness: "opencode", chosen: "default" });
    expect(out.decision?.harness).toBe("gemini");
  });

  it("pin skips the router entirely", async () => {
    const r = echoRouter([decisionJson()]);
    const out = await route({ ...req, pin: { harness: "claude-code", model: "claude-fable-5-1" } }, deps(r));
    expect(r.calls).toHaveLength(0);
    expect(out).toMatchObject({ source: "pin", attempts: 0, verdict: { ok: true, chosen: "pin", model: "claude-fable-5-1" } });
    const bad = await route({ ...req, pin: { harness: "codex", model: "gpt-9" } }, deps(r));
    expect(bad.verdict.ok).toBe(false);
  });

  it("router exception (not timeout) is retried, then default", async () => {
    const boom = { name: "boom", calls: [] as never[], route: async () => { throw new Error("spawn failed"); } };
    const out = await route(req, deps(boom as never));
    expect(out.attempts).toBe(2);
    expect(out.routerError).toBe("spawn failed");
    expect(out.source).toBe("default");
  });
});
