import { describe, expect, it } from "vitest";
import { routerConfig, textFromEvents } from "../src/router/routers/opencode.js";

describe("opencode router helpers", () => {
  it("joins text parts of the JSON event stream and ignores the rest", () => {
    const stdout = [
      JSON.stringify({ type: "step_start", part: {} }),
      "not json",
      JSON.stringify({ type: "tool_use", part: { tool: "read" } }),
      JSON.stringify({ type: "text", part: { text: '{"harness": ' } }),
      JSON.stringify({ type: "text", part: { text: '"codex"}' } }),
      "",
    ].join("\n");
    expect(textFromEvents(stdout)).toBe('{"harness": "codex"}');
  });

  it("router agent has no write, shell or network tools and cannot read key material", () => {
    const cfg = routerConfig("SYS", "deepseek/deepseek-flash", "/h/.secret-gate") as {
      agent: Record<string, { tools: Record<string, boolean>; prompt: string; model: string }>;
      permission: { read: Record<string, string>; bash: string; edit: string; webfetch: string };
    };
    const agent = cfg.agent.router!;
    expect(agent.model).toBe("deepseek/deepseek-flash");
    expect(agent.prompt).toBe("SYS");
    for (const tool of ["bash", "edit", "write", "patch", "webfetch", "websearch"]) expect(agent.tools[tool]).toBe(false);
    expect(cfg.permission.bash).toBe("deny");
    expect(cfg.permission.edit).toBe("deny");
    expect(cfg.permission.webfetch).toBe("deny");
    expect(cfg.permission.read["/h/.secret-gate/*"]).toBe("deny");
    expect(cfg.permission.read["**/.env"]).toBe("deny");
  });
});
