/** Composition root: config → store, bus, engine, executors, quota, API. `serve()` listens on 127.0.0.1 and, with
 *  AGENTSWITCH_REMOTE=1, on the remote HTTPS port for paired phones (app-v0 §2). */

import { Assistant } from "./assistant/assistant.js";
import { AssistantLog } from "./assistant/log.js";
import { announceUpdate, Reporter, type ReporterOptions } from "./assistant/reports.js";
import { updateState } from "./files/appUpdate.js";
import { admitSealed, type TaskBody } from "./api/tasks.js";
import type { ApiDeps } from "./api/shared.js";
import { BrowserSlots } from "./executors/browserSlots.js";
import { cloneRoot, CloneSweeper } from "./executors/chromeClones.js";
import { BROWSER_PROFILES_DIR } from "./executors/protected.js";
import { serve as listen, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./api/app.js";
import { defaultCwdRules } from "./api/cwdPolicy.js";
import { guardLocal } from "./api/localGuard.js";
import { ensureLocalToken, LocalAuth } from "./api/localAuth.js";
import { Bus } from "./engine/bus.js";
import { defaultCleanupPaths } from "./engine/cleanup.js";
import { DEFAULT_MAX_TASKS, Engine } from "./engine/engine.js";
import { Store } from "./engine/store.js";
import { canonical, claudeExecutor, decideTool, probeRateLimits } from "./executors/claude.js";
import { codexExecutor } from "./executors/codex.js";
import { echoExecutor } from "./executors/echo.js";
import { defaultGate, gateHealth, gateNotFound, type GateOptions } from "./executors/gate.js";
import { gateRefsExecutor } from "./executors/gateRefs.js";
import { gateRefs } from "./secrets/refs.js";
import { gateMinter } from "./secrets/minter.js";
import { credentialGate } from "./secrets/credentialRepair.js";
import { platformExperience } from "./engine/platformContext.js";
import { credentialRepairExecutor } from "./executors/credentialRepair.js";
import { routerSealer, type Sealer } from "./secrets/sealer.js";
import { type Extensions, extensionsAt } from "./extensions/index.js";
import { opencodeExecutor } from "./executors/opencode.js";
import { OpenCodeExecServer, opencodeServeConfig } from "./executors/opencodeServer.js";
import { defaultProtected, type ProtectedPaths } from "./executors/protected.js";
import { routerSummarizer } from "./threads/summary.js";
import { routerSupervisor } from "./router/supervisor.js";
import { loadMemory } from "./threads/memory.js";
import { RECORD_WINDOW_MS } from "./router/record.js";
import type { ExtensionsSummary } from "./router/prompt.js";
import type { Executor } from "./executors/types.js";
import { claudeQuota } from "./quota/claude.js";
import { codexQuota } from "./quota/codex.js";
import { deepseekQuota, findDeepSeekKey } from "./quota/deepseek.js";
import { QuotaService } from "./quota/index.js";
import { RateLimitCache } from "./quota/windows.js";
import { loadContext } from "./core/contextDoc.js";
import { sweepDir } from "./files/artifacts.js";
import { resolveCommand } from "./util/which.js";
import { ARTIFACT_TTL_MS, UPLOAD_TTL_MS } from "./files/names.js";
import { Uploads } from "./files/uploads.js";
import { RoutingLog } from "./router/log.js";
import { echoRouter } from "./router/routers/echo.js";
import { opencodeRouter } from "./router/routers/opencode.js";
import type { Router } from "./core/modelCall.js";
import { loadTargets, type Targets, modelKey } from "./router/targets.js";
import { withModelOverlay } from "./router/modelOverlay.js";
import { mountRemoteAdmin } from "./remote/admin.js";
import { createRemoteApp } from "./remote/app.js";
import { DEFAULT_REMOTE_PORT, remoteRuntime, type RemoteRuntime } from "./remote/runtime.js";
import { listenRemote, type RemoteListener } from "./remote/server.js";
import type { TargetRef } from "./core/target.js";
import { mergeLogged } from "./router/discovery.js";
import { ModelOffers } from "./router/modelOffers.js";
import { OpenCodeServer, serveRouter, DEFAULT_OPENCODE_PORT } from "./router/routers/opencodeServe.js";
import type { PlannerFactory } from "./engine/engine.js";
import { claudeTextRouter, type ClaudeRouterOptions } from "./router/routers/claude.js";
import { codexTextRouter } from "./router/routers/codex.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS, QUOTA_TTL_MS } from "./core/limits.js";
import { loadWorkdir } from "./files/workdir.js";
import { defaultSessionSources, SessionMonitor } from "./sessions/monitor.js";
import { broadFolders, sessionsNear, SESSIONS_READ } from "./sessions/folders.js";
import { TerminalAudit } from "./terminals/audit.js";
import { TerminalHost, type Launcher, type TerminalHarness } from "./terminals/host.js";
import { agentLauncher } from "./terminals/launch.js";
import { elsewhereCheck, type ElsewhereCheck } from "./terminals/elsewhere.js";
import { readTerminalStyle, type TerminalStyle } from "./terminals/style.js";
import { TERMINAL_HARNESSES } from "./terminals/host.js";

export const VERSION = "0.1.0";
export const DEFAULT_PORT = 4711;
/** Expired archived threads are deleted at start-up and then this often. */
const THREAD_SWEEP_INTERVAL_MS = 3600_000;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAX_PORT = 65_535;

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
  /** OpenCode executors (AGENTSWITCH_OPENCODE_EXECUTOR): `serve` (default) = sessions on a resident executor server of
   *  their own, `run` = `opencode run --standalone` per step (also the automatic fallback). */
  readonly opencodeExecutor?: "serve" | "run";
  /** app-v0 §2: HTTPS for paired phones on all interfaces (AGENTSWITCH_REMOTE=1, AGENTSWITCH_REMOTE_PORT, default 4713;
   *  AGENTSWITCH_REMOTE_NAME overrides the Mac name in the pairing payload). Absent = off. */
  readonly remote?: { readonly port: number; readonly name?: string };
  /** The AgentSwitch.app this daemon runs from (AGENTSWITCH_APP_BUNDLE, set by the Mac app): staged updates sit next to it. */
  readonly appBundle?: string;
  /** Tasks with no folder of their own work in a dated subfolder of the user's default work folder (docs/control-v0.md
   *  §2; `workdir.json`, default ~/AgentSwitch) instead of a throw-away one in the data directory. On unless
   *  AGENTSWITCH_TASK_FOLDERS=0; tests build configs without it. */
  readonly taskFolders?: boolean;
  /** Watch the Mac's own Claude Code / Codex / OpenCode sessions (docs/control-v0.md §3). On unless
   *  AGENTSWITCH_SESSIONS=0; tests build configs without it. */
  readonly watchSessions?: boolean;
  /** AgentSwitch's own terminals, the manual entry (docs/terminal-v0.md). On unless AGENTSWITCH_TERMINALS=0; tests build
   *  configs without it. */
  readonly terminals?: boolean;
};

/** AGENTSWITCH_REMOTE_PORT as a TCP port (0 = any free one); unset, empty or not a port → the default. */
export function remotePort(value: string | undefined): number {
  const n = value?.trim() ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_PORT ? n : DEFAULT_REMOTE_PORT;
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const home = env.AGENTSWITCH_HOME ?? join(env.HOME ?? ".", ".agentswitch");
  return {
    home,
    targetsPath: env.AGENTSWITCH_TARGETS ?? resolve(HERE, "..", "config", "targets.yaml"),
    port: Number(env.AGENTSWITCH_PORT ?? DEFAULT_PORT),
    router: env.AGENTSWITCH_ROUTER === "echo" ? "echo" : "opencode",
    executors: env.AGENTSWITCH_EXECUTORS === "real" ? "real" : "echo",
    browser: env.AGENTSWITCH_BROWSER !== "0",   // gated Playwright MCP attached to browser tasks when the gate exists
    quotaTtlMs: QUOTA_TTL_MS,
    maxTasks: Math.max(1, Number(env.AGENTSWITCH_MAX_TASKS ?? DEFAULT_MAX_TASKS) || DEFAULT_MAX_TASKS),
    opencodePort: Number(env.AGENTSWITCH_OPENCODE_PORT ?? DEFAULT_OPENCODE_PORT) || DEFAULT_OPENCODE_PORT,
    opencodeBinary: env.OPENCODE_BIN ?? join(env.HOME ?? "", ".opencode", "bin", "opencode"),
    opencodeExecutor: env.AGENTSWITCH_OPENCODE_EXECUTOR === "run" ? "run" : "serve",
    ...(env.AGENTSWITCH_REMOTE === "1" || env.AGENTSWITCH_REMOTE === "true"
      ? { remote: { port: remotePort(env.AGENTSWITCH_REMOTE_PORT), ...(env.AGENTSWITCH_REMOTE_NAME?.trim() ? { name: env.AGENTSWITCH_REMOTE_NAME.trim() } : {}) } }
      : {}),
    ...(env.AGENTSWITCH_APP_BUNDLE?.trim() ? { appBundle: env.AGENTSWITCH_APP_BUNDLE.trim() } : {}),
    taskFolders: env.AGENTSWITCH_TASK_FOLDERS !== "0",
    watchSessions: env.AGENTSWITCH_SESSIONS !== "0",
    terminals: env.AGENTSWITCH_TERMINALS !== "0",
  };
}

export type Daemon = {
  /** What the 127.0.0.1 listener serves: the API plus the local-only remote management routes. */
  readonly app: ReturnType<typeof createApp>;
  /** The API alone; the remote listener forwards its allowlisted routes here. */
  readonly api: ReturnType<typeof createApp>;
  /** Remote access state when AGENTSWITCH_REMOTE is on (certificate generated on first build), else null. */
  readonly remote: RemoteRuntime | null;
  readonly engine: Engine;
  readonly store: Store;
  readonly quota: QuotaService;
  readonly targets: Targets;
  /** AgentSwitch's own terminals (docs/terminal-v0.md), or null when off. */
  readonly terminals: TerminalHost | null;
  /** The port the 127.0.0.1 listener got: the terminals' hook command calls it. */
  setLocalPort(port: number): void;
  close(): void;
};

export type BuildOverrides = {
  readonly router?: Router;
  readonly executors?: readonly Executor[];
  readonly quota?: QuotaService;
  /** Catalog after discovery (serve() passes it); default: the yaml as is. */
  readonly targets?: Targets;
  /** What the agents offer today, kept fresh (serve() passes it with real executors): the terminals' model menus. */
  readonly modelOffers?: ModelOffers;
  /** The resident OpenCode server; when absent, router-type calls fall back to `opencode run --standalone`. */
  readonly opencode?: OpenCodeServer;
  /** The OpenCode executors' own resident server (real executors only); when absent they run `opencode run --standalone`. */
  readonly opencodeExec?: OpenCodeExecServer;
  /** Tests: a sealer without a model or the gate. */
  readonly sealer?: Sealer;
  /** Tests: the planner for multi-step tasks (loop-v0 §6). */
  readonly planner?: PlannerFactory;
  /** Tests: remote state without openssl or the network (null = off whatever cfg.remote says). */
  readonly remote?: RemoteRuntime | null;
  /** Tests: a short SSE heartbeat period. */
  readonly sseHeartbeatMs?: number;
  /** Tests: the reporter's waits (summary, needs-you grace, watch tick) and clock. */
  readonly reports?: Omit<ReporterOptions, "log" | "store" | "bus">;
  /** Tests: the assistant's model (assistant-v0 §1.1) without OpenCode. */
  readonly assistant?: Router;
  /** Tests: how terminals start (a fake agent); also turns terminals on whatever cfg.terminals says. */
  readonly terminalLauncher?: Launcher;
  /** Tests: whether a session is open in another program (default: this Mac's agents; none with a fake launcher). */
  readonly terminalElsewhere?: ElsewhereCheck;
};

/** The agent CLIs a terminal can start, as absolute paths; a missing one is left out (docs/terminal-v0.md §2). The user's
 *  own `claude` (CLAUDE_BIN, else PATH, else the installer's place), not the Agent SDK's bundled copy. */
export function terminalBinaries(targets: Pick<Targets, "harnesses">, opencodeBinary: string, env: NodeJS.ProcessEnv = process.env): Partial<Record<TerminalHarness, string>> {
  const home = env.HOME ?? "";
  const real = (p: string | undefined): string | undefined => (p && isAbsolute(p) && existsSync(p) ? p : undefined);
  const first = (...paths: (string | undefined)[]): string | undefined => paths.map(real).find(Boolean);
  const out: Partial<Record<TerminalHarness, string>> = {};
  const claude = first(env.CLAUDE_BIN ? resolveCommand(env.CLAUDE_BIN, "claude", env.PATH) : undefined, resolveCommand(undefined, "claude", env.PATH), join(home, ".local", "bin", "claude"));
  const codex = first(codexBinary(targets, env));
  const opencode = first(resolveCommand(opencodeBinary || undefined, "opencode", env.PATH), join(home, ".opencode", "bin", "opencode"));
  const pi = first(resolveCommand(undefined, "pi", env.PATH), join(home, ".local", "bin", "pi"));
  if (claude) out["claude-code"] = claude;
  if (codex) out.codex = codex;
  if (opencode) out.opencode = opencode;
  if (pi) out.pi = pi;
  return out;
}

/** The user's own Claude Code CLI (`CLAUDE_BIN`, set by the Mac app) instead of the copy bundled with the Agent SDK:
 *  it already has the user's Keychain grant for its login, where the bundled copy (another code signature) would make
 *  macOS ask again and stall model discovery. Unset → the SDK's bundled CLI, as before. */
export function claudeBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CLAUDE_BIN ? resolveCommand(env.CLAUDE_BIN, "claude", env.PATH) : undefined;
}

const withClaude = (bin: string | undefined): { claudeExecutable?: string } => (bin ? { claudeExecutable: bin } : {});
const executableOf = (bin: string | undefined): { executable?: string } => (bin ? { executable: bin } : {});

/** The codex CLI of this Mac: the catalog's path when it exists, else `codex` on PATH (see resolveCommand). */
export function codexBinary(targets: Pick<Targets, "harnesses">, env: NodeJS.ProcessEnv = process.env): string {
  return resolveCommand(targets.harnesses.codex?.binary, "codex", env.PATH);
}

export function buildDaemon(cfg: DaemonConfig, overrides: BuildOverrides = {}): Daemon {
  // app-v0 §2: $AGENTSWITCH_HOME/models.json (the Mac app's model settings) over targets.yaml; bad parts are ignored.
  const baseTargets = overrides.targets ?? loadTargets(cfg.targetsPath);
  const modelsPath = join(cfg.home, "models.json");
  const targets = withModelOverlay(baseTargets, modelsPath);
  const store = new Store({ dbPath: join(cfg.home, "agentswitch.db"), tasksDir: join(cfg.home, "tasks"), threadsDir: join(cfg.home, "threads"), artifactsDir: join(cfg.home, "artifacts") });
  const bus = new Bus();
  const routingLog = new RoutingLog(join(cfg.home, "routing.db"));
  const contextPath = join(cfg.home, "CONTEXT.md");
  const memoryPath = join(cfg.home, "MEMORY.md");
  const platformMemoryPath = join(cfg.home, "platform-memory.json");
  const policyPath = join(cfg.home, "approvals.json");
  const resident = overrides.opencode;
  const router = overrides.router ?? (cfg.router === "echo" ? defaultEchoRouter(targets) : resident ? serveRouter(resident, "dispatcher", targets.router.model) : opencodeRouter({ model: targets.router.model }));
  const rateLimits = new RateLimitCache();
  const extensions = extensionsAt(cfg.home);
  const prot = defaultProtected({ ...process.env, AGENTSWITCH_HOME: cfg.home });
  const executors = overrides.executors ?? (cfg.executors === "real" ? realExecutors(targets, cfg.browser, rateLimits, extensions, prot, overrides.opencodeExec) : Object.keys(targets.harnesses).map((h) => echoExecutor(h)));
  const quota = overrides.quota ?? new QuotaService([
    codexQuota({ binary: codexBinary(targets) }),
    deepseekQuota({ key: findDeepSeekKey() }),
    claudeQuota({ cache: rateLimits, ...(cfg.executors === "real" ? { probe: (signal?: AbortSignal) => probeRateLimits(undefined, claudeBinary(), signal) } : {}) }),
  ], cfg.quotaTtlMs);
  const workRoot = join(cfg.home, "work");
  const uploads = new Uploads(join(cfg.home, "uploads"));
  const artifactsDir = join(cfg.home, "artifacts");
  sweepDir(uploads.dir, UPLOAD_TTL_MS);
  sweepDir(artifactsDir, ARTIFACT_TTL_MS);
  // The summarizer rides on the real router agent; the echo router's fixed replies are not summaries.
  // The summarizer is a text-only agent on the router's model, run in a scratch dir so it never explores the repo.
  mkdirSync(join(cfg.home, "router-scratch"), { recursive: true });
  const oracle = (agentName: string): Router => resident ? serveRouter(resident, "oracle", targets.router.model) : opencodeRouter({ model: targets.router.model, agentName, tools: "none", runIn: join(cfg.home, "router-scratch") });
  const summarizer = cfg.router === "echo" || overrides.router ? undefined : routerSummarizer(oracle("summarizer"), targets.router.timeout_ms);
  // The supervisor is the same text-only agent shape: approvals on the user's behalf, watchdog, acceptance.
  const supervisor = summarizer ? routerSupervisor(oracle("supervisor"), targets.router.supervisor, targets.router.timeout_ms) : undefined;
  const questionRouter = summarizer ? oracle("question-translator") : router;
  const extensionsSummary = () => summarizeExtensions(extensions);
  // loop-v0 §6: the planner runs multi-step tasks; only with a real router, and only while its harness has quota.
  const planner = overrides.planner ?? (cfg.router === "echo" || overrides.router ? undefined : plannerFor(targets, resident, () => quota.map()));
  // The sealer (router-v0 §9) is the same text-only agent plus `secret-gate enc --batch`; only with real executors, which require the gate.
  const gate = cfg.executors === "real" ? defaultGate() : null;
  const sealer = overrides.sealer ?? (summarizer && gate ? routerSealer(oracle("sealer"), gateMinter(gate), () => loadContext(contextPath).text, targets.router.timeout_ms) : undefined);
  // gate-next-v0 §1/§3: per-execution enc:ref: scope and proxy health, inside the repair bridge so its handoff notes
  // and repaired tokens are registered too.
  const scoped = gate ? executors.map((executor) => gateRefsExecutor(executor, { refs: gateRefs(gate), health: () => gateHealth(gate) })) : executors;
  const wiredExecutors = gate && summarizer ? scoped.map((executor) => credentialRepairExecutor(executor, { gate: credentialGate(gate), router: oracle("credential-repair"), store })) : scoped;
  // Kept browser logins (threads-v0 §4b): real executors only; the directory is read-denied to them (prot.readDenied).
  const browserSlots = cfg.executors === "real" ? new BrowserSlots(join(cfg.home, BROWSER_PROFILES_DIR)) : undefined;
  const cloneDir = cfg.executors === "real" ? cloneRoot() : null;
  const clones = cloneDir ? new CloneSweeper({ root: cloneDir }) : undefined;
  clones?.schedule();   // what earlier runs left behind
  const taskFolderRoot = cfg.taskFolders ? () => loadWorkdir(cfg.home) : undefined;
  // docs/terminal-v0.md: the manual entry's terminals, with the gate like the executors when the gate is there.
  let localPort = cfg.port;
  const agentBinaries = cfg.terminals && !overrides.terminalLauncher ? terminalBinaries(targets, cfg.opencodeBinary) : {};
  const terminalHost = cfg.terminals || overrides.terminalLauncher
    ? new TerminalHost({
      launcher: overrides.terminalLauncher ?? agentLauncher({ binaries: agentBinaries, gate, hookUrl: () => `http://127.0.0.1:${localPort}`, stateDir: join(cfg.home, "terminals"), protected: prot }),
      // The executors' protected paths hold in terminals too, whatever the permission mode (docs/terminal-v0.md §3).
      floor: (tool, input, cwd) => { const d = decideTool(tool, input, canonical(cwd), new Set(), prot); return d.kind === "deny" ? d.reason : null; },
    })
    : null;
  let style: TerminalStyle | null = null;
  const terminals = terminalHost ? {
    host: terminalHost,
    audit: new TerminalAudit(join(cfg.home, "terminals", "audit.jsonl")),
    agents: overrides.terminalLauncher ? [...TERMINAL_HARNESSES] : TERMINAL_HARNESSES.filter((h) => agentBinaries[h]),
    style: () => (style ??= readTerminalStyle()),
    elsewhere: overrides.terminalElsewhere ?? (overrides.terminalLauncher ? async () => null : elsewhereCheck()),
    ...(overrides.modelOffers ? { offers: () => overrides.modelOffers!.current() } : {}),
  } : undefined;
  const sessions = cfg.watchSessions ? new SessionMonitor({ ...defaultSessionSources(cfg.home), ownIds: () => store.harnessSessionIds(), ownFolders: () => (taskFolderRoot ? [taskFolderRoot()] : []) }) : undefined;
  const nearSessions = sessions ? (cwd: string) => sessionsNear(sessions.list(SESSIONS_READ), cwd, Date.now(), broadFolders()) : undefined;
  const conversation = new AssistantLog(join(cfg.home, "assistant.db"));
  const engine = new Engine({ conversation, ...(taskFolderRoot ? { taskFolderRoot } : {}), ...(nearSessions ? { sessionsNear: nearSessions } : {}), store, bus, executors: wiredExecutors, targets, router, questionRouter, quota: () => quota.map(), contextPath, cleanupPaths: { ...defaultCleanupPaths(), workRoot }, routingLog, artifactsDir, protected: prot, ...(browserSlots ? { browserSlots } : {}), ...(clones ? { afterBrowserRun: () => clones.schedule() } : {}), memoryPath, platformMemoryPath, extensionsSummary, maxConcurrentTasks: cfg.maxTasks, policyPath, ...(summarizer ? { summarizer } : {}), ...(supervisor ? { supervisor } : {}), ...(planner ? { planner } : {}) });
  // Tasks the last run left unfinished cannot be confirmed either way (docs/control-v0.md §4).
  engine.interruptLeftovers();
  sweepThreads(store, Date.now(), engine);
  forgetDeletedTasks(conversation, store);
  const routeDeps = () => ({ targets, router, quota: quota.map(), context: loadContext(contextPath), memory: loadMemory(memoryPath), platformMemory: (task: string) => platformExperience(platformMemoryPath, task, loadContext(contextPath).text), records: store.recordsSince(Date.now() - RECORD_WINDOW_MS), extensions: extensionsSummary(), threads: engine.threadBriefs() });
  const apiDeps: ApiDeps = { ...(taskFolderRoot ? { taskFolderRoot } : {}), ...(sessions ? { sessions } : {}), ...(terminals ? { terminals } : {}), ...(sealer ? { sealer } : {}), store, bus, engine, targets, quota, routingLog, routeDeps, contextPath, memoryPath, platformMemoryPath, policyPath, workRoot, cwdRules: defaultCwdRules(process.env, cfg.home), home: cfg.home, ...(cfg.appBundle ? { appBundle: cfg.appBundle } : {}), uploads, artifactsDir, extensions, version: VERSION, models: { path: modelsPath, base: baseTargets }, ...(overrides.sseHeartbeatMs ? { sseHeartbeatMs: overrides.sseHeartbeatMs } : {}) };
  // assistant-v0 §1.1: the router as the user's assistant, on the router model (a text-only agent); echo mode has none
  // and every message becomes a task. Task creation is POST /tasks's second half (admitSealed).
  const assistantRouter = overrides.assistant ?? (summarizer ? oracle("assistant") : undefined);
  // Ends, questions for the user and watched tasks' progress, told in the conversation (assistant-v0 step 3).
  const reporter = new Reporter({ log: conversation, store, bus, home: cfg.home, ...overrides.reports });
  reporter.start();
  announceUpdate(cfg.home, conversation);
  const assistant = new Assistant({ log: conversation, store, engine, ...(assistantRouter ? { router: assistantRouter } : {}), ...(sealer ? { sealer } : {}),
    admit: (body, sealed) => admitSealed(apiDeps, body as TaskBody, sealed), workRoot: apiDeps.workRoot, ...(sessions ? { sessions } : {}), stagedUpdate: () => updateState(cfg.appBundle)?.staged?.built ?? null, timeoutMs: targets.router.timeout_ms });
  const api = createApp({ ...apiDeps, assistant });
  const remote = overrides.remote !== undefined ? overrides.remote : cfg.remote ? remoteRuntime({ home: cfg.home, port: cfg.remote.port, ...(cfg.remote.name ? { name: cfg.remote.name } : {}), gate: () => defaultGate() }) : null;
  const app = mountRemoteAdmin(new Hono().route("/", api), { store, remote });
  return { app, api, remote, engine, store, quota, targets, terminals: terminalHost, setLocalPort: (port) => { localPort = port; },
    close: () => { terminalHost?.closeAll(); reporter.stop(); store.close(); routingLog.close(); conversation.close(); } };
}

/** The planner as a text-only Router (loop-v0 §6): the router's pick when it named a usable one, else targets.yaml
 *  `router.planner`, else none (the router runs the loop itself). claude-code goes through the Agent SDK, codex through
 *  app-server, opencode through the resident server; a harness out of quota is not used. */
export function plannerFor(targets: Targets, resident: OpenCodeServer | undefined, quota: () => Record<string, number>): PlannerFactory {
  const usable = (t: TargetRef | null): boolean => !!t && !!targets.harnesses[t.harness] && !!modelKey(targets.harnesses[t.harness]!, t.model) && (quota()[t.harness] ?? 1) >= targets.router.quota_threshold;
  const build = (t: TargetRef): Router | null => {
    if (t.harness === "claude-code") return claudeTextRouter(claudePlannerOptions(t.model));
    if (t.harness === "codex") return codexTextRouter({ model: t.model, binary: codexBinary(targets) });
    if (t.harness === "opencode" && resident) return serveRouter(resident, "oracle", t.model);
    return null;
  };
  return (pick) => {
    for (const t of [pick, targets.router.planner]) {
      if (!usable(t)) continue;
      const router = build(t!);
      if (router) return { router, target: t! };
    }
    return null;
  };
}

/** A claude-code planner: the user's own CLI like the executor and the model discovery (the SDK's bundled copy has no
 *  Keychain grant when started from the Mac app, so every planner call failed), from tmpdir like the discovery. */
export function claudePlannerOptions(model: string, env: NodeJS.ProcessEnv = process.env): ClaudeRouterOptions {
  return { model, cwd: tmpdir(), ...executableOf(claudeBinary(env)) };
}

/** Real executors need the gate (design §3.9: no harness starts without it; decided again 2026-09-22). */
export function realExecutors(targets: Targets, browser: boolean, rateLimits?: RateLimitCache, extensions?: Extensions, prot: ProtectedPaths = defaultProtected(), opencodeServer?: OpenCodeExecServer): Executor[] {
  const gate = defaultGate();
  if (!gate) throw new Error(`${gateNotFound()}: refusing to start real executors without the gate`);
  const ext = extensions ? { extensions } : {};
  const timeout = (h: string) => targets.harnesses[h]?.timeout_ms ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
  return [
    claudeExecutor({ gate, browser, ...ext, protected: prot, maxMs: timeout("claude-code"), ...(rateLimits ? { rateLimits } : {}), ...executableOf(claudeBinary()) }),
    codexExecutor({ binary: codexBinary(targets), gate, browser, ...ext, protected: prot, maxMs: timeout("codex") }),
    opencodeExecutor({ gate, browser, ...ext, protected: prot, maxMs: timeout("opencode"), ...(opencodeServer ? { server: opencodeServer } : {}) }),
  ];
}

/** Names and one-liners only (progressive disclosure): the router mentions an extension, the executor loads it. */
export function summarizeExtensions(ext: Extensions): ExtensionsSummary {
  return {
    mcp: ext.mcp.list().filter((m) => m.enabled).map((m) => ({ name: m.name, note: m.note, harnesses: m.harnesses })),
    skills: ext.skills.list().filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description, harnesses: s.harnesses })),
  };
}

/** Conversation lines about tasks deleted while the conversation was not told (before it was, or by an older version). */
export function forgetDeletedTasks(conversation: AssistantLog, store: Pick<Store, "getTask">): number {
  const gone = [...conversation.taskIds()].filter((id) => !store.getTask(id));
  const lines = conversation.forgetTasks(gone);
  if (lines) console.error(`conversation: ${lines} lines about ${gone.length} deleted tasks removed`);
  return lines;
}

/** Archived threads past their expiry lose their row, log and private home. Runs at start and hourly. */
export function sweepThreads(store: Store, now = Date.now(), engine?: Pick<Engine, "deleteThread">): string[] {
  const gone: string[] = [];
  for (const t of store.expiredThreads(now)) {
    try {
      if (engine ? engine.deleteThread(t.id).ok : store.deleteThread(t.id)) gone.push(t.id);
    } catch (err) {
      console.error(`thread ${t.id} could not be deleted: ${(err as Error).message}`);
    }
  }
  if (gone.length) console.error(`threads expired and deleted: ${gone.join(", ")}`);
  return gone;
}

function defaultEchoRouter(targets: Targets): Router {
  return echoRouter((input) => JSON.stringify({ harness: targets.router.default.harness, model: null, brief: input.task.split("\n\nTask:\n")[1] ?? input.task, confidence: 0.9 }));
}

/** §3 start-up check: real executors refuse every run while the gate proxy is down, so say so loudly now. */
export async function checkGateProxy(gate: GateOptions | null, log: (message: string) => void = console.error): Promise<boolean> {
  if (!gate) return false;
  const health = await gateHealth(gate);
  if (!health.ok) log(`ERROR secret-gate proxy ${gate.proxy} is not reachable (${health.error}): every task will stop before its executor starts. Start it with \`secret-gate service install\` (launchd) or \`secret-gate proxy\`.`);
  return health.ok;
}

/** The OpenCode executors' resident server (`opencode serve --stdio`, own config and password, proxy-free env). Kept
 *  even when the first start fails: executors retry it after a cooldown and run standalone meanwhile. */
export async function startOpenCodeExecServer(cfg: DaemonConfig): Promise<OpenCodeExecServer> {
  const home = join(cfg.home, "opencode-exec");
  const prot = defaultProtected({ ...process.env, AGENTSWITCH_HOME: cfg.home });
  const server = new OpenCodeExecServer({ binary: cfg.opencodeBinary, home, config: opencodeServeConfig(defaultGate(), prot, join(home, "skills")) });
  try { await server.start(); }
  catch (err) { console.error(`${(err as Error).message}; OpenCode executors run opencode run --standalone until it starts`); }
  return server;
}

/** Start-up: discover models (real executors only: the catalog takes new ids, the terminals' model menus what each
 *  agent offers, kept fresh from then on), bring up the resident OpenCode servers (router: real router only; executors:
 *  real executors in serve mode), then listen. */
export async function serve(cfg: DaemonConfig): Promise<{ daemon: Daemon; close: () => void }> {
  if (cfg.executors === "real") await checkGateProxy(defaultGate());
  const yaml = loadTargets(cfg.targetsPath);
  const modelOffers = cfg.executors === "real" ? new ModelOffers({ codexBinary: codexBinary(yaml), ...withClaude(claudeBinary()) }) : undefined;
  const targets = modelOffers ? mergeLogged(yaml, await modelOffers.refresh()) : yaml;
  const stopOffers = modelOffers?.start();
  let opencode: OpenCodeServer | undefined;
  if (cfg.router === "opencode") {
    const gate = defaultGate();
    const server = new OpenCodeServer({ binary: cfg.opencodeBinary, port: cfg.opencodePort, home: join(cfg.home, "opencode"), gateHome: gate?.home ?? join(process.env.HOME ?? "", ".secret-gate") });
    try { await server.start(); opencode = server; }
    catch (err) { console.error(`${(err as Error).message}; router-type calls fall back to opencode run --standalone`); }
  }
  const opencodeExec = cfg.executors === "real" && (cfg.opencodeExecutor ?? "serve") === "serve" ? await startOpenCodeExecServer(cfg) : undefined;
  const daemon = buildDaemon(cfg, { targets, ...(modelOffers ? { modelOffers } : {}), ...(opencode ? { opencode } : {}), ...(opencodeExec ? { opencodeExec } : {}) });
  const remote: RemoteListener | undefined = daemon.remote
    ? await startRemote(daemon, daemon.remote).catch((err: Error) => { daemon.close(); void opencode?.stop(); void opencodeExec?.stop(); throw err; })
    : undefined;
  // Every local caller shows the token (api/localAuth.ts); made on first start, read by the Mac app and the CLI.
  const auth = new LocalAuth(ensureLocalToken(cfg.home));
  const server = listenLocal(daemon, cfg.port, (info) => {
    daemon.setLocalPort(info.port);
    console.error(`agentswitchd ${VERSION} listening on http://127.0.0.1:${info.port}  router=${cfg.router}${opencode ? " (resident serve)" : ""} executors=${cfg.executors} maxTasks=${cfg.maxTasks} home=${cfg.home}`);
  }, auth);
  void daemon.quota.refresh();
  const sweeper = setInterval(() => sweepThreads(daemon.store, Date.now(), daemon.engine), THREAD_SWEEP_INTERVAL_MS);
  sweeper.unref();
  return { daemon, close: () => { clearInterval(sweeper); stopOffers?.(); server.close(); void remote?.close(); daemon.close(); void opencode?.stop(); void opencodeExec?.stop(); } };
}

/** The 127.0.0.1 listener (web UI, CLI, Mac app): the local app behind the browser guard (api/localGuard.ts: Host,
 *  Origin, JSON bodies) and, when given, the local token (api/localAuth.ts). The remote listener forwards into
 *  `daemon.api` in process and never passes either. */
export function listenLocal(daemon: Pick<Daemon, "app">, port: number, onListening?: (info: AddressInfo) => void, auth?: LocalAuth): ServerType {
  return listen({ fetch: guardLocal((request, env) => auth?.check(request) ?? daemon.app.fetch(request, env)), hostname: "127.0.0.1", port }, onListening);
}

/** app-v0 §2: the HTTPS listener for paired phones, before the local one, so a taken port fails start-up cleanly. */
export async function startRemote(daemon: Pick<Daemon, "api" | "store">, remote: RemoteRuntime, host?: string): Promise<RemoteListener> {
  const app = createRemoteApp({ store: daemon.store, pairing: remote.pairing, presence: remote.presence, gateKey: remote.gateKey, addresses: remote.addresses, local: daemon.api });
  try {
    const listener = await listenRemote({ fetch: app.fetch, tls: remote.tls, port: remote.port, ...(host ? { host } : {}) });
    console.error(`agentswitchd remote listening on https://*:${listener.port}  fingerprint=${remote.tls.fingerprint} name="${remote.name}"`);
    return listener;
  } catch (err) {
    throw new Error(`remote listener on port ${remote.port}: ${(err as Error).message}`);
  }
}
