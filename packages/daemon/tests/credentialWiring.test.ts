import { describe, expect, it } from "vitest";
import { codexConfigToml } from "../src/executors/codex.js";
import { claudeMcpServers, codexGateToml, gateEnv, mcpServerEnv, opencodeGateConfig, withoutCredentialRepair, type GateOptions } from "../src/executors/gate.js";
import { CREDENTIAL_REPAIR_GUIDANCE, executorInstructions } from "../src/executors/instructions.js";
import { opencodeExecConfig } from "../src/executors/opencode.js";

const gate: GateOptions = { bin: "/test/secret-gate", home: "/test/gate-home", proxy: "http://127.0.0.1:8080", playwrightVersion: "test", allowedOrigins: [] };
const repair = { url: "http://127.0.0.1:43210/repair", key: "test-only-per-execution-key" };
const expected = { SECRET_GATE_HOME: gate.home, SECRET_GATE_REPAIR_URL: repair.url, SECRET_GATE_REPAIR_KEY: repair.key };

describe("credential-repair capability wiring", () => {
  it("only Claude's secret-gate MCP gets the repair capability", () => {
    const servers = claudeMcpServers(gate, "/profile", true, repair);
    expect(servers["secret-gate"]!.env).toEqual(expected);
    expect(servers.playwright!.env).toEqual({ SECRET_GATE_HOME: gate.home });
    expect(claudeMcpServers(gate, "/profile", false)["secret-gate"]!.env).toEqual({ SECRET_GATE_HOME: gate.home });
  });

  it("only OpenCode's gate MCP gets it, including through the executor config", () => {
    const cfg = opencodeGateConfig(gate, "/profile", true, repair);
    expect(cfg.mcp["secret-gate"]).toMatchObject({ environment: expected });
    expect(cfg.mcp.playwright).toMatchObject({ environment: { SECRET_GATE_HOME: gate.home } });
    const executor = opencodeExecConfig(gate, "/profile", true, { mcp: { extra: { environment: { PATH: "/bin" } } } }, repair) as { mcp: Record<string, { environment: Record<string, string> }> };
    expect(executor.mcp["secret-gate"]!.environment).toEqual(expected);
    expect(executor.mcp.extra!.environment).not.toHaveProperty("SECRET_GATE_REPAIR_KEY");
    expect(JSON.stringify(opencodeExecConfig(null, "/profile", false, {}, repair))).not.toContain(repair.key);
  });

  it("Codex stores the capability in gate MCP env, never shell policy or the browser", () => {
    const toml = codexGateToml(gate, "/profile", true, repair);
    const [shell, mcp] = toml.split("[mcp_servers.secret-gate.env]");
    expect(shell).not.toContain("SECRET_GATE_REPAIR");
    expect(mcp!.split("[mcp_servers.playwright]")[0]).toContain(`SECRET_GATE_REPAIR_KEY = "${repair.key}"`);
    expect(mcp!.split("[mcp_servers.playwright]")[1]).not.toContain("SECRET_GATE_REPAIR");
    expect(codexConfigToml(gate, "/profile", false, "high", "", repair)).toContain(repair.key);
    expect(codexConfigToml(null, "/profile", false, null, "", repair)).not.toContain(repair.key);
  });

  it("scrubs inherited repair variables and never injects them into generic MCP or shell env", () => {
    const parent = { PATH: "/bin", HOME: "/test/home", SECRET_GATE_REPAIR_URL: repair.url, SECRET_GATE_REPAIR_KEY: repair.key };
    expect(withoutCredentialRepair(parent)).toEqual({ PATH: "/bin", HOME: "/test/home" });
    expect(parent.SECRET_GATE_REPAIR_KEY).toBe(repair.key);
    expect(gateEnv(gate)).not.toHaveProperty("SECRET_GATE_REPAIR_KEY");
    expect(mcpServerEnv(gate, parent)).not.toHaveProperty("SECRET_GATE_REPAIR_KEY");
    expect(mcpServerEnv(null, parent)).not.toHaveProperty("SECRET_GATE_REPAIR_URL");
  });

  it("guidance limits repair to explicit original authorization and retrying the failed field", () => {
    expect(executorInstructions({ executor: "/missing", gate: "/missing" })).toContain(CREDENTIAL_REPAIR_GUIDANCE);
    expect(CREDENTIAL_REPAIR_GUIDANCE).toContain('purpose="totp_seed_import"');
    expect(CREDENTIAL_REPAIR_GUIDANCE).toContain("原用户任务明确授权");
    expect(CREDENTIAL_REPAIR_GUIDANCE).toContain("仅重试刚失败的那个种子字段录入");
    expect(CREDENTIAL_REPAIR_GUIDANCE).toContain("不要猜测、改造、解码 token");
    expect(CREDENTIAL_REPAIR_GUIDANCE).toContain("普通 provider safeguard 不是凭据用途错误");
  });
});
