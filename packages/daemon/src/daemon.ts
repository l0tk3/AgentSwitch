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
import { gateMinter } from "./secrets/minter.js";
import { routerSealer, sitesFromContext, type Sealer } from "./secrets/sealer.js";
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
import { discoverTargets } from "./router/discovery.js";
import { OpenCodeServer, serveRouter, DEFAULT_OPENCODE_PORT } from "./router/routers/opencodeServe.js";

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
  /** Port of the resident `opencode serve` (AGENTSWITCH_OPENCODE_PORT); router-type calls go there. */
  readonly opencodePort: number;
  readonly opencodeBinary: string;
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
    opencodePort: Number(env.AGENTSWITCH_OPENCODE_PORT ?? DEFAULT_OPENCODE_PORT) || DEFAULT_OPENCODE_PORT,
    opencodeBinary: env.OPENCODE_BIN ?? join(env.HOME ?? "", ".opencode", "bin", "opencode"),
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

export type BuildOverrides = {
  readonly router?: Router;
  readonly executors?: readonly Executor[];
  readonly quota?: QuotaService;
  /** Catalog after discovery (serve() passes it); default: the yaml as is. */
  readonly targets?: Targets;
  /** The resident OpenCode server; when absent, router-type calls fall back to `opencode run --standalone`. */
  readonly opencode?: OpenCodeServer;
  /** Tests: a sealer without a model or the gate. */
  readonly sealer?: Sealer;
};

export function buildDaemon(cfg: DaemonConfig, overrides: BuildOverrides = {}): Daemon {
  const targets = overrides.targets ?? loadTargets(cfg.targetsPath);
  const store = new Store({ dbPath: join(cfg.home, "agentswitch.db"), tasksDir: join(cfg.home, "tasks"), threadsDir: join(cfg.home, "threads") });
  const bus = new Bus();
  const routingLog = new RoutingLog(join(cfg.home, "routing.db"));
  const contextPath = join(cfg.home, "CONTEXT.md");
  const memoryPath = join(cfg.home, "MEMORY.md");
  const policyPath = join(cfg.home, "approvals.json");
  const resident = overrides.opencode;
  const router = overrides.router ?? (cfg.router === "echo" ? defaultEchoRouter(targets) : resident ? serveRouter(resident, "dispatcher", targets.router.model) : opencodeRouter({ model: targets.router.model }));
  const rateLimits = new RateLimitCache();
  const extensions = extensionsAt(cfg.home);
  const prot = defaultProtected({ ...process.env, AGENTSWITCH_HOME: cfg.home });
  const executors = overrides.executors ?? (cfg.executors === "real" ? realExecutors(targets, cfg.browser, rateLimits, extensions, prot) : Object.keys(targets.harnesses).map((h) => echoExecutor(h)));
  const quota = overrides.quota ?? new QuotaService([
    codexQuota({ binary: targets.harnesses.codex?.binary ?? "codex" }),
    deepseekQuota({ key: findDeepSeekKey() }),
    claudeQuota({ cache: rateLimits, ...(cfg.executors === "real" ? { probe: () => probeRateLimits() } : {}) }),
  ], cfg.quotaTtlMs);
  const workRoot = join(cfg.home, "work");
  const uploads = new Uploads(join(cfg.home, "uploads"));
  const artifactsDir = join(cfg.home, "artifacts");
  sweepDir(uploads.dir, UPLOAD_TTL_MS);
  sweepDir(artifactsDir, ARTIFACT_TTL_MS);
  sweepThreads(store);
  // The summarizer rides on the real router agent; the echo router's fixed replies are not summaries.
  // The summarizer is a text-only agent on the router's model, run in a scratch dir so it never explores the repo.
  mkdirSync(join(cfg.home, "router-scratch"), { recursive: true });
  const oracle = (agentName: string): Router => resident ? serveRouter(resident, "oracle", targets.router.model) : opencodeRouter({ model: targets.router.model, agentName, tools: "none", runIn: join(cfg.home, "router-scratch") });
  const summarizer = cfg.router === "echo" || overrides.router ? undefined : routerSummarizer(oracle("summarizer"), targets.router.timeout_ms);
  // The supervisor is the same text-only agent shape: approvals on the user's behalf, watchdog, acceptance.
  const supervisor = summarizer ? routerSupervisor(oracle("supervisor"), targets.router.supervisor, targets.router.timeout_ms) : undefined;
  const extensionsSummary = () => summarizeExtensions(extensions);
  // The sealer (router-v0 §9) is the same text-only agent plus `secret-gate enc --batch`; only with real executors, which require the gate.
  const gate = cfg.executors === "real" ? defaultGate() : null;
  const sealer = overrides.sealer ?? (summarizer && gate ? routerSealer(oracle("sealer"), gateMinter(gate), () => sitesFromContext(loadContext(contextPath).text), targets.router.timeout_ms) : undefined);
  const engine = new Engine({ store, bus, executors, targets, router, quota: () => quota.map(), contextPath, cleanupPaths: { ...defaultCleanupPaths(), workRoot }, routingLog, artifactsDir, protected: prot, memoryPath, extensionsSummary, maxConcurrentTasks: cfg.maxTasks, policyPath, ...(summarizer ? { summarizer } : {}), ...(supervisor ? { supervisor } : {}) });
  const routeDeps = () => ({ targets, router, quota: quota.map(), running: engine.runningByHarness(), context: loadContext(contextPath), memory: loadMemory(memoryPath), records: store.recordsSince(Date.now() - RECORD_WINDOW_MS), extensions: extensionsSummary(), threads: engine.threadBriefs() });
  const app = createApp({ ...(sealer ? { sealer } : {}), store, bus, engine, targets, quota, routingLog, routeDeps, contextPath, memoryPath, policyPath, workRoot, cwdRules: defaultCwdRules(process.env, cfg.home), uploads, artifactsDir, extensions, version: VERSION });
  return { app, engine, store, quota, targets, close: () => { store.close(); routingLog.close(); } };
}

/** Real executors need the gate (design §3.9: no harness starts without it; decided again 2026-09-22). */
export function realExecutors(targets: Targets, browser: boolean, rateLimits?: RateLimitCache, extensions?: Extensions, prot: ProtectedPaths = defaultProtected()): Executor[] {
  const gate = defaultGate();
  if (!gate) throw new Error("secret-gate not found (packages/secret-gate/.venv/bin/secret-gate or $SECRET_GATE_BIN): refusing to start real executors without the gate");
  const ext = extensions ? { extensions } : {};
  const timeout = (h: string) => targets.harnesses[h]?.timeout_ms ?? 30 * 60_000;
  return [
    claudeExecutor({ gate, browser, ...ext, protected: prot, maxMs: timeout("claude-code"), ...(rateLimits ? { rateLimits } : {}) }),
    codexExecutor({ binary: targets.harnesses.codex?.binary ?? "codex", gate, browser, ...ext, maxMs: timeout("codex") }),
    opencodeExecutor({ gate, browser, ...ext, protected: prot, maxMs: timeout("opencode") }),
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

/** Start-up: discover models (real executors only), bring up the resident OpenCode server (real router only), then listen. */
export async function serve(cfg: DaemonConfig): Promise<{ daemon: Daemon; close: () => void }> {
  const yaml = loadTargets(cfg.targetsPath);
  const targets = cfg.executors === "real" ? await discoverTargets(yaml, { codexBinary: yaml.harnesses.codex?.binary ?? "codex" }) : yaml;
  let opencode: OpenCodeServer | undefined;
  if (cfg.router === "opencode") {
    const gate = defaultGate();
    const server = new OpenCodeServer({ binary: cfg.opencodeBinary, port: cfg.opencodePort, home: join(cfg.home, "opencode"), gateHome: gate?.home ?? join(process.env.HOME ?? "", ".secret-gate") });
    try { await server.start(); opencode = server; }
    catch (err) { console.error(`${(err as Error).message}; router-type calls fall back to opencode run --standalone`); }
  }
  const daemon = buildDaemon(cfg, { targets, ...(opencode ? { opencode } : {}) });
  const server = listen({ fetch: daemon.app.fetch, hostname: "127.0.0.1", port: cfg.port }, (info) => {
    console.error(`agentswitchd ${VERSION} listening on http://127.0.0.1:${info.port}  router=${cfg.router}${opencode ? " (resident serve)" : ""} executors=${cfg.executors} maxTasks=${cfg.maxTasks} home=${cfg.home}`);
  });
  void daemon.quota.refresh();
  const sweeper = setInterval(() => sweepThreads(daemon.store), 3600_000);
  sweeper.unref();
  return { daemon, close: () => { clearInterval(sweeper); server.close(); daemon.close(); opencode?.stop(); } };
}
