import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeExecutor, EMPTY_FOLD, foldMessage, outcomeFromFold } from "../src/executors/claude.js";
import { applyNotification, codexExecutor, EMPTY_TURN, outcomeFromTurn } from "../src/executors/codex.js";
import { opencodeExecutor, outcomeFromRun, resumeRefused, summarizeRun } from "../src/executors/opencode.js";
import type { ExecutionInput } from "../src/executors/types.js";

const { fakeQuery } = vi.hoisted(() => ({ fakeQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: fakeQuery }));

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "agentswitch-effects-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); fakeQuery.mockReset(); });
function input(cwd: string, over: Partial<ExecutionInput> = {}): ExecutionInput {
  return { taskId: "fixture", task: "fixture", brief: "fixture", cwd, model: "fixture-model", effort: null,
    handoffNote: null, context: null, knownTokens: new Set(), threadHome: null, resume: null, attachments: [], browser: false,
    signal: new AbortController().signal, emit: () => undefined, approve: async () => "allow", ask: async () => null, ...over };
}
function binary(dir: string, source: string): string {
  const path = join(dir, "fake-executor");
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return path;
}
const assistant = { type: "assistant", message: { content: [{ type: "tool_use", name: "Write" }, { type: "tool_use", name: "mcp__playwright__browser_click" }] } };

describe("interrupted executor telemetry", () => {
  it("Claude exceptions preserve observed edits, MCP tools and sub-agents", async () => {
    fakeQuery.mockImplementation(async function* () {
      yield assistant;
      yield { type: "system", subtype: "task_started", task_id: "child" };
      throw new Error("ECONNRESET fixture");
    });
    const out = await claudeExecutor().run(input(fixture()));
    expect(out).toMatchObject({ ok: false, sideEffectsKnown: false, sideEffects: { filesChanged: 1, commandsRun: 1 }, agents: { spawned: 1 }, stderr: "ECONNRESET fixture" });
  });

  it("Claude timeout retains operations when abort ends the SDK stream", async () => {
    fakeQuery.mockImplementation(async function* ({ options }: { options: { abortController: AbortController } }) {
      yield assistant;
      await new Promise<void>((resolve) => options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("aborted");
    });
    const out = await claudeExecutor({ maxMs: 30 }).run(input(fixture()));
    expect(out).toMatchObject({ ok: false, timedOut: true, sideEffectsKnown: false, sideEffects: { filesChanged: 1, commandsRun: 1 } });
  });

  it("a sub-agent bookend without a parent tool still means possible effects", () => {
    const claude = foldMessage(EMPTY_FOLD, { type: "system", subtype: "task_started", task_id: "child" } as never);
    expect(outcomeFromFold(claude, 0, false)).toMatchObject({ sideEffectsKnown: false, sideEffects: { commandsRun: 1 } });
    const codex = applyNotification(EMPTY_TURN, "item/started", { item: { type: "subAgentActivity", kind: "started", agentThreadId: "child" } });
    expect(outcomeFromTurn(codex, "connection closed")).toMatchObject({ sideEffectsKnown: false, sideEffects: { commandsRun: 1 } });
  });

  it("Codex counts started operations once and preserves them after incomplete RPC", async () => {
    const dir = fixture(); const authPath = join(dir, "fake-auth.json"); writeFileSync(authPath, "{}");
    const bin = binary(dir, `const rl = require('node:readline').createInterface({input:process.stdin});
      const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
      rl.on('line', line => { const m=JSON.parse(line); if(!m.id)return;
        if(m.method==='turn/start'){
          for(const item of [{id:'edit',type:'fileChange'},{id:'mcp',type:'mcpToolCall'}]) send({method:'item/started',params:{item}});
          send({method:'item/completed',params:{item:{id:'edit',type:'fileChange'}}});
          send({id:m.id,error:{message:'ECONNRESET fixture'}});
        }else send({id:m.id,result:m.method==='thread/start'?{thread:{id:'fixture-thread'}}:{}});
      });`);
    const out = await codexExecutor({ binary: bin, authPath, maxMs: 5000 }).run(input(dir));
    expect(out).toMatchObject({ ok: false, sideEffectsKnown: false, sideEffects: { filesChanged: 1, commandsRun: 1 }, stderr: expect.stringContaining("ECONNRESET") });
  });

  it("OpenCode MCP/sub-agent activity survives process failure and cannot trigger a fresh resume", async () => {
    const dir = fixture(); const calls = join(dir, "calls");
    const bin = binary(dir, `require('node:fs').appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      for(const tool of ['playwright_browser_click','task']) console.log(JSON.stringify({type:'tool_use',part:{tool}}));
      console.error('Error: session fixture not found'); process.exitCode=1;`);
    const out = await opencodeExecutor({ binary: bin }).run(input(dir, { resume: "previous" }));
    expect(out).toMatchObject({ ok: false, sideEffectsKnown: false, sideEffects: { commandsRun: 2 }, agents: { spawned: 1 } });
    expect(readFileSync(calls, "utf8")).toBe("call\n");
  });

  it("OpenCode only retries a clear, operation-free resume rejection", () => {
    const empty = summarizeRun("");
    expect(resumeRefused(empty, 1, "session old not found")).toBe(true);
    expect(resumeRefused(empty, null, "session old not found")).toBe(false);
    expect(resumeRefused(empty, 1, "session connection lost")).toBe(false);
    expect(resumeRefused(empty, 1, "session old not found", true)).toBe(false);
    const corrupt = summarizeRun('{"type":"tool_use"');
    expect(resumeRefused(corrupt, 1, "session old not found")).toBe(false);
    expect(outcomeFromRun(corrupt, 0, "", false).sideEffectsKnown).toBe(false);
  });

  it("OpenCode timeout preserves remote operations and never restarts the session", async () => {
    const dir = fixture(); const calls = join(dir, "calls");
    const bin = binary(dir, `require('node:fs').appendFileSync(${JSON.stringify(calls)},'call\\n');
      console.log(JSON.stringify({type:'tool_use',part:{tool:'mcp_submit'}}));
      console.error('session old not found'); setInterval(()=>{},1000);`);
    const out = await opencodeExecutor({ binary: bin, maxMs: 1500 }).run(input(dir, { resume: "old" }));
    expect(out).toMatchObject({ ok: false, timedOut: true, sideEffectsKnown: false, sideEffects: { commandsRun: 1 } });
    expect(readFileSync(calls, "utf8")).toBe("call\n");
  });

  it("Codex does not reset a thread on transport failure or after observed operations", async () => {
    for (const effect of [false, true]) {
      const dir = fixture(); const authPath = join(dir, "fake-auth.json"); writeFileSync(authPath, "{}");
      const calls = join(dir, "calls");
      const bin = binary(dir, `const rl = require('node:readline').createInterface({input:process.stdin});
        const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
        rl.on('line', line => {const m=JSON.parse(line); if(!m.id)return;
          require('node:fs').appendFileSync(${JSON.stringify(calls)},m.method+'\\n');
          if(m.method==='thread/resume'){
            ${effect ? "send({method:'item/started',params:{item:{id:'mcp',type:'mcpToolCall'}}});" : ""}
            send({id:m.id,error:{message:${JSON.stringify(effect ? "thread old not found" : "ECONNRESET")}}});
          }else send({id:m.id,result:{}});
        });`);
      expect(await codexExecutor({ binary: bin, authPath, maxMs: 5000 }).run(input(dir, { resume: "old" }))).toMatchObject({ ok: false, sideEffectsKnown: false });
      expect(readFileSync(calls, "utf8")).not.toContain("thread/start");
    }
  });

  it("Codex still starts fresh after a clear zero-operation missing-thread response", async () => {
    const dir = fixture(); const authPath = join(dir, "fake-auth.json"); writeFileSync(authPath, "{}");
    const calls = join(dir, "calls");
    const bin = binary(dir, `const rl = require('node:readline').createInterface({input:process.stdin});
      const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
      rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;
        require('node:fs').appendFileSync(${JSON.stringify(calls)},m.method+'\\n');
        if(m.method==='thread/resume')return send({id:m.id,error:{message:'thread old not found'}});
        send({id:m.id,result:m.method==='thread/start'?{thread:{id:'new'}}:{}});
        if(m.method==='turn/start')send({method:'turn/completed',params:{threadId:'new'}});
      });`);
    expect(await codexExecutor({ binary: bin, authPath, maxMs: 5000 }).run(input(dir, { resume: "old" }))).toMatchObject({ ok: true, sideEffectsKnown: true });
    expect(readFileSync(calls, "utf8")).toBe("initialize\nthread/resume\nthread/start\nturn/start\n");
  });
});
