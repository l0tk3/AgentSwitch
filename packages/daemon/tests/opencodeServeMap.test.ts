/** Pure mapping for the OpenCode serve path. The ruleset fixture is what OpenCode 2.0.8 itself made of the same
 *  `permission` section (GET /api/config on a throwaway server), so session rules and config rules agree. */
import { describe, expect, it } from "vitest";
import { categoriesOf } from "../src/engine/approvalPolicy.js";
import { NO_ANSWER_MESSAGE } from "../src/core/questions.js";
import { opencodeExecConfig } from "../src/executors/opencode.js";
import { approvalFor, foldTurn, formAnswer, formQuestions, modelRef, runtimeMcp, shellEnv, toRuleset } from "../src/executors/opencodeServeMap.js";

const gate = { bin: "/g/bin/secret-gate", home: "/h/.secret-gate", proxy: "http://127.0.0.1:8080", playwrightVersion: "0.0.82", allowedOrigins: [] };

describe("OpenCode serve mapping", () => {
  it("translates the permission section exactly as OpenCode 2.0.8 does", () => {
    const { permission } = opencodeExecConfig(gate, "/p", false, { protected: { roots: ["/h/.agentswitch", "/h/.secret-gate"], exempt: [] } }) as { permission: Record<string, unknown> };
    const r = (action: string, resource: string, effect: string) => ({ action, resource, effect });
    expect(toRuleset(permission)).toEqual([
      r("read", "*", "allow"), r("read", "/h/.secret-gate/*", "deny"), r("read", "**/.env", "deny"), r("read", "**/*.pem", "deny"), r("read", "**/*.key", "deny"),
      r("shell", "*", "allow"), r("shell", "secret-gate keygen*", "deny"), r("shell", "cat /h/.secret-gate/*", "deny"), r("shell", "*/h/.agentswitch*", "deny"), r("shell", "*/h/.secret-gate*", "deny"),
      r("edit", "*", "allow"), r("edit", "/h/.agentswitch/*", "deny"), r("edit", "/h/.secret-gate/*", "deny"),
      r("external_directory", "*", "allow"), r("external_directory", "/h/.agentswitch", "deny"), r("external_directory", "/h/.agentswitch/*", "deny"), r("external_directory", "/h/.secret-gate", "deny"), r("external_directory", "/h/.secret-gate/*", "deny"),
      r("webfetch", "*", "deny"),
    ]);
    expect(toRuleset({ edit: "allow", bash: { x: "bogus" } })).toEqual([r("edit", "*", "allow")]);
  });

  it("model references, runtime MCP shape, shell env", () => {
    expect(modelRef("deepseek/deepseek-flash")).toEqual({ providerID: "deepseek", id: "deepseek-flash" });
    expect(modelRef("openrouter/qwen/qwen3")).toEqual({ providerID: "openrouter", id: "qwen/qwen3" });
    expect(runtimeMcp({
      a: { type: "local", command: ["x", "mcp"], enabled: true, environment: { K: "v" } },
      b: { type: "remote", url: "https://m.example.com", headers: { H: "1" }, enabled: true },
      off: { type: "local", command: ["y"], enabled: false },
    })).toEqual({ a: { type: "local", command: ["x", "mcp"], environment: { K: "v" } }, b: { type: "remote", url: "https://m.example.com", headers: { H: "1" } } });
    const env = shellEnv(gate, "SCOPE", "/w", { PATH: "/bin", HTTPS_PROXY: "http://other", SECRET_GATE_REPAIR_KEY: "k", OPENCODE_SERVER_PASSWORD: "p", OPENCODE_CONFIG: "/c" });
    expect(env).toMatchObject({ PATH: "/bin", HTTPS_PROXY: "http://scope:SCOPE@127.0.0.1:8080", PWD: "/w", GIT_EDITOR: "true", SECRET_GATE_HOME: "/h/.secret-gate" });
    expect(Object.keys(env).filter((k) => /REPAIR|OPENCODE_/.test(k))).toEqual([]);
    expect(shellEnv(null, "SCOPE", "/w", { PATH: "/bin", https_proxy: "x" })).toEqual({ PATH: "/bin", PWD: "/w", GIT_EDITOR: "true" });
  });

  it("folds a turn: finished items once, running tools counted, streaming ones not, unknown types flagged", () => {
    const msgs = [
      { id: "m0", type: "user", time: { created: 5 }, text: "earlier turn" },
      { id: "m1", type: "user", time: { created: 10 }, text: "go" },
      { id: "m2", type: "assistant", time: { created: 11, completed: 12 }, tokens: { input: 100, output: 7 }, content: [{ type: "text", text: "a" }, { type: "tool", id: "t1", name: "shell", state: { status: "error", input: { command: "x" }, error: { message: "denied" } } }] },
      { id: "m3", type: "assistant", time: { created: 13 }, content: [{ type: "text", text: "b" }, { type: "tool", id: "t2", name: "write", state: { status: "running", input: {} } }, { type: "tool", id: "t4", name: "read", state: { status: "completed", input: { filePath: "y" } } }, { type: "tool", id: "t3", name: "shell", state: { status: "streaming", input: "{" } }] },
    ];
    const live = foldTurn(msgs, 10, "ses");
    // "b" is finished (the model moved on to a tool); the completed read waits for the running write before it.
    expect(live.items).toEqual([{ key: "m2:0", kind: "text", text: "a" }, { key: "m2:t1", kind: "tool", tool: "shell", input: { command: "x" }, error: "denied" }, { key: "m3:0", kind: "text", text: "b" }]);
    expect(live.summary).toMatchObject({ text: "ab", sessionId: "ses", telemetryComplete: true, tools: [{ tool: "shell", input: { command: "x" } }, { tool: "write", input: {} }, { tool: "read", input: { filePath: "y" } }] });
    expect(live.idle).toBeNull();
    expect(live.tokens).toBe(107);
    const final = foldTurn([...msgs, { id: "m4", type: "idle", time: { created: 14 }, outcome: "interrupted" }, { id: "m5", type: "mystery", time: { created: 15 } }], 10, "ses", true);
    expect(final.items.map((i) => i.key)).toEqual(["m2:0", "m2:t1", "m3:0", "m3:t4"]);
    expect(final.idle).toBe("interrupted");
    expect(final.summary.telemetryComplete).toBe(false);
  });

  it("approval cards fall into the engine's categories like Claude's and Codex's", () => {
    const bash = approvalFor({ id: "p", sessionID: "s", action: "shell", resources: ["rm -rf build"] });
    expect(bash.action).toBe("Bash: rm -rf build");
    expect(categoriesOf(bash.action, bash.evidence)).toEqual(expect.arrayContaining(["shell", "delete"]));
    const outside = approvalFor({ id: "p", sessionID: "s", action: "external_directory", resources: ["/etc/*"] });
    expect(categoriesOf(outside.action)).toContain("outside_cwd");
    expect(approvalFor({ id: "p", sessionID: "s", action: "doom_loop" }).action).toBe("OpenCode doom_loop: ");
  });

  it("question forms map to engine questions and back", () => {
    const form = { id: "f", metadata: { kind: "question" }, fields: [
      { key: "q0", type: "string", title: "Color", description: "Which?", custom: true, options: [{ value: "r", label: "Red" }] },
      { key: "q1", type: "multiselect", description: "Which ones?", custom: false, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    ] };
    expect(formQuestions(form)!.map((q) => [q.id, q.multi, q.options.map((o) => o.label)])).toEqual([["q0", false, ["Red"]], ["q1", true, ["A", "B"]]]);
    expect(formAnswer(form, { q0: ["Red"], q1: ["A", "B"] })).toEqual({ q0: "r", q1: ["a", "b"] });
    expect(formAnswer(form, null)).toBeNull();   // q1 takes no free text: the form is cancelled instead
    expect(formAnswer({ fields: [form.fields[0]] }, null)).toEqual({ q0: NO_ANSWER_MESSAGE });
    expect(formQuestions({ metadata: { kind: "oauth" }, fields: form.fields })).toBeNull();
    expect(formQuestions({ metadata: { kind: "question" }, fields: [{ key: "n", type: "number", description: "How many?" }] })).toBeNull();
  });
});
