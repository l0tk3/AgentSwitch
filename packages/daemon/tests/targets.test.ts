import { describe, expect, it } from "vitest";
import { catalogText, markUnavailable, modelKey, modelSpec, parseTargets } from "../src/router/targets.js";
import { realTargets } from "./helpers.js";

describe("targets.yaml", () => {
  const t = realTargets();

  it("lists the three harnesses with every selectable model", () => {
    expect(Object.keys(t.harnesses)).toEqual(["claude-code", "codex", "opencode"]);
    expect(Object.keys(t.harnesses["claude-code"]!.models)).toHaveLength(15);
    expect(Object.keys(t.harnesses["claude-code"]!.models).filter((m) => m.endsWith("[1m]"))).toHaveLength(7);
    expect(t.harnesses["claude-code"]!.models).toHaveProperty(["claude-opus-5-5"]);
    expect(t.harnesses["claude-code"]!.models).toHaveProperty(["claude-opus-5-5[1m]"]);
    expect(Object.keys(t.harnesses.codex!.models)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
    expect(Object.keys(t.harnesses.opencode!.models)).toEqual(["deepseek/deepseek-flash"]);
  });

  it("Sonnet 5 is excluded (2026-09-24, user's call): not listed, not admitted, Sonnet 4.6 takes its place", () => {
    const claude = t.harnesses["claude-code"]!;
    expect(claude.exclude).toEqual(["claude-sonnet-5", "claude-sonnet-5[1m]"]);
    expect(modelKey(claude, "claude-sonnet-5")).toBeUndefined();
    expect(modelKey(claude, "claude-sonnet-5[1m]")).toBeUndefined();
    expect(claude.default_model).toBe("claude-sonnet-4-6");
    expect(claude.models["claude-sonnet-4-6"]!.strengths).toContain("browser");
  });

  it("Opus and GPT-6 are the preferred models (2026-09-24, user's call) and the fallback planner is Opus 5.5", () => {
    const preferred = Object.entries(t.harnesses).flatMap(([h, spec]) => Object.entries(spec.models).filter(([, m]) => m.preferred).map(([id]) => `${h}/${id}`));
    expect(preferred).toEqual(["claude-code/claude-opus-5-5", "claude-code/claude-opus-5-5[1m]", "claude-code/claude-opus-5", "claude-code/claude-opus-5[1m]",
      "codex/gpt-6-astra", "codex/gpt-6-sol", "codex/gpt-6-luna"]);
    expect(catalogText(t)).toContain("claude-opus-5-5: cost high; complex-code, refactor, review; preferred");
    expect(catalogText(t)).toMatch(/gpt-5\.5: cost mid; code, shell; efforts: [^\n]*$/m);   // no marker on the others
    expect(t.router.planner).toEqual({ harness: "claude-code", model: "claude-opus-5-5" });
  });

  it("an excluded id is refused even through a wildcard, and cannot also be listed", () => {
    const catalog = (models: string, exclude: string) => `
harnesses:
  x: {quota: balance, max_concurrent: 1, browser: false, default_model: a, exclude: [${exclude}], models: {${models}}}
router: {harness: x, model: a, default: {harness: x, model: a}}`;
    const t2 = parseTargets(catalog(`a: {cost: low}, "p/*": {cost: low}`, `"p/bad"`));
    expect(modelKey(t2.harnesses.x!, "p/good")).toBe("p/*");
    expect(modelKey(t2.harnesses.x!, "p/bad")).toBeUndefined();
    expect(() => parseTargets(catalog(`a: {cost: low}, b: {cost: low}`, "b"))).toThrow(/x: b is both listed and excluded/);
    expect(() => parseTargets(catalog(`a: {cost: low}`, "a"))).toThrow(/default_model a not in models/);
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
