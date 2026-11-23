/** `agentswitch node run`: the keeper of a node without the Mac app (docs/mesh-v0.md §4.2). In the foreground, logs on
 *  standard output (systemd's journal): the gate first and, once it answers, the daemon; both kept running. SIGTERM or
 *  SIGINT stops the daemon, then the gate; SIGHUP reads node.json again and restarts the daemon (`agentswitch node
 *  restart`, after a setting changed).
 *
 *  With the gate installed as the system service (gate-simple-v0 §5, keeper/gateService.ts) the keeper starts no gate:
 *  it only watches the service's proxy and hands the daemon the service's public directory, CA and port. It never
 *  starts a gate of the user's own beside the service, not even when the service does not answer (that would quietly
 *  undo the isolation). The mode is looked at on every probe: once `sudo secret-gate system install` wrote
 *  gate-service.json the keeper stops its own gate (freeing the port for the service) and restarts the daemon; once
 *  `uninstall` removed it, it starts its own gate again. */

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Child, reap, startTime, type ChildSpec } from "./child.js";
import { gateMode, gatePort, type GateMode } from "./gateService.js";
import { layout, loginShellPath, mergedPath, plan, portsOf, readSettings, type Layout, type Ports } from "./plan.js";

const run = promisify(execFile);

/** How often both are asked whether they answer, and how many misses in a row count as down (mac-app `AppModel`).
 *  Neither is restarted for not answering in its first two minutes: starting is not failing. */
export const PROBE_EVERY_MS = 3_000;
const GATE_MISSES = 5, DAEMON_MISSES = 10, EXTERNAL_GATE_MISSES = 2;
const GRACE_MS = 120_000;
const GATE_WAIT_MS = 20_000;

export const KEEPER_PID = "keeper.pid";

/** The places a keeper works with, from the environment (the same defaults the daemon and the gate use). */
export function homes(env: NodeJS.ProcessEnv = process.env): { home: string; gateHome: string; runDir: string } {
  const user = env.HOME ?? homedir();
  const home = env.AGENTSWITCH_HOME ?? join(user, ".agentswitch");
  return { home, gateHome: env.SECRET_GATE_HOME ?? join(user, ".secret-gate"), runDir: join(home, "run") };
}

/** The pid of the keeper running for this home, or null. */
export function runningKeeper(runDir: string): number | null {
  try {
    const [pid, started] = readFileSync(join(runDir, KEEPER_PID), "utf8").trim().split(/\s+/);
    const n = Number(pid);
    return Number.isInteger(n) && started && startTime(n) === started ? n : null;
  } catch { return null; }
}

/** Whether the gate answers on `port` as the gate: a request for a loopback address carrying a ciphertext no key opens,
 *  which the gate refuses with 403 and `X-Secret-Gate: denied` before going anywhere (secret_gate/proxy_probe.py). */
export function probeGate(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((done) => {
    const sock = connect({ host: "127.0.0.1", port });
    let head = "", settled = false;
    const finish = (ok: boolean) => { if (settled) return; settled = true; sock.destroy(); done(ok); };
    const verdict = () => {
      const end = head.indexOf("\r\n\r\n");
      const block = head.slice(0, end < 0 ? head.length : end);
      return /^HTTP\/1\.[01] 403\b/.test(block) && /^x-secret-gate:\s*denied\s*$/im.test(block);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.on("error", () => finish(false));
    sock.on("close", () => finish(verdict()));
    sock.on("connect", () => sock.write("GET http://127.0.0.1:9/secret-gate-probe HTTP/1.1\r\nHost: 127.0.0.1:9\r\n" +
      `X-Secret-Gate-Probe: enc:v1:${"A".repeat(24)}\r\nConnection: close\r\n\r\n`));
    sock.on("data", (d) => {
      head += d.toString("latin1");
      if (head.includes("\r\n\r\n") || head.length >= 8192) finish(verdict());
    });
  });
}

/** Whether the daemon answers its liveness route. */
export async function probeDaemon(port: number, timeoutMs = 2_000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok && ((await res.json()) as { ok?: unknown }).ok === true;
  } catch { return false; }
}

/** The gate's keypair, made on the first run (mac-app `GateCLI.ensureKeypair`): `proxy` will not start without one.
 *  The gate has one keypair (gate-simple-v0 §1), made by `secret-gate keygen`. */
async function ensureKeypair(gate: string, env: Record<string, string>, log: (s: string) => void): Promise<void> {
  const list = JSON.parse((await run(gate, ["keys", "--json"], { env, timeout: 30_000 })).stdout) as unknown[];
  if (Array.isArray(list) && list.length) return;
  await run(gate, ["keygen"], { env, timeout: 30_000 });
  log("made the gate's keypair");
}

/** Whether the keeper has to hand the gate over or restart the daemon: the mode changed, or the service's port did. */
export function modeChanged(was: GateMode, now: GateMode): boolean {
  if (was.kind !== now.kind) return true;
  return was.kind === "service" && now.kind === "service" && (was.proxyPort !== now.proxyPort || was.publicDir !== now.publicDir);
}

/** What the keeper's log says about where the gate runs (doctor and `agentswitch gate` say it in the node's language). */
export function modeLine(mode: GateMode): string {
  if (mode.kind === "user") return "the gate runs as this account: it guards against values being seen by mistake, not against them being read on purpose (sudo secret-gate system install: agentswitch gate)";
  return `the gate runs as the system service (${mode.publicDir}); not starting one${mode.error ? ` (${mode.error})` : ""}`;
}

/** mitmproxy's CA as `<gate home>/ca.pem`, where the executors' trust is pointed (mac-app `syncCA`). */
function syncCA(gateHome: string, env: Record<string, string>, log: (s: string) => void): void {
  const from = join(env.HOME ?? homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem"), to = join(gateHome, "ca.pem");
  if (!existsSync(from)) return;
  const pem = readFileSync(from);
  if (existsSync(to) && readFileSync(to).equals(pem)) return;
  copyFileSync(from, to);
  log(`copied the gate's CA to ${to}`);
}

export async function runNode(env: NodeJS.ProcessEnv = process.env, out: (line: string) => void = (l) => console.log(l)): Promise<number> {
  const log = (s: string) => out(`[keeper] ${s}`);
  const { home, gateHome, runDir } = homes(env);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const other = runningKeeper(runDir);
  if (other && other !== process.pid) { log(`another keeper (pid ${other}) runs for ${home}; stop it first`); return 1; }
  writeFileSync(join(runDir, KEEPER_PID), `${process.pid} ${startTime(process.pid) ?? ""}\n`, { mode: 0o600 });

  const l: Layout = layout(env);
  if (!existsSync(l.gate)) { log(`no secret-gate at ${l.gate}`); return 1; }
  const shellPath = await loginShellPath(env);
  if (!shellPath) log("the login shell gave no PATH; using the usual folders");

  let ports: Ports;
  let mode: GateMode = gateMode(env);
  const specs = () => {
    const settings = readSettings(home);
    ports = portsOf(settings);
    const p = plan({ env, home, gateHome, settings, ports, layout: l, path: mergedPath(shellPath, env.HOME ?? homedir(), l.nodeBin), gate: mode });
    const gate: ChildSpec = { name: "gate", command: [l.gate, "proxy", "--port", String(ports.gate)], env: p.gateEnv, cwd: dirname(gateHome), pidFile: join(runDir, "gate.pid"), stopSignal: "SIGTERM", stopTimeoutMs: 5_000 };
    const daemon: ChildSpec = { name: "daemon", command: [...l.daemon, "serve"], env: p.daemonEnv, cwd: home, pidFile: join(runDir, "daemon.pid"), stopSignal: "SIGINT", stopTimeoutMs: 10_000 };
    return { gate, daemon, p };
  };
  let s = specs();
  const agents = Object.keys(s.p.daemonEnv).filter((k) => k.endsWith("_BIN") && k !== "SECRET_GATE_BIN").map((k) => `${k}=${s.p.daemonEnv[k]}`);
  log(`home ${home}; gate ${l.gate}; ${l.runtime ? `runtime ${l.runtime}` : "from a checkout"}; agents: ${agents.join(" ") || "none found"}`);
  log(modeLine(mode));

  await reap(s.daemon.pidFile, "SIGINT", 10_000, log);
  await reap(s.gate.pidFile, "SIGTERM", 5_000, log);

  let gate = new Child(s.gate, out);
  const daemon = new Child(s.daemon, out);
  const port = () => gatePort(mode, ports!);
  let external = false;
  /** This account's gate, unless one already answers on the port (started by hand, or by another tool): that one is
   *  used as it is, until it stops answering. */
  const startOwnGate = async () => {
    await ensureKeypair(l.gate, s.p.gateEnv, log);
    external = await probeGate(port());
    if (external) { log(`a gate already answers on ${port()}; using it`); return; }
    gate.start();
    const until = Date.now() + GATE_WAIT_MS;
    while (Date.now() < until && !(await probeGate(port()))) await new Promise((r) => setTimeout(r, 300));
    syncCA(gateHome, s.p.gateEnv, log);
  };
  if (mode.kind === "user") await startOwnGate();
  else if (!(await probeGate(port()))) log(`the gate service does not answer on ${port()} yet`);
  daemon.start();

  /** gate-service.json appeared or went (or `system update --port` moved the service): the gate changes hands, and
   *  the daemon starts again with the new places. */
  const switchMode = async (next: GateMode) => {
    mode = next;
    log(modeLine(mode));
    s = specs();
    if (mode.kind === "service") await gate.stop();       // frees the port for the service's proxy
    else { gate = new Child(s.gate, out); await startOwnGate(); }
    daemon.update(s.daemon);
    await daemon.restart();
  };

  let gateMisses = 0, daemonMisses = 0, busy = false, said = false;
  const tick = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      const next = gateMode(env);
      if (modeChanged(mode, next)) { gateMisses = 0; said = false; await switchMode(next); return; }
      if (await probeGate(port())) { gateMisses = 0; said = false; if (mode.kind === "user") syncCA(gateHome, s.p.gateEnv, log); }
      else if (++gateMisses >= (external || mode.kind === "service" ? EXTERNAL_GATE_MISSES : GATE_MISSES)) {
        gateMisses = 0;
        if (mode.kind === "service") { if (!said) log(`the gate service does not answer on ${port()}; not starting one (agentswitch doctor)`); said = true; }
        else if (external) { external = false; log("the gate that was there stopped answering; starting one"); gate.start(); }
        else if (gate.running && gate.uptime() > GRACE_MS) gate.failed("does not answer");
      }
      if (await probeDaemon(ports!.local)) daemonMisses = 0;
      else if (++daemonMisses >= DAEMON_MISSES) { daemonMisses = 0; if (daemon.running && daemon.uptime() > GRACE_MS) daemon.failed("does not answer"); }
    })().catch((e: unknown) => log(`probe: ${(e as Error).message}`)).finally(() => { busy = false; });
  }, PROBE_EVERY_MS);

  return new Promise<number>((done) => {
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) process.exit(1);
      stopping = true;
      log(`${signal}: stopping`);
      clearInterval(tick);
      void daemon.stop().then(() => gate.stop()).finally(() => {
        if (runningKeeper(runDir) === process.pid) rmSync(join(runDir, KEEPER_PID), { force: true });
        done(0);
      });
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGHUP", () => {
      if (stopping) return;
      try { s = specs(); } catch (e) { log(`node.json: ${(e as Error).message}; not restarting`); return; }
      log("SIGHUP: restarting the daemon with node.json as it is now");
      gate.update(s.gate);
      daemon.update(s.daemon);
      void daemon.restart();
    });
  });
}
