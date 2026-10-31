/** Composition root: config → store, bus, engine, executors, quota, API. `serve()` listens on 127.0.0.1 and, with
 *  AGENTSWITCH_REMOTE=1, on the remote HTTPS port for paired phones (app-v0 §2). */

import { openCodeVariants } from "./harness/efforts.js";
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
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./api/app.js";
import { DEFAULT_PROFILE, PROFILE_AGENTS, ProfileStore } from "./profiles/store.js";
import { SessionKeys } from "./browser/sessionKey.js";
import { ApiKeys } from "./profiles/apiKeys.js";
import { proxyPlace } from "./browser/identity.js";
import { ClashIntegration } from "./clash/integration.js";
import { ClashSource } from "./clash/source.js";
import { ClashStore } from "./clash/store.js";
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
import { defaultGate, gateHealth, gateNotFound, proxyEndpoint, warmBrowserMcp, type GateOptions } from "./executors/gate.js";
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
import { defaultProtected, terminalProtected, type ProtectedPaths } from "./executors/protected.js";
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
import { mountNodes } from "./api/nodes.js";
import { NodeBook, NODES_DIR } from "./nodes/book.js";
import { Dialer } from "./nodes/dial.js";
import { Nodes } from "./nodes/nodes.js";
import { loadMesh, scopeOf, setScope } from "./nodes/settings.js";
import { FileAudit, type FileAccess } from "./api/browse.js";
import { DEFAULT_SCOPE } from "./files/browse.js";
import { Thumbnails } from "./files/thumbnails.js";
import { vergeDir } from "./clash/verge.js";
import { createRemoteApp } from "./remote/app.js";
import { DEFAULT_REMOTE_PORT, macName, remoteRuntime, type RemoteRuntime } from "./remote/runtime.js";
import { listenRemote, type RemoteListener } from "./remote/server.js";
import type { TargetRef } from "./core/target.js";
import { mergeLogged } from "./router/discovery.js";
import { CodexHookTrust, codexHookArgs } from "./terminals/codexHooks.js";
import { ModelOffers } from "./router/modelOffers.js";
import { OpenCodeServer, serveRouter, DEFAULT_OPENCODE_PORT } from "./router/routers/opencodeServe.js";
import type { PlannerFactory } from "./engine/engine.js";
import { claudeTextRouter, type ClaudeRouterOptions } from "./router/routers/claude.js";
import { codexTextRouter } from "./router/routers/codex.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS, QUOTA_TTL_MS } from "./core/limits.js";
import { loadWorkdir } from "./files/workdir.js";
import { defaultSessionSources, SessionMonitor, type SessionSources } from "./sessions/monitor.js";
import { KeptPictures } from "./sessions/pictures.js";
import { openCodeDeleter, type OpenCodeDelete } from "./sessions/opencode.js";
import { broadFolders, sessionsNear, SESSIONS_READ } from "./sessions/folders.js";
import { TerminalAudit } from "./terminals/audit.js";
import { TerminalHost, type KeptTerminal, type Launcher, type TerminalHarness } from "./terminals/host.js";
import { agentLauncher, hookCommandOf, HOOK_SCRIPT, PERMISSION_HOOK_TIMEOUT_S, QUICK_HOOK_TIMEOUT_S, restoreCompanion } from "./terminals/launch.js";
import { holding } from "./terminals/held.js";
import { elsewhereCheck, type ElsewhereCheck } from "./terminals/elsewhere.js";
import { readTerminalStyle, type TerminalStyle } from "./terminals/style.js";
import { endLeftHeld, TERMINAL_HARNESSES } from "./terminals/host.js";
import { BRIDGE_SCRIPT, bridgeCommand, terminalOwner, type AgentEngine } from "./browser/agents.js";
import type { BrowserDriver } from "./browser/driver.js";
import { gateFill } from "./browser/fill.js";
import { exitLookup } from "./browser/exit.js";
import { ExitPool } from "./browser/exits.js";
import { claudeSignedIn, codexSignedIn } from "./terminals/signIn.js";
import { ProfileBrowsers } from "./browser/fleet.js";
import { exitKey, profileOfKey } from "./api/profiles.js";
import type { BrowserHost } from "./browser/host.js";
import { sharedBrowser } from "./browser/setup.js";
import { newEngineKit } from "./browser/engine/setup.js";
import { stdioServePorts } from "./harness/opencodeStdio.js";

export const VERSION = "0.1.0";
export const DEFAULT_PORT = 4711;
/** Expired archived threads are deleted at start-up and then this often. */
const THREAD_SWEEP_INTERVAL_MS = 3600_000;
/** How often Clash Integration looks whether its subscription is due to be fetched again. */
const CLASH_TICK_MS = 60_000;
/** How often the Codex records are looked at for the picture files they name when no screen reads the list (a pasted
 *  picture's file lasts about three days), and how soon after the service starts (docs/simple-view-v0.md §4). */
const PICTURES_EVERY_MS = 30 * 60_000;
const PICTURES_FIRST_MS = 20_000;
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
  /** The shared browser (docs/browser-v0.md): one Chrome the daemon holds, for the screens and later the agents. On
   *  unless AGENTSWITCH_BROWSER_HOST=0; tests build configs without it. */
  readonly browserHost?: boolean;
  /** Camoufox with windows of its own (docs/browser-v0.md §7.2); off: headless. */
  readonly browserWindow?: boolean;
  /** Terminals outlive the service on holders of their own (docs/terminal-v0.md §10). */
  readonly holdTerminals?: boolean;
};

/** AGENTSWITCH_REMOTE_PORT as a TCP port (0 = any free one); unset, empty or not a port → the default. */
export function remotePort(value: string | undefined): number {
  const n = value?.trim() ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_PORT ? n : DEFAULT_REMOTE_PORT;
}

/** A held terminal's output its holder keeps for the next daemon: as much as a terminal's buffer (terminal-v0 §2). */
const TERMINAL_RING_BYTES = 2 * 1024 * 1024;

/** A path in this runtime spelled through its `current` link (`AGENTSWITCH_RUNTIME_LINK`, the Linux node's keeper sets
 *  it), so that a command written into a terminal's settings still works after an update removes this runtime. */
function stable(path: string, link: string | undefined = process.env.AGENTSWITCH_RUNTIME_LINK): string {
  if (!link) return path;
  try {
    const root = realpathSync(link);
    return path.startsWith(`${root}/`) ? join(link, path.slice(root.length + 1)) : path;
  } catch { return path; }
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
    // docs/terminal-v0.md §10: each terminal's program on a pty its own holder holds, so that it outlives the service
    // (the Linux node's keeper turns it on; node.json `"holdTerminals": false` turns it off).
    holdTerminals: env.AGENTSWITCH_HOLD_TERMINALS === "1",
    browserHost: env.AGENTSWITCH_BROWSER_HOST !== "0",
    // docs/browser-v0.md §7.2: Camoufox's tabs have windows of their own on a Mac; `AGENTSWITCH_BROWSER_WINDOW=0`
    // (throw-away services, a Mac nobody sits at) and every other system keep it without one.
    browserWindow: process.platform === "darwin" && env.AGENTSWITCH_BROWSER_WINDOW !== "0",
  };
}

export type Daemon = {
  /** What the 127.0.0.1 listener serves: the API plus the local-only remote management routes. */
  readonly app: ReturnType<typeof createApp>;
  /** The API alone; the remote listener forwards its allowlisted routes here. */
  readonly api: ReturnType<typeof createApp>;
  /** Remote access state when AGENTSWITCH_REMOTE is on (certificate generated on first build), else null. */
  readonly remote: RemoteRuntime | null;
  /** The other nodes this one uses, and what it says of itself to them (docs/mesh-v0.md). */
  readonly nodes: Nodes;
  readonly engine: Engine;
  readonly store: Store;
  readonly quota: QuotaService;
  readonly targets: Targets;
  /** AgentSwitch's own terminals (docs/terminal-v0.md), or null when off. */
  readonly terminals: TerminalHost | null;
  /** The Mac's own sessions as they are watched (docs/control-v0.md §3), or null when off. */
  readonly sessions: SessionMonitor | null;
  /** The shared browser (docs/browser-v0.md), or null when off. */
  readonly browser: BrowserHost | null;
  /** Closes the shared browser's Chrome (a few seconds at most); `close()` does not wait for it. */
  stopBrowser(): Promise<void>;
  /** The port the 127.0.0.1 listener got: the terminals' hook command calls it. */
  setLocalPort(port: number): void;
  readonly clash: ClashIntegration;
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
  /** Tests: where the agents' own sessions are read (default: the user's, under their home). */
  readonly sessionSources?: SessionSources;
  /** Tests: how an OpenCode session is deleted (default: the user's opencode; none with a fake launcher). */
  readonly openCodeDelete?: OpenCodeDelete;
  /** Tests: a fake browser for the shared browser; also turns it on whatever cfg.browserHost says. */
  readonly browserDriver?: BrowserDriver;
  /** Tests: the agents' MCP engine in the shared browser (default: Playwright MCP in this process). */
  readonly browserEngine?: AgentEngine;
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
  // pi as chosen in the Mac app's 设置 › Agents (`PI_BIN`, docs/agents-v0.md §3), else where it is found.
  const pi = first(env.PI_BIN, resolveCommand(undefined, "pi", env.PATH), join(home, ".local", "bin", "pi"));
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

/** The codex CLI of this Mac: the one chosen in the Mac app's 设置 › Agents when it is there (`CODEX_BIN`,
 *  docs/agents-v0.md §3: the vendor's own install, a beta, a pinned version, or ChatGPT.app's copy), else the catalog's
 *  path when it exists, else `codex` on PATH (see resolveCommand). */
export function codexBinary(targets: Pick<Targets, "harnesses">, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env.CODEX_BIN;
  if (chosen && isAbsolute(chosen) && existsSync(chosen)) return chosen;
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
  const router = overrides.router ?? (cfg.router === "echo" ? defaultEchoRouter(targets) : resident ? serveRouter(resident, "dispatcher", targets.router.model, targets.router.effort) : opencodeRouter({ model: targets.router.model }));
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
  const oracle = (agentName: string): Router => resident ? serveRouter(resident, "oracle", targets.router.model, targets.router.effort) : opencodeRouter({ model: targets.router.model, agentName, tools: "none", runIn: join(cfg.home, "router-scratch") });
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
  // The shared browser's Chrome is the user's own too, so its clones are swept the same way.
  const realBrowser = Boolean(cfg.browserHost) && !overrides.browserDriver;
  const cloneDir = cfg.executors === "real" || realBrowser ? cloneRoot() : null;
  const clones = cloneDir ? new CloneSweeper({ root: cloneDir }) : undefined;
  clones?.schedule();   // what earlier runs left behind
  const taskFolderRoot = cfg.taskFolders ? () => loadWorkdir(cfg.home) : undefined;
  // docs/terminal-v0.md: the manual entry's terminals, with the gate like the executors when the gate is there.
  let localPort = cfg.port;
  const agentBinaries = cfg.terminals && !overrides.terminalLauncher ? terminalBinaries(targets, cfg.opencodeBinary) : {};
  // Codex terminals get AgentSwitch's hooks once the user's Codex trusts them (docs/terminal-v0.md §3): checked now and
  // again before a Codex terminal starts. In each folder Codex runs in: the Mac's own, and an account profile's
  // (docs/profiles-v0.md §6.2), where the trust is the Mac's own while its config.toml is linked in.
  const codexTrusts = new Map<string, CodexHookTrust>();
  const codexTrust = (home?: string): CodexHookTrust | undefined => {
    if (!agentBinaries.codex) return undefined;
    let trust = codexTrusts.get(home ?? "");
    if (!trust) {
      trust = new CodexHookTrust({ binary: agentBinaries.codex, args: codexHookArgs(hookCommandOf({}), QUICK_HOOK_TIMEOUT_S, PERMISSION_HOOK_TIMEOUT_S), ...(home ? { env: { ...process.env, CODEX_HOME: home } } : {}) });
      codexTrusts.set(home ?? "", trust);
    }
    return trust;
  };
  void codexTrust()?.ensure();
  // docs/browser-v0.md: the shared browser; AgentSwitch's own ports are never opened in it nor listed as local servers.
  // People fill ciphertexts in through the gate; agents get it through the agent bridge (terminals below).
  const gateProxyPort = proxyEndpoint(gate?.proxy ?? process.env.SECRET_GATE_PROXY ?? "http://127.0.0.1:8080")?.port;
  // With every OpenCode server the daemon runs now: the executors' resident one and the terminals' companions (port 0).
  const ownPorts = (): number[] => [localPort, cfg.port, cfg.remote?.port, cfg.opencodePort, gateProxyPort, ...stdioServePorts()].filter((p): p is number => typeof p === "number" && p > 0);
  // docs/browser-v0.md §7: Camoufox and its Playwright on disk, and their updates. What an update that never finished
  // left is cleared now; nothing is downloaded until asked.
  const engineKit = cfg.browserHost ? newEngineKit(cfg.home) : undefined;
  engineKit?.start();
  const browserOptions = { home: cfg.home, userHome: process.env.HOME ?? homedir(), protected: prot, ownPorts, ...(engineKit ? { kit: engineKit } : {}), headless: !cfg.browserWindow, ...(gate ? { gateHome: gate.home } : {}), ...(overrides.browserDriver ? { driver: overrides.browserDriver } : {}),
      ...(overrides.browserEngine ? { engine: overrides.browserEngine } : {}), ...(gate ? { fill: gateFill(gate) } : {}),
      ...(clones ? { afterExit: () => clones.schedule() } : {}) };
  const browser = cfg.browserHost || overrides.browserDriver ? sharedBrowser(browserOptions) : undefined;
  // Profiles' own proxies (docs/profiles-v0.md §4): a forwarder each, checked before anything starts under one. And
  // their own browsers (§5.1, §5.5): one for each profile but the Mac's own, made when first needed — through that
  // forwarder when the profile has a proxy, straight out when it has none.
  const profiles = new ProfileStore({ home: cfg.home });
  const exits = new ExitPool({ ownPorts, ...(gate ? { resolve: gateFill(gate) } : {}), lookup: exitLookup(), log: (line) => console.error(line) });
  const profileBrowsers = browser
    ? new ProfileBrowsers((key, forwarder) => sharedBrowser({ ...browserOptions, own: { name: key, forwarder,
          zone: () => { const p = profileOfKey(key); return p ? profiles.all()[p.agent].profiles.find((x) => x.id === p.id)?.exit?.timezone ?? null : null; },
          // Its sign-in to claude.ai, when the profile keeps a session key (docs/profiles-v0.md §3.4).
          launched: async () => { const p = profileOfKey(key); if (p) await sessionKeys.launched(p.agent, p.id); } } }), exits,
        (key) => { const p = profileOfKey(key); return p && p.id !== DEFAULT_PROFILE && profiles.homeOf(p.agent, p.id) ? { proxy: profiles.proxyOf(p.agent, p.id) } : null; })
    : undefined;
  // An address asked for its models with a profile's key is asked the way the profile's agent would send it: through
  // the forwarder of its proxy when it has one (docs/profiles-v0.md §4), straight out when it has none.
  const apiKeys = new ApiKeys({ store: profiles, ...(gate ? { resolve: gateFill(gate) } : {}),
    through: async (agent, id) => { const proxy = profiles.proxyOf(agent, id); return proxy ? exits.address(exitKey(agent, id), proxy) : null; } });
  const sessionKeys: SessionKeys = new SessionKeys({ store: profiles, ...(gate ? { resolve: gateFill(gate) } : {}),
    browser: (agent, id) => profileBrowsers?.get(`${agent}.${id}`)?.host ?? null });
  // A new engine is switched to with the browser stopped, which then comes back with its tabs (docs/browser-v0.md §7.2 第 6 条).
  if (browser && engineKit) engineKit.aroundSwitch((apply) => browser.host.restart(apply));
  // The terminals' agents use it through the agent bridge (docs/terminal-v0.md §3; with no gate in front since
  // 2026-10-08, docs/profiles-v0.md §8): a session of their own per terminal, ended with the program; the terminal's
  // tabs close when the terminal is deleted.
  const agents = browser?.agents;
  const terminalBrowser = agents
    ? (req: { id: string; harness: string; cwd: string; browserKey?: string }) => {
        // Under a profile with a browser of its own, the agent's browser tool is that browser's (§5.1).
        const own = req.browserKey ? profileBrowsers?.of(req.browserKey) ?? null : null, base = `http://127.0.0.1:${localPort}`;
        const minted = (own?.agents ?? agents).mint(terminalOwner(req.id, req.harness, req.cwd));
        const command = bridgeCommand(minted, own ? `${base}/profile-browser/${req.browserKey}` : base, stable(process.execPath), stable(BRIDGE_SCRIPT));
        // A held terminal keeps the session for the next daemon, which takes it up again with the same token.
        return Object.assign(command, { minted: { session: minted.id, token: minted.token, ...(own ? { key: req.browserKey! } : {}) } });
      }
    : undefined;
  // Terminals are used like any terminal: only the credentials at rest stay closed there (docs/terminal-v0.md §3).
  const termProt = terminalProtected({ ...process.env, AGENTSWITCH_HOME: cfg.home });
  // Terminals that outlive the service (docs/terminal-v0.md §10): each program on a holder of its own.
  const held = cfg.holdTerminals && (cfg.terminals || overrides.terminalLauncher) ? holding({ ringBytes: TERMINAL_RING_BYTES }) : null;
  if (cfg.holdTerminals && !held) console.error("terminals: no holder (native/build/pty-hold) — terminals end with the service");
  const terminalHost = cfg.terminals || overrides.terminalLauncher
    ? new TerminalHost({
      // Which profile each conversation runs under is kept, so it goes on under the same one (docs/profiles-v0.md §3.3).
      deviceOf: (harness, profile) => { const agent = PROFILE_AGENTS.find((a) => a === harness); return agent ? profiles.deviceOf(agent, profile ?? DEFAULT_PROFILE) : null; },
      onSession: (harness, sessionId, profile) => { const agent = PROFILE_AGENTS.find((a) => a === harness); if (agent) profiles.noteSession(agent, sessionId, profile); },
      launcher: overrides.terminalLauncher ?? agentLauncher({ binaries: agentBinaries, hookUrl: () => `http://127.0.0.1:${localPort}`, stateDir: join(cfg.home, "terminals"), protected: termProt,
        // Through `current` where the runtime has one: a terminal that outlives this runtime runs the next one's hooks.
        node: stable(process.execPath), hookScript: stable(HOOK_SCRIPT), holding: held,
        codexHooks: (home) => codexTrust(home)?.trusted ?? false, opencodeServer: true,
        // Codex on its own, as its command line starts it (2026-10-08, user: 你直接改回命令行吧). Through an app-server of
        // the terminal's own a screen could set its model and effort (codexTerminal.ts), but a session made that way is
        // marked as an app's, not the command line's (`codex app-server` says so itself, with no option), and Codex's
        // desktop app no longer lists it under its project. `AGENTSWITCH_CODEX_TERMINAL=server` starts it that way.
        codexServer: process.env.AGENTSWITCH_CODEX_TERMINAL === "server",
        // Its Daybreak switch, where this Codex and this account have one (router/modelOffers.ts; simple-view-v0 §5.8).
        codexDaybreak: () => overrides.modelOffers?.current().codex?.daybreak !== undefined,
        ...(terminalBrowser ? { browser: terminalBrowser } : {}) }),
      // Whatever the permission mode.
      floor: (tool, input, cwd) => { const d = decideTool(tool, input, canonical(cwd), new Set(), termProt); return d.kind === "deny" ? d.reason : null; },
      ...(agents ? { onExit: (id: string) => agents.end({ kind: "terminal", id }), onRemove: (id: string) => agents.end({ kind: "terminal", id }, true) } : {}),
      ...(held ? { hold: {
        holding: held,
        dir: join(cfg.home, "terminals"),
        // What this service made for a terminal before, made again as its program knows it: its profile's forwarder on
        // the same port with the same password, its browser session with the same token.
        restoring: async (kept: KeptTerminal) => {
          const agent = PROFILE_AGENTS.find((a) => a === kept.harness);
          if (agent && kept.profile && kept.given.proxy) {
            const at = new URL(kept.given.proxy), key = exitKey(agent, kept.profile.id);
            const proxy = profiles.proxyOf(agent, kept.profile.id);
            // The profile's proxy was taken away while the terminal ran: its forwarder was dropped then, and nothing
            // listens on its port now either — the terminal stays shut, not let out as this machine (§4).
            if (!proxy) console.error(`terminals: ${kept.id}'s profile has no proxy any more; its forwarder on ${at.port} is not made again`);
            else await exits.address(key, proxy, { port: Number(at.port), password: decodeURIComponent(at.password) })
              .catch((err: Error) => console.error(`terminals: ${kept.id}'s proxy forwarder did not come back on ${at.port}: ${err.message}`));
          }
          const b = kept.given.browser;
          if (b) (b.key ? profileBrowsers?.of(b.key)?.agents : agents)?.adopt(b.session, b.token, terminalOwner(kept.id, kept.harness, kept.cwd));
        },
        companion: (harness: TerminalHarness, kept: Record<string, unknown>) => restoreCompanion(harness, kept, held),
      } } : {}),
    })
    : null;
  let style: TerminalStyle | null = null;
  const terminals = terminalHost ? {
    host: terminalHost,
    audit: new TerminalAudit(join(cfg.home, "terminals", "audit.jsonl")),
    agents: overrides.terminalLauncher ? [...TERMINAL_HARNESSES] : TERMINAL_HARNESSES.filter((h) => agentBinaries[h]),
    // Claude Code and Codex say themselves whether they are signed in, in a profile's folder (terminals/signIn.ts).
    signedIn: (harness: TerminalHarness, home: string) => (harness === "claude-code" && agentBinaries["claude-code"] ? claudeSignedIn(agentBinaries["claude-code"], home)
      : harness === "codex" && agentBinaries.codex ? codexSignedIn(agentBinaries.codex, home) : Promise.resolve(null)),
    style: () => (style ??= readTerminalStyle()),
    elsewhere: overrides.terminalElsewhere ?? (overrides.terminalLauncher ? async () => null : elsewhereCheck()),
    ...(agentBinaries.codex ? { prepare: async (harness: string, home?: string) => { if (harness === "codex") await withTimeout(codexTrust(home)!.ensure({ fresh: true }), 8000); } } : {}),
    ...(overrides.modelOffers ? { offers: () => overrides.modelOffers!.current(), variants: () => overrides.modelOffers!.variants(), daybreakTurned: (on: boolean) => overrides.modelOffers!.noteCodexDaybreak(on) } : {}),
  } : undefined;
  // Deleting an OpenCode session goes through the user's own opencode (docs/terminal-v0.md §5, threads-v0 删除): the
  // user's from the session list, the executors' with their tasks. None with a fake launcher, nor when no opencode is
  // configured (tests): a test never reaches the user's OpenCode.
  const sessionSources = overrides.sessionSources ?? defaultSessionSources(cfg.home);
  const opencodeBin = overrides.terminalLauncher || !cfg.opencodeBinary ? undefined : agentBinaries.opencode ?? terminalBinaries(targets, cfg.opencodeBinary).opencode;
  const openCodeDelete = overrides.openCodeDelete ?? (opencodeBin ? openCodeDeleter(opencodeBin, sessionSources.opencodeDb) : undefined);
  const sessions = cfg.watchSessions ? new SessionMonitor({
    ...sessionSources, ...(openCodeDelete ? { openCodeDelete } : {}),
    ownIds: () => store.harnessSessionIds(), ownFolders: () => (taskFolderRoot ? [taskFolderRoot()] : []),
  }) : undefined;
  const nearSessions = sessions ? (cwd: string) => sessionsNear(sessions.list(SESSIONS_READ), cwd, Date.now(), broadFolders()) : undefined;
  const conversation = new AssistantLog(join(cfg.home, "assistant.db"));
  const engine = new Engine({ conversation, ...(openCodeDelete ? { deleteSessions: executorSessionsDeleter(openCodeDelete) } : {}), ...(taskFolderRoot ? { taskFolderRoot } : {}), ...(nearSessions ? { sessionsNear: nearSessions } : {}), store, bus, executors: wiredExecutors, targets, router, questionRouter, quota: () => quota.map(), contextPath, cleanupPaths: { ...defaultCleanupPaths(), workRoot }, routingLog, artifactsDir, protected: prot, ...(browserSlots ? { browserSlots } : {}), ...(clones ? { afterBrowserRun: () => clones.schedule() } : {}), memoryPath, platformMemoryPath, extensionsSummary, maxConcurrentTasks: cfg.maxTasks, policyPath, ...(summarizer ? { summarizer } : {}), ...(supervisor ? { supervisor } : {}), ...(planner ? { planner } : {}) });
  // Tasks the last run left unfinished cannot be confirmed either way (docs/control-v0.md §4).
  engine.interruptLeftovers();
  sweepThreads(store, Date.now(), engine);
  forgetDeletedTasks(conversation, store);
  const routeDeps = () => ({ targets, router, quota: quota.map(), context: loadContext(contextPath), memory: loadMemory(memoryPath), platformMemory: (task: string) => platformExperience(platformMemoryPath, task, loadContext(contextPath).text), records: store.recordsSince(Date.now() - RECORD_WINDOW_MS), extensions: extensionsSummary(), threads: engine.threadBriefs() });
  const clash = new ClashIntegration({ store: new ClashStore(cfg.home), source: new ClashSource(cfg.home), base: () => `http://127.0.0.1:${localPort}`,
    // A profile's proxy server is tried on its own port by the routing check (docs/clash-v0.md §7.9).
    proxyPorts: () => new Map(Object.values(profiles.all()).flatMap((a) => a.profiles).flatMap((p) => { const place = p.proxy ? proxyPlace(p.proxy.server) : null; return place ? [[place.host.toLowerCase(), place.port] as const] : []; })) });
  // The nodes are made after the API (they need the remote listener): what they heard is asked through this.
  let nodesMade: Nodes | null = null;
  // The Files column (docs/files-v0.md §7): what of this node's disk its screens and its paired devices may read.
  const thumbnails = new Thumbnails();
  const fileAccess: FileAccess = {
    home: process.env.HOME ?? homedir(), denied: prot, thumbnails, audit: new FileAudit(join(cfg.home, "files", "audit.jsonl")),
    remote: () => { const m = loadMesh(cfg.home); return { on: m.files, changes: m.changes, scopeOf: (id: string) => m.scopes[id] ?? DEFAULT_SCOPE }; },
    // A folder a terminal runs in is asked about before it is renamed or moved (docs/files-v0.md §12.2).
    running: () => (terminalHost?.list() ?? []).filter((t) => t.status !== "exited").map((t) => ({ id: t.id, name: t.name, workdir: t.workdir })),
  };
  const apiDeps: ApiDeps = { liveElsewhere: () => nodesMade?.lives() ?? [], remoteKeyboard: () => loadMesh(cfg.home).keyboard, fileAccess, exits, profiles, sessionKeys, apiKeys, ...(profileBrowsers ? { profileBrowsers } : {}), clash, ...(browser ? { browser } : {}), ...(engineKit ? { engineKit } : {}), ...(taskFolderRoot ? { taskFolderRoot } : {}), ...(sessions ? { sessions } : {}), ...(terminals ? { terminals } : {}), ...(sealer ? { sealer } : {}), store, bus, engine, targets, quota, routingLog, routeDeps, contextPath, memoryPath, platformMemoryPath, policyPath, workRoot, cwdRules: defaultCwdRules(process.env, cfg.home), home: cfg.home, ...(cfg.appBundle ? { appBundle: cfg.appBundle } : {}), uploads, artifactsDir, extensions, version: VERSION, models: { path: modelsPath, base: baseTargets }, ...(overrides.sseHeartbeatMs ? { sseHeartbeatMs: overrides.sseHeartbeatMs } : {}) };
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
  // docs/mesh-v0.md: this node among the others. What it has is what its screens would show of it.
  const nodes = new Nodes({
    book: new NodeBook(join(cfg.home, NODES_DIR)), dialer: new Dialer(), store, remote,
    info: () => ({
      name: remote?.name ?? macName(), kind: process.platform === "darwin" ? "mac" : "linux", version: VERSION, home: process.env.HOME ?? homedir(),
      has: ["dispatch", ...(terminalHost ? ["terminals", "profiles"] : []), ...(browser ? ["browser"] : []), ...(process.platform === "darwin" && existsSync(vergeDir()) ? ["clash"] : []),
        ...(cfg.appBundle ? ["update"] : []), ...(loadMesh(cfg.home).keyboard ? ["keyboard"] : []), "files"],
    }),
  });
  nodesMade = nodes;
  const fileScopes = { get: (id: string) => scopeOf(cfg.home, id), set: (id: string, scope: Parameters<typeof setScope>[2]) => setScope(cfg.home, id, scope) };
  const app = mountNodes(mountRemoteAdmin(new Hono().route("/", api), { store, remote, onRevoke: (id) => nodes.inboundGone(id), fileScopes }), { nodes, home: cfg.home });
  return { app, api, remote, nodes, engine, store, quota, targets, clash, terminals: terminalHost, sessions: sessions ?? null, browser: browser?.host ?? null, setLocalPort: (port) => { localPort = port; },
    stopBrowser: async () => { await profileBrowsers?.stop(); await browser?.agents.shutdown(); await browser?.host.shutdown(); await browser?.stop(); },
    close: () => { nodes.close(); thumbnails.close(); terminalHost?.closeAll(); void profileBrowsers?.stop(); void exits.stop(); void browser?.agents.shutdown(); void browser?.host.shutdown(); reporter.stop(); store.close(); routingLog.close(); conversation.close(); } };
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

/** The executors' sessions of deleted tasks (threads-v0 删除): OpenCode's live in the user's own database and are deleted
 *  there, one after another in the background (each a short opencode run); Claude Code's and Codex's live in the
 *  thread's home, already gone with it. A failure is logged and does not hold the deletion up. */
export function executorSessionsDeleter(openCodeDelete: OpenCodeDelete, log: (line: string) => void = console.error): (sessions: readonly { harness: string; sessionId: string }[]) => void {
  let queue: Promise<unknown> = Promise.resolve();
  return (sessions) => {
    for (const s of sessions) {
      if (s.harness !== "opencode") continue;
      queue = queue.then(() => openCodeDelete(s.sessionId)).then(
        (deleted) => { if (deleted) log(`executor session deleted with its task: opencode ${s.sessionId}`); },
        (err: unknown) => log(`executor session opencode ${s.sessionId} could not be deleted: ${(err as Error).message}`));
    }
  };
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

/** A promise's result, or undefined once `ms` passed. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => { setTimeout(() => r(undefined), ms).unref(); })]);
}

/** Start-up: discover models (real executors only: the catalog takes new ids, the terminals' model menus what each
 *  agent offers, kept fresh from then on), bring up the resident OpenCode servers (router: real router only; executors:
 *  real executors in serve mode), then listen. */
export async function serve(cfg: DaemonConfig): Promise<{ daemon: Daemon; close: () => void; stop: () => Promise<void> }> {
  if (cfg.executors === "real") await checkGateProxy(defaultGate());
  if (cfg.executors === "real") warmBrowserMcp(defaultGate());
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
  // OpenCode's variants (its models' thinking levels) for the terminals' menus, from the executors' server.
  if (modelOffers && opencodeExec) modelOffers.watchOpenCode(() => openCodeVariants((method, path) => opencodeExec.call(method, path), join(cfg.home, "opencode-exec")));
  // Codex names a picture by where its file was: the running service keeps copies, which outlive the file
  // (docs/simple-view-v0.md §4). Under the home, where no managed executor writes; nothing from a folder no agent may
  // read. Here and not in buildDaemon: a daemon built by a test copies no one's pictures.
  const pictures = cfg.watchSessions
    ? new KeptPictures(join(cfg.home, "sessions", "pictures"), { closed: defaultProtected({ ...process.env, AGENTSWITCH_HOME: cfg.home }).readDenied ?? [] })
    : undefined;
  const daemon = buildDaemon(cfg, { targets, ...(modelOffers ? { modelOffers } : {}), ...(opencode ? { opencode } : {}), ...(opencodeExec ? { opencodeExec } : {}),
    ...(pictures ? { sessionSources: { ...defaultSessionSources(cfg.home), pictures } } : {}) });
  const remote: RemoteListener | undefined = daemon.remote
    ? await startRemote(daemon, daemon.remote).catch((err: Error) => { daemon.close(); void opencode?.stop(); void opencodeExec?.stop(); throw err; })
    : undefined;
  // Every local caller shows the token (api/localAuth.ts); made on first start, read by the Mac app and the CLI.
  const auth = new LocalAuth(ensureLocalToken(cfg.home));
  const server = listenLocal(daemon, cfg.port, (info) => {
    daemon.setLocalPort(info.port);
    // Terminals the last daemon left to their holders (docs/terminal-v0.md §10): their hooks reach this port. A daemon
    // that holds none ends them: a terminal nobody takes up is not left running on its own.
    if (daemon.terminals && !daemon.terminals.holds) void endLeftHeld(join(cfg.home, "terminals")).then((n: number) => { if (n) console.error(`terminals: ${n} left held by the last daemon, ended`); });
    else void daemon.terminals?.restore().then((n) => { if (n) console.error(`terminals: ${n} taken up again from their holders`); }, (err: Error) => console.error(`terminals: restore: ${err.message}`));
    console.error(`agentswitchd ${VERSION} listening on http://127.0.0.1:${info.port}  router=${cfg.router}${opencode ? " (resident serve)" : ""} executors=${cfg.executors} maxTasks=${cfg.maxTasks} home=${cfg.home}`);
  }, auth);
  void daemon.quota.refresh();
  const sweeper = setInterval(() => sweepThreads(daemon.store, Date.now(), daemon.engine), THREAD_SWEEP_INTERVAL_MS);
  sweeper.unref();
  // Clash Integration's subscription, fetched again when its interval has passed (docs/clash-v0.md §7.1).
  const clashTimer = setInterval(() => { void daemon.clash.tick(); }, CLASH_TICK_MS);
  clashTimer.unref();
  // The pictures Codex's records name, copied while their files are there, whether or not a screen reads the list.
  const keepPictures = () => { try { daemon.sessions?.keepPictures(); } catch { /* the next round */ } };
  const picturesFirst = setTimeout(keepPictures, PICTURES_FIRST_MS);
  picturesFirst.unref();
  const picturesTimer = setInterval(keepPictures, PICTURES_EVERY_MS);
  picturesTimer.unref();
  const close = () => { clearInterval(sweeper); clearInterval(clashTimer); clearTimeout(picturesFirst); clearInterval(picturesTimer); stopOffers?.(); server.close(); void remote?.close(); daemon.close(); void opencode?.stop(); void opencodeExec?.stop(); };
  // A signal: Chrome is let quit on its own first (a killed one leaves its code-sign clone behind), then the rest.
  return { daemon, close, stop: async () => { await daemon.stopBrowser().catch(() => undefined); close(); } };
}

/** The 127.0.0.1 listener (web UI, CLI, Mac app): the local app behind the browser guard (api/localGuard.ts: Host,
 *  Origin, JSON bodies) and, when given, the local token (api/localAuth.ts). The remote listener forwards into
 *  `daemon.api` in process and never passes either. */
export function listenLocal(daemon: Pick<Daemon, "app">, port: number, onListening?: (info: AddressInfo) => void, auth?: LocalAuth): ServerType {
  return listen({ fetch: guardLocal((request, env) => auth?.check(request) ?? daemon.app.fetch(request, env)), hostname: "127.0.0.1", port }, onListening);
}

/** app-v0 §2: the HTTPS listener for paired phones, before the local one, so a taken port fails start-up cleanly. */
export async function startRemote(daemon: Pick<Daemon, "api" | "store"> & { readonly nodes?: Nodes }, remote: RemoteRuntime, host?: string): Promise<RemoteListener> {
  const app = createRemoteApp({ store: daemon.store, pairing: remote.pairing, presence: remote.presence, gateKey: remote.gateKey, addresses: remote.addresses, local: daemon.api, ...(daemon.nodes ? { nodes: daemon.nodes } : {}) });
  try {
    const listener = await listenRemote({ fetch: app.fetch, tls: remote.tls, port: remote.port, ...(host ? { host } : {}) });
    console.error(`agentswitchd remote listening on https://*:${listener.port}  fingerprint=${remote.tls.fingerprint} name="${remote.name}"`);
    return listener;
  } catch (err) {
    throw new Error(`remote listener on port ${remote.port}: ${(err as Error).message}`);
  }
}
