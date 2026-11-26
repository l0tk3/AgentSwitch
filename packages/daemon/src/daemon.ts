/** Composition root: config → terminals, rooms, browser, profiles, vault, API. `serve()` listens on 127.0.0.1 and, with
 *  AGENTSWITCH_REMOTE=1, on the remote HTTPS port for paired phones (app-v0 §2). */

import type { ApiDeps } from "./api/shared.js";
import { cloneRoot, CloneSweeper } from "./core/chromeClones.js";
import { serve as listen, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./api/app.js";
import { DEFAULT_PROFILE, PROFILE_AGENTS, ProfileStore } from "./profiles/store.js";
import { Addons, codexMcpOff } from "./profiles/addons.js";
import { ProfileHealthChecks } from "./profiles/health.js";
import { subscriptionHealth } from "./profileHealthProviders.js";
import { SessionKeys } from "./browser/sessionKey.js";
import { ApiKeys } from "./profiles/apiKeys.js";
import { proxyPlace } from "./browser/identity.js";
import { ClashIntegration } from "./clash/integration.js";
import { ClashSources } from "./clash/sources.js";
import { ClashStore } from "./clash/store.js";
import { filesRoot, MAX_STARTED, RoomStore } from "./rooms/store.js";
import { RoomDelivery } from "./rooms/delivery.js";
import { RoomKit } from "./rooms/kit.js";
import type { SeatLookup } from "./rooms/state.js";
import { runningOf, seatLive, sessionOf as seatSessionOf, wasOf as seatWasOf } from "./api/rooms.js";
import { SeatRewind } from "./api/roomRewind.js";
import { follow } from "./rooms/follow.js";
import { RoomPolicy } from "./rooms/policy.js";
import { roomOrg, type Ask } from "./api/roomOrg.js";
import { DispatchDesk } from "./api/dispatchDesk.js";

/** How often what has not arrived in the rooms is looked at again. */
const ROOM_LOOK_MS = 2000;
import { SessionTitles } from "./sessions/titles.js";
import { ShownFoldersStore } from "./sessions/shownFolders.js";
import { defaultCwdRules } from "./api/cwdPolicy.js";
import { guardLocal } from "./api/localGuard.js";
import { ensureLocalToken, LocalAuth } from "./api/localAuth.js";
import { canonical, decideTool } from "./core/toolGuard.js";
import { defaultGate, gateBin } from "./core/gateBin.js";
import { defaultProtected, terminalProtected } from "./core/protected.js";
import { sweepDir } from "./files/artifacts.js";
import { resolveCommand } from "./util/which.js";
import { ARTIFACT_TTL_MS, UPLOAD_TTL_MS } from "./files/names.js";
import { Uploads } from "./files/uploads.js";
import { loadTargets, type Targets } from "./models/targets.js";
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
import { DEFAULT_REMOTE_PORT, discoverAddresses, macName, remoteRuntime, type RemoteRuntime } from "./remote/runtime.js";
import { DEFAULT_PHONE_PORT, listenPhone, PHONE_PATH, type PhoneListener } from "./clash/phoneListener.js";
import type { PhoneReach } from "./clash/integration.js";
import { forgetClaudeLogin } from "./profiles/claudeLogin.js";
import { isAllowedSource } from "./remote/address.js";
import { listenRemote, type RemoteListener } from "./remote/server.js";
import { mergeLogged } from "./models/discovery.js";
import { CodexHookTrust, codexHookArgs } from "./terminals/codexHooks.js";
import { ensureGrokHooks, ensureGrokKit, grokHome } from "./terminals/grokHooks.js";
import { AGY_HOME_VAR, agyGeminiDir, agyHome, ensureAgyMcp } from "./terminals/agy.js";
import { ModelOffers } from "./models/modelOffers.js";
import { readOpenCodeVariants } from "./models/opencodeVariants.js";
import { DeviceStore } from "./remote/deviceStore.js";
import { DatabaseSync } from "node:sqlite";
import { loadWorkdir } from "./files/workdir.js";
import { defaultSessionSources, SessionMonitor, type SessionSources } from "./sessions/monitor.js";
import type { SessionHarness } from "./sessions/types.js";
import { KeptPictures } from "./sessions/pictures.js";
import { openCodeDeleter, type OpenCodeDelete } from "./sessions/opencode.js";
import { TerminalAudit } from "./terminals/audit.js";
import { TerminalHost, type KeptTerminal, type Launcher, type TerminalHarness } from "./terminals/host.js";
import { agentLauncher, hookCommandOf, HOOK_SCRIPT, PERMISSION_HOOK_TIMEOUT_S, QUICK_HOOK_TIMEOUT_S, restoreCompanion, ROOM_KIT_SCRIPT } from "./terminals/launch.js";
import { loadTrustList } from "./terminals/trustedFolders.js";
import { holding } from "./terminals/held.js";
import { elsewhereCheck, type ElsewhereCheck } from "./terminals/elsewhere.js";
import { readTerminalStyle, type TerminalStyle } from "./terminals/style.js";
import { endLeftHeld, TERMINAL_HARNESSES } from "./terminals/host.js";
import { Leftovers } from "./terminals/leftovers.js";
import { forgetTerminalFiles, sweepAttachments, sweepTerminalFiles } from "./terminals/stateFiles.js";
import { BRIDGE_SCRIPT, bridgeCommand, terminalOwner, type AgentEngine } from "./browser/agents.js";
import type { BrowserDriver } from "./browser/driver.js";
import { gateFill } from "./browser/fill.js";
import { fileKey, vaultKey } from "./vault/key.js";
import { sealValue, vaultOpener, type Opener } from "./vault/seal.js";
import { moveSealed } from "./sealedMove.js";
import { RedactionStore, saltKey } from "./vault/words.js";
import { ModelGate } from "./vault/modelGate.js";
import { PasswordBook } from "./vault/passwords.js";
import { exitLookup } from "./browser/exit.js";
import { ExitPool } from "./browser/exits.js";
import { claudeSignedIn, codexSignedIn } from "./terminals/signIn.js";
import { ProfileBrowsers } from "./browser/fleet.js";
import { exitKey, profileOfKey } from "./api/profiles.js";
import type { BrowserHost } from "./browser/host.js";
import { removeOwnBrowserFiles, sharedBrowser, sweepOwnBrowserFiles } from "./browser/setup.js";
import { newEngineKit } from "./browser/engine/setup.js";
import { stdioServePorts } from "./harness/opencodeStdio.js";

export const VERSION = "1.0.0";
export const DEFAULT_PORT = 4711;
/** How often Clash Integration looks whether its subscription is due to be fetched again. */
/** This Mac's addresses are looked up again this often for the phones' Clash address (§12). */
const PHONE_ADDRESSES_MS = 60_000;
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
  /** The user's `opencode` (OPENCODE_BIN), for OpenCode terminals and what its models offer. */
  readonly opencodeBinary: string;
  /** app-v0 §2: HTTPS for paired phones on all interfaces (AGENTSWITCH_REMOTE=1, AGENTSWITCH_REMOTE_PORT, default 4713;
   *  AGENTSWITCH_REMOTE_NAME overrides the Mac name in the pairing payload). Absent = off. */
  readonly remote?: { readonly port: number; readonly name?: string };
  /** docs/clash-v0.md §12: the port phones' Clash and Stash take the subscription on, plain HTTP on all interfaces
   *  (AGENTSWITCH_CLASH_PHONE_PORT, default 4714, with AGENTSWITCH_REMOTE on; 0 or `off`: none). Absent = off. */
  readonly clashPhonePort?: number;
  /** The AgentSwitch.app this daemon runs from (AGENTSWITCH_APP_BUNDLE, set by the Mac app): staged updates sit next to it. */
  readonly appBundle?: string;
  /** The old Dispatch's tasks worked in dated subfolders of the user's default work folder (docs/control-v0.md §2;
   *  `workdir.json`, default ~/AgentSwitch): the sessions they left there stay off the list of sessions. On unless
   *  AGENTSWITCH_TASK_FOLDERS=0; tests build configs without it. */
  readonly taskFolders?: boolean;
  /** A deleted Claude profile's sign-in, and Default's when its identity is reset, is taken out of the keychain
   *  (profiles/claudeLogin.ts). On when the configuration is read from the environment; tests build configs without
   *  it and never reach this Mac's keychain. */
  readonly forgetLogins?: boolean;
  /** Watch the Mac's own Claude Code / Codex / OpenCode sessions (docs/control-v0.md §3). On unless
   *  AGENTSWITCH_SESSIONS=0; tests build configs without it. */
  readonly watchSessions?: boolean;
  /** AgentSwitch's own terminals (docs/terminal-v0.md). On unless AGENTSWITCH_TERMINALS=0; tests build configs without
   *  it. */
  readonly terminals?: boolean;
  /** Ask this machine's agents what they offer, for the terminals' model menus (models/modelOffers.ts): it starts the
   *  user's own Claude Code, Codex and OpenCode. On with the terminals unless AGENTSWITCH_EXECUTORS=echo — what the Mac
   *  app's throw-away services and a node's `"executors": "echo"` say, from when the same word also chose the old
   *  Dispatch's executors; tests build configs without it. */
  readonly modelOffers?: boolean;
  /** The shared browser (docs/browser-v0.md): one Chrome the daemon holds, for the screens and later the agents. On
   *  unless AGENTSWITCH_BROWSER_HOST=0; tests build configs without it. */
  readonly browserHost?: boolean;
  /** Camoufox with windows of its own (docs/browser-v0.md §7.2); off: headless. */
  readonly browserWindow?: boolean;
  /** Terminals outlive the service on holders of their own (docs/terminal-v0.md §10). */
  readonly holdTerminals?: boolean;
  /** What a terminal leaves running after it ended is ended after a grace (docs/terminal-v0.md §11); on unless
   *  AGENTSWITCH_LEFTOVERS=0. Tests build with it off: a sweep reads the machine's process table. */
  readonly leftovers?: boolean;
};

/** AGENTSWITCH_CLASH_PHONE_PORT as a TCP port; unset or empty → the default; 0, `off` or not a port → none. */
function clashPhonePort(raw: string | undefined): number {
  if (raw === undefined || !raw.trim()) return DEFAULT_PHONE_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= MAX_PORT ? n : 0;
}

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
    opencodeBinary: env.OPENCODE_BIN ?? join(env.HOME ?? "", ".opencode", "bin", "opencode"),
    ...(env.AGENTSWITCH_REMOTE === "1" || env.AGENTSWITCH_REMOTE === "true"
      ? { remote: { port: remotePort(env.AGENTSWITCH_REMOTE_PORT), ...(env.AGENTSWITCH_REMOTE_NAME?.trim() ? { name: env.AGENTSWITCH_REMOTE_NAME.trim() } : {}) } }
      : {}),
    ...((env.AGENTSWITCH_REMOTE === "1" || env.AGENTSWITCH_REMOTE === "true") && clashPhonePort(env.AGENTSWITCH_CLASH_PHONE_PORT) ? { clashPhonePort: clashPhonePort(env.AGENTSWITCH_CLASH_PHONE_PORT) } : {}),
    ...(env.AGENTSWITCH_APP_BUNDLE?.trim() ? { appBundle: env.AGENTSWITCH_APP_BUNDLE.trim() } : {}),
    taskFolders: env.AGENTSWITCH_TASK_FOLDERS !== "0",
    // Never under a test runner, whatever a test builds its configuration from.
    forgetLogins: !env.VITEST && env.NODE_ENV !== "test",
    watchSessions: env.AGENTSWITCH_SESSIONS !== "0",
    terminals: env.AGENTSWITCH_TERMINALS !== "0",
    modelOffers: env.AGENTSWITCH_TERMINALS !== "0" && env.AGENTSWITCH_EXECUTORS !== "echo",
    // docs/terminal-v0.md §10: each terminal's program on a pty its own holder holds, so that it outlives the service
    // (the Linux node's keeper turns it on; node.json `"holdTerminals": false` turns it off).
    holdTerminals: env.AGENTSWITCH_HOLD_TERMINALS === "1",
    leftovers: env.AGENTSWITCH_LEFTOVERS !== "0",
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
  /** The devices paired with this node (remote/deviceStore.ts). */
  readonly devices: DeviceStore;
  readonly targets: Targets;
  /** AgentSwitch's own terminals (docs/terminal-v0.md), or null when off. */
  readonly terminals: TerminalHost | null;
  /** The model traffic gateway (vault/modelGate.ts), or null with no real terminals. */
  readonly modelGate: ModelGate | null;
  /** What the terminals leave running after they ended (docs/terminal-v0.md §11), or null when not cleaned. */
  readonly leftovers: Leftovers | null;
  /** The Mac's own sessions as they are watched (docs/control-v0.md §3), or null when off. */
  readonly sessions: SessionMonitor | null;
  /** The shared browser (docs/browser-v0.md), or null when off. */
  readonly browser: BrowserHost | null;
  /** Closes the shared browser's Chrome (a few seconds at most); `close()` does not wait for it. */
  stopBrowser(): Promise<void>;
  /** The port the 127.0.0.1 listener got: the terminals' hook command calls it. */
  setLocalPort(port: number): void;
  readonly clash: ClashIntegration;
  /** Where phones reach this Mac for the Clash subscription (§12), and what to do when that is switched on or off:
   *  both set by whoever listens. */
  readonly clashPhone: { reach: PhoneReach; changed: ((on: boolean) => Promise<void>) | null };
  close(): void;
};

export type BuildOverrides = {
  /** Catalog after discovery (serve() passes it); default: the yaml as is. */
  readonly targets?: Targets;
  /** What the agents offer today, kept fresh (serve() passes it with real terminals): the terminals' model menus. */
  readonly modelOffers?: ModelOffers;
  /** Tests: remote state without openssl or the network (null = off whatever cfg.remote says). */
  readonly remote?: RemoteRuntime | null;
  /** Tests: a short SSE heartbeat period. */
  readonly sseHeartbeatMs?: number;
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
  // Grok as chosen there (`GROK_BIN`), else where it is found, else where its installer puts it.
  const grok = first(env.GROK_BIN, resolveCommand(undefined, "grok", env.PATH), join(home, ".local", "bin", "grok"), join(home, ".grok", "bin", "grok"));
  // Antigravity CLI as chosen there (`AGY_BIN`), else where it is found, else where its installer puts it.
  const agy = first(env.AGY_BIN, resolveCommand(undefined, "agy", env.PATH), join(home, ".local", "bin", "agy"));
  if (pi) out.pi = pi;
  if (grok) out.grok = grok;
  if (agy) out.agy = agy;
  return out;
}

/** The user's own Claude Code CLI (`CLAUDE_BIN`, set by the Mac app) instead of the copy bundled with the Agent SDK:
 *  it already has the user's Keychain grant for its login, where the bundled copy (another code signature) would make
 *  macOS ask again and stall model discovery. Unset → the SDK's bundled CLI, as before. */
export function claudeBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CLAUDE_BIN ? resolveCommand(env.CLAUDE_BIN, "claude", env.PATH) : undefined;
}

const withClaude = (bin: string | undefined): { claudeExecutable?: string } => (bin ? { claudeExecutable: bin } : {});

/** The codex CLI of this Mac: the one chosen in the Mac app's 设置 › Agents when it is there (`CODEX_BIN`,
 *  docs/agents-v0.md §3: the vendor's own install, a beta, a pinned version, or ChatGPT.app's copy), else the catalog's
 *  path when it exists, else `codex` on PATH (see resolveCommand). */
export function codexBinary(targets: Pick<Targets, "harnesses">, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env.CODEX_BIN;
  if (chosen && isAbsolute(chosen) && existsSync(chosen)) return chosen;
  return resolveCommand(targets.harnesses.codex?.binary, "codex", env.PATH);
}

export function buildDaemon(cfg: DaemonConfig, overrides: BuildOverrides = {}): Daemon {
  const targets = overrides.targets ?? loadTargets(cfg.targetsPath);
  const devices = new DeviceStore({ dbPath: join(cfg.home, "agentswitch.db") });
  const prot = defaultProtected({ ...process.env, AGENTSWITCH_HOME: cfg.home });
  const uploads = new Uploads(join(cfg.home, "uploads"));
  // The files the old Dispatch's tasks kept still go when their time is up; nothing new is written there.
  const artifactsDir = join(cfg.home, "artifacts");
  sweepDir(uploads.dir, UPLOAD_TTL_MS);
  sweepDir(artifactsDir, ARTIFACT_TTL_MS);
  // And every few hours while the service runs (2026-11-11, user: 然后定期清理缓存): it may stay up for weeks.
  setInterval(() => { try { sweepDir(uploads.dir, UPLOAD_TTL_MS); sweepDir(artifactsDir, ARTIFACT_TTL_MS); } catch { /* the next round */ } }, 6 * 3600_000).unref();
  // The agents and the browser as they really are; a test gives a fake launcher or a fake driver instead.
  const realTerminals = Boolean(cfg.terminals) && !overrides.terminalLauncher;
  const realBrowser = Boolean(cfg.browserHost) && !overrides.browserDriver;
  // The gate, while this machine has one: it opens the ciphertexts kept from before (sealedMove.ts, vault/seal.ts).
  const gate = realTerminals || realBrowser ? defaultGate() : null;
  // The shared browser's Chrome is the user's own, so the clones macOS leaves of it are swept.
  const cloneDir = realBrowser ? cloneRoot() : null;
  const clones = cloneDir ? new CloneSweeper({ root: cloneDir }) : undefined;
  clones?.schedule();   // what earlier runs left behind
  const taskFolderRoot = cfg.taskFolders ? () => loadWorkdir(cfg.home) : undefined;
  // docs/terminal-v0.md: the terminals.
  let localPort = cfg.port;
  const agentBinaries = realTerminals ? terminalBinaries(targets, cfg.opencodeBinary) : {};
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
  const vaultKeys = realTerminals ? ((): Buffer[] => {
    const k = vaultKey(cfg.home);
    const old = k.where === "keychain" ? fileKey(cfg.home) : null;
    return old ? [k.key, old] : [k.key];
  })() : null;
  // What a profile and the browser keep sealed (API key, proxy password, session key) is opened by the vault's own
  // key; a gate's ciphertext from before by the gate while there is one (vault/seal.ts; user #369).
  const opener: Opener | null = vaultKeys ? vaultOpener(vaultKeys, gate ? gateFill(gate) : null) : gate ? gateFill(gate) : null;
  // The gate's proxy, where one still runs (the keeper's on a Linux node), is AgentSwitch's own port too.
  const gateProxyPort = portOf(process.env.SECRET_GATE_PROXY ?? "http://127.0.0.1:8080");
  // With every OpenCode server the daemon runs now: the terminals' companions (port 0).
  const ownPorts = (): number[] => [localPort, cfg.port, cfg.remote?.port, gateProxyPort, ...stdioServePorts()].filter((p): p is number => typeof p === "number" && p > 0);
  // docs/browser-v0.md §7: Camoufox and its Playwright on disk, and their updates. What an update that never finished
  // left is cleared now; nothing is downloaded until asked.
  const engineKit = cfg.browserHost ? newEngineKit(cfg.home) : undefined;
  engineKit?.start();
  const browserOptions = { home: cfg.home, userHome: process.env.HOME ?? homedir(), protected: prot, ownPorts, ...(engineKit ? { kit: engineKit } : {}), headless: !cfg.browserWindow, ...(gate ? { gateHome: gate.home } : {}), ...(overrides.browserDriver ? { driver: overrides.browserDriver } : {}),
      ...(overrides.browserEngine ? { engine: overrides.browserEngine } : {}), ...(opener ? { fill: opener } : {}),
      ...(clones ? { afterExit: () => clones.schedule() } : {}) };
  const browser = cfg.browserHost || overrides.browserDriver ? sharedBrowser(browserOptions) : undefined;
  // Profiles' own proxies (docs/profiles-v0.md §4): a forwarder each, checked before anything starts under one. And
  // their own browsers (§5.1, §5.5): one for each profile but the Mac's own, made when first needed — through that
  // forwarder when the profile has a proxy, straight out when it has none.
  const profiles = new ProfileStore({ home: cfg.home });
  { const old = profiles.removeOldSystemHomes(); if (old) console.error(`profiles: removed ${old} private home folders isolated profiles no longer use`); }
  const exits = new ExitPool({ ownPorts, ...(opener ? { resolve: opener } : {}), lookup: exitLookup(), log: (line) => console.error(line) });
  const profileBrowsers = browser
    ? new ProfileBrowsers((key, forwarder) => sharedBrowser({ ...browserOptions, own: { name: key, forwarder,
          zone: () => { const p = profileOfKey(key); return p ? profiles.all()[p.agent].profiles.find((x) => x.id === p.id)?.exit?.timezone ?? null : null; },
          // Its sign-in to claude.ai, when the profile keeps a session key (docs/profiles-v0.md §3.4).
          launched: async () => { const p = profileOfKey(key); if (p) await sessionKeys.launched(p.agent, p.id); } } }), exits,
        (key) => { const p = profileOfKey(key); return p && ((["claude-code", "codex"].includes(p.agent) && p.id === DEFAULT_PROFILE) || profiles.homeOf(p.agent, p.id)) ? { proxy: profiles.proxyOf(p.agent, p.id) } : null; },
        (key) => removeOwnBrowserFiles(cfg.home, key))
    : undefined;
  // Browser folders of profiles removed before a removal took them along (setup.ts): any profile still listed keeps its.
  if (profileBrowsers) {
    const swept = sweepOwnBrowserFiles(cfg.home, (key) => { const p = profileOfKey(key); return !!p && (p.id === DEFAULT_PROFILE || profiles.all()[p.agent].profiles.some((x) => x.id === p.id)); });
    if (swept.length) console.error(`browser: removed the folders of ${swept.length} profiles that are no more: ${swept.join(", ")}`);
  }
  // An address asked for its models with a profile's key is asked the way the profile's agent would send it: through
  // the forwarder of its proxy when it has one (docs/profiles-v0.md §4), straight out when it has none.
  const apiKeys = new ApiKeys({ store: profiles, ...(opener ? { resolve: opener } : {}),
    through: async (agent, id) => { const proxy = profiles.proxyOf(agent, id); return proxy ? exits.address(exitKey(agent, id), proxy) : null; } });
  const sessionKeys: SessionKeys = new SessionKeys({ store: profiles, ...(opener ? { resolve: opener } : {}),
    browser: (agent, id) => profileBrowsers?.get(`${agent}.${id}`)?.host ?? null });
  // The gate's ciphertexts kept from before are sealed anew under the vault's key, the gate opening each one last time.
  if (vaultKeys && gate) void moveSealed({ key: vaultKeys[0]!, gate: gateFill(gate), profiles, identity: browser?.identity, log: (line) => console.error(line) }).catch((err: Error) => console.error(`vault: moving kept secrets: ${err.message}`));
  const profileHealth = new ProfileHealthChecks(profiles, apiKeys, subscriptionHealth(profiles, exits, agentBinaries));
  // A new engine is switched to with the browser stopped, which then comes back with its tabs (docs/browser-v0.md §7.2 第 6 条).
  // The profiles' own browsers run on the same copy: stopped with it, back with their tabs after.
  if (browser && engineKit) {
    const hosts = () => [browser.host, ...(profileBrowsers?.keys() ?? []).flatMap((key) => { const b = profileBrowsers?.get(key); return b ? [b.host] : []; })];
    engineKit.aroundSwitch((apply) => hosts().reduceRight<() => Promise<void>>((inner, host) => () => host.restart(inner), async () => { apply(); })());
    engineKit.idleWhen(() => hosts().every((host) => host.list().length === 0));
  }
  // The terminals' agents use it through the agent bridge (docs/terminal-v0.md §3; with no gate in front since
  // 2026-10-08, docs/profiles-v0.md §8): a session of their own per terminal, ended with the program; the terminal's
  // tabs close when the terminal is deleted.
  const agents = browser?.agents;
  const terminalBrowser = agents
    ? (req: { id: string; harness: string; cwd: string; browserKey?: string }) => {
        // Under a profile with a browser of its own, the agent's browser tool is that browser's (§5.1).
        const own = req.browserKey ? profileBrowsers?.of(req.browserKey) ?? null : null, base = `http://127.0.0.1:${localPort}`;
        if (req.browserKey && !own) throw new Error("profile browser is unavailable; refusing to use the shared browser");
        const minted = (own?.agents ?? agents).mint(terminalOwner(req.id, req.harness, req.cwd));
        const command = bridgeCommand(minted, own ? `${base}/profile-browser/${req.browserKey}` : base, stable(process.execPath), stable(BRIDGE_SCRIPT));
        // A held terminal keeps the session for the next daemon, which takes it up again with the same token.
        return Object.assign(command, { minted: { session: minted.id, token: minted.token, ...(own ? { key: req.browserKey! } : {}) } });
      }
    : undefined;
  // Terminals are used like any terminal: only the credentials at rest stay closed there (docs/terminal-v0.md §3).
  const termProt = terminalProtected({ ...process.env, AGENTSWITCH_HOME: cfg.home });
  // The titles agents give their sessions while they run in a terminal here, kept for the list of sessions.
  const sessionTitles = new SessionTitles(cfg.home);
  let saidTitle: (harness: string, sessionId: string) => string | null = () => null;
  const sessionFolders = new ShownFoldersStore(cfg.home);
  // Terminals that outlive the service (docs/terminal-v0.md §10): each program on a holder of its own.
  const held = cfg.holdTerminals && (cfg.terminals || overrides.terminalLauncher) ? holding({ ringBytes: TERMINAL_RING_BYTES }) : null;
  if (cfg.holdTerminals && !held) console.error("terminals: no holder (native/build/pty-hold) — terminals end with the service");
  let leftovers: Leftovers | null = null;
  // Chat Room (docs/chatroom-v0.md): the rooms as kept, how their messages reach the sessions they are for, and what
  // a session in a room can do there. Who a seat is now is asked of the terminals, once there are any.
  const rooms = new RoomStore(cfg.home);
  // The model traffic gateway and the words it replaces (vault/; user #320-#332): with real terminals only.
  const vault = vaultKeys ? new RedactionStore(cfg.home, vaultKeys) : null;
  const passwords = vaultKeys ? new PasswordBook(cfg.home, vaultKeys) : null;
  const modelGate = vault ? new ModelGate({ home: cfg.home, bin: gateBin(), store: vault, roomsOf: (t) => rooms.roomsOf(t).map((x) => x.room.id), more: () => passwords?.words() ?? [], log: (line) => console.error(line) }) : null;
  const roomPolicy = new RoomPolicy(cfg.home);
  const roomFilesDir = filesRoot(cfg.home);
  mkdirSync(roomFilesDir, { recursive: true, mode: 0o700 });
  rooms.sweep();
  let roomSeat: SeatLookup = () => null;
  let roomSay: (terminal: string, text: string) => Promise<boolean> = async () => false;
  let roomPoke: (terminal: string, text: string) => Promise<{ readonly given: boolean; readonly why?: string }> = async () => ({ given: false, why: "没有终端" });
  let roomAside: (terminal: string, question: string) => Promise<{ readonly ok: boolean; readonly answer?: string; readonly why?: string }> = async () => ({ ok: false, why: "没有终端" });
  // Only a session that has the Kit is given anything: one that could not answer in the room is not spoken to.
  const roomDelivery: RoomDelivery = new RoomDelivery({ store: rooms, seat: (terminal) => roomSeat(terminal), home: homedir(), push: (terminal, text) => (roomKit.has(terminal) ? roomSay(terminal, text) : Promise.resolve(false)), poke: (terminal, text) => roomPoke(terminal, text), aside: (terminal, question) => roomAside(terminal, question) });
  let roomAsk: Ask | null = null;
  // The new dispatch (api/dispatchDesk.ts): a session at the 调度台 room; it may start more sessions than an admin.
  const dispatchDesk = new DispatchDesk({ home: cfg.home, rooms, ask: (method, path, body) => (roomAsk ? roomAsk(method, path, body) : Promise.resolve({ status: 503, body: { error: "the service is not ready" } })), changed: () => roomDelivery.look() });
  const roomKit: RoomKit = new RoomKit({ store: rooms, seat: (terminal) => roomSeat(terminal), delivery: roomDelivery, org: () => (roomAsk ? roomOrg(roomAsk, roomPolicy) : null), startLimit: (terminal) => dispatchDesk.limitOf(terminal) ?? MAX_STARTED });
  let seatRewind: SeatRewind | null = null;
  const terminalHost = cfg.terminals || overrides.terminalLauncher
    ? new TerminalHost({
      // A profile's placeholders are its account's (vault/words.ts saltKey; user #421).
      ...(modelGate ? { modelGate: {
        open: ({ harness, ...scope }) => { const agent = PROFILE_AGENTS.find((x) => x === harness); return modelGate.open({ ...scope, profile: saltKey(harness ?? "", scope.profile, agent ? profiles.accountOf(agent, scope.profile || DEFAULT_PROFILE) : null) }); },
        close: (terminal: string) => modelGate.close(terminal),
      } } : {}),
      // Which profile each conversation runs under is kept, so it goes on under the same one (docs/profiles-v0.md §3.3).
      deviceOf: (harness, profile) => { const agent = PROFILE_AGENTS.find((a) => a === harness); return agent ? profiles.deviceOf(agent, profile ?? DEFAULT_PROFILE) : null; },
      onSession: (harness, sessionId, profile) => { sessionTitles.seen(harness, sessionId); const agent = PROFILE_AGENTS.find((a) => a === harness); if (agent) profiles.noteSession(agent, sessionId, profile); },
      onTitle: (harness, sessionId, title) => sessionTitles.note(harness, sessionId, title),
      // Antigravity names its model as its picker shows it: the menus' entry for it, and its level.
      modelNamed: (harness, name) => (harness === "agy" ? overrides.modelOffers?.agyNamed(name) ?? null : null),
      customTitle: (harness, sessionId) => sessionTitles.custom(harness, sessionId),
      // The list of sessions is made after the terminals: asked through it once it is there.
      saidTitle: (harness, sessionId) => saidTitle(harness, sessionId),
      onRename: (harness, sessionId, title) => sessionTitles.rename(harness, sessionId, title),
      launcher: overrides.terminalLauncher ?? agentLauncher({ binaries: agentBinaries, hookUrl: () => `http://127.0.0.1:${localPort}`, stateDir: join(cfg.home, "terminals"), roomFiles: roomFilesDir, protected: termProt,
        // Through `current` where the runtime has one: a terminal that outlives this runtime runs the next one's hooks.
        node: stable(process.execPath), hookScript: stable(HOOK_SCRIPT), holding: held,
        codexHooks: (home) => codexTrust(home)?.trusted ?? false, opencodeServer: true,
        // Folders trusted once in AgentSwitch: read at each start, so a change on the Mac counts from the next one.
        trustedFolders: () => loadTrustList(cfg.home),
        // Grok's hooks are a file of ours in its own folder (terminals/grokHooks.ts), looked for — and written again
        // where it is gone — as each Grok terminal starts: a profile's folder, or the Mac's own for `Default`.
        grokHooks: (home) => ensureGrokHooks(home ?? grokHome(), QUICK_HOOK_TIMEOUT_S),
        // The Chatroom Kit's server in Grok's config.toml, under this service's node.
        grokKit: (home) => ensureGrokKit(home ?? grokHome(), process.execPath, ROOM_KIT_SCRIPT),
        // Antigravity's Chat Room tools are an entry of ours in its own MCP configuration (terminals/agy.ts), looked
        // for — and written again where it is gone — as each of its terminals starts: the kit under this service's node.
        agyMcp: () => ensureAgyMcp(agyGeminiDir(), process.execPath, ROOM_KIT_SCRIPT),
        // Codex on its own, as its command line starts it (2026-10-08, user: 你直接改回命令行吧). Through an app-server of
        // the terminal's own a screen could set its model and effort (codexTerminal.ts), but a session made that way is
        // marked as an app's, not the command line's (`codex app-server` says so itself, with no option), and Codex's
        // desktop app no longer lists it under its project. `AGENTSWITCH_CODEX_TERMINAL=server` starts it that way.
        codexServer: process.env.AGENTSWITCH_CODEX_TERMINAL === "server",
        // Its Daybreak switch, where this Codex and this account have one (models/modelOffers.ts; simple-view-v0 §5.8).
        // Codex's MCP servers switched off under a profile, by the folder it runs in (profiles/addons.ts).
        codexMcpOff: (configHome) => {
          const dir = configHome ? dirname(configHome) : join(cfg.home, "profiles", "codex", DEFAULT_PROFILE);
          return codexMcpOff(join(dir, "addons.json"), join(configHome ?? join(homedir(), ".codex"), "config.toml"));
        },
        codexDaybreak: () => overrides.modelOffers?.current().codex?.daybreak !== undefined,
        ...(terminalBrowser ? { browser: terminalBrowser } : {}) }),
      // Whatever the permission mode.
      // A reply refused by Claude's safeguard takes the member back to before the room's message it answered
      // (api/roomRewind.ts, user #288): nothing is handed it meanwhile.
      mail: (id, takes) => (!roomKit.has(id) ? null : seatRewind?.refused(id) ? null : roomDelivery.atTurnEnd(id, takes)),
      failed: (id) => { if (roomKit.has(id)) setTimeout(() => seatRewind?.refused(id), 800).unref(); },
      mailNow: (id) => (roomKit.has(id) ? roomDelivery.duringTurn(id) : null),
      prompted: (id, prompt) => roomDelivery.userTyped(id, prompt),
      floor: (tool, input, cwd) => { const d = decideTool(tool, input, canonical(cwd), new Set(), termProt); return d.kind === "deny" ? d.reason : null; },
      ...(agents ? {
        onExit: (id: string) => {
          agents.end({ kind: "terminal", id });
          for (const key of profileBrowsers?.keys() ?? []) profileBrowsers?.get(key)?.agents.end({ kind: "terminal", id });
        },
        onRemove: (id: string) => {
          agents.end({ kind: "terminal", id }, true);
          for (const key of profileBrowsers?.keys() ?? []) profileBrowsers?.get(key)?.agents.end({ kind: "terminal", id }, true);
        },
      } : {}),
      // What its program leaves running is ended after a grace (docs/terminal-v0.md §11).
      // Its own folder too (stateFiles.ts): nothing reads it once the program is gone.
      onLeft: (id: string) => { leftovers?.ended(id); forgetTerminalFiles(join(cfg.home, "terminals"), id); },
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
  // The processes a terminal left running (docs/terminal-v0.md §11): this service's are the ones tagged with its
  // address; a terminal's are left once its program is not running.
  if (terminalHost && cfg.leftovers) {
    leftovers = new Leftovers({ url: () => `http://127.0.0.1:${localPort}`, live: () => new Set(terminalHost.list().filter((t) => t.status !== "exited").map((t) => t.id)), log: (line) => console.error(line) });
  }
  let style: TerminalStyle | null = null;
  if (terminalHost) { roomSeat = (terminal) => seatLive(terminalHost.get(terminal)); roomSay = (terminal, text) => terminalHost.say(terminal, text); roomPoke = (terminal, text) => terminalHost.poke(terminal, text); roomAside = (terminal, question) => terminalHost.aside(terminal, question); }
  // A session's state changes without the rooms being told (it comes to rest, it ends): what has not arrived is
  // looked at again every little while.
  // Each time, seats first follow their sessions (rooms/follow.ts): a session that runs in another terminal now — the
  // service started again, or it was resumed elsewhere — has its seat there.
  const roomFollows = (): void => { if (terminalHost) { try { follow(rooms, terminalHost.list().map(runningOf)); } catch (err) { console.error("rooms: follow", err); } } };
  roomFollows();
  const roomLooks = setInterval(() => { roomFollows(); roomDelivery.look(); }, ROOM_LOOK_MS);
  roomLooks.unref();
  const terminals = terminalHost ? {
    host: terminalHost,
    ...(leftovers ? { leftovers } : {}),
    audit: new TerminalAudit(join(cfg.home, "terminals", "audit.jsonl")),
    agents: overrides.terminalLauncher ? [...TERMINAL_HARNESSES] : TERMINAL_HARNESSES.filter((h) => agentBinaries[h]),
    // Claude Code and Codex say themselves whether they are signed in, in a profile's folder (terminals/signIn.ts).
    signedIn: (harness: TerminalHarness, home: string, isolated?: boolean) => (harness === "claude-code" && agentBinaries["claude-code"] ? claudeSignedIn(agentBinaries["claude-code"], home, isolated)
      : harness === "codex" && agentBinaries.codex ? codexSignedIn(agentBinaries.codex, home) : Promise.resolve(null)),
    style: () => (style ??= readTerminalStyle()),
    elsewhere: overrides.terminalElsewhere ?? (overrides.terminalLauncher ? async () => null : elsewhereCheck()),
    reidentified: (harness: string, from: string, to: string) => sessionTitles.reidentified(harness, from, to),
    ...(agentBinaries.codex ? { prepare: async (harness: string, home?: string) => { if (harness === "codex") await withTimeout(codexTrust(home)!.ensure({ fresh: true }), 8000); } } : {}),
    ...(overrides.modelOffers ? { offers: () => overrides.modelOffers!.current(), variants: () => overrides.modelOffers!.variants(), daybreakTurned: (on: boolean) => overrides.modelOffers!.noteCodexDaybreak(on) } : {}),
  } : undefined;
  // Deleting an OpenCode session from the session list goes through the user's own opencode (docs/terminal-v0.md §5).
  // None with a fake launcher, nor when no opencode is configured (tests): a test never reaches the user's OpenCode.
  const sessionSources = overrides.sessionSources ?? defaultSessionSources(cfg.home);
  const opencodeBin = overrides.terminalLauncher || !cfg.opencodeBinary ? undefined : agentBinaries.opencode ?? terminalBinaries(targets, cfg.opencodeBinary).opencode;
  const openCodeDelete = overrides.openCodeDelete ?? (opencodeBin ? openCodeDeleter(opencodeBin, sessionSources.opencodeDb) : undefined);
  // The sessions the old Dispatch's executors made in the user's own stores stay off the list, as they always were.
  const oldSessions = cfg.watchSessions ? oldDispatchSessionIds(join(cfg.home, "agentswitch.db")) : new Set<string>();
  const sessions = cfg.watchSessions ? new SessionMonitor({
    ...sessionSources, claudeProfileProjects: () => profiles.claudeProjectRoots(), codexProfileSessions: () => profiles.codexSessionRoots(), grokProfileSessions: () => profiles.grokSessionRoots(), ...(openCodeDelete ? { openCodeDelete } : {}),
    ownIds: () => oldSessions, ownFolders: () => (taskFolderRoot ? [taskFolderRoot()] : []),
    agentTitle: (harness, id) => sessionTitles.get(harness, id), customTitle: (harness, id) => sessionTitles.custom(harness, id), ranHere: (harness, id) => sessionTitles.ran(harness, id) || profiles.sessionProfile(harness, id) !== null, folders: () => sessionFolders.get(),
  }) : undefined;
  if (sessions) saidTitle = (harness, id) => sessions.find(harness as SessionHarness, id)?.title || null;
  const clashStore = new ClashStore(cfg.home);
  const clashPhone: Daemon["clashPhone"] = { reach: { port: null, lan: [], tailnet: [], problem: null }, changed: null };
  const clash = new ClashIntegration({ store: clashStore, reach: () => clashPhone.reach, phoneChanged: (on) => clashPhone.changed?.(on), source: new ClashSources(cfg.home, undefined, undefined, undefined, () => clashStore.settings().autoUpdateHours), base: () => `http://127.0.0.1:${localPort}`,
    // A profile's proxy server is tried on its own port by the routing check (docs/clash-v0.md §7.9).
    proxyPorts: () => new Map(Object.values(profiles.all()).flatMap((a) => a.profiles).flatMap((p) => { const place = p.proxy ? proxyPlace(p.proxy.server) : null; return place ? [[place.host.toLowerCase(), place.port] as const] : []; })) });
  // The nodes are made after the API (they need the remote listener): what they heard is asked through this.
  let nodesMade: Nodes | null = null;
  // The Files column (docs/files-v0.md §7): what of this node's disk its screens and its paired devices may read.
  const thumbnails = new Thumbnails();
  const fileAccess: FileAccess = {
    home: process.env.HOME ?? homedir(), denied: prot, thumbnails, audit: new FileAudit(join(cfg.home, "files", "audit.jsonl")),
    remote: () => { const m = loadMesh(cfg.home); return { on: m.files, changes: m.changes, scopeOf: (id: string) => m.scopes[id] ?? DEFAULT_SCOPE, platformOf: (id: string) => devices.getDevice(id)?.platform }; },
    // A folder a terminal runs in is asked about before it is renamed or moved (docs/files-v0.md §12.2).
    running: () => (terminalHost?.list() ?? []).filter((t) => t.status !== "exited").map((t) => ({ id: t.id, name: t.name, workdir: t.workdir })),
  };
  seatRewind = new SeatRewind({
    rooms, host: () => terminalHost ?? undefined, callLocal: (method, path, body) => (roomAsk ? roomAsk(method, path, body) : Promise.resolve({ status: 503, body: { error: "the service is not ready" } })),
    locate: (agent, session) => (agent === "claude-code" || agent === "codex" || agent === "pi" ? sessions?.locate(agent, session) ?? null : null),
    noteProfile: (session, profile, agent = "claude-code") => { const a = PROFILE_AGENTS.find((x) => x === agent); if (a) profiles.noteSession(a, session, profile); },
    sessionOf: seatSessionOf, wasOf: seatWasOf, changed: () => roomDelivery.look(),
  });
  const apiDeps: ApiDeps = { seatRewind, rooms, roomKit, dispatchDesk, roomDelivery, roomPolicy, roomsChanged: () => { roomDelivery.look(); modelGate?.changed(); }, ...(vault && modelGate ? { redaction: { store: vault, gate: modelGate } } : {}), ...(passwords ? { passwords } : {}), ...(vaultKeys ? { seal: (value: string) => sealValue(vaultKeys[0]!, value) } : {}), callLocal: (method, path, body) => roomAsk ? roomAsk(method, path, body) : Promise.resolve({ status: 503, body: { error: "the service is not ready" } }), ...(cfg.forgetLogins ? { forgetClaudeLogin: (dir: string | null) => forgetClaudeLogin(dir, join(process.env.HOME ?? homedir(), ".claude")) } : {}), addons: new Addons({ binaries: agentBinaries }), profileHealth, sessionFolders, liveElsewhere: () => nodesMade?.lives() ?? [], remoteKeyboard: () => loadMesh(cfg.home).keyboard, fileAccess, exits, profiles, sessionKeys, apiKeys, ...(profileBrowsers ? { profileBrowsers } : {}), clash, ...(browser ? { browser } : {}), ...(engineKit ? { engineKit } : {}), ...(sessions ? { sessions } : {}), ...(terminals ? { terminals } : {}), targets, cwdRules: defaultCwdRules(process.env, cfg.home), home: cfg.home, ...(cfg.appBundle ? { appBundle: cfg.appBundle } : {}), uploads, version: VERSION, ...(overrides.sseHeartbeatMs ? { sseHeartbeatMs: overrides.sseHeartbeatMs } : {}) };
  const api = createApp(apiDeps);
  // The Kit's organizing tools ask this API itself, as this Mac's own screens would.
  roomAsk = async (method, path, body) => {
    const res = await api.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // The dispatch, while it is on, is kept running (resumed when it ended).
  if (terminalHost) dispatchDesk.watch();
  const remote = overrides.remote !== undefined ? overrides.remote : cfg.remote ? remoteRuntime({ home: cfg.home, port: cfg.remote.port, ...(cfg.remote.name ? { name: cfg.remote.name } : {}), gate: () => defaultGate() }) : null;
  // docs/mesh-v0.md: this node among the others. What it has is what its screens would show of it.
  const nodes = new Nodes({
    book: new NodeBook(join(cfg.home, NODES_DIR)), dialer: new Dialer(), store: devices, remote,
    info: () => ({
      name: remote?.name ?? macName(), kind: process.platform === "darwin" ? "mac" : "linux", version: VERSION, home: process.env.HOME ?? homedir(),
      // `dispatch`: the dispatch desk (api/dispatchDesk.ts), a session in a terminal here.
      has: [...(terminalHost ? ["dispatch", "terminals", "profiles"] : []), ...(browser ? ["browser"] : []), ...(process.platform === "darwin" && existsSync(vergeDir()) ? ["clash"] : []),
        ...(cfg.appBundle ? ["update"] : []), ...(loadMesh(cfg.home).keyboard ? ["keyboard"] : []), "files"],
    }),
  });
  nodesMade = nodes;
  const fileScopes = { get: (id: string) => scopeOf(cfg.home, id), set: (id: string, scope: Parameters<typeof setScope>[2]) => setScope(cfg.home, id, scope) };
  const app = mountNodes(mountRemoteAdmin(new Hono().route("/", api), { store: devices, remote, onRevoke: (id) => nodes.inboundGone(id), fileScopes }), { nodes, home: cfg.home });
  return { app, api, remote, nodes, devices, targets, clash, clashPhone, terminals: terminalHost, modelGate, leftovers, sessions: sessions ?? null, browser: browser?.host ?? null, setLocalPort: (port) => { localPort = port; },
    stopBrowser: async () => { await profileBrowsers?.stop(); await browser?.agents.shutdown(); await browser?.host.shutdown(); await browser?.stop(); },
    close: () => { clearInterval(roomLooks); modelGate?.stop(); dispatchDesk.close(); sessionTitles.flush(); nodes.close(); thumbnails.close(); leftovers?.stop(); terminalHost?.closeAll(); void profileBrowsers?.stop(); void exits.stop(); void browser?.agents.shutdown(); void browser?.host.shutdown(); devices.close(); } };
}

/** The port a proxy's address names, or undefined. */
function portOf(address: string): number | undefined {
  try { const url = new URL(address); return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80; } catch { return undefined; }
}

/** The sessions the old Dispatch's executors made (its `thread_events`, kept in `agentswitch.db` since before it was
 *  removed on 2026-11-25): OpenCode's are in the user's own store, and are not the user's. None where it never ran. */
export function oldDispatchSessionIds(dbPath: string): Set<string> {
  const ids = new Set<string>();
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const row of db.prepare("SELECT payload FROM thread_events WHERE type = 'session'").all() as { payload: string }[]) {
        try { const id = (JSON.parse(row.payload) as { sessionId?: unknown }).sessionId; if (typeof id === "string" && id) ids.add(id); } catch { /* not a session's */ }
      }
    } finally { db.close(); }
  } catch { /* no such table: the old Dispatch never ran here */ }
  return ids;
}

/** A promise's result, or undefined once `ms` passed. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => { setTimeout(() => r(undefined), ms).unref(); })]);
}

/** Start-up: ask what the agents offer where that is on (the catalog takes new ids, the terminals' model menus
 *  what each agent offers, kept fresh from then on), then listen. */
export async function serve(cfg: DaemonConfig): Promise<{ daemon: Daemon; close: () => void; stop: () => Promise<void> }> {
  const yaml = loadTargets(cfg.targetsPath);
  const grokBinary = cfg.terminals ? terminalBinaries(yaml, cfg.opencodeBinary).grok : undefined;
  const agyBinary = cfg.terminals ? terminalBinaries(yaml, cfg.opencodeBinary).agy : undefined;
  const modelOffers = cfg.modelOffers ? new ModelOffers({ codexBinary: codexBinary(yaml), ...withClaude(claudeBinary()), ...(grokBinary ? { grokBinary, grokHome: grokHome() } : {}),
    ...(agyBinary ? { agyBinary, agyHome: agyHome(), agyGeminiDir: process.env[AGY_HOME_VAR]?.trim() || null } : {}) }) : undefined;
  const targets = modelOffers ? mergeLogged(yaml, await modelOffers.refresh()) : yaml;
  const stopOffers = modelOffers?.start();
  // OpenCode's variants (its models' thinking levels) for the terminals' menus, asked of a server of its own each time.
  const opencode = modelOffers ? terminalBinaries(yaml, cfg.opencodeBinary).opencode : undefined;
  if (modelOffers && opencode) modelOffers.watchOpenCode(() => readOpenCodeVariants({ binary: opencode, home: join(cfg.home, "opencode-exec") }));
  // Codex names a picture by where its file was: the running service keeps copies, which outlive the file
  // (docs/simple-view-v0.md §4). Under the home; nothing from a folder no agent may read. Here and not in buildDaemon:
  // a daemon built by a test copies no one's pictures.
  const pictures = cfg.watchSessions
    ? new KeptPictures(join(cfg.home, "sessions", "pictures"), { closed: defaultProtected({ ...process.env, AGENTSWITCH_HOME: cfg.home }).readDenied ?? [] })
    : undefined;
  const daemon = buildDaemon(cfg, { targets, ...(modelOffers ? { modelOffers } : {}),
    ...(pictures ? { sessionSources: { ...defaultSessionSources(cfg.home), pictures } } : {}) });
  const remote: RemoteListener | undefined = daemon.remote
    ? await startRemote(daemon, daemon.remote).catch((err: Error) => { daemon.close(); throw err; })
    : undefined;
  // docs/clash-v0.md §12: phones' Clash and Stash take the subscription here. A port that is taken is said on the
  // page, not a reason not to start.
  let phone: PhoneListener | null = null;
  const phonePort = cfg.clashPhonePort;
  const addresses = async () => {
    const found = await (daemon.remote?.addresses ?? discoverAddresses)().catch(() => ({ lan: [] as string[], tailnet: [] as string[] }));
    daemon.clashPhone.reach = { ...daemon.clashPhone.reach, lan: found.lan, tailnet: found.tailnet };
  };
  const phoneListen = async (on: boolean) => {
    if (!phonePort) return;
    if (!on) { await phone?.close(); phone = null; daemon.clashPhone.reach = { ...daemon.clashPhone.reach, port: null, problem: null }; return; }
    if (phone) return;
    try {
      phone = await listenPhone(daemon.clash, phonePort, { allowSource: isAllowedSource });
      daemon.clashPhone.reach = { ...daemon.clashPhone.reach, port: phone.port, problem: null };
      console.error(`agentswitchd clash subscription for phones on http://*:${phone.port}${PHONE_PATH}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      daemon.clashPhone.reach = { ...daemon.clashPhone.reach, port: null, problem: code === "EADDRINUSE" ? `端口 ${phonePort} 已被占用` : (err as Error).message };
      console.error(`clash subscription for phones on port ${phonePort}: ${(err as Error).message}`);
    }
  };
  daemon.clashPhone.changed = phoneListen;
  if (phonePort) { await addresses(); await phoneListen(daemon.clash.phoneOn()); }
  const addressTimer = phonePort ? setInterval(() => { void addresses(); }, PHONE_ADDRESSES_MS) : null;
  addressTimer?.unref();
  // Every local caller shows the token (api/localAuth.ts); made on first start, read by the Mac app and the CLI.
  const auth = new LocalAuth(ensureLocalToken(cfg.home));
  const server = listenLocal(daemon, cfg.port, (info) => {
    daemon.setLocalPort(info.port);
    // Terminals the last daemon left to their holders (docs/terminal-v0.md §10): their hooks reach this port. A daemon
    // that holds none ends them: a terminal nobody takes up is not left running on its own.
    const taken: Promise<unknown> = daemon.terminals && !daemon.terminals.holds
      ? endLeftHeld(join(cfg.home, "terminals")).then((n: number) => { if (n) console.error(`terminals: ${n} left held by the last daemon, ended`); })
      : daemon.terminals?.restore().then((n) => { if (n) console.error(`terminals: ${n} taken up again from their holders`); }, (err: Error) => console.error(`terminals: restore: ${err.message}`)) ?? Promise.resolve();
    // What the last daemon's terminals left running is looked for once this daemon's own terminals are all known
    // (docs/terminal-v0.md §11): a held terminal taken up again has left nothing.
    void taken.finally(() => {
      if (daemon.terminals) daemon.modelGate?.keepOnly(new Set(daemon.terminals.list().map((t) => t.id)));
      daemon.leftovers?.start();
      // Folders of terminals no daemon has any more (stateFiles.ts), once this daemon's own are all known.
      if (daemon.terminals) {
        const live = new Set(daemon.terminals.list().map((t) => t.id));
        const swept = sweepTerminalFiles(join(cfg.home, "terminals"), live);
        if (swept) console.error(`terminals: removed ${swept} folders of terminals that ended`);
        sweepAttachments(join(tmpdir(), "agentswitch-attach"), live, (folder) => daemon.sessions?.keepPicturesIn(folder));
      }
    });
    console.error(`agentswitchd ${VERSION} listening on http://127.0.0.1:${info.port}  home=${cfg.home}`);
  }, auth);
  // Clash Integration's subscription, fetched again when its interval has passed (docs/clash-v0.md §7.1).
  const clashTimer = setInterval(() => { void daemon.clash.tick(); }, CLASH_TICK_MS);
  clashTimer.unref();
  // The pictures Codex's records name, copied while their files are there, whether or not a screen reads the list.
  const keepPictures = () => { try { daemon.sessions?.keepPictures(); } catch { /* the next round */ } };
  const picturesFirst = setTimeout(keepPictures, PICTURES_FIRST_MS);
  picturesFirst.unref();
  const picturesTimer = setInterval(keepPictures, PICTURES_EVERY_MS);
  picturesTimer.unref();
  const close = () => { if (addressTimer) clearInterval(addressTimer); void phone?.close(); clearInterval(clashTimer); clearTimeout(picturesFirst); clearInterval(picturesTimer); stopOffers?.(); server.close(); void remote?.close(); daemon.close(); };
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
export async function startRemote(daemon: Pick<Daemon, "api" | "devices"> & { readonly nodes?: Nodes }, remote: RemoteRuntime, host?: string): Promise<RemoteListener> {
  const app = createRemoteApp({ store: daemon.devices, pairing: remote.pairing, presence: remote.presence, gateKey: remote.gateKey, addresses: remote.addresses, local: daemon.api, ...(daemon.nodes ? { nodes: daemon.nodes } : {}) });
  try {
    const listener = await listenRemote({ fetch: app.fetch, tls: remote.tls, port: remote.port, ...(host ? { host } : {}) });
    console.error(`agentswitchd remote listening on https://*:${listener.port}  fingerprint=${remote.tls.fingerprint} name="${remote.name}"`);
    return listener;
  } catch (err) {
    throw new Error(`remote listener on port ${remote.port}: ${(err as Error).message}`);
  }
}
