/** Registry MCP servers and skills in each harness's config shape. stdio servers inherit the gate
 *  proxy env so `enc:v1:` ciphertext in their env/headers is substituted on the wire like any other
 *  tool; the user's own env entries win over ours. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "../extensions/types.js";

export type ClaudeMcp = Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> } | { type: "http"; url: string; headers: Record<string, string> }>;

export function claudeMcpFromRegistry(servers: readonly McpServer[], baseEnv: Record<string, string>): ClaudeMcp {
  const out: ClaudeMcp = {};
  for (const s of servers) {
    out[s.name] = s.kind === "stdio"
      ? { type: "stdio", command: s.command!, args: [...s.args], env: { ...baseEnv, ...s.env } }
      : { type: "http", url: s.url!, headers: { ...s.headers } };
  }
  return out;
}

export function opencodeMcpFromRegistry(servers: readonly McpServer[], baseEnv: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    out[s.name] = s.kind === "stdio"
      ? { type: "local", command: [s.command!, ...s.args], environment: { ...baseEnv, ...s.env }, enabled: true }
      : { type: "remote", url: s.url!, headers: { ...s.headers }, enabled: true };
  }
  return out;
}

function tomlTable(header: string, entries: Record<string, string>): string {
  const body = Object.entries(entries).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join("\n");
  return body ? `\n[${header}]\n${body}\n` : "";
}

export function codexMcpToml(servers: readonly McpServer[], baseEnv: Record<string, string>): string {
  return servers.map((s) => {
    const head = `\n[mcp_servers.${JSON.stringify(s.name)}]\n`;
    if (s.kind === "stdio") {
      return `${head}command = ${JSON.stringify(s.command)}\nargs = ${JSON.stringify(s.args)}\n` + tomlTable(`mcp_servers.${JSON.stringify(s.name)}.env`, { ...baseEnv, ...s.env });
    }
    return `${head}url = ${JSON.stringify(s.url)}\n` + tomlTable(`mcp_servers.${JSON.stringify(s.name)}.http_headers`, s.headers);
  }).join("");
}

/** Names of servers whose tools Claude Code may call without a human: `mcp__<name>__*`. */
export function autoAllowedMcp(servers: readonly McpServer[]): ReadonlySet<string> {
  return new Set(servers.filter((s) => s.approval === "allow").map((s) => s.name));
}

/** Server name from a Claude tool name like `mcp__github__create_issue`, else null. */
export function mcpServerOf(toolName: string): string | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(toolName);
  return m ? m[1]! : null;
}

export const PLUGIN_NAME = "agentswitch";

/** Claude Code loads skills from a local plugin: <dir>/.claude-plugin/plugin.json + <dir>/skills/<name>/SKILL.md.
 *  Returns the plugin dir when it holds at least one skill, else null. */
export function claudePluginDir(root: string, skillsDir: string): string | null {
  if (!existsSync(skillsDir)) return null;
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: PLUGIN_NAME, version: "0.1.0", description: "Skills managed in AgentSwitch" }));
  return root;
}
