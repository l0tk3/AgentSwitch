import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import { echoExecutor } from "../src/executors/echo.js";
import { composePrompt } from "../src/executors/instructions.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, realTargets } from "./helpers.js";

const targets = realTargets();

describe("CONTEXT.md reaches router and executor", () => {
  it("composePrompt: brief, then handoff, then the context section; nothing extra when both are absent", () => {
    expect(composePrompt({ brief: "do x", handoffNote: null, context: null })).toBe("do x");
    expect(composePrompt({ brief: "do x", handoffNote: null, context: "  " })).toBe("do x");
    const p = composePrompt({ brief: "do x", handoffNote: "prev did y", context: "- site A password enc:v1:AAAAAAAAAAAAAAAAAAAA" });
    expect(p.indexOf("do x")).toBeLessThan(p.indexOf("Handoff from a previous attempt:\nprev did y"));
    expect(p.indexOf("Handoff")).toBeLessThan(p.indexOf("User environment context"));
    expect(p).toContain("- site A password enc:v1:AAAAAAAAAAAAAAAAAAAA");
  });

  it("the engine re-reads CONTEXT.md on every dispatch, lints it, and hands the text to the executor", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-ctx-"));
    const contextPath = join(home, "CONTEXT.md");
    writeFileSync(contextPath, "## 站点\n- 财务 http://fin.internal:8600 账号 alice 密码 enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA\n");
    const store = new Store({ dbPath: ":memory:", threadsDir: join(home, "threads") });
    const router = echoRouter(() => decisionJson({ harness: "codex", model: "gpt-5.5", effort: null }));
    const echo = Object.keys(targets.harnesses).map((h) => echoExecutor(h));
    const engine = new Engine({ store, bus: new Bus(), executors: echo, targets, router, quota: () => ({}), approvalTimeoutMs: 100, retryBackoffMs: 1, contextPath });
    engine.submit({ task: "登录财务系统看首页", cwd: "/tmp" });
    await engine.idle();
    expect(router.calls[0]!.system).toContain("http://fin.internal:8600");
    const codex = echo.find((e) => e.harness === "codex")!;
    expect(codex.runs[0]!.context).toContain("enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA");
    // edited on the page after the daemon started: the next task sees the new entry, and the lint still strips plaintext
    writeFileSync(contextPath, "- 邮件 http://mail.internal:8400 密码 enc:v1:BBBBBBBBBBBBBBBBBBBBBBBB\n- 旧站 http://old.internal 密码 hunter2plain\n");
    engine.submit({ task: "登录邮件系统", cwd: "/tmp" });
    await engine.idle();
    expect(router.calls[1]!.system).toContain("mail.internal:8400");
    expect(router.calls[1]!.system).not.toContain("fin.internal");
    expect(codex.runs[1]!.context).toContain("enc:v1:BBBBBBBBBBBBBBBBBBBBBBBB");
    expect(codex.runs[1]!.context).not.toContain("hunter2plain");
  });
});
