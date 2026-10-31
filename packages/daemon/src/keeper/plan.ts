/** What the keeper of a node without the Mac app starts, and with what (docs/mesh-v0.md §4.1–4.2): the gate, then the
 *  daemon, each with the environment the Mac app gives it (mac-app `ChildEnvironment`, `RuntimePlan`). Pure apart from
 *  reading files and asking the login shell for its PATH. */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { which } from "../util/which.js";

export const DEFAULT_PORTS = { local: 4711, opencode: 4712, remote: 4713, gate: 8080 } as const;
export type Ports = { local: number; opencode: number; remote: number; gate: number };

/** `$AGENTSWITCH_HOME/node.json`: this node's own settings, the part the Mac app keeps in its preferences. All optional. */
export type NodeSettings = {
  /** What other nodes and phones call this one (the remote listener's name; else the host name). */
  readonly name?: string;
  readonly ports?: Partial<Ports>;
  /** The remote listener for paired phones and nodes; on unless false. */
  readonly remote?: boolean;
  /** `echo` only for trying things out; real agents otherwise. */
  readonly executors?: "real" | "echo";
  /** `echo` skips the dispatch model (no OpenCode); the default is OpenCode's. */
  readonly router?: "opencode" | "echo";
  /** The addresses to offer instead of the ones found (`AGENTSWITCH_LAN`, remote/address.ts). */
  readonly lan?: string;
  /** Terminals outlive a restart of the service, each on a holder of its own (docs/terminal-v0.md §10); on unless false. */
  readonly holdTerminals?: boolean;
  /** The language `agentswitch config` speaks (docs/tui-v0.md §5.2): `en`, `zh-Hans`, `zh-Hant`, `ja`, `es`. Kept here
   *  because the service's own environment says `C.UTF-8`. */
  readonly language?: string;
};

export const SETTINGS_FILE = "node.json";

export function readSettings(home: string): NodeSettings {
  const file = join(home, SETTINGS_FILE);
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: not a JSON object`);
  return raw as NodeSettings;
}

export function writeSettings(home: string, next: NodeSettings): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, SETTINGS_FILE), tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The ports in effect: each a TCP port, all different (else the defaults, saying why). */
export function portsOf(settings: NodeSettings): Ports {
  const p = { ...DEFAULT_PORTS, ...settings.ports };
  const all = Object.values(p);
  if (all.some((n) => !Number.isInteger(n) || n < 1024 || n > 65535)) throw new Error(`node.json ports must be 1024–65535: ${JSON.stringify(settings.ports)}`);
  if (new Set(all).size !== all.length) throw new Error(`node.json ports must all differ: ${JSON.stringify(p)}`);
  return p;
}

/** Where the keeper finds what it runs. A runtime (packages/linux build) is `<root>/node/bin/node`,
 *  `<root>/daemon/dist/cli.js`, `<root>/python/bin/secret-gate`; from a checkout the gate is the package's .venv. */
export type Layout = {
  /** The daemon's command line, without `serve`: how this very process was started. */
  readonly daemon: readonly string[];
  readonly gate: string;
  /** The folder of the node binary, for agents that need one when the login shell has none. */
  readonly nodeBin: string;
  readonly runtime: string | null;
};

const HERE = dirname(fileURLToPath(import.meta.url));

export function layout(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv, execArgv: readonly string[] = process.execArgv, execPath: string = process.execPath): Layout {
  const daemonDir = resolve(HERE, "..", "..");            // <root>/daemon, or packages/daemon in a checkout
  const root = dirname(daemonDir);
  const inRuntime = existsSync(join(root, "python", "bin", "secret-gate"));
  const gate = env.SECRET_GATE_BIN?.trim() || (inRuntime ? join(root, "python", "bin", "secret-gate") : join(root, "secret-gate", ".venv", "bin", "secret-gate"));
  return { daemon: [execPath, ...execArgv, argv[1]!], gate, nodeBin: dirname(execPath), runtime: inRuntime ? root : null };
}

/** The variables a child takes from the keeper; everything else is set on purpose. No proxy variables: a node's own
 *  traffic goes the way the machine's does (mac-app `ChildEnvironment.base`). */
const INHERITED = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SSH_AUTH_SOCK",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "DBUS_SESSION_BUS_ADDRESS"] as const;

function base(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of INHERITED) { const v = env[k]; if (v) out[k] = v; }
  out.HOME ??= homedir();
  out.LANG ??= "C.UTF-8";
  return out;
}

/** The agents the daemon drives, by the variable it reads for each (daemon.ts `terminalBinaries`). */
export const AGENT_BINS = { CLAUDE_BIN: "claude", CODEX_BIN: "codex", OPENCODE_BIN: "opencode", PI_BIN: "pi" } as const;

export function agentBins(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, name] of Object.entries(AGENT_BINS)) { const found = which(name, path); if (found) out[key] = found; }
  return out;
}

export type Plan = { readonly gateEnv: Record<string, string>; readonly daemonEnv: Record<string, string> };

export function plan(input: { env: NodeJS.ProcessEnv; home: string; gateHome: string; settings: NodeSettings; ports: Ports; layout: Layout; path: string }): Plan {
  const { env, home, gateHome, settings, ports, layout: l, path } = input;
  const gateEnv = { ...base(env), PATH: `${dirname(l.gate)}:/usr/bin:/bin`, SECRET_GATE_HOME: gateHome, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
  const remote = settings.remote !== false;
  const daemonEnv: Record<string, string> = {
    ...base(env),
    PATH: path,
    AGENTSWITCH_HOME: home,
    AGENTSWITCH_PORT: String(ports.local),
    AGENTSWITCH_OPENCODE_PORT: String(ports.opencode),
    AGENTSWITCH_REMOTE: remote ? "1" : "0",
    ...(remote ? { AGENTSWITCH_REMOTE_PORT: String(ports.remote) } : {}),
    ...(remote && settings.name?.trim() ? { AGENTSWITCH_REMOTE_NAME: settings.name.trim() } : {}),
    ...(settings.lan?.trim() ? { AGENTSWITCH_LAN: settings.lan.trim() } : {}),
    AGENTSWITCH_EXECUTORS: settings.executors === "echo" ? "echo" : "real",
    AGENTSWITCH_HOLD_TERMINALS: settings.holdTerminals === false ? "0" : "1",
    // A terminal outliving this runtime runs its hooks and its browser bridge through `current` (daemon.ts `stable`).
    ...(l.runtime ? { AGENTSWITCH_RUNTIME_LINK: join(dirname(l.runtime), "current") } : {}),
    ...(settings.router === "echo" ? { AGENTSWITCH_ROUTER: "echo" } : {}),
    SECRET_GATE_HOME: gateHome,
    SECRET_GATE_BIN: l.gate,
    SECRET_GATE_PROXY: `http://127.0.0.1:${ports.gate}`,
    PYTHONDONTWRITEBYTECODE: "1",
    ...agentBins(path),
  };
  return { gateEnv, daemonEnv };
}

/** Folders added after the login shell's PATH, where agents and tools are usually installed (mac-app
 *  `LoginShellPath.fallbacks`, with Linux's), then the runtime's own node for agents that need one. */
export function mergedPath(shellPath: string | null, home: string, nodeBin: string): string {
  const fallbacks = [join(home, ".local", "bin"), join(home, ".opencode", "bin"), join(home, ".npm-global", "bin"), join(home, ".bun", "bin"),
    "/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin", nodeBin];
  const all = [...(shellPath ?? "").split(delimiter), ...fallbacks].filter((d) => d.startsWith("/"));
  return [...new Set(all)].join(delimiter);
}

const BEGIN = "__AGENTSWITCH_PATH_BEGIN__", END = "__AGENTSWITCH_PATH_END__";
const SHELL_TIMEOUT_MS = 5_000;

/** What `PATH` the user's interactive login shell sets (a systemd user service has none of it), or null. The shell
 *  runs in a session of its own, without the terminal: an interactive shell given a terminal takes it over for job
 *  control and leaves its own group in front when it ends, so whatever asked from that terminal (`agentswitch config`'s
 *  Environment page, through doctor) is stopped the next time it reads a key ("suspended (tty input)"). */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  let shell = env.SHELL;
  try { shell ||= userInfo().shell ?? undefined; } catch { /* no passwd entry */ }
  shell ||= "/bin/sh";
  const home = env.HOME ?? homedir();
  return new Promise((done) => {
    const child = spawn(shell!, ["-lic", `printf '%s%s%s' '${BEGIN}' "$PATH" '${END}'`],
      { env: { HOME: home, USER: env.USER ?? "", TERM: "dumb", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, cwd: home, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let s = "";
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, SHELL_TIMEOUT_MS);
    child.stdout!.setEncoding("utf8").on("data", (d: string) => { s += d; });
    const finish = () => {
      clearTimeout(timer);
      const i = s.lastIndexOf(BEGIN), j = s.lastIndexOf(END);
      done(i >= 0 && j > i ? s.slice(i + BEGIN.length, j) || null : null);
    };
    child.on("error", finish);
    child.on("close", finish);
  });
}
