/** `agentswitch service …`: the systemd user service that starts the keeper at boot and again if it exits (docs/mesh-v0.md
 *  §4.2). Only the keeper runs under it; the keeper starts and stops the gate and the daemon in their order, so systemd
 *  sends its stop signal to the keeper alone (`KillMode=mixed`) and kills what is left after the timeout.
 *  The kernel's OOM killer taking one process of the unit does not stop the rest (`OOMPolicy=continue`; systemd's
 *  default, `stop`, ends the whole unit): the unit holds the terminals and everything their agents run, and on
 *  2026-10-14 one agent's 25 GB job, killed alone by the kernel, took every other terminal down with it. The keeper
 *  starts the gate or the daemon again when it was one of them, and systemd the keeper (`Restart=on-failure`).
 *  The terminals' programs are not in this unit: each is held in a scope of its own in `agentswitch-terminals.slice`
 *  (terminals/held.ts, docs/terminal-v0.md §10), so a restart of the unit leaves them running. `service stop` and
 *  `uninstall` stop that slice too: the node off is its terminals off. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Layout } from "./plan.js";
import { SLICE } from "../terminals/held.js";

export const UNIT = "agentswitch.service";

export function unitPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config"), "systemd", "user", UNIT);
}

/** The keeper's command line for the unit: through the runtime's `current` link when there is one, so that an update
 *  (which moves the link) needs no new unit. */
export function keeperCommand(l: Layout): string[] {
  if (l.runtime) {
    const current = join(dirname(l.runtime), "current");
    const root = existsSync(current) ? current : l.runtime;
    return [join(root, "node", "bin", "node"), "--no-warnings=ExperimentalWarning", join(root, "daemon", "dist", "cli.js"), "node", "run"];
  }
  return [...l.daemon, "node", "run"];
}

/** A word of an ExecStart line: quoted when it has to be (systemd.syntax). */
const word = (s: string): string => /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\])/g, "\\$1")}"`;

export function unitText(command: readonly string[], env: Record<string, string> = {}): string {
  return `[Unit]
Description=AgentSwitch node (docs/mesh-v0.md)

[Service]
Type=simple
ExecStart=${command.map(word).join(" ")}
ExecReload=/bin/kill -HUP $MAINPID
${Object.entries(env).map(([k, v]) => `Environment=${word(`${k}=${v}`)}\n`).join("")}KillMode=mixed
OOMPolicy=continue
TimeoutStopSec=30
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const systemctl = (...args: string[]) => spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" }).status ?? 1;

/** Whether systemd keeps this user's services running with nobody logged in. */
export function lingers(user = process.env.USER ?? ""): boolean {
  const r = spawnSync("loginctl", ["show-user", user, "-p", "Linger", "--value"], { encoding: "utf8" });
  return r.stdout?.trim() === "yes";
}

export function service(action: string | undefined, l: Layout, env: NodeJS.ProcessEnv = process.env): number {
  const file = unitPath(env);
  switch (action) {
    case "install": {
      if (!l.runtime) console.error("note: not from an installed runtime; the unit runs this checkout as it is (packages/linux/README.md)");
      // AGENTSWITCH_HOME and SECRET_GATE_HOME go into the unit only when they are not the defaults.
      const keep = Object.fromEntries((["AGENTSWITCH_HOME", "SECRET_GATE_HOME"] as const).filter((k) => env[k]).map((k) => [k, env[k]!]));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, unitText(keeperCommand(l), keep));
      console.log(`wrote ${file}`);
      if (systemctl("daemon-reload") || systemctl("enable", "--now", UNIT)) return 1;
      if (!lingers()) console.log(`\nWith nobody logged in, systemd stops this user's services. To keep the node up:\n  loginctl enable-linger ${env.USER ?? "$USER"}`);
      return 0;
    }
    case "uninstall": {
      if (existsSync(file)) { systemctl("disable", "--now", UNIT); systemctl("stop", SLICE); rmSync(file); systemctl("daemon-reload"); console.log(`removed ${file}`); }
      else console.log("the service is not installed");
      return 0;
    }
    case "status": return systemctl("status", "--no-pager", UNIT) === 0 ? 0 : 1;
    case "restart": return systemctl("restart", UNIT);
    // The terminals held outside the unit end with it here; `restart` leaves them running.
    case "stop": return systemctl("stop", UNIT) || systemctl("stop", SLICE);
    case "start": return systemctl("start", UNIT);
    case "logs": return spawnSync("journalctl", ["--user", "-u", UNIT, "-n", "200", "-f"], { stdio: "inherit" }).status ?? 1;
    default:
      console.error("service install | uninstall | status | start | stop | restart | logs");
      return 2;
  }
}
