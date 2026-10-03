/** The local servers a new tab offers (browser-v0 §2 本地开发服务): the current user's TCP listeners on this Mac, as
 *  `lsof` sees them, with a short name for the program and its folder. Listeners on 127.0.0.1 / ::1 are listed, and
 *  those on every interface (`*`, as `next dev` binds), as long as the program runs in a folder of the user's: apps keep
 *  loopback ports of their own (chat apps, proxies, sync agents), and they run in `/`, in their container under
 *  `~/Library` or inside their bundle, so those are left out. AgentSwitch's own are left out too: its ports, its own
 *  process and the servers it started (OpenCode), the bundled app's processes and the gate's proxy. Full command lines
 *  never leave this module (they can carry tokens); only the program's name does. */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LSOF_TIMEOUT_MS = 5_000;
const LSOF_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_SERVERS = 100;

export type LocalServer = {
  readonly port: number;
  /** `loopback` (127.0.0.1 / ::1) or `all` (every interface). */
  readonly bind: "loopback" | "all";
  readonly pid: number;
  /** A short name: `vite`, `next-server`, `python3 -m http.server`, `ruby`. */
  readonly name: string;
  readonly cwd: string;
  readonly url: string;
};

/** One listening socket as `lsof -F pcRn` reports it. */
export type Listener = { readonly pid: number; readonly ppid: number; readonly command: string; readonly host: string; readonly port: number };

/** `lsof -F pcRn` output (lines `p<pid>`, `c<command>`, `R<ppid>`, `f<fd>`, `n<address>`) as listeners. */
export function parseListeners(output: string): Listener[] {
  const out: Listener[] = [];
  let pid = 0;
  let ppid = 0;
  let command = "";
  for (const line of output.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") { pid = Number(value); ppid = 0; command = ""; }
    else if (tag === "c") command = value;
    else if (tag === "R") ppid = Number(value);
    else if (tag === "n") {
      const m = /^(.*):(\d+)$/.exec(value);
      if (!m || !pid) continue;
      out.push({ pid, ppid, command, host: m[1]!.replace(/^\[|\]$/g, ""), port: Number(m[2]) });
    }
  }
  return out;
}

/** `lsof -a -d cwd -F pn` output as pid → folder. */
export function parseCwds(output: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
  }
  return out;
}

/** `ps -o pid=,command=` output as pid → command line. */
export function parseCommands(output: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]!.trim());
  }
  return out;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const EVERYWHERE = new Set(["*", "0.0.0.0", "::"]);
const INTERPRETERS = /^(node|nodejs|bun|deno|python[\d.]*|ruby|php|perl|java)$/i;
/** AgentSwitch's own processes, by command line: the bundled app, the gate's proxy, the harness's OpenCode servers. */
const OWN_COMMAND = [/\/AgentSwitch\.app\/Contents\//, /\bsecret-gate\b.*\bproxy\b/, /\bopencode\b.*\bserve\b.*--stdio\b/];

/** A script an interpreter runs: a file with a script's extension, or one in a `bin` folder (`node_modules/.bin/vite`,
 *  `bin/rails`). Anything else on the command line (a flag's value: a token, a password) is never a name. */
const SCRIPT_FILE = /\.(m?js|cjs|m?ts|cts|py|rb|php|pl|jar)$/i;
const IN_BIN = /(^|\/)\.?bin\/[^/]+$/;
const PYTHON_MODULE = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;
const SHOWN_NAME = /^[\w.@+-]{1,64}$/;

/** A short name for a listener's program: the executable's own name; for an interpreter, the script it runs (`vite`)
 *  or Python's `-m module`. Only names: never another word of the command line (it can hold a token). */
export function serverName(command: string, processName: string): string {
  const words = command.split(/\s+/).filter(Boolean);
  const exe = basename(words[0] ?? processName);
  if (!INTERPRETERS.test(exe)) return processName || exe;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w === "-m") return words[i + 1] && PYTHON_MODULE.test(words[i + 1]!) && words[i + 1]!.length <= 64 ? `${exe} -m ${words[i + 1]}` : exe;
    if (w.startsWith("-") || !(SCRIPT_FILE.test(w) || IN_BIN.test(w))) continue;
    const name = basename(w).replace(SCRIPT_FILE, "");
    return SHOWN_NAME.test(name) ? name : exe;
  }
  return exe;
}

export type ServerFilter = {
  /** Ports never listed (the local API, remote, gate proxy, OpenCode router). */
  readonly ports: readonly number[];
  /** The daemon's pid: its own listeners and its children's (OpenCode servers) are left out. */
  readonly pid: number;
  readonly home: string;
};

/** A folder an app, not a person, runs in: `/`, system folders, an app bundle, an app's container under ~/Library. */
export function appFolder(cwd: string, home: string): boolean {
  return cwd === "/" || cwd.startsWith(`${home}/Library/`) || /\.app(\/|$)/.test(cwd) || /^\/(System|Library|Applications|usr|bin|sbin)(\/|$)/.test(cwd);
}

/** Listeners → the list: loopback or everywhere, run from a folder of the user's, not AgentSwitch's, one per port. */
export function localServers(listeners: readonly Listener[], cwds: ReadonlyMap<number, string>, commands: ReadonlyMap<number, string>, filter: ServerFilter): LocalServer[] {
  const byPort = new Map<number, LocalServer>();
  for (const l of listeners) {
    const loopback = LOOPBACK.has(l.host);
    const cwd = cwds.get(l.pid) ?? null;
    if ((!loopback && !EVERYWHERE.has(l.host)) || !cwd || appFolder(cwd, filter.home)) continue;
    if (filter.ports.includes(l.port) || l.pid === filter.pid || l.ppid === filter.pid) continue;
    const command = commands.get(l.pid) ?? l.command;
    if (OWN_COMMAND.some((re) => re.test(command))) continue;
    const seen = byPort.get(l.port);
    if (seen && seen.bind === "loopback") continue;
    byPort.set(l.port, { port: l.port, bind: loopback ? "loopback" : "all", pid: l.pid, name: serverName(command, l.command), cwd, url: `http://localhost:${l.port}/` });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port).slice(0, MAX_SERVERS);
}

export type Run = (file: string, args: readonly string[]) => Promise<string>;

/** A command's stdout; lsof exits 1 when nothing matched, which is an empty answer, not a failure. */
const run: Run = async (file, args) => {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: LSOF_TIMEOUT_MS, maxBuffer: LSOF_MAX_BUFFER });
    return stdout;
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; killed?: boolean };
    if (e.code === 1 && !e.killed && typeof e.stdout === "string") return e.stdout;
    throw err;
  }
};

/** This user's local servers now. */
export async function listLocalServers(filter: ServerFilter, exec: Run = run, uid: number = process.getuid?.() ?? 0): Promise<LocalServer[]> {
  const listeners = parseListeners(await exec("lsof", ["-nP", "-a", "-u", String(uid), "-iTCP", "-sTCP:LISTEN", "-F", "pcRn"]));
  const pids = [...new Set(listeners.map((l) => l.pid))];
  if (!pids.length) return [];
  const list = pids.join(",");
  const [cwds, commands] = await Promise.all([
    exec("lsof", ["-a", "-p", list, "-d", "cwd", "-F", "pn"]).then(parseCwds, () => new Map<number, string>()),
    exec("ps", ["-o", "pid=,command=", "-p", list]).then(parseCommands, () => new Map<number, string>()),
  ]);
  return localServers(listeners, cwds, commands, filter);
}
