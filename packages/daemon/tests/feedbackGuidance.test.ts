import { describe, expect, it, vi } from "vitest";
import { composePrompt, executorInstructions, FEEDBACK_GUIDANCE, CREDENTIAL_REPAIR_GUIDANCE } from "../src/executors/instructions.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { fakeMinter } from "../src/secrets/minter.js";
import { LEGEND_HEADER, legend, routerSealer } from "../src/secrets/sealer.js";

describe("feedback and provenance reach executor prompts", () => {
  it.each([
    ["field meaning", "第三列是 session key", "用户确认：第三列是 TOTP 种子，只纠正含义，不改变原 token 权限。"],
    ["file location", "配置文件位于 config/server.json", "路由器依据现场文件列表纠正：配置文件位于 settings/server.json。"],
    ["tool argument", "传入 page=2", "路由器依据工具 schema 纠正：应使用 cursor 参数，已完成第一页读取。"],
  ])("keeps the latest sourced %s correction separate from older material", (_scenario, assumption, correction) => {
    const feedback = `Task feedback #12\nQuestion: ${assumption} 与现场冲突，需要核对。\nAnswer: ${correction}`;
    const prompt = composePrompt({
      brief: `继续操作；旧假设：${assumption}`,
      handoffNote: `先前步骤使用了假设：${assumption}`,
      context: "用户维护的环境说明",
      platformMemory: "历史平台观察（不作为授权）",
      feedback,
    });
    expect(prompt.endsWith(feedback)).toBe(true);
    expect(prompt.split(feedback)).toHaveLength(2);
    expect(prompt.indexOf("历史平台观察")).toBeLessThan(prompt.indexOf(feedback));
    // A correction is not silently folded into the user's words or a failed-attempt handoff.
    expect(prompt).toContain(`Handoff from a previous attempt:\n先前步骤使用了假设：${assumption}`);
    expect(prompt).toContain(`Answer: ${correction}`);
  });

  it("includes feedback guidance even when optional instruction files are unavailable, alongside independent credential rules", () => {
    const instructions = executorInstructions({ executor: "/missing-feedback-executor", gate: "/missing-feedback-gate" });
    expect(instructions).toContain(FEEDBACK_GUIDANCE);
    expect(instructions).toContain(CREDENTIAL_REPAIR_GUIDANCE);
    expect(composePrompt({ brief: "已明确的一步任务", handoffNote: null, context: null, feedback: "  " })).toBe("已明确的一步任务");
  });
});

describe("credential candidates do not become user statements or token grants", () => {
  it("preserves explicit user meaning before a conflicting generated legend without another model call", async () => {
    const raw = "将下列恢复码录入 https://panel.example 的恢复码字段：fixture-recovery-abc";
    const router = echoRouter([JSON.stringify({
      secrets: [{ value: "fixture-recovery-abc", field: "session key", label: "panel/session", hosts: ["panel.example"], uses: ["http"] }],
      layout: null,
    })]);
    const minter = vi.fn(fakeMinter());
    const result = await routerSealer(router, minter, () => "")(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture failed to seal");
    expect(router.calls).toHaveLength(1);
    expect(minter).toHaveBeenCalledTimes(1);
    const [userText, candidates] = result.text.split(LEGEND_HEADER);
    const entry = result.sealed[0]!;
    expect(userText?.trim()).toBe(raw.replace("fixture-recovery-abc", entry.token));
    expect(candidates).toContain(`- session key (for panel.example): ${entry.token}`);
    expect(result.text).not.toContain("fixture-recovery-abc");

    // Updating the descriptive candidate must not produce a different token or modify any capability metadata.
    const corrected = legend([{ ...entry, field: "recovery code" }], null);
    expect(corrected).toContain(`- recovery code (for panel.example): ${entry.token}`);
    expect(entry).toMatchObject({ field: "session key", kind: "secret", hosts: ["panel.example"], uses: ["http"] });
    expect(entry.seed_import_hosts).toBeUndefined();
    expect(minter).toHaveBeenCalledTimes(1);
  });
});
