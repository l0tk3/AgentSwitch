import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendMemory, factLines, loadMemory, MEMORY_HEADER } from "../src/threads/memory.js";

describe("MEMORY.md", () => {
  it("appends linted, deduplicated facts with their source; header on first write; load lints", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentswitch-mem-")), "MEMORY.md");
    expect(loadMemory(path)).toMatchObject({ text: "", source: null });
    const r1 = appendMemory(path, ["core 控制台的登录表单是 React，要用 secret_fill", "  password: hunter2secret  ", "", "AgentSwitch 的测试要跑四分钟"], { taskId: "ab12", ts: Date.UTC(2026, 8, 21) });
    expect(r1.added).toEqual(["core 控制台的登录表单是 React，要用 secret_fill", "AgentSwitch 的测试要跑四分钟"]);
    expect(r1.skipped).toHaveLength(2);
    const text = readFileSync(path, "utf8");
    expect(text.startsWith(MEMORY_HEADER)).toBe(true);
    expect(text).toContain("- core 控制台的登录表单是 React，要用 secret_fill (task ab12, 2026-09-21)");
    expect(text).not.toContain("hunter2secret");
    const r2 = appendMemory(path, ["AgentSwitch 的测试要跑四分钟", "新事实"], { taskId: "cd34" });
    expect(r2).toEqual({ added: ["新事实"], skipped: ["AgentSwitch 的测试要跑四分钟"] });
    expect(factLines(readFileSync(path, "utf8"))).toEqual(["core 控制台的登录表单是 React，要用 secret_fill", "AgentSwitch 的测试要跑四分钟", "新事实"]);
    expect(loadMemory(path).text).toContain("新事实");
    expect(appendMemory(path, ["a", "b", "c", "d", "e", "f", "g"], { taskId: "x" }).added).toHaveLength(5);
  });

  it("refuses to grow past the size cap", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentswitch-mem-")), "MEMORY.md");
    writeFileSync(path, "# x\n" + "- filler\n".repeat(8000));
    expect(appendMemory(path, ["one more"], { taskId: "x" })).toEqual({ added: [], skipped: ["one more"] });
  });
});
