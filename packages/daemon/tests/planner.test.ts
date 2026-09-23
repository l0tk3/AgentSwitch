/** loop-v0 §6: the planner factory honours the router's pick, falls back to targets.yaml, and skips harnesses out of quota. */
import { describe, expect, it } from "vitest";
import { plannerFor } from "../src/daemon.js";
import { realTargets } from "./helpers.js";

const targets = realTargets();

describe("plannerFor", () => {
  it("a listed pick with quota wins; an unlisted or exhausted pick falls back to the yaml planner; nothing usable → null", () => {
    const withDefault = { ...targets, router: { ...targets.router, planner: { harness: "claude-code", model: "claude-sonnet-5" } } };
    const f = plannerFor(withDefault, undefined, () => ({}));
    expect(f({ harness: "claude-code", model: "claude-opus-5" })).toMatchObject({ target: { harness: "claude-code", model: "claude-opus-5" }, router: { name: "claude:claude-opus-5" } });
    expect(f({ harness: "codex", model: "gpt-5.5" })).toMatchObject({ target: { harness: "codex", model: "gpt-5.5" }, router: { name: "codex:gpt-5.5" } });
    expect(f({ harness: "nope", model: "x" })).toMatchObject({ target: { harness: "claude-code", model: "claude-sonnet-5" } });
    expect(f({ harness: "claude-code", model: "not-listed" })).toMatchObject({ target: { harness: "claude-code", model: "claude-sonnet-5" } });
    expect(f(null)).toMatchObject({ target: { harness: "claude-code", model: "claude-sonnet-5" } });
    const dry = plannerFor(withDefault, undefined, () => ({ "claude-code": 0 }));
    expect(dry({ harness: "claude-code", model: "claude-opus-5" })).toBeNull();
    expect(dry({ harness: "codex", model: "gpt-5.5" })).toMatchObject({ target: { harness: "codex" } });
    const none = plannerFor({ ...targets, router: { ...targets.router, planner: null } }, undefined, () => ({}));
    expect(none(null)).toBeNull();
    expect(none({ harness: "opencode", model: "deepseek/deepseek-flash" })).toBeNull();   // opencode needs the resident server
  });
});
