/** secret-gate wiring shared by the real executors: proxy env, MCP entries, per-harness config text.
 *  Mirrors packages/secret-gate/scripts/*_browser_demo.sh, which are the verified reference. */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CredentialRepair } from "./types.js";

export type GateOptions = {
  readonly bin: string;            // .../packages/secret-gate/.venv/bin/secret-gate
  readonly home: string;           // ~/.secret-gate
  readonly proxy: string;          // http://127.0.0.1:8080
  readonly playwrightVersion: string;
  readonly allowedOrigins: readonly string[];
};

const HERE = new URL(".", import.meta.url).pathname;

export function defaultGate(env: NodeJS.ProcessEnv = process.env): GateOptions | null {
  const bin = env.SECRET_GATE_BIN ?? resolve(HERE, "..", "..", "..", "secret-gate", ".venv", "bin", "secret-gate");
  if (!existsSync(bin)) return null;
  return {
    bin,
    home: env.SECRET_GATE_HOME ?? join(env.HOME ?? "", ".secret-gate"),
    proxy: env.SECRET_GATE_PROXY ?? "http://127.0.0.1:8080",
    playwrightVersion: env.PW_MCP_VERSION ?? "0.0.82",
    allowedOrigins: (env.AGENTSWITCH_BROWSER_ORIGINS ?? "").split(";").filter(Boolean),
  };
}

export const NO_PROXY_HOSTS = "127.0.0.1,localhost,api.anthropic.com,.anthropic.com,claude.ai,.claude.ai,api.openai.com,chatgpt.com,.openai.com,api.deepseek.com,.deepseek.com,.statsig.com,.sentry.io";

/** Proxy in both cases (curl honours lowercase for http://), plus the gate home. */
export function gateEnv(gate: GateOptions): Record<string, string> {
  return {
    SECRET_GATE_HOME: gate.home,
    HTTP_PROXY: gate.proxy, http_proxy: gate.proxy, HTTPS_PROXY: gate.proxy, https_proxy: gate.proxy,
    NO_PROXY: NO_PROXY_HOSTS, no_proxy: NO_PROXY_HOSTS,
  };
}

/** Keep the repair capability out of harness processes, ordinary shell tools and user extensions. */
export function withoutCredentialRepair(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { SECRET_GATE_REPAIR_URL: _url, SECRET_GATE_REPAIR_KEY: _key, ...rest } = env;
  return rest;
}

function gateMcpEnv(gate: GateOptions, repair?: CredentialRepair): Record<string, string> {
  return { SECRET_GATE_HOME: gate.home, ...(repair ? { SECRET_GATE_REPAIR_URL: repair.url, SECRET_GATE_REPAIR_KEY: repair.key } : {}) };
}

/** Env vars a spawned MCP server needs to run at all; the MCP stdio transport does not inherit
 *  the parent environment when an explicit env is given. */
const INHERITED = ["PATH", "HOME", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TERM"] as const;

export function inheritedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of INHERITED) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}

/** Env for a user MCP server behind the gate: enough to start, the proxy, and the gate CA so an
 *  intercepted TLS connection verifies. Without the CA the server would fail every HTTPS call. */
export function mcpServerEnv(gate: GateOptions | null | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!gate) return inheritedEnv(env);
  const ca = join(gate.home, "ca.pem");
  const trust = existsSync(ca) ? { NODE_EXTRA_CA_CERTS: ca, SSL_CERT_FILE: ca, REQUESTS_CA_BUNDLE: ca } : {};
  return { ...inheritedEnv(env), ...gateEnv(gate), ...trust };
}

export { stripProxy } from "../util/env.js";

function playwrightArgs(gate: GateOptions, profile: string): string[] {
  return ["browser", "--", "npx", "-y", "--prefer-offline", `@playwright/mcp@${gate.playwrightVersion}`,
    `--proxy-server=${gate.proxy}`, "--ignore-https-errors", `--user-data-dir=${profile}`,
    ...(gate.allowedOrigins.length ? [`--allowed-origins=${gate.allowedOrigins.join(";")}`] : [])];
}

/** MCP servers in Claude Code / Agent SDK shape. */
export function claudeMcpServers(gate: GateOptions, profile: string, browser: boolean, repair?: CredentialRepair): Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> }> {
  const env = gateMcpEnv(gate, repair);
  return {
    "secret-gate": { type: "stdio", command: gate.bin, args: ["mcp"], env },
    ...(browser ? { playwright: { type: "stdio", command: gate.bin, args: playwrightArgs(gate, profile), env: gateMcpEnv(gate) } } : {}),
  };
}

/** OpenCode `mcp` + `permission` sections. */
export function opencodeGateConfig(gate: GateOptions, profile: string, browser: boolean, repair?: CredentialRepair): { mcp: Record<string, unknown>; readDeny: Record<string, string> } {
  const environment = gateMcpEnv(gate, repair);
  return {
    mcp: {
      "secret-gate": { type: "local", command: [gate.bin, "mcp"], enabled: true, environment },
      ...(browser ? { playwright: { type: "local", command: [gate.bin, ...playwrightArgs(gate, profile)], enabled: true, environment: gateMcpEnv(gate) } } : {}),
    },
    readDeny: { [`${gate.home}/*`]: "deny" },
  };
}

/** Codex config.toml sections (proxy only for the shell tool; never in the codex process env). */
export function codexGateToml(gate: GateOptions, profile: string, browser: boolean, repair?: CredentialRepair): string {
  const set = Object.entries(gateEnv(gate)).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ");
  const pw = browser
    ? `\n[mcp_servers.playwright]\ncommand = ${JSON.stringify(gate.bin)}\nargs = ${JSON.stringify(playwrightArgs(gate, profile))}\n\n[mcp_servers.playwright.env]\nSECRET_GATE_HOME = ${JSON.stringify(gate.home)}\n`
    : "";
  const mcpEnv = Object.entries(gateMcpEnv(gate, repair)).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n");
  return `[sandbox_workspace_write]\nnetwork_access = true\n\n[shell_environment_policy]\ninherit = "all"\nset = { ${set} }\n\n[mcp_servers.secret-gate]\ncommand = ${JSON.stringify(gate.bin)}\nargs = ["mcp"]\n\n[mcp_servers.secret-gate.env]\n${mcpEnv}\n${pw}`;
}
