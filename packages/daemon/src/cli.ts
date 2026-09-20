/** `route "<task>" [--cwd dir] [--router echo|opencode] [--pin harness/model] [--browser] [--context file]`
 *  `reroute "<task>" --failed harness/model --kind refusal|quota|transport|task_failed --excerpt "..."`
 *  `context init` writes the CONTEXT.md template to ~/.agentswitch if missing.
 *  Prints the result as JSON; `route` also appends to the routing log. */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { loadContext } from "./router/context.js";
import { echoRouter } from "./router/routers/echo.js";
import { opencodeRouter } from "./router/routers/opencode.js";
import { RoutingLog } from "./router/log.js";
import { reroute, route } from "./router/route.js";
import { NO_SIDE_EFFECTS, type FailureKind } from "./router/failure.js";
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
      failed: { type: "string" },
      kind: { type: "string", default: "refusal" },
      excerpt: { type: "string", default: "" },
      context: { type: "string", default: join(process.env.HOME ?? ".", ".agentswitch", "CONTEXT.md") },
    },
  });
  const [cmd, task] = positionals;
  if (cmd === "context" && task === "init") {
    if (existsSync(values.context)) {
      console.log(`exists: ${values.context}`);
    } else {
      mkdirSync(dirname(values.context), { recursive: true });
      copyFileSync(resolve(HERE, "..", "config", "CONTEXT.example.md"), values.context);
      console.log(`written: ${values.context}`);
    }
    return 0;
  }
  if ((cmd !== "route" && cmd !== "reroute") || !task) {
    console.error('usage: route "<task>" [--cwd dir] [--router echo|opencode] [--pin harness/model] [--browser]\n'
      + '       reroute "<task>" --failed harness/model --kind refusal|quota|transport|task_failed --excerpt "..."');
    return 2;
  }
  const targets = loadTargets(values.targets);
  const context = loadContext(values.context);
  for (const w of context.warnings) console.error(`context warning: ${w}`);
  const router = values.router === "echo"
    ? echoRouter([JSON.stringify({ harness: targets.router.default.harness, model: null, brief: task, confidence: 0.9 })])
    : opencodeRouter({ model: targets.router.model });
  if (cmd === "reroute") {
    if (!values.failed) throw new Error("reroute needs --failed harness/model");
    const failed = splitPin(values.failed);
    const attempt = { ...failed, kind: values.kind as FailureKind, excerpt: values.excerpt, sideEffects: NO_SIDE_EFFECTS };
    const out = await reroute(
      { task, cwd: resolve(values.cwd), needsBrowser: values.browser, decision: null, attempts: [attempt], routerAsks: 0 },
      { targets, router, quota: {}, running: {}, context },
    );
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  const pin = values.pin ? splitPin(values.pin) : undefined;
  const result = await route(
    { task, cwd: resolve(values.cwd), ...(pin ? { pin } : {}), needsBrowser: values.browser },
    { targets, router, quota: {}, running: {}, context },
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
