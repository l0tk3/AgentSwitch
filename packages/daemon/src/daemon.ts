/** Composition root: config → store, bus, engine, executors, quota, API. `serve()` listens on 127.0.0.1. */

import { serve as listen } from "@hono/node-server";
import { join, resolve } from "node:path";
import { createApp } from "./api/app.js";
import { Bus } from "./engine/bus.js";
import { defaultCleanupPaths } from "./engine/cleanup.js";
import { Engine } from "./engine/engine.js";
import { Store } from "./engine/store.js";
import { claudeExecutor, probeRateLimits } from "./executors/claude.js";
import { codexExecutor } from "./executors/codex.js";
import { echoExecutor } from "./executors/echo.js";
import { defaultGate } from "./executors/gate.js";
import { opencodeExecutor } from "./executors/opencode.js";
import type { Executor } from "./executors/types.js";
import { claudeQuota } from "./quota/claude.js";
import { codexQuota } from "./quota/codex.js";
import { deepseekQuota, findDeepSeekKey } from "./quota/deepseek.js";
import { QuotaService } from "./quota/index.js";
import { RateLimitCache } from "./quota/windows.js";
import { loadContext } from "./router/context.js";
import { RoutingLog } from "./router/log.js";
import { echoRouter } from "./router/routers/echo.js";
import { opencodeRouter } from "./router/routers/opencode.js";
import type { Router } from "./router/routers/types.js";
import { loadTargets, type Targets } from "./router/targets.js";

export const VERSION = "0.1.0";
export const DEFAULT_PORT = 4711;
const HERE = new URL(".", import.meta.url).pathname;

export type DaemonConfig = {
  readonly home: string;                 // ~/.agentswitch
  readonly targetsPath: string;
  readonly port: number;
  readonly router: "opencode" | "echo";
  readonly executors: "echo" | "real";   // real = claude-code (Agent SDK), codex (app-server), opencode (run)
  readonly browser: boolean;             // give real executors the gated Playwright browser
  readonly quotaTtlMs: number;
};

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const home = env.AGENTSWITCH_HOME ?? join(env.HOME ?? ".", ".agentswitch");
  return {
    home,
    targetsPath: env.AGENTSWITCH_TARGETS ?? resolve(HERE, "..", "config", "targets.yaml"),
    port: Number(env.AGENTSWITCH_PORT ?? DEFAULT_PORT),
    router: env.AGENTSWITCH_ROUTER === "echo" ? "echo" : "opencode",
    executors: env.AGENTSWITCH_EXECUTORS === "real" ? "real" : "echo",
    browser: env.AGENTSWITCH_BROWSER !== "0",   // gated Playwright MCP attached to browser tasks when the gate exists
    quotaTtlMs: 60_000,
  };
}

export type Daemon = {
  readonly app: ReturnType<typeof createApp>;
  readonly engine: Engine;
  readonly store: Store;
  readonly quota: QuotaService;
  readonly targets: Targets;
  close(): void;
};

export function buildDaemon(cfg: DaemonConfig, overrides: { router?: Router; executors?: readonly Executor[]; quota?: QuotaService } = {}): Daemon {
  const targets = loadTargets(cfg.targetsPath);
  const store = new Store({ dbPath: join(cfg.home, "agentswitch.db"), tasksDir: join(cfg.home, "tasks") });
  const bus = new Bus();
  const routingLog = new RoutingLog(join(cfg.home, "routing.db"));
  const contextPath = join(cfg.home, "CONTEXT.md");
  const router = overrides.router ?? (cfg.router === "echo" ? defaultEchoRouter(targets) : opencodeRouter({ model: targets.router.model }));
  const rateLimits = new RateLimitCache();
  const executors = overrides.executors ?? (cfg.executors === "real" ? realExecutors(targets, cfg.browser, rateLimits) : Object.keys(targets.harnesses).map((h) => echoExecutor(h)));
  const quota = overrides.quota ?? new QuotaService([
    codexQuota({ binary: targets.harnesses.codex?.binary ?? "codex" }),
    deepseekQuota({ key: findDeepSeekKey() }),
    claudeQuota(store, { cache: rateLimits, ...(cfg.executors === "real" ? { probe: () => probeRateLimits() } : {}) }),
  ], cfg.quotaTtlMs);
  const workRoot = join(cfg.home, "work");
  const engine = new Engine({ store, bus, executors, targets, router, quota: () => quota.map(), context: loadContext(contextPath), cleanupPaths: { ...defaultCleanupPaths(), workRoot }, routingLog });
  const routeDeps = () => ({ targets, router, quota: quota.map(), running: {}, context: loadContext(contextPath) });
  const app = createApp({ store, bus, engine, targets, quota, routingLog, routeDeps, contextPath, workRoot, version: VERSION });
  return { app, engine, store, quota, targets, close: () => { store.close(); routingLog.close(); } };
}

export function realExecutors(targets: Targets, browser: boolean, rateLimits?: RateLimitCache): Executor[] {
  const gate = defaultGate();
  if (!gate) console.error("secret-gate venv not found: executors run without the gate (no proxy, no MCP)");
  return [
    claudeExecutor({ gate, browser, ...(rateLimits ? { rateLimits } : {}) }),
    codexExecutor({ binary: targets.harnesses.codex?.binary ?? "codex", gate, browser }),
    opencodeExecutor({ gate, browser }),
  ];
}

function defaultEchoRouter(targets: Targets): Router {
  return echoRouter((input) => JSON.stringify({ harness: targets.router.default.harness, model: null, brief: input.task.split("\n\nTask:\n")[1] ?? input.task, confidence: 0.9 }));
}

export function serve(cfg: DaemonConfig): { daemon: Daemon; close: () => void } {
  const daemon = buildDaemon(cfg);
  const server = listen({ fetch: daemon.app.fetch, hostname: "127.0.0.1", port: cfg.port }, (info) => {
    console.error(`agentswitchd ${VERSION} listening on http://127.0.0.1:${info.port}  router=${cfg.router} executors=${cfg.executors} home=${cfg.home}`);
  });
  void daemon.quota.refresh();
  return { daemon, close: () => { server.close(); daemon.close(); } };
}
