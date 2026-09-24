import { describe, expect, it } from "vitest";
import { inferCost, mergeDiscovered } from "../src/router/discovery.js";
import { realTargets } from "./helpers.js";

describe("model discovery", () => {
  it("infers a cost tier from the name", () => {
    expect(inferCost("claude-fable-6")).toBe("top");
    expect(inferCost("gpt-6-astra")).toBe("top");
    expect(inferCost("claude-opus-5-1")).toBe("high");
    expect(inferCost("claude-haiku-5")).toBe("low");
    expect(inferCost("gpt-5.7")).toBe("mid");
  });

  it("merges new ids under their harness, keeps every yaml entry, ignores unknown harnesses", () => {
    const t = realTargets();
    const before = Object.keys(t.harnesses["claude-code"]!.models).length;
    const { targets, added } = mergeDiscovered(t, { "claude-code": ["claude-sonnet-4-6", "claude-sonnet-6"], codex: ["gpt-5.5", "gpt-7"] });
    expect(added).toEqual(["claude-code/claude-sonnet-6", "codex/gpt-7"]);
    expect(Object.keys(targets.harnesses["claude-code"]!.models)).toHaveLength(before + 1);
    expect(targets.harnesses["claude-code"]!.models["claude-sonnet-6"]).toEqual({ cost: "mid", strengths: ["discovered"] });
    expect(targets.harnesses.codex!.models["gpt-7"]).toMatchObject({ cost: "mid", efforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(targets.harnesses.codex!.models["gpt-5.5"]).toEqual(t.harnesses.codex!.models["gpt-5.5"]);   // untouched
    expect(t.harnesses.codex!.models["gpt-7"]).toBeUndefined();                                          // input not mutated
  });

  it("never adds a model the catalog excludes, however the CLI lists it", () => {
    const { targets, added } = mergeDiscovered(realTargets(), { "claude-code": ["claude-sonnet-5", "claude-sonnet-5[1m]", "claude-sonnet-6"], codex: [] });
    expect(added).toEqual(["claude-code/claude-sonnet-6"]);
    expect(targets.harnesses["claude-code"]!.models).not.toHaveProperty(["claude-sonnet-5"]);
    expect(targets.harnesses["claude-code"]!.models).not.toHaveProperty(["claude-sonnet-5[1m]"]);
  });
});
