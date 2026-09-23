import { describe, expect, it } from "vitest";
import { catalogText, markUnavailable, modelKey, modelSpec, parseTargets } from "../src/router/targets.js";
import { realTargets } from "./helpers.js";

describe("targets.yaml", () => {
  const t = realTargets();

  it("lists the three harnesses with every selectable model", () => {
    expect(Object.keys(t.harnesses)).toEqual(["claude-code", "codex", "opencode"]);
    expect(Object.keys(t.harnesses["claude-code"]!.models)).toHaveLength(15);
    expect(Object.keys(t.harnesses["claude-code"]!.models).filter((m) => m.endsWith("[1m]"))).toHaveLength(7);
    expect(Object.keys(t.harnesses.codex!.models)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
    expect(Object.keys(t.harnesses.opencode!.models)).toEqual(["deepseek/deepseek-flash"]);
  });

  it("default models and the router default are listed", () => {
    for (const h of Object.values(t.harnesses)) expect(modelKey(h, h.default_model)).toBeDefined();
    expect(t.router.default).toEqual({ harness: "opencode", model: "deepseek/deepseek-flash" });
    expect(t.router.timeout_ms).toBe(45_000);
    expect(t.router.planner_timeout_ms).toBe(120_000);
  });

  it("accepts an independent planner deadline and rejects nonpositive values", () => {
    const catalog = (timeout: number) => `
harnesses:
  x: {quota: balance, max_concurrent: 1, browser: false, default_model: a, models: {a: {cost: low}}}
router: {harness: x, model: a, timeout_ms: 1000, planner_timeout_ms: ${timeout}, default: {harness: x, model: a}}`;
    expect(parseTargets(catalog(240_000)).router).toMatchObject({ timeout_ms: 1000, planner_timeout_ms: 240_000 });
    expect(() => parseTargets(catalog(0))).toThrow();
  });

  it("rejects a catalog whose default model is not listed", () => {
    expect(() =>
      parseTargets(`
harnesses:
  x: {quota: balance, max_concurrent: 1, browser: false, default_model: nope, models: {a: {cost: low}}}
router: {harness: x, model: a, default: {harness: x, model: a}}`),
    ).toThrow(/default_model nope/);
  });

  it("wildcard keys admit prefixed models", () => {
    const t2 = parseTargets(`
harnesses:
  oc: {quota: balance, max_concurrent: 1, browser: false, default_model: d/m, models: {d/m: {cost: low}, "openrouter/*": {cost: mid}}}
router: {harness: oc, model: d/m, default: {harness: oc, model: d/m}}`);
    const h = t2.harnesses.oc!;
    expect(modelKey(h, "openrouter/anthropic/claude")).toBe("openrouter/*");
    expect(modelKey(h, "openrouter/")).toBeUndefined();
    expect(modelKey(h, "other/x")).toBeUndefined();
    expect(modelSpec(h, "d/m")?.cost).toBe("low");
  });

  it("markUnavailable returns a new catalog and hides the model from the prompt", () => {
    const t2 = markUnavailable(t, [{ harness: "codex", model: "gpt-5.5" }]);
    expect(t2.harnesses.codex!.models["gpt-5.5"]!.unavailable).toBe(true);
    expect(t.harnesses.codex!.models["gpt-5.5"]!.unavailable).toBeUndefined();
    expect(catalogText(t2)).not.toContain("gpt-5.5:");
    expect(catalogText(t)).toContain("gpt-5.5: cost mid");
    expect(catalogText(t)).toContain("efforts: low/medium/high/xhigh/max/ultra");
  });
});
