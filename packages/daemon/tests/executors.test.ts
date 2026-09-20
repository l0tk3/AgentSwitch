import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AppServerClient, type Json } from "../src/executors/appserver.js";
import { canonical, decideTool, foldMessage, outcomeFromFold, type Folded } from "../src/executors/claude.js";
import { applyNotification, approvalAnswer, codexConfigToml, describeApproval, outcomeFromTurn, type TurnState } from "../src/executors/codex.js";
import { claudeMcpServers, codexGateToml, gateEnv, opencodeGateConfig, type GateOptions } from "../src/executors/gate.js";
import { opencodeExecConfig, outcomeFromRun, summarizeRun } from "../src/executors/opencode.js";
import { classifyFailure } from "../src/router/failure.js";

const gate: GateOptions = { bin: "/g/secret-gate", home: "/h/.secret-gate", proxy: "http://127.0.0.1:8080", playwrightVersion: "0.0.82", allowedOrigins: ["http://a:8400"] };

describe("gate wiring", () => {
  it("env has both proxy cases and keeps model APIs direct", () => {
    const e = gateEnv(gate);
    expect(e.HTTP_PROXY).toBe(e.http_proxy);
    expect(e.NO_PROXY).toContain("api.anthropic.com");
    expect(e.NO_PROXY).toContain("127.0.0.1");
  });
  it("browser goes through `secret-gate browser` in every harness shape", () => {
    const c = claudeMcpServers(gate, "/p", true);
    expect(c.playwright!.args.slice(0, 3)).toEqual(["browser", "--", "npx"]);
    expect(c.playwright!.args).toContain("--allowed-origins=http://a:8400");
    expect(claudeMcpServers(gate, "/p", false).playwright).toBeUndefined();
    const o = opencodeGateConfig(gate, "/p", true);
    expect((o.mcp.playwright as { command: string[] }).command.slice(0, 3)).toEqual(["/g/secret-gate", "browser", "--"]);
    expect(o.readDeny).toEqual({ "/h/.secret-gate/*": "deny" });
    const t = codexGateToml(gate, "/p", true);
    expect(t).toContain('network_access = true');
    expect(t).toMatch(/set = \{.*http_proxy = "http:\/\/127.0.0.1:8080".*\}/);
    expect(t).toContain("[mcp_servers.playwright]");
    expect(codexGateToml(gate, "/p", false)).not.toContain("playwright");
  });
});

describe("opencode executor helpers", () => {
  it("config: gate MCP, gate home unreadable, webfetch denied; works without a gate", () => {
    const c = opencodeExecConfig(gate, "/p", false) as { mcp: Record<string, unknown>; permission: { read: Record<string, string>; webfetch: string; bash: Record<string, string> } };
    expect(Object.keys(c.mcp)).toEqual(["secret-gate"]);
    expect(c.permission.read["/h/.secret-gate/*"]).toBe("deny");
    expect(c.permission.webfetch).toBe("deny");
    expect(c.permission.bash["cat /h/.secret-gate/*"]).toBe("deny");
    const plain = opencodeExecConfig(null, "/p", false) as { mcp: object };
    expect(plain.mcp).toEqual({});
  });
  it("summarize + outcome", () => {
    const stdout = [JSON.stringify({ type: "text", part: { text: "hello " } }), JSON.stringify({ type: "tool_use", part: { tool: "edit", input: { file: "a" } } }),
      JSON.stringify({ type: "tool_use", part: { tool: "bash" } }), "junk", JSON.stringify({ type: "text", part: { text: "world" } })].join("\n");
    const s = summarizeRun(stdout);
    expect(s.text).toBe("hello world");
    expect(s.tools.map((t) => t.tool)).toEqual(["edit", "bash"]);
    const ok = outcomeFromRun(s, 0, "", false);
    expect(ok).toMatchObject({ ok: true, lastText: "hello world", sideEffects: { filesChanged: 1, commandsRun: 1 } });
    expect(outcomeFromRun(s, 1, "connect ECONNREFUSED", false).ok).toBe(false);
    expect(classifyFailure(outcomeFromRun(s, 1, "connect ECONNREFUSED", false))).toBe("transport");
    expect(outcomeFromRun(summarizeRun(JSON.stringify({ type: "error", error: "rate limit exceeded" })), 0, "", false)).toMatchObject({ ok: false, stderr: "rate limit exceeded" });
    expect(outcomeFromRun(summarizeRun(""), null, "", true)).toMatchObject({ ok: false, timedOut: true });
  });
});

describe("codex executor helpers", () => {
  it("config toml carries approval policy, sandbox, effort and gate sections", () => {
    const t = codexConfigToml(gate, "/p", false, "high");
    expect(t).toContain('approval_policy = "on-request"');
    expect(t).toContain('model_reasoning_effort = "high"');
    expect(t).toContain("[mcp_servers.secret-gate]");
    expect(codexConfigToml(null, "/p", false, null)).not.toContain("model_reasoning_effort");
    expect(codexConfigToml(null, "/p", false, null)).toContain("network_access = true");
  });
  it("approval answers match each method's vocabulary", () => {
    expect(approvalAnswer("execCommandApproval", true)).toEqual({ decision: "approved" });
    expect(approvalAnswer("execCommandApproval", false)).toEqual({ decision: "denied" });
    expect(approvalAnswer("item/commandExecution/requestApproval", false)).toEqual({ decision: "decline" });
    expect(approvalAnswer("mcpServer/elicitation/request", true)).toEqual({ action: "accept", content: {} });
    expect(describeApproval("item/commandExecution/requestApproval", { item: { command: ["rm", "-rf", "x"], cwd: "/w" } }).action).toBe("item/commandExecution/requestApproval: rm -rf x");
    expect(describeApproval("item/fileChange/requestApproval", { item: { changes: [{ path: "a" }] } }).action).toContain("file changes");
    expect(describeApproval("weird", { x: 1 }).evidence).toBe('{"x":1}');
  });
  it("notifications fold into a turn state and an outcome", () => {
    let s: TurnState = { text: [], tools: 0, edits: 0, approvals: 0, completed: null, errors: [] };
    s = applyNotification(s, "item/completed", { item: { type: "agentMessage", text: "hi" } });
    s = applyNotification(s, "item/completed", { item: { type: "commandExecution", command: "ls" } });
    s = applyNotification(s, "item/completed", { item: { type: "fileChange" } });
    s = applyNotification(s, "item/completed", { item: { type: "mcpToolCall" } });
    s = applyNotification(s, "other", {});
    expect(outcomeFromTurn(s, null)).toMatchObject({ ok: false });   // not completed yet
    s = applyNotification(s, "turn/completed", { threadId: "t" });
    expect(outcomeFromTurn(s, null)).toMatchObject({ ok: true, lastText: "hi", sideEffects: { filesChanged: 1, commandsRun: 2 } });
    const errored = applyNotification(s, "error", { message: "boom" });
    expect(outcomeFromTurn(errored, null)).toMatchObject({ ok: false, stderr: expect.stringContaining("boom") });
    expect(outcomeFromTurn(s, "app-server exited 1").ok).toBe(false);
    expect(outcomeFromTurn({ ...s, completed: { turn: { error: { message: "rate limit" } } } }, null).stderr).toContain("rate limit");
  });
});

describe("AppServerClient", () => {
  it("requests, notifications and server requests over a fake transport", async () => {
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    const notes: string[] = [];
    const client = new AppServerClient(toServer, fromServer, async (method, params) => ({ echoed: method, ok: (params as { x?: number }).x }), (m) => notes.push(m));
    const serverSeen: Json[] = [];
    toServer.on("data", (d: Buffer) => { for (const line of d.toString().split("\n").filter(Boolean)) serverSeen.push(JSON.parse(line) as Json); });
    const p = client.request("initialize", { a: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(serverSeen[0]).toMatchObject({ id: 1, method: "initialize", params: { a: 1 } });
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hello: true } }) + "\n");
    expect(await p).toEqual({ hello: true });
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: {} }) + "\n");
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: 77, method: "execCommandApproval", params: { x: 5 } }) + "\n");
    fromServer.write("not json\n");
    await new Promise((r) => setTimeout(r, 10));
    expect(notes).toEqual(["item/completed"]);
    expect(serverSeen.at(-1)).toEqual({ jsonrpc: "2.0", id: 77, result: { echoed: "execCommandApproval", ok: 5 } });
    const failing = client.request("x", {}, 20);
    await expect(failing).rejects.toThrow(/no response/);
    const p2 = client.request("y");
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: 1, message: "nope" } }) + "\n");
    await expect(p2).rejects.toThrow(/nope/);
    const p3 = client.request("z");
    client.fail(new Error("closed"));
    await expect(p3).rejects.toThrow(/closed/);
  });
});

describe("claude executor helpers", () => {
  it("tool policy: read-only and gate tools pass, edits inside cwd pass, the rest asks", () => {
    expect(decideTool("Read", { file_path: "/etc/passwd" }, "/w")).toEqual({ kind: "allow" });
    expect(decideTool("mcp__secret-gate__secret_fill", {}, "/w")).toEqual({ kind: "allow" });
    expect(decideTool("Edit", { file_path: "src/a.ts" }, "/w")).toEqual({ kind: "allow" });
    expect(decideTool("Write", { file_path: "/etc/hosts" }, "/w")).toMatchObject({ kind: "ask", action: expect.stringContaining("outside cwd") });
    expect(decideTool("Write", { file_path: "/wrong/x" }, "/w")).toMatchObject({ kind: "ask" });
    expect(decideTool("Bash", { command: "rm -rf /", description: "clean" }, "/w")).toEqual({ kind: "ask", action: "Bash: rm -rf /", evidence: "clean" });
    expect(decideTool("WebFetch", { url: "http://x" }, "/w")).toMatchObject({ kind: "ask", action: "WebFetch" });
  });
  it("edits inside cwd stay allowed across symlinked path spellings (macOS /var vs /private/var)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-canon-"));   // /var/folders/... on macOS
    const cwd = canonical(dir);
    expect(canonical(join(dir, "new", "file.txt"))).toBe(join(cwd, "new", "file.txt"));
    expect(decideTool("Write", { file_path: join(dir, "hello.txt") }, cwd)).toEqual({ kind: "allow" });
    expect(decideTool("Write", { file_path: join(cwd, "sub", "x.txt") }, cwd)).toEqual({ kind: "allow" });
    expect(canonical("/definitely/not/here/x")).toBe("/definitely/not/here/x");
    expect(decideTool("Write", { file_path: join(dir, "..", "escape.txt") }, cwd)).toMatchObject({ kind: "ask" });
  });
  it("messages fold into an outcome: success, error, refusal, rate limit, cancelled", () => {
    const empty: Folded = { text: [], tools: 0, edits: 0, result: null, refusal: false, rateLimited: false };
    const assistant = { type: "assistant", message: { content: [{ type: "text", text: "working" }, { type: "tool_use", name: "Edit" }, { type: "tool_use", name: "Bash" }] } } as never;
    const success = { type: "result", subtype: "success", is_error: false, result: "all done", usage: { input_tokens: 10, output_tokens: 5 } } as never;
    let s = foldMessage(foldMessage(empty, assistant), success);
    expect(outcomeFromFold(s, 1, false)).toMatchObject({ ok: true, lastText: "all done", tokens: 15, sideEffects: { filesChanged: 1, commandsRun: 1, approvalsGranted: 1 } });
    const err = { type: "result", subtype: "error_max_turns", is_error: true, usage: {} } as never;
    expect(outcomeFromFold(foldMessage(empty, err), 0, false)).toMatchObject({ ok: false, stderr: "error_max_turns" });
    s = foldMessage(foldMessage(empty, { type: "system", subtype: "model_refusal_no_fallback" } as never), success);
    const refused = outcomeFromFold(s, 0, false);
    expect(refused.ok).toBe(false);
    expect(classifyFailure(refused)).toBe("refusal");
    s = foldMessage(foldMessage(empty, { type: "rate_limit_event" } as never), err);
    expect(classifyFailure(outcomeFromFold(s, 0, false))).toBe("quota");
    expect(outcomeFromFold(empty, 0, true)).toMatchObject({ ok: false, stderr: "cancelled" });
    expect(outcomeFromFold(empty, 0, false)).toMatchObject({ ok: false, timedOut: true });
    expect(foldMessage(empty, { type: "user" } as never)).toEqual(empty);
  });
});
