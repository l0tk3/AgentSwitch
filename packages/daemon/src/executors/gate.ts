/** secret-gate wiring shared by the real executors: proxy env, MCP entries, per-harness config text.
 *  Mirrors packages/secret-gate/scripts/*_browser_demo.sh, which are the verified reference. */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { TransferGrant } from "../core/transfer.js";
import { which } from "../util/which.js";
import type { ExecutionInput } from "./types.js";

export type GateOptions = {
  readonly bin: string;            // .../packages/secret-gate/.venv/bin/secret-gate
  readonly home: string;           // ~/.secret-gate
  /** The gate's CA certificate the executors trust: `$SECRET_GATE_CA` (the service's published copy, gate-service-v0
   *  §3.3), else `<home>/ca.pem`. */
  readonly ca?: string;
  readonly proxy: string;          // http://127.0.0.1:8080
  readonly playwrightVersion: string;
  readonly allowedOrigins: readonly string[];
  /** The browser Playwright MCP starts when it is not Google Chrome where Playwright looks for it: off macOS without
   *  /opt/google/chrome, a Chromium on the PATH (mesh-v0 §4.4). Absent: Playwright's own choice, Chrome. */
  readonly browserExecutable?: string;
};

/** The proxy health check: a TCP connect that takes longer counts as down. */
const HEALTH_TIMEOUT_MS = 1_500;

export { VENV_GATE_BIN, gateBin, gateNotFound } from "../core/gateBin.js";
import { VENV_GATE_BIN, gateBin } from "../core/gateBin.js";

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
    ...withBrowser(chromeExecutable(env)),
  };
}

const withBrowser = (path: string | null) => path ? { browserExecutable: path } : {};

/** Google Chrome where Playwright's `chrome` channel looks on Linux, else a Chromium on the PATH; null on macOS, where
 *  the channel finds Chrome itself, and when there is neither. `AGENTSWITCH_CHROME` names one outright. */
export function chromeExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string | null {
  if (env.AGENTSWITCH_CHROME) return env.AGENTSWITCH_CHROME;
  if (platform === "darwin" || exists("/opt/google/chrome/chrome")) return null;
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    const found = which(name, env.PATH);
    if (found) return found;
  }
  return null;
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

function gateMcpEnv(gate: GateOptions, run: GateRun = {}): Record<string, string> {
  return { SECRET_GATE_HOME: gate.home, ...(run.scope ? { SECRET_GATE_SCOPE: run.scope } : {}) };
}

/** The browser gate: home and scope, plus the §5.2 grant as JSON, only ever together with a scope. */
function browserMcpEnv(gate: GateOptions, run: GateRun): Record<string, string> {
  return { ...gateMcpEnv(gate, run), ...(run.scope && run.transfer ? { SECRET_GATE_TRANSFER: JSON.stringify(run.transfer) } : {}) };
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

const playwrightPackage = (gate: GateOptions): string => `@playwright/mcp@${gate.playwrightVersion}`;

function playwrightArgs(gate: GateOptions, profile: string): string[] {
  return ["browser", "--", "npx", "-y", "--prefer-offline", playwrightPackage(gate),
    `--proxy-server=${gate.proxy}`, "--ignore-https-errors", `--user-data-dir=${profile}`,
    ...(gate.browserExecutable ? [`--executable-path=${gate.browserExecutable}`] : []),
    ...(gate.allowedOrigins.length ? [`--allowed-origins=${gate.allowedOrigins.join(";")}`] : [])];
}

/** At start-up, in the background: the browser MCP fetched once without `--prefer-offline`. The executors run it with
 *  that flag (a browser step starts without asking the registry), which also trusts npm's cached list of a package's
 *  versions; a list cached before the pinned version's Playwright was published fails every browser step with
 *  ETARGET until something refreshes it (seen on a Linux node whose npm cache was older, mesh-v0 §12). */
export function warmBrowserMcp(gate: GateOptions | null, run: (cmd: string, args: string[], done: (err: Error | null) => void) => void =
  (cmd, args, done) => { execFile(cmd, args, { timeout: 180_000 }, (err) => done(err)); }): void {
  if (!gate) return;
  run("npx", ["-y", playwrightPackage(gate), "--version"], (err) => {
    if (err) console.error(`browser MCP: ${playwrightPackage(gate)} could not be fetched (${err.message.split("\n")[0]}); browser steps may fail`);
  });
}

/** MCP servers in Claude Code / Agent SDK shape. */
export function claudeMcpServers(gate: GateOptions, profile: string, browser: boolean, run: GateRun = {}): Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> }> {
  const env = gateMcpEnv(gate, run);
  return {
    "secret-gate": { type: "stdio", command: gate.bin, args: ["mcp"], env },
    ...(browser ? { playwright: { type: "stdio", command: gate.bin, args: playwrightArgs(gate, profile), env: browserMcpEnv(gate, run) } } : {}),
  };
}

/** OpenCode `mcp` + `permission` sections. */
export function opencodeGateConfig(gate: GateOptions, profile: string, browser: boolean, run: GateRun = {}): { mcp: Record<string, unknown>; readDeny: Record<string, string> } {
  const environment = gateMcpEnv(gate, run);
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
export function codexGateToml(gate: GateOptions, profile: string, browser: boolean, run: GateRun = {}): string {
  const set = Object.entries(gateEnv(gate, run.scope)).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ");
  const pw = browser
    ? `\n[mcp_servers.playwright]\ncommand = ${JSON.stringify(gate.bin)}\nargs = ${JSON.stringify(playwrightArgs(gate, profile))}\n\n[mcp_servers.playwright.env]\n${tomlTable(browserMcpEnv(gate, run))}\n`
    : "";
  const mcpEnv = tomlTable(gateMcpEnv(gate, run));
  return `[sandbox_workspace_write]\nnetwork_access = true\n\n[shell_environment_policy]\ninherit = "all"\nset = { ${set} }\n\n[mcp_servers.secret-gate]\ncommand = ${JSON.stringify(gate.bin)}\nargs = ["mcp"]\n\n[mcp_servers.secret-gate.env]\n${mcpEnv}\n${pw}`;
}
