/** The catalog as a terminal's model menu lists it (models/targets.ts), and the remote listener's settings from the
 *  environment. */

import { describe, expect, it } from "vitest";
import { defaultConfig, remotePort } from "../src/daemon.js";
import { parseTargets, selectableModels } from "../src/models/targets.js";
import { realTargets } from "./helpers.js";

describe("the catalog's models", () => {
  it("an agent's selectable models: concrete ids in the catalog's order, none unavailable; none for an agent it does not list", () => {
    const real = realTargets();
    const codex = (unavailable: boolean) => ({ ...real, harnesses: { ...real.harnesses, codex: { ...real.harnesses.codex!, models: { ...real.harnesses.codex!.models, "gpt-x": { cost: "mid" as const, strengths: [], unavailable } } } } });
    expect(selectableModels(codex(false), "codex")).toContain("gpt-x");
    const t = codex(true);
    expect(selectableModels(t, "codex")).not.toContain("gpt-x");
    expect(selectableModels(t, "claude-code")).toContain("claude-opus-5[1m]");
    expect(selectableModels(t, "opencode").some((id) => id.endsWith("/*"))).toBe(false);
    expect(selectableModels(t, "pi")).toEqual([]);
  });

  it("targets.yaml: router.model must be a listed model of router.harness", () => {
    const yaml = (model: string) => `harnesses:\n  opencode:\n    quota: balance\n    max_concurrent: 1\n    browser: false\n    default_model: a/x\n    models:\n      a/x: {cost: low}\n      a/y: {cost: low}\nrouter:\n  harness: opencode\n  model: ${model}\n`;
    expect(parseTargets(yaml("a/y")).router.model).toBe("a/y");
    expect(() => parseTargets(yaml("a/z"))).toThrow(/router\.model must be a listed model of router\.harness/);
  });
});

describe("remote configuration from the environment", () => {
  it("AGENTSWITCH_REMOTE=1 turns it on with port 4713 unless AGENTSWITCH_REMOTE_PORT says otherwise", () => {
    expect(defaultConfig({ HOME: "/h" }).remote).toBeUndefined();
    expect(defaultConfig({ HOME: "/h", AGENTSWITCH_REMOTE: "0" }).remote).toBeUndefined();
    expect(defaultConfig({ HOME: "/h", AGENTSWITCH_REMOTE: "1" }).remote).toEqual({ port: 4713 });
    expect(defaultConfig({ HOME: "/h", AGENTSWITCH_REMOTE: "true", AGENTSWITCH_REMOTE_PORT: "5713", AGENTSWITCH_REMOTE_NAME: " Studio " }).remote).toEqual({ port: 5713, name: "Studio" });
    for (const bad of ["", "abc", "70000", "-1", "1.5"]) expect(remotePort(bad), bad).toBe(4713);
    expect(remotePort(undefined)).toBe(4713);
    expect(remotePort("0")).toBe(0);
  });
});
