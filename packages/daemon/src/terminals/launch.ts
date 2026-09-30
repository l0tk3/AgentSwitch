/** How each agent starts in an AgentSwitch terminal (docs/terminal-v0.md §2–3): the service builds the command line
 *  (clients only name the agent, folder, model and a session to resume), the env carries the gate like the managed
 *  executors', and the hooks go into this terminal's own settings — the user's global agent configuration is never
 *  touched, so agents they start in iTerm are unaffected. */

import { codexHookArgs } from "./codexHooks.js";
import { OpenCodeCompanion } from "./opencodeTerminal.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeMcpServers, gateEnv, withoutCredentialRepair, type GateOptions } from "../executors/gate.js";
import { protectedDeny } from "../executors/opencodeShared.js";
import type { ProtectedPaths } from "../executors/protected.js";
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
};

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
  const deny = prot ? [...new Set([...(prot.readDenied ?? []).flatMap((p) => rule("Read", p)), ...prot.roots.flatMap((p) => rule("Edit", p))])] : [];
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
    switch (req.harness) {
      case "claude-code": {
        const settings = join(dir, "settings.json");
        writeFileSync(settings, JSON.stringify(claudeHookSettings(hookCommand, opts.protected), null, 2), { mode: 0o600 });
        const args = ["--settings", settings];
        if (opts.gate) {
          const mcp = join(dir, "mcp.json");
          writeFileSync(mcp, JSON.stringify({ mcpServers: claudeMcpServers(opts.gate, join(dir, "profile"), false) }, null, 2), { mode: 0o600 });
          args.push("--mcp-config", mcp);
        }
        if (req.model) args.push("--model", req.model);
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
        if (req.model) args.push("-m", req.model);
        if (req.mode === "bypass") args.push("--dangerously-bypass-approvals-and-sandbox");
        // Asking is stated, not left to config.toml (which may never ask): it asks before anything outside the sandbox.
        // With the hooks, the read-denied paths are the PreToolUse floor's (as for Claude Code), not the profile's: Codex
        // never lifts a deny entry, so with one an approved "outside the sandbox" still runs sandboxed, where no setuid
        // program (ps, top, sudo, ping) can start.
        else args.push("-a", "on-request", ...codexPermissions(req.mode === "auto" ? ":workspace" : ":read-only", opts.protected, { denyReads: !hooked }));
        // `resume` goes on in the same conversation (Codex locks it against a second writer); `fork` starts a new one.
        if (req.resume) args.unshift(req.fork ? "fork" : "resume", req.resume);
        return { file, args, env: own, hooks: hooked };
      }
      case "opencode": {
        // A private server — the service's own, which it watches (opencodeTerminal.ts), else the TUI's `--standalone` one:
        // by default OpenCode 2 runs the session in the user's shared background service, where this terminal's
        // environment (its config, the gate) never arrives.
        const rest = req.model ? ["-m", req.model] : [];
        if (req.mode !== "manual") rest.push("--auto");   // OpenCode has one switch: approve what is not denied
        if (req.resume) rest.push("--session", req.resume);   // OpenCode cannot fork: always the same session
        let own = env;
        if (opts.protected) {
          const config = join(dir, "opencode.json");
          writeFileSync(config, JSON.stringify(opencodeTerminalConfig(opts.protected, env), null, 2), { mode: 0o600 });
          own = { ...env, OPENCODE_CONFIG: config };
        }
        const companion = opts.opencodeServer ? new OpenCodeCompanion({ binary: file, cwd: req.cwd, env: own, args: rest, asks: req.mode === "manual" }) : undefined;
        return { file, args: ["--standalone", ...rest], env: own, hooks: false, ...(companion ? { companion } : {}) };
      }
      case "pi": {
        const args = ["--extension", opts.piExtension ?? PI_EXTENSION];
        if (req.model) args.push("--model", req.model);
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
  for (const p of prot?.roots ?? []) filesystem[p] = "read";
  if (o.denyReads ?? true) for (const p of prot?.readDenied ?? []) filesystem[p] = "deny";
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
