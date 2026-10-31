/** `agentswitch doctor`: what this node has and lacks (docs/mesh-v0.md §4.3), the Mac app's environment checks for a
 *  node without one. Every line is one thing: found or not, and what to do when not. Nothing is changed. */

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { findDeepSeekKey } from "../quota/deepseek.js";
import { claudeSignedIn } from "../terminals/signIn.js";
import { which } from "../util/which.js";
import { homes, probeDaemon, probeGate, runningKeeper } from "./run.js";
import { AGENT_BINS, layout, loginShellPath, mergedPath, portsOf, readSettings } from "./plan.js";
import { lingers, unitPath } from "./systemd.js";
import { HOLDER_BINARY, SLICE } from "../terminals/held.js";

const run = promisify(execFile);
type Mark = "ok" | "no" | "warn";
const MARK: Record<Mark, string> = { ok: "✓", no: "✗", warn: "!" };

async function version(bin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try { return (await run(bin, ["--version"], { env, timeout: 15_000 })).stdout.trim().split("\n")[0] ?? null; } catch { return null; }
}

/** `print` takes each line (`agentswitch config`'s Environment page collects them). */
export async function doctor(env: NodeJS.ProcessEnv = process.env, print: (line: string) => void = console.log): Promise<number> {
  let bad = 0;
  const say = (mark: Mark, what: string, detail = "") => { if (mark === "no") bad++; print(`${MARK[mark]} ${what.padEnd(16)} ${detail}`); };
  const section = (title: string) => print(`\n// ${title}`);
  const home = env.HOME ?? homedir();
  const { home: asHome, gateHome, runDir } = homes(env);
  const l = layout(env);

  section("runtime");
  const [major, minor] = process.versions.node.split(".").map(Number);
  say(major! > 22 || (major === 22 && minor! >= 5) ? "ok" : "no", "node", `${process.version} (${process.execPath})`);
  try { createRequire(import.meta.url)("node-pty"); say("ok", "node-pty", "loads"); }
  catch (e) { say("no", "node-pty", `does not load: ${(e as Error).message.split("\n")[0]} — the terminals need it`); }
  say(existsSync(l.gate) ? "ok" : "no", "secret-gate", existsSync(l.gate) ? l.gate : `not at ${l.gate}`);
  say(l.runtime ? "ok" : "warn", "installed", l.runtime ?? "running from a checkout");
  say(existsSync(HOLDER_BINARY) ? "ok" : "warn", "pty-hold", existsSync(HOLDER_BINARY) ? "terminals outlive a restart of the service" : `not at ${HOLDER_BINARY}: terminals end with the service (npm run build:native)`);

  section("service");
  let ports = { local: 4711, opencode: 4712, remote: 4713, gate: 8080 };
  try { ports = portsOf(readSettings(asHome)); } catch (e) { say("no", "node.json", (e as Error).message); }
  const keeper = runningKeeper(runDir);
  say(keeper ? "ok" : "no", "keeper", keeper ? `pid ${keeper}` : "not running: agentswitch service start (or agentswitch node run)");
  say(await probeGate(ports.gate) ? "ok" : "no", "gate", `127.0.0.1:${ports.gate}; keys in ${gateHome}`);
  say(await probeDaemon(ports.local) ? "ok" : "no", "daemon", `127.0.0.1:${ports.local}; home ${asHome}`);
  const held = (() => { try { return readdirSync(join(asHome, "terminals")).filter((d) => existsSync(join(asHome, "terminals", d, "meta.json"))).length; } catch { return 0; } })();
  say("ok", "terminals", held ? `${held} held, in ${SLICE}` : "none held now");
  const unit = unitPath(env);
  say(existsSync(unit) ? "ok" : "warn", "systemd", existsSync(unit) ? unit : "no user service: agentswitch service install");
  say(lingers() ? "ok" : "warn", "linger", lingers() ? "the service runs with nobody logged in" : `stops at logout: loginctl enable-linger ${env.USER ?? ""}`);

  section("agents");
  const path = mergedPath(await loginShellPath(env), home, l.nodeBin);
  const agentEnv = { ...env, PATH: path };
  for (const [, name] of Object.entries(AGENT_BINS)) {
    const bin = which(name, path);
    if (!bin) { say(name === "claude" || name === "codex" ? "no" : "warn", name, "not found on the login shell's PATH"); continue; }
    say("ok", name, `${await version(bin, agentEnv) ?? "?"}  ${bin}`);
    if (name === "claude") {
      const signed = await claudeSignedIn(bin, join(home, ".claude"));
      say(signed ? "ok" : signed === false ? "no" : "warn", "  signed in", signed ? "yes" : signed === false ? "no: claude auth login (or open a terminal from the phone)" : "could not tell");
    }
    if (name === "codex") {
      const auth = join(env.CODEX_HOME ?? join(home, ".codex"), "auth.json");
      say(existsSync(auth) ? "ok" : "no", "  signed in", existsSync(auth) ? auth : "no: codex login --device-auth");
    }
    if (name === "opencode") say(findDeepSeekKey(env) ? "ok" : "warn", "  deepseek", findDeepSeekKey(env) ? "a key is there (the dispatch model)" : "no DeepSeek key: opencode auth login (Dispatch's router uses deepseek/deepseek-flash)");
  }
  if (!which("opencode", path)) say("warn", "dispatch", "without OpenCode the router, the assistant and the sealer do not run (docs/router-v0.md)");

  section("tools");
  for (const [name, why] of [["git", "the folders' git state"], ["unzip", "installing the browser engine"], ["lsof", "the browser's list of local servers; sessions open elsewhere"], ["openssl", "the remote listener's certificate"]] as const) {
    say(which(name, path) ? "ok" : "warn", name, which(name, path) ? why : `missing: ${why}`);
  }
  // Optional (docs/yazi-v0.md): Files beside a terminal.
  const yazi = which("yazi", path);
  say(yazi ? "ok" : "warn", "yazi", yazi ? "Files beside a terminal" : "missing (optional): Files beside a terminal need yazi (pacman -S yazi, apt install yazi, brew install yazi)");
  const chrome = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"].map((n) => which(n, path)).find(Boolean);
  say(chrome ? "ok" : "warn", "chrome", chrome ?? "none: Dispatch's browser tasks (Playwright MCP) need Google Chrome");
  return bad ? 1 : 0;
}
