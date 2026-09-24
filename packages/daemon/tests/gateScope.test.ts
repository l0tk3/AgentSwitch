/** gate-next-v0 §1/§3/§5.2 wiring: where the execution scope and the transfer grant go in each harness, and the proxy
 *  health check. Fake harness binaries and a mocked Agent SDK; no gate process, no model. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkGateProxy } from "../src/daemon.js";
import { claudeExecutor } from "../src/executors/claude.js";
import { codexConfigToml, codexExecutor } from "../src/executors/codex.js";
import { claudeMcpServers, codexGateToml, gateEnv, gateHealth, gateRun, mcpServerEnv, opencodeGateConfig, proxyEndpoint, scopedProxy, type GateOptions } from "../src/executors/gate.js";
import { opencodeExecConfig, opencodeExecutor } from "../src/executors/opencode.js";
import type { ExecutionInput } from "../src/executors/types.js";
import type { TransferGrant } from "../src/core/transfer.js";

const { fakeQuery } = vi.hoisted(() => ({ fakeQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: fakeQuery }));

const gate: GateOptions = { bin: "/g/secret-gate", home: "/h/.secret-gate", proxy: "http://127.0.0.1:8080", playwrightVersion: "0.0.82", allowedOrigins: [] };
const scope = "Sc0pe_Fixture-0123456789abcdefgh";
const scoped = `http://scope:${scope}@127.0.0.1:8080`;
const transfer: TransferGrant = { source: ["crm.example.com"], destination: ["erp.example.com:8443"], fields: ["email", "phone"], purpose: "把客户联系方式登记到 ERP" };
const repair = { url: "http://127.0.0.1:5555/credential-repair", key: "repair-key" };
const proxyVars = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] as const;

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "agentswitch-scope-")); dirs.push(dir); return dir; };
const servers: Server[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
  fakeQuery.mockReset();
});

function input(cwd: string, over: Partial<ExecutionInput> = {}): ExecutionInput {
  return { taskId: "fixture", task: "copy the contact", brief: "copy the contact", cwd, model: "fixture-model", effort: null,
    handoffNote: null, context: null, knownTokens: new Set(), threadHome: null, resume: null, attachments: [], browser: true,
    gateScope: scope, transfer, signal: new AbortController().signal, emit: () => undefined, approve: async () => "allow", ask: async () => null, ...over };
}

/** A TOML basic string value (JSON-compatible escapes) from `KEY = "..."`. */
function tomlValue(toml: string, key: string): string | null {
  const line = toml.split("\n").find((l) => l.startsWith(`${key} = `));
  return line ? JSON.parse(line.slice(key.length + 3)) as string : null;
}

describe("gate wiring with an execution scope", () => {
  it("the shell tools' proxy URL carries the scope; user MCP servers and scope-less runs keep the plain proxy", () => {
    expect(scopedProxy("http://127.0.0.1:8080", scope)).toBe(scoped);
    for (const k of proxyVars) {
      expect(gateEnv(gate, scope)[k]).toBe(scoped);
      expect(gateEnv(gate)[k]).toBe("http://127.0.0.1:8080");
      expect(mcpServerEnv(gate, {})[k]).toBe("http://127.0.0.1:8080");
    }
    expect(gateEnv(gate, scope).NO_PROXY).toContain("api.anthropic.com");
  });

  it("the transfer only rides with a scope and an attached browser", () => {
    expect(gateRun({ gateScope: scope, transfer }, true)).toEqual({ scope, transfer });
    expect(gateRun({ gateScope: scope, transfer }, false)).toEqual({ scope, transfer: null });
    expect(gateRun({ transfer }, true)).toEqual({ scope: null, transfer: null });
    expect(gateRun({}, true)).toEqual({ scope: null, transfer: null });
  });

  it("Claude shape: scope for both gate processes, the grant only for the browser gate, nothing in argv", () => {
    const servers = claudeMcpServers(gate, "/p", true, repair, { scope, transfer });
    expect(servers["secret-gate"]!.env).toEqual({ SECRET_GATE_HOME: gate.home, SECRET_GATE_SCOPE: scope, SECRET_GATE_REPAIR_URL: repair.url, SECRET_GATE_REPAIR_KEY: repair.key });
    expect(servers.playwright!.env).toEqual({ SECRET_GATE_HOME: gate.home, SECRET_GATE_SCOPE: scope, SECRET_GATE_TRANSFER: JSON.stringify(transfer) });
    expect(JSON.stringify([servers["secret-gate"]!.args, servers.playwright!.args])).not.toContain(scope);
    expect(servers.playwright!.args).toContain("--proxy-server=http://127.0.0.1:8080");   // Chromium cannot carry proxy credentials
    expect(claudeMcpServers(gate, "/p", true, undefined, { transfer }).playwright!.env).toEqual({ SECRET_GATE_HOME: gate.home });
    expect(claudeMcpServers(gate, "/p", true).playwright!.env).toEqual({ SECRET_GATE_HOME: gate.home });
  });

  it("OpenCode shape: the same split in `environment`", () => {
    const { mcp } = opencodeGateConfig(gate, "/p", true, repair, { scope, transfer }) as { mcp: Record<string, { command: string[]; environment: Record<string, string> }> };
    expect(mcp["secret-gate"]!.environment.SECRET_GATE_SCOPE).toBe(scope);
    expect(mcp["secret-gate"]!.environment.SECRET_GATE_TRANSFER).toBeUndefined();
    expect(JSON.parse(mcp.playwright!.environment.SECRET_GATE_TRANSFER!)).toEqual(transfer);
    expect(mcp.playwright!.environment.SECRET_GATE_REPAIR_KEY).toBeUndefined();
    expect(JSON.stringify(mcp.playwright!.command)).not.toContain(scope);
    const plain = opencodeExecConfig(gate, "/p", false, {}, undefined, { scope, transfer }) as { mcp: Record<string, unknown> };
    expect(Object.keys(plain.mcp)).toEqual(["secret-gate"]);
  });

  it("Codex shape: scoped proxy in shell_environment_policy.set, scope in both MCP env tables, grant JSON a valid TOML string", () => {
    const toml = codexGateToml(gate, "/p", true, repair, { scope, transfer });
    const set = toml.split("\n").find((l) => l.startsWith("set = "))!;
    for (const k of proxyVars) expect(set).toContain(`${k} = ${JSON.stringify(scoped)}`);
    const gateEnvTable = toml.split("[mcp_servers.secret-gate.env]\n")[1]!.split("\n[")[0]!;
    expect(tomlValue(gateEnvTable, "SECRET_GATE_SCOPE")).toBe(scope);
    expect(tomlValue(gateEnvTable, "SECRET_GATE_TRANSFER")).toBeNull();
    const pwEnv = toml.split("[mcp_servers.playwright.env]\n")[1]!;
    expect(tomlValue(pwEnv, "SECRET_GATE_SCOPE")).toBe(scope);
    expect(JSON.parse(tomlValue(pwEnv, "SECRET_GATE_TRANSFER")!)).toEqual(transfer);
    expect(tomlValue(pwEnv, "SECRET_GATE_REPAIR_KEY")).toBeNull();
    const args = toml.split("\n").find((l) => l.startsWith("args = ") && l.includes("browser"))!;
    expect(args).not.toContain(scope);
    expect(codexConfigToml(gate, "/p", true, null, "", undefined, {})).not.toContain("SECRET_GATE_SCOPE");
    expect(codexGateToml(gate, "/p", true)).toMatch(/set = \{.*http_proxy = "http:\/\/127.0.0.1:8080".*\}/);
  });
});

describe("executors pass the run's scope and grant through", () => {
  it("Claude: tool env and gate MCP carry the scope; the prompt names the grant but never the scope; the executor reports the grant", async () => {
    type Seen = { prompt: string; options: { env: Record<string, string>; mcpServers?: unknown; extraArgs?: Record<string, string> }; mcp: { mcpServers: Record<string, { env: Record<string, string> }> } | null };
    let seen: Seen | null = null;
    const mock = (args: Omit<Seen, "mcp">) => {
      const file = args.options.extraArgs?.["mcp-config"];
      seen = { ...args, mcp: file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null };
    };
    fakeQuery.mockImplementation(async function* (args: Omit<Seen, "mcp">) {
      mock(args);
      yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 }, session_id: "s" };
    });
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const out = await claudeExecutor({ gate }).run(input(fixture(), { emit: (type, payload) => { events.push({ type, payload }); } }));
    expect(out).toMatchObject({ ok: true, lastText: "ok" });
    const got = seen! as Seen;
    expect(got.options.env.HTTPS_PROXY).toBe(scoped);
    expect(got.options.mcpServers).toBeUndefined();   // never inline: the SDK would put it into argv
    expect(existsSync(got.options.extraArgs!["mcp-config"]!)).toBe(false);   // removed with the run dir
    expect(got.mcp!.mcpServers["secret-gate"]!.env.SECRET_GATE_SCOPE).toBe(scope);
    expect(JSON.parse(got.mcp!.mcpServers.playwright!.env.SECRET_GATE_TRANSFER!)).toEqual(transfer);
    expect(got.prompt).toContain("Authorized field transfer");
    expect(got.prompt).toContain("email, phone from crm.example.com to erp.example.com:8443");
    expect(got.prompt).not.toContain(scope);
    expect(events).toContainEqual({ type: "transfer_grant", payload: { status: "applied", harness: "claude-code" } });
    // Browser off for this executor: no browser gate, so the prompt must not promise a transfer, and the audit says so.
    fakeQuery.mockImplementation(async function* (args: Omit<Seen, "mcp">) { mock(args); yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: {}, session_id: "s" }; });
    const off: { type: string; payload: Record<string, unknown> }[] = [];
    await claudeExecutor({ gate, browser: false }).run(input(fixture(), { emit: (type, payload) => { off.push({ type, payload }); } }));
    expect((seen! as Seen).prompt).not.toContain("Authorized field transfer");
    expect((seen! as Seen).mcp!.mcpServers.playwright).toBeUndefined();
    expect(off).toContainEqual({ type: "transfer_grant", payload: { status: "inactive", harness: "claude-code", reason: "browser not attached for this executor" } });
    // No scope (the refs wrapper fell back): the grant is not wired and the audit says why.
    const noScope: { type: string; payload: Record<string, unknown> }[] = [];
    await claudeExecutor({ gate }).run(input(fixture(), { gateScope: null, emit: (type, payload) => { noScope.push({ type, payload }); } }));
    expect((seen! as Seen).mcp!.mcpServers.playwright!.env.SECRET_GATE_TRANSFER).toBeUndefined();
    expect(noScope).toContainEqual({ type: "transfer_grant", payload: { status: "inactive", harness: "claude-code", reason: "no execution scope (short references unavailable for this run)" } });
  });

  it("OpenCode: process env (shell tool) has the scoped proxy, config has scope and grant, argv has no scope", async () => {
    const dir = fixture(); const out = join(dir, "seen.json");
    const bin = join(dir, "fake-opencode");
    writeFileSync(bin, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({argv:process.argv.slice(2),proxy:process.env.HTTPS_PROXY,config:JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG,'utf8'))}));console.log(JSON.stringify({type:'text',part:{text:'done'}}));`, { mode: 0o700 });
    const result = await opencodeExecutor({ binary: bin, gate }).run(input(dir));
    expect(result).toMatchObject({ ok: true, lastText: "done" });
    const seen = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; proxy: string; config: { mcp: Record<string, { environment: Record<string, string> }> } };
    expect(seen.proxy).toBe(scoped);
    expect(seen.config.mcp["secret-gate"]!.environment.SECRET_GATE_SCOPE).toBe(scope);
    expect(JSON.parse(seen.config.mcp.playwright!.environment.SECRET_GATE_TRANSFER!)).toEqual(transfer);
    expect(seen.argv.join(" ")).not.toContain(scope);
    expect(seen.argv.at(-1)).toContain("Authorized field transfer");
  });

  it("Codex: config.toml has the scoped shell proxy, the app-server process has none, the prompt names the grant", async () => {
    const dir = fixture(); const out = join(dir, "seen.json"); const authPath = join(dir, "auth.json"); writeFileSync(authPath, "{}");
    const bin = join(dir, "fake-codex");
    writeFileSync(bin, `#!${process.execPath}\nconst fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});
      const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
      rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;
        if(m.method==='turn/start'){fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({proxy:process.env.HTTPS_PROXY??null,toml:fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8'),prompt:m.params.input[0].text}));
          send({id:m.id,result:{}});send({method:'item/completed',params:{item:{type:'agentMessage',text:'done'}}});send({method:'turn/completed',params:{turn:{}}});}
        else send({id:m.id,result:m.method==='thread/start'?{thread:{id:'t'}}:{}});});`, { mode: 0o700 });
    const result = await codexExecutor({ binary: bin, authPath, gate, maxMs: 5000 }).run(input(dir));
    expect(result).toMatchObject({ ok: true, lastText: "done" });
    const seen = JSON.parse(readFileSync(out, "utf8")) as { proxy: string | null; toml: string; prompt: string };
    expect(seen.proxy).toBeNull();
    expect(seen.toml).toContain(`https_proxy = ${JSON.stringify(scoped)}`);
    expect(seen.toml).toContain(`SECRET_GATE_SCOPE = ${JSON.stringify(scope)}`);
    expect(seen.toml).toContain("SECRET_GATE_TRANSFER = ");
    expect(seen.prompt).toContain("Authorized field transfer");
    expect(seen.prompt).not.toContain(scope);
  });
});

describe("gate proxy health (gate-next-v0 §3)", () => {
  it("parses the proxy endpoint", () => {
    expect(proxyEndpoint("http://127.0.0.1:8080")).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(proxyEndpoint("http://[::1]:8080")).toEqual({ host: "::1", port: 8080 });
    expect(proxyEndpoint("http://localhost")).toEqual({ host: "localhost", port: 80 });
    expect(proxyEndpoint("https://gate.local")).toEqual({ host: "gate.local", port: 443 });
    expect(proxyEndpoint("not a url")).toBeNull();
  });

  it("is healthy while something listens, and names the failure when nothing does", async () => {
    const server = createServer((socket) => socket.end());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    expect(await gateHealth({ proxy: `http://127.0.0.1:${port}` })).toEqual({ ok: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const down = await gateHealth({ proxy: `http://127.0.0.1:${port}` });
    expect(down).toEqual({ ok: false, error: `127.0.0.1:${port}: ECONNREFUSED` });
    expect(await gateHealth({ proxy: "::nonsense" })).toEqual({ ok: false, error: "invalid proxy address ::nonsense" });
  });

  it("gives up after its timeout when the connection never completes", async () => {
    const silent = new Socket();   // never dialled: neither connects nor fails
    expect(await gateHealth({ proxy: "http://127.0.0.1:8080" }, 30, () => silent)).toEqual({ ok: false, error: "127.0.0.1:8080 did not answer within 30 ms" });
    expect(silent.destroyed).toBe(true);
  });

  it("start-up check: logs a clear error with the fix when the proxy is down, stays quiet when it is up", async () => {
    const logs: string[] = [];
    expect(await checkGateProxy(null, (m) => logs.push(m))).toBe(false);
    expect(logs).toEqual([]);
    const server = createServer((socket) => socket.end());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    expect(await checkGateProxy({ ...gate, proxy: `http://127.0.0.1:${port}` }, (m) => logs.push(m))).toBe(true);
    expect(logs).toEqual([]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await checkGateProxy({ ...gate, proxy: `http://127.0.0.1:${port}` }, (m) => logs.push(m))).toBe(false);
    expect(logs[0]).toMatch(/^ERROR secret-gate proxy .* is not reachable/);
    expect(logs[0]).toContain("secret-gate service install");
    expect(logs[0]).toContain("secret-gate proxy");
  });
});
