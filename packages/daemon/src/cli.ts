/** `agentswitch route "<task>" [--cwd dir] [--router echo|opencode] [--pin harness/model] [--browser]`
 *  Prints the RouteResult as JSON and appends it to the routing log. */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { join } from "node:path";
import { echoRouter } from "./router/routers/echo.js";
import { opencodeRouter } from "./router/routers/opencode.js";
import { RoutingLog } from "./router/log.js";
import { route } from "./router/route.js";
import { loadTargets } from "./router/targets.js";

const HERE = new URL(".", import.meta.url).pathname;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      cwd: { type: "string", default: process.cwd() },
      router: { type: "string", default: "opencode" },
      pin: { type: "string" },
      browser: { type: "boolean", default: false },
      targets: { type: "string", default: resolve(HERE, "..", "config", "targets.yaml") },
      log: { type: "string", default: join(process.env.HOME ?? ".", ".agentswitch", "routing.db") },
    },
  });
  const [cmd, task] = positionals;
  if (cmd !== "route" || !task) {
    console.error('usage: route "<task>" [--cwd dir] [--router echo|opencode] [--pin harness/model] [--browser]');
    return 2;
  }
  const targets = loadTargets(values.targets);
  const router = values.router === "echo"
    ? echoRouter([JSON.stringify({ harness: targets.router.default.harness, model: null, brief: task, confidence: 0.9 })])
    : opencodeRouter({ model: targets.router.model });
  const pin = values.pin ? splitPin(values.pin) : undefined;
  const result = await route(
    { task, cwd: resolve(values.cwd), ...(pin ? { pin } : {}), needsBrowser: values.browser },
    { targets, router, quota: {}, running: {} },
  );
  const log = new RoutingLog(values.log);
  const id = log.record(task, values.cwd, result);
  log.close();
  console.log(JSON.stringify({ id, ...result }, null, 2));
  return result.verdict.ok ? 0 : 1;
}

function splitPin(text: string): { harness: string; model: string } {
  const i = text.indexOf("/");
  if (i <= 0) throw new Error("--pin must be harness/model");
  return { harness: text.slice(0, i), model: text.slice(i + 1) };
}

process.exitCode = await main();
