import { describe, expect, it } from "vitest";
import { Decision } from "../src/router/decision.js";
import { NO_SIDE_EFFECTS } from "../src/router/failure.js";
import { reroute } from "../src/router/route.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();
const first = Decision.parse({ harness: "claude-code", model: "claude-sonnet-5", brief: "log in", confidence: 0.9, needs_browser: true });
const refused = { harness: "claude-code", model: "claude-sonnet-5", kind: "refusal" as const, excerpt: "I can't help with automating logins", sideEffects: NO_SIDE_EFFECTS };
const base = { task: "打开站点登录，密码 enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", cwd: "/tmp/x", decision: first, attempts: [refused], routerAsks: 0 };

describe("reroute()", () => {
  it("refusal: router gets the history, picks another harness, floor validates with the refused one excluded", async () => {
    const r = echoRouter([decisionJson({ harness: "codex", model: "gpt-6-astra", effort: "high", needs_browser: true, handoff_note: "user's own account" })]);
    const out = await reroute(base, { targets, router: r, quota: {}, running: {} });
    expect(out.step).toMatchObject({ kind: "redispatch", source: "router", verdict: { ok: true, harness: "codex", model: "gpt-6-astra" } });
    expect(out.decision?.handoff_note).toBe("user's own account");
    const msg = r.calls[0]!.task;
    expect(msg).toContain("Previous attempts:");
    expect(msg).toContain("claude-code/claude-sonnet-5 -> refusal");
    expect(msg).toContain("Excluded (do not choose): claude-code/claude-sonnet-5");
    expect(r.calls[0]!.system).not.toContain("claude-sonnet-5:");   // excluded model hidden from the catalog
  });

  it("router picks the excluded target again: floor rejects it and falls to a default that avoids the tried harness", async () => {
    const r = echoRouter([decisionJson({ harness: "claude-code", model: "claude-sonnet-5", effort: null, needs_browser: true, fallbacks: [] })]);
    const out = await reroute(base, { targets, router: r, quota: {}, running: {} });
    expect(out.step.kind).toBe("redispatch");
    if (out.step.kind === "redispatch") {
      expect(out.step.source).toBe("default");
      expect(out.step.verdict).toMatchObject({ ok: true, harness: "codex", model: "gpt-6-astra", chosen: "pin" });
      expect(out.step.verdict.notes[0]).toContain("unavailable");
    }
  });

  it("router gives up: surfaced with its reason", async () => {
    const r = echoRouter([decisionJson({ harness: "codex", action: "give_up", reason: "no listed model may automate this site" })]);
    const out = await reroute(base, { targets, router: r, quota: {}, running: {} });
    expect(out.step).toEqual({ kind: "give_up", reason: "no listed model may automate this site" });
  });

  it("router unusable: default policy excluding the tried harness", async () => {
    const r = echoRouter(["garbage", "garbage"]);
    const out = await reroute(base, { targets, router: r, quota: {}, running: {} });
    expect(out.step).toMatchObject({ kind: "redispatch", source: "default", verdict: { ok: true, harness: "codex" } });
    expect(out.routerError).toBe("no JSON object in reply");
  });

  it("quota, first transport failure and gate denial never reach the router", async () => {
    const r = echoRouter([decisionJson()]);
    const quota = await reroute({ ...base, attempts: [{ ...refused, kind: "quota" }] }, { targets, router: r, quota: {}, running: {} });
    expect(quota.step).toMatchObject({ kind: "switch", target: { harness: "codex", model: "gpt-6-astra" } });  // browser task: opencode cannot
    const chat = await reroute({ ...base, task: "总结一下", decision: { ...first, needs_browser: false }, attempts: [{ ...refused, kind: "quota" }] }, { targets, router: r, quota: {}, running: {} });
    expect(chat.step).toMatchObject({ kind: "switch", target: { harness: "opencode" } });
    const transport = await reroute({ ...base, attempts: [{ ...refused, kind: "transport" }] }, { targets, router: r, quota: {}, running: {} });
    expect(transport.step).toMatchObject({ kind: "retry" });
    const denied = await reroute({ ...base, attempts: [{ ...refused, kind: "gate_denied" }] }, { targets, router: r, quota: {}, running: {} });
    expect(denied.step).toMatchObject({ kind: "stop", security: true });
    expect(r.calls).toHaveLength(0);
  });

  it("repeated transport failure: router is asked, sees the repair tools, and may request one", async () => {
    const proxyDown = { ...refused, kind: "transport" as const, excerpt: "connect ECONNREFUSED 127.0.0.1:8080" };
    const repairs = [{ name: "restart_gate_proxy", description: "restart the secret-gate proxy on :8080" }];
    const r = echoRouter([decisionJson({ action: "repair", repair: { tool: "restart_gate_proxy", args: { port: 8080 } }, reason: "proxy is down" })]);
    const out = await reroute({ ...base, attempts: [proxyDown, proxyDown] }, { targets, router: r, quota: {}, running: {}, repairs });
    expect(out.step).toEqual({ kind: "repair", tool: "restart_gate_proxy", args: { port: 8080 } });
    expect(r.calls[0]!.task).toContain("- restart_gate_proxy: restart the secret-gate proxy");
    expect(r.calls[0]!.task).toContain("transport (proxy, TLS, network");
  });

  it("repair requested for an unregistered tool degrades to a plain re-dispatch", async () => {
    const proxyDown = { ...refused, kind: "transport" as const, excerpt: "ETIMEDOUT" };
    const r = echoRouter([decisionJson({ harness: "codex", model: "gpt-6-astra", effort: "high", needs_browser: true, action: "repair", repair: { tool: "reboot_mac", args: {} } })]);
    const out = await reroute({ ...base, attempts: [proxyDown, proxyDown] }, { targets, router: r, quota: {}, running: {} });
    expect(out.step).toMatchObject({ kind: "redispatch", source: "router", verdict: { ok: true, harness: "codex" } });
    expect(r.calls[0]!.task).toContain("(none registered; action=repair is not available)");
  });
});
