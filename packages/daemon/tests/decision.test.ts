import { describe, expect, it } from "vitest";
import { extractJsonObject, parseDecision } from "../src/router/decision.js";
import { decisionJson } from "./helpers.js";

describe("parseDecision", () => {
  it("accepts a bare object and fills defaults", () => {
    const r = parseDecision(decisionJson());
    expect(r.ok && r.decision.needs_browser).toBe(false);
    expect(r.ok && r.decision.fallbacks).toEqual([]);
    expect(r.ok && r.decision.expected_size).toBe("medium");
  });

  it("finds the object inside prose and code fences, ignoring braces in strings", () => {
    const text = 'Sure! ```json\n' + decisionJson({ brief: 'fix {a} and "b"' }) + "\n``` done {";
    const r = parseDecision(text);
    expect(r.ok && r.decision.brief).toBe('fix {a} and "b"');
    expect(extractJsonObject("no json here")).toBeUndefined();
    expect(extractJsonObject("{ unbalanced")).toBeUndefined();
  });

  it("reports schema and syntax errors", () => {
    expect(parseDecision("{ not json }")).toMatchObject({ ok: false, error: expect.stringContaining("invalid JSON") });
    expect(parseDecision(JSON.stringify({ harness: "codex" }))).toMatchObject({ ok: false, error: expect.stringContaining("brief") });
    expect(parseDecision(decisionJson({ confidence: 1.5 }))).toMatchObject({ ok: false, error: expect.stringContaining("confidence") });
    expect(parseDecision("nothing")).toMatchObject({ ok: false, error: "no JSON object in reply" });
  });

  it.each([
    { action: "give_up", reason: "The requested operation needs clarification." },
    { action: "give_up", reason: "The requested operation needs clarification.", harness: 17, brief: null, confidence: 4 },
  ])("accepts a stop independently of dispatch fields: %j", (value) => {
    expect(parseDecision(JSON.stringify(value))).toMatchObject({ ok: true, decision: { action: "give_up", reason: value.reason } });
  });

  it("retains other non-dispatch actions without inventing an executable target", () => {
    expect(parseDecision(JSON.stringify({ action: "clarify", question: "Which local file should be inspected?" })))
      .toMatchObject({ ok: true, decision: { action: "clarify", question: "Which local file should be inspected?" } });
    expect(parseDecision(JSON.stringify({ action: "clarify", question: 42 })))
      .toMatchObject({ ok: true, decision: { action: "clarify", question: null } });
    expect(parseDecision(JSON.stringify({ action: "repair", repair: { tool: "restart_proxy", args: {} } })))
      .toMatchObject({ ok: true, decision: { action: "repair", repair: { tool: "restart_proxy", args: {} } } });
  });
});
