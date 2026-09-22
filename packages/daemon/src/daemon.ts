/** Composition root: config → store, bus, engine, executors, quota, API. `serve()` listens on 127.0.0.1. */

import { serve as listen } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "./api/app.js";
import { defaultCwdRules } from "./api/cwdPolicy.js";
import { Bus } from "./engine/bus.js";
import { defaultCleanupPaths } from "./engine/cleanup.js";
import { DEFAULT_MAX_TASKS, Engine } from "./engine/engine.js";
import { Store } from "./engine/store.js";
import { claudeExecutor, probeRateLimits } from "./executors/claude.js";
import { codexExecutor } from "./executors/codex.js";
import { echoExecutor } from "./executors/echo.js";
import { defaultGate } from "./executors/gate.js";
import { type Extensions, extensionsAt } from "./extensions/index.js";
import { opencodeExecutor } from "./executors/opencode.js";
import { defaultProtected, type ProtectedPaths } from "./executors/protected.js";
import { routerSummarizer } from "./threads/summary.js";
import { routerSupervisor } from "./router/supervisor.js";
import { loadMemory } from "./threads/memory.js";
import { RECORD_WINDOW_MS } from "./threads/record.js";
import type { ExtensionsSummary } from "./router/prompt.js";
import type { Executor } from "./executors/types.js";
import { claudeQuota } from "./quota/claude.js";
import { codexQuota } from "./quota/codex.js";
import { deepseekQuota, findDeepSeekKey } from "./quota/deepseek.js";
import { QuotaService } from "./quota/index.js";
import { RateLimitCache } from "./quota/windows.js";
import { loadContext } from "./router/context.js";
import { sweepDir } from "./files/artifacts.js";
import { ARTIFACT_TTL_MS, UPLOAD_TTL_MS } from "./files/names.js";
import { Uploads } from "./files/uploads.js";
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
  /** Tasks in flight at once (AGENTSWITCH_MAX_TASKS, default 4); see docs/background-v0.md. */
  readonly maxTasks: number;
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
    maxTasks: Math.max(1, Number(env.AGENTSWITCH_MAX_TASKS ?? DEFAULT_MAX_TASKS) || DEFAULT_MAX_TASKS),
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
  const store = new Store({ dbPath: join(cfg.home, "agentswitch.db"), tasksDir: join(cfg.home, "tasks"), threadsDir: join(cfg.home, "threads") });
  const bus = new Bus();
  const routingLog = new RoutingLog(join(cfg.home, "routing.db"));
  const contextPath = join(cfg.home, "CONTEXT.md");
  const memoryPath = join(cfg.home, "MEMORY.md");
  const policyPath = join(cfg.home, "approvals.json");
  const router = overrides.router ?? (cfg.router === "echo" ? defaultEchoRouter(targets) : opencodeRouter({ model: targets.router.model }));
  const rateLimits = new RateLimitCache();
  const extensions = extensionsAt(cfg.home);
  const prot = defaultProtected({ ...process.env, AGENTSWITCH_HOME: cfg.home });
  const executors = overrides.executors ?? (cfg.executors === "real" ? realExecutors(targets, cfg.browser, rateLimits, extensions, prot) : Object.keys(targets.harnesses).map((h) => echoExecutor(h)));
  const quota = overrides.quota ?? new QuotaService([
    codexQuota({ binary: targets.harnesses.codex?.binary ?? "codex" }),
    deepseekQuota({ key: findDeepSeekKey() }),
    claudeQuota(store, { cache: rateLimits, ...(cfg.executors === "real" ? { probe: () => probeRateLimits() } : {}) }),
  ], cfg.quotaTtlMs);
  const workRoot = join(cfg.home, "work");
  const uploads = new Uploads(join(cfg.home, "uploads"));
  const artifactsDir = join(cfg.home, "artifacts");
  sweepDir(uploads.dir, UPLOAD_TTL_MS);
  sweepDir(artifactsDir, ARTIFACT_TTL_MS);
  sweepThreads(store);
  // The summarizer rides on the real router agent; the echo router's fixed replies are not summaries.
  // The summarizer is a text-only agent on the router's model, run in a scratch dir so it never explores the repo.
  const summarizer = cfg.router === "echo" || overrides.router ? undefined : routerSummarizer(opencodeRouter({ model: targets.router.model, agentName: "summarizer", tools: "none", runIn: join(cfg.home, "router-scratch") }), targets.router.timeout_ms);
  mkdirSync(join(cfg.home, "router-scratch"), { recursive: true });
  // The supervisor is the same text-only agent shape: approvals on the user's behalf, watchdog, acceptance.
  const supervisor = summarizer ? routerSupervisor(opencodeRouter({ model: targets.router.model, agentName: "supervisor", tools: "none", runIn: join(cfg.home, "router-scratch") }), targets.router.supervisor, targets.router.timeout_ms) : undefined;
  const extensionsSummary = () => summarizeExtensions(extensions);
  const engine = new Engine({ store, bus, executors, targets, router, quota: () => quota.map(), contextPath, cleanupPaths: { ...defaultCleanupPaths(), workRoot }, routingLog, artifactsDir, protected: prot, memoryPath, extensionsSummary, maxConcurrentTasks: cfg.maxTasks, policyPath, ...(summarizer ? { summarizer } : {}), ...(supervisor ? { supervisor } : {}) });
  const routeDeps = () => ({ targets, router, quota: quota.map(), running: engine.runningByHarness(), context: loadContext(contextPath), memory: loadMemory(memoryPath), records: store.recordsSince(Date.now() - RECORD_WINDOW_MS), extensions: extensionsSummary(), threads: engine.threadBriefs() });
  const app = createApp({ store, bus, engine, targets, quota, routingLog, routeDeps, contextPath, memoryPath, policyPath, workRoot, cwdRules: defaultCwdRules(process.env, cfg.home), uploads, artifactsDir, extensions, version: VERSION });
  return { app, engine, store, quota, targets, close: () => { store.close(); routingLog.close(); } };
}

export function realExecutors(targets: Targets, browser: boolean, rateLimits?: RateLimitCache, extensions?: Extensions, prot: ProtectedPaths = defaultProtected()): Executor[] {
  const gate = defaultGate();
  if (!gate) console.error("secret-gate venv not found: executors run without the gate (no proxy, no MCP)");
  const ext = extensions ? { extensions } : {};
  return [
    claudeExecutor({ gate, browser, ...ext, protected: prot, ...(rateLimits ? { rateLimits } : {}) }),
    codexExecutor({ binary: targets.harnesses.codex?.binary ?? "codex", gate, browser, ...ext }),
    opencodeExecutor({ gate, browser, ...ext, protected: prot }),
  ];
}

/** Names and one-liners only (progressive disclosure): the router mentions an extension, the executor loads it. */
export function summarizeExtensions(ext: Extensions): ExtensionsSummary {
  return {
    mcp: ext.mcp.list().filter((m) => m.enabled).map((m) => ({ name: m.name, note: m.note, harnesses: m.harnesses })),
    skills: ext.skills.list().filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description, harnesses: s.harnesses })),
  };
}

/** Archived threads past their expiry lose their row, log and private home. Runs at start and hourly. */
export function sweepThreads(store: Store, now = Date.now()): string[] {
  const gone: string[] = [];
  for (const t of store.expiredThreads(now)) { if (store.deleteThread(t.id)) gone.push(t.id); }
  if (gone.length) console.error(`threads expired and deleted: ${gone.join(", ")}`);
  return gone;
}

function defaultEchoRouter(targets: Targets): Router {
  return echoRouter((input) => JSON.stringify({ harness: targets.router.default.harness, model: null, brief: input.task.split("\n\nTask:\n")[1] ?? input.task, confidence: 0.9 }));
}

export function serve(cfg: DaemonConfig): { daemon: Daemon; close: () => void } {
  const daemon = buildDaemon(cfg);
  const server = listen({ fetch: daemon.app.fetch, hostname: "127.0.0.1", port: cfg.port }, (info) => {
    console.error(`agentswitchd ${VERSION} listening on http://127.0.0.1:${info.port}  router=${cfg.router} executors=${cfg.executors} maxTasks=${cfg.maxTasks} home=${cfg.home}`);
  });
  void daemon.quota.refresh();
  const sweeper = setInterval(() => sweepThreads(daemon.store), 3600_000);
  sweeper.unref();
  return { daemon, close: () => { clearInterval(sweeper); server.close(); daemon.close(); } };
}
