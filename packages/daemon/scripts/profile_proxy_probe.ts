/** A profile's own proxy tried for real on this Mac (docs/profiles-v0.md §4), with nothing of the user's changed:
 *
 *  - the proxy "somewhere else" is the running Clash's own proxy port (a real proxy that is at hand);
 *  - an exit of the pool is made for it — a forwarder on this Mac — and checked: where does traffic through it come out;
 *  - `curl` is run with the environment a terminal under such a profile gets, to see that a process's traffic does
 *    leave through the forwarder;
 *  - Claude Code itself is run that way for a moment, signed out (an empty config folder of its own, so no model is
 *    called), to see whether what it sends at start-up goes through the forwarder too.
 *
 *    npx tsx scripts/profile_proxy_probe.ts */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitLookup } from "../src/browser/exit.js";
import { ExitPool } from "../src/browser/exits.js";
import { ClashController } from "../src/clash/controller.js";
import { vergeSocket } from "../src/clash/verge.js";
import { proxyEnv } from "../src/terminals/launch.js";

const say = (line: string) => console.log(line);
/** A command run to its end without stopping this process meanwhile — the forwarder it talks to lives here. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 25_000): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ out: out.trim(), code }); });
    child.on("error", () => { clearTimeout(timer); resolve({ out: "", code: -1 }); });
  });
}
const clean = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(https?|all|no)_proxy$/i.test(k)));

async function main(): Promise<void> {
  const socket = vergeSocket();
  const port = socket ? (await new ClashController(socket).status()).proxyPort : null;
  if (!port) { say("no proxy at hand to try with (Clash is not running, or has no proxy port)"); return; }
  const proxy = { server: `http://127.0.0.1:${port}` };
  const exits = new ExitPool({ ownPorts: () => [], lookup: exitLookup() });
  const home = mkdtempSync(join(tmpdir(), "as-profile-probe-"));
  try {
    const exit = await exits.check("probe", proxy);
    say(`1) the exit, checked through the forwarder: ${exit.ip.replace(/\d+\.\d+$/, "x.x")} · ${exit.place} · ${exit.timezone}`);
    const via = ExitPool.url(await exits.address("probe", proxy));
    say(`   what a process is given: ${via.replace(/:[^:@/]+@/, ":<run password>@")}`);
    const env = { ...clean(process.env), ...proxyEnv(via) };
    const before = exits.requests("probe");
    const curl = await run("curl", ["-s", "-m", "15", "https://ipinfo.io/ip"], env);
    say(`2) curl with that environment: sees ${curl.out.replace(/\d+\.\d+$/, "x.x") || `nothing (exit ${curl.code})`}; the forwarder was asked ${exits.requests("probe") - before} time(s)`);
    const mid = exits.requests("probe");
    const local = await run("curl", ["-s", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:1/"], env);
    say(`   to this Mac itself it goes straight, not through the forwarder: asked ${exits.requests("probe") - mid} more time(s) [curl: ${local.out || local.code}]`);
    const claude = (await run("/bin/sh", ["-c", "command -v claude"], process.env)).out;
    if (!claude) { say("3) Claude Code is not on the PATH: not tried"); return; }
    const version = (await run(claude, ["--version"], clean(process.env))).out;
    const mark = exits.requests("probe");
    const with_ = await run(claude, ["-p", "ok"], { ...env, CLAUDE_CONFIG_DIR: join(home, "claude") });
    say(`3) Claude Code (${version}), signed out, with that environment: it said ${JSON.stringify(with_.out.split("\n")[0]?.slice(0, 80) ?? "")}; the forwarder was asked ${exits.requests("probe") - mark} time(s)`);
  } finally {
    await exits.stop();
    rmSync(home, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
