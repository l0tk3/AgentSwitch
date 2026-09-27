/** secret-gate wiring shared by the real executors: proxy env, MCP entries, per-harness config text.
 *  Mirrors packages/secret-gate/scripts/*_browser_demo.sh, which are the verified reference. */

import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TransferGrant } from "../core/transfer.js";
import { which } from "../util/which.js";
import type { CredentialRepair, ExecutionInput } from "./types.js";

export type GateOptions = {
  readonly bin: string;            // .../packages/secret-gate/.venv/bin/secret-gate
  readonly home: string;           // ~/.secret-gate
  /** The gate's CA certificate the executors trust: `$SECRET_GATE_CA` (the service's published copy, gate-service-v0
   *  §3.3), else `<home>/ca.pem`. */
  readonly ca?: string;
  readonly proxy: string;          // http://127.0.0.1:8080
  readonly playwrightVersion: string;
  readonly allowedOrigins: readonly string[];
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** The proxy health check: a TCP connect that takes longer counts as down. */
const HEALTH_TIMEOUT_MS = 1_500;

/** The monorepo's own secret-gate install (packages/secret-gate/.venv). */
export const VENV_GATE_BIN = resolve(HERE, "..", "..", "..", "secret-gate", ".venv", "bin", "secret-gate");

/** The secret-gate binary: $SECRET_GATE_BIN when set (authoritative: a wrong path finds nothing rather than silently
 *  falling back to another gate), else the repo's venv, else `secret-gate` on $PATH as an absolute path. Null when none. */
export function gateBin(env: NodeJS.ProcessEnv = process.env, venv: string = VENV_GATE_BIN): string | null {
  if (env.SECRET_GATE_BIN) return existsSync(env.SECRET_GATE_BIN) ? env.SECRET_GATE_BIN : null;
  if (existsSync(venv)) return venv;
  return which("secret-gate", env.PATH);
}

/** Why `gateBin` found nothing, naming the three places it looks, in its order. */
export function gateNotFound(env: NodeJS.ProcessEnv = process.env, venv: string = VENV_GATE_BIN): string {
  if (env.SECRET_GATE_BIN) return `secret-gate not found: $SECRET_GATE_BIN=${env.SECRET_GATE_BIN} does not exist (when set, it is the only place looked at; unset it to use the repo venv ${venv} or \`secret-gate\` on $PATH)`;
  return `secret-gate not found: $SECRET_GATE_BIN is not set, the repo venv ${venv} does not exist, and there is no \`secret-gate\` on $PATH`;
}

export function defaultGate(env: NodeJS.ProcessEnv = process.env, venv: string = VENV_GATE_BIN): GateOptions | null {
  const bin = gateBin(env, venv);
  if (!bin) return null;
  const home = env.SECRET_GATE_HOME ?? join(env.HOME ?? "", ".secret-gate");
  return {
    bin,
    home,
    ca: env.SECRET_GATE_CA || join(home, "ca.pem"),
    proxy: env.SECRET_GATE_PROXY ?? "http://127.0.0.1:8080",
    playwrightVersion: env.PW_MCP_VERSION ?? "0.0.82",
    allowedOrigins: (env.AGENTSWITCH_BROWSER_ORIGINS ?? "").split(";").filter(Boolean),
  };
}

export const NO_PROXY_HOSTS = "127.0.0.1,localhost,api.anthropic.com,.anthropic.com,claude.ai,.claude.ai,api.openai.com,chatgpt.com,.openai.com,api.deepseek.com,.deepseek.com,.statsig.com,.sentry.io";

/** What one execution adds to the gate wiring (gate-next-v0 §1, §5.2): its ref scope and, with the browser, an
 *  authorized field transfer. Both are capabilities of this run only: environment and config, never argv or logs. */
export type GateRun = { readonly scope?: string | null; readonly transfer?: TransferGrant | null };

/** The run's wiring: the transfer only rides along with a scope and an attached browser (the browser gate refuses it otherwise). */
export function gateRun(input: Pick<ExecutionInput, "gateScope" | "transfer">, browser: boolean): GateRun {
  const scope = input.gateScope ?? null;
  return { scope, transfer: scope && browser ? input.transfer ?? null : null };
}

/** §5.2 audit from the one place that knows: did this run's browser gate really receive the grant the engine offered? */
export function reportTransfer(input: Pick<ExecutionInput, "transfer" | "gateScope" | "emit">, run: GateRun, harness: string, gate: boolean, browser: boolean): void {
  if (!input.transfer) return;
  if (gate && run.transfer) { input.emit("transfer_grant", { status: "applied", harness }); return; }
  const reason = !gate ? "no secret-gate for this executor" : !input.gateScope ? "no execution scope (short references unavailable for this run)" : !browser ? "browser not attached for this executor" : "not wired";
  input.emit("transfer_grant", { status: "inactive", harness, reason });
}

/** `http://scope:<scope>@host:port`: curl and Python send it as Proxy-Authorization, which the proxy strips. */
export function scopedProxy(proxy: string, scope: string): string {
  const url = new URL(proxy);
  return `${url.protocol}//scope:${scope}@${url.host}`;
}

/** Proxy in both cases (curl honours lowercase for http://), plus the gate home. With a scope (the shell tools of one
 *  execution) the proxy URL carries it, so enc:ref: references resolve; user MCP servers get the scope-less form. */
/** Everything behind the gate needs the proxy and the gate's CA (design-v0 §3 工具子进程环境): the proxy intercepts
 *  TLS, so without the CA every HTTPS call from Python, curl or Node fails ("unable to get local issuer
 *  certificate"). The same three variables as secret-gate's harness snippets (harness_config.py CA_ENV_VARS). */
export function gateEnv(gate: GateOptions, scope?: string | null): Record<string, string> {
  const proxy = scope ? scopedProxy(gate.proxy, scope) : gate.proxy;
  return {
    SECRET_GATE_HOME: gate.home,
    HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: proxy, https_proxy: proxy,
    NO_PROXY: NO_PROXY_HOSTS, no_proxy: NO_PROXY_HOSTS,
    ...gateTrust(gate),
  };
}

/** The gate CA as trust variables, once `secret-gate install-ca` (or the Mac app) has exported it. */
function gateTrust(gate: Pick<GateOptions, "home" | "ca">): Record<string, string> {
  const ca = gate.ca ?? join(gate.home, "ca.pem");
  return existsSync(ca) ? { SSL_CERT_FILE: ca, REQUESTS_CA_BUNDLE: ca, NODE_EXTRA_CA_CERTS: ca } : {};
}

export type GateHealth = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** host and port of the proxy URL (default port by scheme), or null when it is not a usable URL. */
export function proxyEndpoint(proxy: string): { readonly host: string; readonly port: number } | null {
  try {
    const url = new URL(proxy);
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return host ? { host, port } : null;
  } catch { return null; }
}

/** §3 health check: can we open a TCP connection to the gate proxy? A dead proxy means no harness may start. */
export function gateHealth(gate: Pick<GateOptions, "proxy">, timeoutMs = HEALTH_TIMEOUT_MS, dial: (host: string, port: number) => Socket = (host, port) => connect({ host, port })): Promise<GateHealth> {
  const at = proxyEndpoint(gate.proxy);
  if (!at) return Promise.resolve({ ok: false, error: `invalid proxy address ${gate.proxy}` });
  return new Promise((resolve) => {
    const socket = dial(at.host, at.port);
    const done = (result: GateHealth) => { clearTimeout(timer); socket.destroy(); resolve(result); };
    const timer = setTimeout(() => done({ ok: false, error: `${at.host}:${at.port} did not answer within ${timeoutMs} ms` }), timeoutMs);
    socket.once("connect", () => done({ ok: true }));
    socket.once("error", (e: NodeJS.ErrnoException) => done({ ok: false, error: `${at.host}:${at.port}: ${e.code ?? e.message}` }));
  });
}

/** Keep the repair capability out of harness processes, ordinary shell tools and user extensions. */
export function withoutCredentialRepair(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { SECRET_GATE_REPAIR_URL: _url, SECRET_GATE_REPAIR_KEY: _key, ...rest } = env;
  return rest;
}

function gateMcpEnv(gate: GateOptions, repair?: CredentialRepair, run: GateRun = {}): Record<string, string> {
  return { SECRET_GATE_HOME: gate.home, ...(run.scope ? { SECRET_GATE_SCOPE: run.scope } : {}), ...(repair ? { SECRET_GATE_REPAIR_URL: repair.url, SECRET_GATE_REPAIR_KEY: repair.key } : {}) };
}

/** The browser gate: home and scope, plus the §5.2 grant as JSON, only ever together with a scope. */
function browserMcpEnv(gate: GateOptions, run: GateRun): Record<string, string> {
  return { ...gateMcpEnv(gate, undefined, run), ...(run.scope && run.transfer ? { SECRET_GATE_TRANSFER: JSON.stringify(run.transfer) } : {}) };
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
  return { ...inheritedEnv(env), ...gateEnv(gate) };
}

function playwrightArgs(gate: GateOptions, profile: string): string[] {
  return ["browser", "--", "npx", "-y", "--prefer-offline", `@playwright/mcp@${gate.playwrightVersion}`,
    `--proxy-server=${gate.proxy}`, "--ignore-https-errors", `--user-data-dir=${profile}`,
    ...(gate.allowedOrigins.length ? [`--allowed-origins=${gate.allowedOrigins.join(";")}`] : [])];
}

/** MCP servers in Claude Code / Agent SDK shape. */
export function claudeMcpServers(gate: GateOptions, profile: string, browser: boolean, repair?: CredentialRepair, run: GateRun = {}): Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> }> {
  const env = gateMcpEnv(gate, repair, run);
  return {
    "secret-gate": { type: "stdio", command: gate.bin, args: ["mcp"], env },
    ...(browser ? { playwright: { type: "stdio", command: gate.bin, args: playwrightArgs(gate, profile), env: browserMcpEnv(gate, run) } } : {}),
  };
}

/** OpenCode `mcp` + `permission` sections. */
export function opencodeGateConfig(gate: GateOptions, profile: string, browser: boolean, repair?: CredentialRepair, run: GateRun = {}): { mcp: Record<string, unknown>; readDeny: Record<string, string> } {
  const environment = gateMcpEnv(gate, repair, run);
  return {
    mcp: {
      "secret-gate": { type: "local", command: [gate.bin, "mcp"], enabled: true, environment },
      ...(browser ? { playwright: { type: "local", command: [gate.bin, ...playwrightArgs(gate, profile)], enabled: true, environment: browserMcpEnv(gate, run) } } : {}),
    },
    readDeny: { [`${gate.home}/*`]: "deny" },
  };
}

const tomlTable = (env: Record<string, string>): string => Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n");

/** Codex config.toml sections (proxy only for the shell tool; never in the codex process env). */
export function codexGateToml(gate: GateOptions, profile: string, browser: boolean, repair?: CredentialRepair, run: GateRun = {}): string {
  const set = Object.entries(gateEnv(gate, run.scope)).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ");
  const pw = browser
    ? `\n[mcp_servers.playwright]\ncommand = ${JSON.stringify(gate.bin)}\nargs = ${JSON.stringify(playwrightArgs(gate, profile))}\n\n[mcp_servers.playwright.env]\n${tomlTable(browserMcpEnv(gate, run))}\n`
    : "";
  const mcpEnv = tomlTable(gateMcpEnv(gate, repair, run));
  return `[sandbox_workspace_write]\nnetwork_access = true\n\n[shell_environment_policy]\ninherit = "all"\nset = { ${set} }\n\n[mcp_servers.secret-gate]\ncommand = ${JSON.stringify(gate.bin)}\nargs = ["mcp"]\n\n[mcp_servers.secret-gate.env]\n${mcpEnv}\n${pw}`;
}
