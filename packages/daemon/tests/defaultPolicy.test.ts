import { describe, expect, it } from "vitest";
import { classify, defaultTarget } from "../src/router/defaultPolicy.js";
import { realTargets } from "./helpers.js";

const t = realTargets();

describe("default policy", () => {
  it("classifies coarse capability from the task text", () => {
    expect(classify("打开 http://core.internal.example:8400 并登录")).toBe("browser");
    expect(classify("把 secret_gate/cli.py 里的 keys 子命令加个 --json")).toBe("code");
    expect(classify("Fix the failing test in resolver.ts")).toBe("code");
    expect(classify("把这段话翻译成英文")).toBe("chat");
  });

  it("browser goes to the browser-capable harness with the most quota, chat to the router default", () => {
    expect(defaultTarget("打开网页登录", t, {})).toEqual({ harness: "claude-code", model: "claude-sonnet-5" });
    expect(defaultTarget("打开网页登录", t, { "claude-code": 0 })).toEqual({ harness: "codex", model: "gpt-6-astra" });
    expect(defaultTarget("总结一下这篇文章", t, {})).toEqual({ harness: "opencode", model: "deepseek/deepseek-flash" });
  });

  it("code goes to whichever code harness has more quota left", () => {
    expect(defaultTarget("修一下这个 bug", t, { "claude-code": 0.9, codex: 0.2 })).toEqual({ harness: "claude-code", model: "claude-sonnet-5" });
    expect(defaultTarget("修一下这个 bug", t, { "claude-code": 0.1, codex: 0.8 })).toEqual({ harness: "codex", model: "gpt-6-astra" });
    expect(defaultTarget("修一下这个 bug", t, {})).toEqual({ harness: "claude-code", model: "claude-sonnet-5" });
  });
});
