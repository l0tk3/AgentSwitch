/** How each agent starts in an AgentSwitch terminal (docs/terminal-v0.md §2–3): the service builds the command line
 *  (clients only name the agent, folder, model and a session to resume), the env carries the gate like the managed
 *  executors', and the hooks go into this terminal's own settings — the user's global agent configuration is never
 *  touched, so agents they start in iTerm are unaffected. */

import { effortArgs } from "../harness/efforts.js";
import { codexHookArgs } from "./codexHooks.js";
import { OpenCodeCompanion } from "./opencodeTerminal.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeMcpServers, gateEnv, withoutCredentialRepair, type GateOptions } from "../executors/gate.js";
import { protectedDeny } from "../executors/opencodeShared.js";
import { rootSpellings, type ProtectedPaths } from "../executors/protected.js";
import type { LaunchPlan, LaunchRequest, Launcher, TerminalHarness } from "./host.js";

/** The hook command's script next to this module: hookClient.js in dist/, hookClient.ts under tsx (node strips its types). */
const EXT = import.meta.url.endsWith(".ts") ? "ts" : "js";
export const HOOK_SCRIPT = fileURLToPath(new URL(`./hookClient.${EXT}`, import.meta.url));
/** pi's extension (piExtension.ts; pi loads TypeScript itself). */
export const PI_EXTENSION = fileURLToPath(new URL(`./piExtension.${EXT}`, import.meta.url));

/** Seconds Claude Code waits for the permission hook: a screen has this long to answer before the terminal asks. */
export const PERMISSION_HOOK_TIMEOUT_S = 30 * 60;
export const QUICK_HOOK_TIMEOUT_S = 10;

export type LauncherOptions = {
  /** Agent executables; a missing one cannot be started. */
  readonly binaries: Partial<Record<TerminalHarness, string>>;
  readonly gate: GateOptions | null;
  /** The service's local URL the hook command calls (http://127.0.0.1:<port>). */
  readonly hookUrl: () => string;
  /** Per-terminal files (settings, MCP config) go under here: `<dir>/<id>/`. The managed executors may not read it. */
  readonly stateDir: string;
  readonly node?: string;
  readonly hookScript?: string;
  readonly piExtension?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The protected paths (terminals: only the credentials at rest, `terminalProtected`): each agent gets them refused its
   *  own way (docs/terminal-v0.md §3). */
  readonly protected?: ProtectedPaths;
  /** Codex gets AgentSwitch's hooks (status, permission requests, the protected-path check), once the user's Codex
   *  trusts them (codexHooks.ts); until then it goes without and its status is guessed. */
  readonly codexHooks?: () => boolean;
  /** OpenCode's TUI attaches to a private server the service starts and watches (status, permission requests;
   *  opencodeTerminal.ts); without it, or when that server does not start, it runs `--standalone` and its status is
   *  guessed. */
  readonly opencodeServer?: boolean;
  /** The shared browser for the agent (docs/browser-v0.md §2 给 agent, terminal-v0 §3): the agent bridge's command for
   *  terminal `id`, made when it starts (a session of its own); the gate wraps it as the `browser` MCP server. Codex,
   *  Claude Code and OpenCode; only with the gate (no ungated browser for an agent); absent or null: no browser tool. */
  readonly browser?: (req: { readonly id: string; readonly harness: TerminalHarness; readonly cwd: string }) => readonly string[] | null;
};

/** The agents that take MCP servers, and so the browser tool. */
export const BROWSER_HARNESSES: ReadonlySet<TerminalHarness> = new Set(["claude-code", "codex", "opencode"]);
/** The MCP server's name in each agent's configuration: its tools show as `browser_navigate`, … under it. */
export const BROWSER_SERVER = "browser";
/** What a terminal's agent is told about the `browser` tools it has (docs/browser-v0.md §6 告诉 agent 用哪个, 2026-10-03,
 *  user: 怎么着么费劲呢，codex调用浏览器，我看他默认还是加载chrome): its own browser tools are there too — Chrome DevTools,
 *  computer use, Playwright —, and without a word it picks any, starting a browser of its own. Theirs stay usable by name. */
export const BROWSER_GUIDANCE =
  "This terminal runs in AgentSwitch. To open, look at, check or operate anything in a web browser (a site, a local dev " +
  "server, a page or picture you made), use the tools of the `browser` MCP server: browser_navigate, browser_snapshot, " +
  "browser_take_screenshot, browser_click, browser_type and the rest (some agents list them as mcp__browser__browser_navigate " +
  "and so on). They drive AgentSwitch's shared browser, which the user watches and can take over from the Mac and the " +
  "iPhone, signed in as the user. It opens http(s) pages only: serve a local file from a local server (python3 -m " +
  "http.server on 127.0.0.1) and open that. Do not use any other browser (Chrome DevTools, Safari or another app through " +
  "computer use, an in-app browser, Playwright scripts) unless the user asks for that one by name.";

/** The user's own `developer_instructions` at the top of Codex's config.toml: the terminal's `-c` would replace them, so
 *  then it sets none (the browser tools keep their own descriptions). */
export function codexHasOwnInstructions(env: NodeJS.ProcessEnv): boolean {
  const home = env.CODEX_HOME || (env.HOME ? join(env.HOME, ".codex") : "");
  if (!home) return false;
  let text: string;
  try { text = readFileSync(join(home, "config.toml"), "utf8"); } catch { return false; }
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) return false;   // the first table: the top level is over
    if (/^\s*developer_instructions\s*=/.test(line)) return true;
  }
  return false;
}

/** Codex gives an MCP tool call 60 s by default: a call waits up to two minutes while a person holds its tab. */
const BROWSER_TOOL_TIMEOUT_S = 300;

/** The browser tool as an MCP server: `secret-gate browser -- <the bridge>`, with the gate's home (its rules and keys). */
export type BrowserServer = { readonly command: string; readonly args: readonly string[]; readonly env: Record<string, string> };

export function browserServer(gate: GateOptions, bridge: readonly string[]): BrowserServer {
  return { command: gate.bin, args: ["browser", "--", ...bridge], env: { SECRET_GATE_HOME: gate.home } };
}

/** Codex's `-c` overrides for the browser server (its session config, never the user's config.toml). */
export function codexBrowserArgs(server: BrowserServer): string[] {
  const key = `mcp_servers.${BROWSER_SERVER}`;
  return [
    "-c", `${key}.command=${JSON.stringify(server.command)}`,
    "-c", `${key}.args=${JSON.stringify(server.args)}`,
    "-c", `${key}.env=${tomlInline(server.env)}`,
    "-c", `${key}.tool_timeout_sec=${BROWSER_TOOL_TIMEOUT_S}`,
  ];
}

/** The hook command a terminal's agent runs (the service's node and hook client). */
export const hookCommandOf = (opts: Pick<LauncherOptions, "node" | "hookScript">): string =>
  `${shq(opts.node ?? process.execPath)} ${shq(opts.hookScript ?? HOOK_SCRIPT)}`;

/** Markers of the Claude Code session the service itself was started from (a developer running it from Claude Code):
 *  inherited, they make the new agent think it is a child session (no transcript) and hand it that session's messaging
 *  token. The user's own settings (ANTHROPIC_*, CLAUDE_CONFIG_DIR, …) stay. */
const PARENT_SESSION = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|EXECPATH|SSE_PORT|SESSION_[A-Z_]+|MESSAGING_[A-Z_]+))$/;

export function withoutParentSession(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !PARENT_SESSION.test(k)) out[k] = v;
  return out;
}

/** A double-quoted shell word (the hook command is run by a shell). */
const shq = (s: string): string => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

/** Claude Code's hooks for one terminal: status events and the permission request, all through the hook command. With
 *  the protected paths, also its own deny rules for them (`//` = from the filesystem root): they hold for the built-in
 *  file tools even when the service does not answer the hook (which then lets the call through). */
export function claudeHookSettings(command: string, prot?: ProtectedPaths): Record<string, unknown> {
  const hook = (timeout: number) => [{ matcher: "*", hooks: [{ type: "command", command, timeout }] }];
  const rule = (tool: string, path: string) => [`${tool}(/${path})`, `${tool}(/${path}/**)`];
  const deny = prot ? [...new Set([...(prot.readDenied ?? []).flatMap(rootSpellings).flatMap((p) => rule("Read", p)), ...prot.roots.flatMap(rootSpellings).flatMap((p) => rule("Edit", p))])] : [];
  return {
    ...(deny.length ? { permissions: { deny } } : {}),
    hooks: {
      SessionStart: hook(QUICK_HOOK_TIMEOUT_S),
      UserPromptSubmit: hook(QUICK_HOOK_TIMEOUT_S),
      Notification: hook(QUICK_HOOK_TIMEOUT_S),
      Stop: hook(QUICK_HOOK_TIMEOUT_S),
      // The turn ended on an API error: the Mac's Live Activity says so (assistant-v0 §4).
      StopFailure: hook(QUICK_HOOK_TIMEOUT_S),
      // The protected-path floor, in every permission mode (bypass included): the service answers deny or nothing.
      PreToolUse: hook(QUICK_HOOK_TIMEOUT_S),
      // Tells the service a permission request was answered in the terminal (the tool ran).
      PostToolUse: hook(QUICK_HOOK_TIMEOUT_S),
      // Sub-agents at work, for the tree (docs/terminal-v0.md §1).
      SubagentStart: hook(QUICK_HOOK_TIMEOUT_S),
      SubagentStop: hook(QUICK_HOOK_TIMEOUT_S),
      // A change of model (docs/simple-view-v0.md §5.4): one a screen of ours asked for goes through without Claude
      // Code's own question, and the model it is on afterwards is what the screens show.
      PreModelSwitch: hook(QUICK_HOOK_TIMEOUT_S),
      PostModelSwitch: hook(QUICK_HOOK_TIMEOUT_S),
      PermissionRequest: hook(PERMISSION_HOOK_TIMEOUT_S),
    },
  };
}

export function agentLauncher(opts: LauncherOptions): Launcher {
  const node = opts.node ?? process.execPath;
  const script = opts.hookScript ?? HOOK_SCRIPT;
  const hookCommand = hookCommandOf(opts);
  return (req: LaunchRequest): LaunchPlan => {
    const file = opts.binaries[req.harness];
    if (!file) throw new Error(`${req.harness} is not installed on this Mac`);
    const dir = join(opts.stateDir, req.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const gated = opts.gate ? gateEnv(opts.gate) : {};
    const own: Record<string, string> = {
      ...withoutParentSession(withoutCredentialRepair(opts.env ?? process.env)),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      AGENTSWITCH_TERMINAL_ID: req.id,
      AGENTSWITCH_TERMINAL_URL: opts.hookUrl(),
      AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken,
    };
    const env = { ...own, ...gated };
    const bridge = opts.gate && opts.browser && BROWSER_HARNESSES.has(req.harness) ? opts.browser({ id: req.id, harness: req.harness, cwd: req.cwd }) : null;
    const browser = opts.gate && bridge ? browserServer(opts.gate, bridge) : null;
    switch (req.harness) {
      case "claude-code": {
        const settings = join(dir, "settings.json");
        writeFileSync(settings, JSON.stringify(claudeHookSettings(hookCommand, opts.protected), null, 2), { mode: 0o600 });
        const args = ["--settings", settings];
        if (opts.gate) {
          const mcp = join(dir, "mcp.json");
          const servers = { ...claudeMcpServers(opts.gate, join(dir, "profile"), false), ...(browser ? { [BROWSER_SERVER]: { type: "stdio", ...browser } } : {}) };
          writeFileSync(mcp, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
          args.push("--mcp-config", mcp);
        }
        if (browser) args.push("--append-system-prompt", BROWSER_GUIDANCE);
        if (req.model) args.push("--model", req.model);
        args.push(...effortArgs("claude-code", req.effort, req.model).args);
        args.push(...(req.mode === "bypass" ? ["--dangerously-skip-permissions"] : ["--permission-mode", req.mode]));
        // As in iTerm: ⇧Tab can reach bypass later. Only for terminals started on the Mac (not from a paired phone).
        if (req.mode !== "bypass" && req.allowBypass) args.push("--allow-dangerously-skip-permissions");
        // The same session goes on (one record, docs/terminal-v0.md §5); a fork is a new session with the whole history.
        if (req.resume) args.push("--resume", req.resume, ...(req.fork ? ["--fork-session"] : []));
        return { file, args, env, hooks: true };
      }
      case "codex": {
        // `notify` runs a program with the event JSON as its last argument when a turn ends.
        const args = ["-c", `notify=${JSON.stringify([node, script, "codex"])}`];
        const hooked = opts.codexHooks?.() ?? false;
        if (hooked) args.push(...codexHookArgs(hookCommand, QUICK_HOOK_TIMEOUT_S, PERMISSION_HOOK_TIMEOUT_S));
        // Codex's own "needs you" notifications, as terminal notifications (OSC 9) whether or not its window has focus:
        // the host reads them as waiting. They cover what no hook does (an app tool's approval form, a question).
        args.push(...CODEX_ATTENTION);
        // The gate's proxy and CA reach the commands Codex runs, never Codex's own traffic (as the managed executor).
        if (opts.gate) args.push("-c", `shell_environment_policy.set=${tomlInline(gated)}`);
        if (browser) args.push(...codexBrowserArgs(browser));
        if (browser && !codexHasOwnInstructions(opts.env ?? process.env)) args.push("-c", `developer_instructions=${JSON.stringify(BROWSER_GUIDANCE)}`);
        if (req.model) args.push("-m", req.model);
        args.push(...effortArgs("codex", req.effort, req.model).args);
        if (req.mode === "bypass") args.push("--dangerously-bypass-approvals-and-sandbox");
        // Asking is stated, not left to config.toml (which may never ask): it asks before anything outside the sandbox.
        // With the hooks, the read-denied paths are the PreToolUse floor's (as for Claude Code), not the profile's: Codex
        // never lifts a deny entry, so with one an approved "outside the sandbox" still runs sandboxed, where no setuid
        // program (ps, top, sudo, ping) can start.
        else args.push("-a", "on-request", ...codexPermissions(req.mode === "auto" ? ":workspace" : ":read-only", opts.protected, { denyReads: !hooked }));
        // `resume` goes on in the same conversation (Codex locks it against a second writer); `fork` starts a new one.
        // The folder is named (`-C`, the terminal's own): Codex does not ask whether to use the one the session ran in,
        // which may be gone (docs/terminal-v0.md §5).
        if (req.resume) args.unshift(req.fork ? "fork" : "resume", "-C", req.cwd, req.resume);
        return { file, args, env: own, hooks: hooked };
      }
      case "opencode": {
        // A private server — the service's own, which it watches (opencodeTerminal.ts), else the TUI's `--standalone` one:
        // by default OpenCode 2 runs the session in the user's shared background service, where this terminal's
        // environment (its config, the gate) never arrives.
        // A variant is part of the model's name (`provider/model#variant`): none without a model.
        const named = effortArgs("opencode", req.effort, req.model).model;
        const rest = named ? ["-m", named] : [];
        if (req.mode !== "manual") rest.push("--auto");   // OpenCode has one switch: approve what is not denied
        if (req.resume) rest.push("--session", req.resume);   // OpenCode cannot fork: always the same session
        let own = env;
        if (opts.protected || browser) {
          const config = join(dir, "opencode.json");
          const mcp = browser ? { mcp: { [BROWSER_SERVER]: { type: "local", command: [browser.command, ...browser.args], enabled: true, environment: browser.env } } } : {};
          const told = join(dir, "browser.md");
          if (browser) writeFileSync(told, `${BROWSER_GUIDANCE}\n`, { mode: 0o600 });
          const base = opts.protected ? opencodeTerminalConfig(opts.protected, env) : { $schema: "https://opencode.ai/config.json" };
          writeFileSync(config, JSON.stringify({ ...base, ...mcp, ...(browser ? { instructions: [told] } : {}) }, null, 2), { mode: 0o600 });
          own = { ...env, OPENCODE_CONFIG: config };
        }
        const companion = opts.opencodeServer ? new OpenCodeCompanion({ binary: file, cwd: req.cwd, env: own, args: rest, asks: req.mode === "manual" }) : undefined;
        return { file, args: ["--standalone", ...rest], env: own, hooks: false, ...(companion ? { companion } : {}) };
      }
      case "pi": {
        const args = ["--extension", opts.piExtension ?? PI_EXTENSION];
        if (req.model) args.push("--model", req.model);
        args.push(...effortArgs("pi", req.effort, req.model).args);
        return { file, args, env, hooks: true };
      }
    }
  };
}

/** A TOML inline table of strings (a `-c` value). JSON's string escapes are TOML's. */
const tomlInline = (table: Record<string, string>): string => {
  const pairs = Object.entries(table).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return pairs.length ? `{ ${pairs.join(", ")} }` : "{}";
};

/** The TUI's notifications Codex sends for what waits for you (not for a finished turn), as OSC 9. */
export const CODEX_ATTENTION = ["-c", 'tui.notifications=["approval-requested","async-question","plan-mode-prompt"]', "-c", 'tui.notification_method="osc9"', "-c", 'tui.notification_condition="always"'];

/** Codex's own permission profile for one terminal: asking or auto (`:read-only` / `:workspace`) with the protected
 *  paths on top, not writable, and (`denyReads`) the read-denied ones unreadable. Codex's sandbox enforces it, for the
 *  commands it runs sandboxed (not in bypass). A deny entry holds even for a command the user lets run outside the
 *  sandbox: Codex then keeps it sandboxed. */
export function codexPermissions(base: ":read-only" | ":workspace", prot?: ProtectedPaths, o: { denyReads?: boolean } = {}): string[] {
  const filesystem: Record<string, string> = {};
  for (const p of (prot?.roots ?? []).flatMap(rootSpellings)) filesystem[p] = "read";
  if (o.denyReads ?? true) for (const p of (prot?.readDenied ?? []).flatMap(rootSpellings)) filesystem[p] = "deny";
  const profile = `{ extends = ${JSON.stringify(base)}, filesystem = ${tomlInline(filesystem)} }`;
  return ["-c", 'default_permissions="agentswitch"', "-c", `permissions.agentswitch=${profile}`];
}

/** OPENCODE_CONFIG for one terminal: only the refusals of the managed executors' table (reads by path, commands by
 *  their text, writes and outside folders by path), on top of the user's own settings, which stay as they are. */
export function opencodeTerminalConfig(prot: ProtectedPaths, env: NodeJS.ProcessEnv): object {
  const d = protectedDeny(prot, env);
  const denied = (rules: Record<string, string>) => Object.fromEntries(Object.entries(rules).filter(([, v]) => v === "deny"));
  return { $schema: "https://opencode.ai/config.json", permission: { read: denied(d.read), bash: denied(d.bash), edit: denied(d.edit), external_directory: denied(d.external) } };
}
