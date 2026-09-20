import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contextSection, EMPTY_CONTEXT, lintContext, loadContext, MAX_CONTEXT_BYTES } from "../src/router/context.js";
import { systemPrompt } from "../src/router/prompt.js";
import { route } from "../src/router/route.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, realTargets } from "./helpers.js";

const TOKEN = "enc:v1:" + "A".repeat(40);

describe("context lint", () => {
  it("keeps token lines and strips plaintext credentials with a warning", () => {
    const raw = ["- 站点 A：https://a.example.com/", `  密码 ${TOKEN}`, "  账号 alice", "  密码 Hunter2-Real", "  Token: sk-live-123", "  备注：无"].join("\n");
    const { text, warnings } = lintContext(raw);
    expect(text).toContain(TOKEN);
    expect(text).toContain("账号 alice");
    expect(text).not.toContain("Hunter2-Real");
    expect(text).not.toContain("sk-live-123");
    expect(text).toContain("密码 [removed: not a secret-gate token]");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("line 4");
  });

  it("placeholders, labels without values and prose are left alone", () => {
    const raw = ["- 密码 enc:v1:REPLACE_WITH_TOKEN", "  2FA <token>（用 secret_otp 取码）", "## 密码", "  password:",
      "只放密文，不放明文密码：daemon 会删掉可疑行。", "secret-gate 的 secret_fill 工具"].join("\n");
    const { text, warnings } = lintContext(raw);
    expect(warnings).toEqual([]);
    expect(text).toBe(raw);
  });

  it("truncates oversized files", () => {
    const { text, warnings } = lintContext("x".repeat(MAX_CONTEXT_BYTES + 10));
    expect(Buffer.byteLength(text)).toBe(MAX_CONTEXT_BYTES);
    expect(warnings[0]).toContain("truncated");
  });

  it("the example file passes the lint unchanged", () => {
    const loaded = loadContext(resolve(import.meta.dirname, "..", "config", "CONTEXT.example.md"));
    expect(loaded.warnings).toEqual([]);
    expect(loaded.text).toContain("enc:v1:REPLACE_WITH_TOKEN");
  });

  it("missing file is empty context and adds nothing to the prompt", () => {
    expect(loadContext("/nonexistent/CONTEXT.md")).toEqual(EMPTY_CONTEXT);
    expect(loadContext(undefined)).toEqual(EMPTY_CONTEXT);
    expect(contextSection(EMPTY_CONTEXT)).toBe("");
    expect(systemPrompt(realTargets())).not.toContain("User environment context");
  });
});

describe("context in the pipeline", () => {
  it("router sees the linted context in its system prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-ctx-"));
    const file = join(dir, "CONTEXT.md");
    writeFileSync(file, `## 站点\n- core：http://core.internal.example:8400/\n  密码 ${TOKEN}\n  密码 leaked-plain\n`);
    const ctx = loadContext(file);
    const r = echoRouter([decisionJson()]);
    await route({ task: "登录 core 看首页标题", cwd: dir }, { targets: realTargets(), router: r, quota: {}, running: {}, context: ctx });
    const system = r.calls[0]!.system;
    expect(system).toContain("User environment context");
    expect(system).toContain(TOKEN);
    expect(system).not.toContain("leaked-plain");
    expect(system).toContain("Never invent credentials");
  });
});
