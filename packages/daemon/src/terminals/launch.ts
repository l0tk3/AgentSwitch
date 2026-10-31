/** How each agent starts in an AgentSwitch terminal (docs/terminal-v0.md §2–3): the service builds the command line
 *  (clients only name the agent, folder, model and a session to resume), the env carries the gate like the managed
 *  executors', and the hooks go into this terminal's own settings — the user's global agent configuration is never
 *  touched, so agents they start in iTerm are unaffected. */

import { effortArgs } from "../harness/efforts.js";
import { codexHookArgs } from "./codexHooks.js";
import { CodexCompanion } from "./codexTerminal.js";
import { CODEX_DAYBREAK_FEATURE } from "../harness/codexFeatures.js";
import { OpenCodeCompanion } from "./opencodeTerminal.js";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { which } from "../util/which.js";
import { fileURLToPath } from "node:url";
import { withoutCredentialRepair } from "../executors/gate.js";
import { CODEX_FILE_STORE } from "./signIn.js";
import { protectedDeny } from "../executors/opencodeShared.js";
import { rootSpellings, type ProtectedPaths } from "../executors/protected.js";
import type { Companion, LaunchPlan, LaunchRequest, Launcher, TerminalHarness } from "./host.js";
import type { Holding } from "./held.js";

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
   *  trusts them (codexHooks.ts) — in the folder it runs in: a profile's (`home`) or the Mac's own; until then it goes
   *  without and its status is guessed. */
  readonly codexHooks?: (home?: string) => boolean;
  /** OpenCode's TUI attaches to a private server the service starts and watches (status, permission requests;
   *  opencodeTerminal.ts); without it, or when that server does not start, it runs `--standalone` and its status is
   *  guessed. */
  readonly opencodeServer?: boolean;
  /** Codex's TUI attaches to a private app-server the service starts (codexTerminal.ts), so a screen can set its
   *  model and reasoning effort. Without it, or when that server does not start, Codex runs on its own as before. */
  readonly codexServer?: boolean;
  /** Codex has its Daybreak switch here (its program knows the feature, the account has the program;
   *  router/modelOffers.ts): a terminal is started with the feature enabled, for that terminal alone
   *  (docs/simple-view-v0.md §5.8). */
  readonly codexDaybreak?: () => boolean;
  /** The shared browser for the agent (docs/browser-v0.md §2 给 agent, terminal-v0 §3): the agent bridge's command for
   *  terminal `id`, made when it starts (a session of its own). It is the `browser` MCP server as it is: a terminal is
   *  not behind the credential gate (docs/profiles-v0.md §8, 2026-10-08), so its agent sees a page as the page is.
   *  Codex, Claude Code and OpenCode; absent or null: no browser tool. */
  readonly browser?: (req: { readonly id: string; readonly harness: TerminalHarness; readonly cwd: string; /** The profile's own browser rather than the shared one (docs/profiles-v0.md §5.1). */ readonly browserKey?: string }) => BridgeCommand | null;
  /** Terminals that outlive the service (docs/terminal-v0.md §10): companions' servers run on held ptys too. */
  readonly holding?: Holding | null;
};

/** The bridge's command line; with the session it was made for, which a held terminal keeps for the next daemon. */
export type BridgeCommand = readonly string[] & { readonly minted?: { readonly session: string; readonly token: string; readonly key?: string } };

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

/** The browser tool as an MCP server: the agent bridge itself (browser/agents.ts), which carries MCP to the service.
 *  Until 2026-10-08 the gate stood in front (`secret-gate browser -- <the bridge>`); Dispatch's tasks still have it. */
export type BrowserServer = { readonly command: string; readonly args: readonly string[]; readonly env: Record<string, string> };

export function browserServer(bridge: readonly string[]): BrowserServer | null {
  const [command, ...args] = bridge;
  return command ? { command, args, env: {} } : null;
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

/** OpenAI's own address, where a key goes when the profile names no other (profiles/store.ts `API_HOME`). */
const OPENAI_API = "https://api.openai.com/v1";
/** Codex's own name for the provider a profile that pays by a key is: in its configuration for this terminal alone. */
export const CODEX_KEY_PROVIDER = "agentswitch";

/** Codex started on a profile that pays by a key (docs/profiles-v0.md §3.6): a provider of this terminal's own — the
 *  address, and a command Codex runs for the key (the hook program's `key`, which asks this service) — chosen over
 *  whatever the folder it runs in is signed in to. Seen on Codex 0.163 (scripts/api_key_probe.ts). */
export function codexKeyProviderArgs(node: string, script: string, api: { readonly name: string; readonly baseUrl?: string }): string[] {
  const provider = `{ name = ${JSON.stringify(api.name)}, base_url = ${JSON.stringify(api.baseUrl ?? OPENAI_API)}, wire_api = "responses", auth = { command = ${JSON.stringify(node)}, args = ${JSON.stringify([script, "key"])} } }`;
  return ["-c", `model_provider=${JSON.stringify(CODEX_KEY_PROVIDER)}`, "-c", `model_providers.${CODEX_KEY_PROVIDER}=${provider}`];
}

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
/** `open` and `BROWSER` for a terminal whose profile has a browser of its own: a small program put first on the PATH
 *  under the name `open` (what Claude Code calls to show a page on macOS; `xdg-open` elsewhere) and named as `BROWSER`
 *  (what other tools call). Given a web address and nothing else to do with it, it asks this service to open the address
 *  in the profile's browser; anything else it hands to the system's own opener. If the service does not take the
 *  address it fails, saying so — it does not fall back to the user's browser. */
export function openInProfileBrowser(dir: string, path: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const bin = join(dir, "bin"), file = join(bin, "open");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  // The system's own opener, found before this folder joins the PATH (the shim would otherwise call itself).
  const system = platform === "darwin" ? "/usr/bin/open" : which("xdg-open", path);
  const other = system ? `exec ${shq(system)} "$@"` : `echo "AgentSwitch: no program here opens $*." >&2; exit 1`;
  writeFileSync(file, `#!/bin/sh
# AgentSwitch: a web address is opened in this terminal's profile's own browser (docs/profiles-v0.md §5.1).
url=""
for a in "$@"; do
  case "$a" in
    http://*|https://*) url="$a" ;;
    -*) ;;
    *) ${other} ;;
  esac
done
[ -n "$url" ] || { ${other} ; }
# As JSON: the service's local listener takes no other body (api/localGuard.ts). Asked of this machine itself, whatever
# proxy this terminal has.
esc=$(printf '%s' "$url" | /usr/bin/sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')
code=$(/usr/bin/curl -s -m 40 --noproxy '*' -o /dev/null -w '%{http_code}' -X POST "$AGENTSWITCH_TERMINAL_URL/terminals/open" \\
  -H "content-type: application/json" -H "x-agentswitch-terminal: $AGENTSWITCH_TERMINAL_ID" -H "authorization: Bearer $AGENTSWITCH_TERMINAL_HOOK_TOKEN" \\
  --data-binary "{\\"url\\":\\"$esc\\"}")
[ "$code" = "200" ] && exit 0
echo "AgentSwitch: this address was not opened in the profile's browser ($code). Open it yourself in a browser that leaves this machine the same way." >&2
exit 1
`, { mode: 0o755 });
  if (platform !== "darwin") { rmSync(join(bin, "xdg-open"), { force: true }); symlinkSync("open", join(bin, "xdg-open")); }
  return { PATH: `${bin}:${path}`, BROWSER: file };
}

/** The environment that sends a process's traffic through `proxy`, in both spellings tools read; what is on this
 *  Mac goes straight. */
export function proxyEnv(proxy: string): Record<string, string> {
  const local = "127.0.0.1,localhost,::1";
  return { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, all_proxy: proxy, NO_PROXY: local, no_proxy: local };
}

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
  // A held terminal's companion server is held too, next to the terminal's own holder (docs/terminal-v0.md §10).
  const heldServer = (dir: string, id: string) => (opts.holding ? { held: { holding: opts.holding, socket: join(dir, "serve.sock"), unit: `agentswitch-term-${id}-serve` } } : {});
  // The browser session made for the plan being made (a launch is synchronous).
  let minted: BridgeCommand["minted"] | null = null;
  const plans = (req: LaunchRequest): LaunchPlan => {
    const file = opts.binaries[req.harness];
    if (!file) throw new Error(`${req.harness} is not installed on this Mac`);
    const dir = join(opts.stateDir, req.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A terminal is a terminal: the agent and what it runs have the service's own environment and this terminal's
    // three variables — no proxy and no certificate of the credential gate, none of its tools (docs/profiles-v0.md §8,
    // 2026-10-08: the gate stays in Dispatch). What stays closed is the credentials at rest (`protected`).
    const env: Record<string, string> = {
      ...withoutParentSession(withoutCredentialRepair(opts.env ?? process.env)),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      AGENTSWITCH_TERMINAL_ID: req.id,
      AGENTSWITCH_TERMINAL_URL: opts.hookUrl(),
      AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken,
    };
    // A profile with a proxy of its own (docs/profiles-v0.md §4): what the agent and the commands it runs send
    // leaves through it. What stays on this Mac — the hook, the browser bridge, a local server — does not.
    const proxied = req.proxy ? proxyEnv(req.proxy) : null;
    if (proxied) Object.assign(env, proxied);
    const bridge = opts.browser && BROWSER_HARNESSES.has(req.harness) ? opts.browser({ id: req.id, harness: req.harness, cwd: req.cwd, ...(req.browserKey ? { browserKey: req.browserKey } : {}) }) : null;
    minted = bridge?.minted ?? null;
    // A profile with a browser of its own: a web address the agent asks the system to open — its sign-in page — is
    // opened there, not in the user's own browser, which leaves this Mac another way (§5.1).
    if (req.browserKey) Object.assign(env, openInProfileBrowser(dir, env.PATH ?? ""));
    const browser = bridge ? browserServer(bridge) : null;
    switch (req.harness) {
      case "claude-code": {
        // A profile other than the Mac's own: its sign-in and its identifiers are in a folder of its own.
        if (req.configHome) env.CLAUDE_CONFIG_DIR = req.configHome;
        const settings = join(dir, "settings.json");
        // In the settings laid over the user's too: an `env` of the user's own settings would win over the process's.
        // A profile that pays by a key (§3.6): Claude Code runs the hook program for it (`apiKeyHelper`, sent as both
        // `x-api-key` and `Authorization`), and is told where to send it when that is not Anthropic's own address.
        const keyed = req.api ? { apiKeyHelper: `${hookCommand} key` } : {};
        // A profile with its telemetry off (§3.7): in both, for the same reason.
        const quiet = req.telemetryOff ? { DISABLE_TELEMETRY: "1" } : {};
        Object.assign(env, quiet);
        const own = { ...proxied, ...quiet, ...(req.api?.baseUrl ? { ANTHROPIC_BASE_URL: req.api.baseUrl } : {}) };
        writeFileSync(settings, JSON.stringify({ ...claudeHookSettings(hookCommand, opts.protected), ...keyed, ...(Object.keys(own).length ? { env: own } : {}) }, null, 2), { mode: 0o600 });
        const args = ["--settings", settings];
        if (browser) {
          const mcp = join(dir, "mcp.json");
          writeFileSync(mcp, JSON.stringify({ mcpServers: { [BROWSER_SERVER]: { type: "stdio", ...browser } } }, null, 2), { mode: 0o600 });
          args.push("--mcp-config", mcp);
        }
        if (browser) args.push("--append-system-prompt", BROWSER_GUIDANCE);
        if (req.model ?? req.api?.model) args.push("--model", (req.model ?? req.api?.model)!);
        args.push(...effortArgs("claude-code", req.effort, req.model).args);
        args.push(...(req.mode === "bypass" ? ["--dangerously-skip-permissions"] : ["--permission-mode", req.mode]));
        // As in iTerm: ⇧Tab can reach bypass later. Only for terminals started on the Mac (not from a paired phone).
        if (req.mode !== "bypass" && req.allowBypass) args.push("--allow-dangerously-skip-permissions");
        // The same session goes on (one record, docs/terminal-v0.md §5); a fork is a new session with the whole history.
        if (req.resume) args.push("--resume", req.resume, ...(req.fork ? ["--fork-session"] : []));
        // Its first input, as if typed: `/login` where nobody is signed in (it opens at the sign-in's choices).
        if (req.signIn) args.push("/login");
        return { file, args, env, hooks: true };
      }
      case "codex": {
        // A profile that signs in with an account (docs/profiles-v0.md §6.2): a folder of its own, its sign-in kept in
        // a file there, and OpenAI's own provider whatever the user's config.toml (linked in) names.
        if (req.configHome) env.CODEX_HOME = req.configHome;
        // `notify` runs a program with the event JSON as its last argument when a turn ends.
        const args = [...(req.configHome ? [...CODEX_FILE_STORE, "-c", 'model_provider="openai"'] : []), "-c", `notify=${JSON.stringify([node, script, "codex"])}`];
        const hooked = opts.codexHooks?.(req.configHome) ?? false;
        if (hooked) args.push(...codexHookArgs(hookCommand, QUICK_HOOK_TIMEOUT_S, PERMISSION_HOOK_TIMEOUT_S));
        // Codex's own "needs you" notifications, as terminal notifications (OSC 9) whether or not its window has focus:
        // the host reads them as waiting. They cover what no hook does (an app tool's approval form, a question).
        args.push(...CODEX_ATTENTION);
        if (browser) args.push(...codexBrowserArgs(browser));
        if (browser && !codexHasOwnInstructions(env)) args.push("-c", `developer_instructions=${JSON.stringify(BROWSER_GUIDANCE)}`);
        // Its Daybreak switch, where it has one: the feature it is kept under is off unless enabled (0.162), and
        // without it `/daybreak` is no command and the user's own default does nothing. For this terminal alone.
        const daybreak = opts.codexDaybreak?.() ?? false;
        if (daybreak) args.push("-c", `features.${CODEX_DAYBREAK_FEATURE}=true`);
        if (req.api) args.push(...codexKeyProviderArgs(node, script, req.api));
        if (req.model ?? req.api?.model) args.push("-m", (req.model ?? req.api?.model)!);
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
        // Nobody signed in to its profile: Codex's device-code sign-in first, in the same terminal, then Codex itself
        // (the same process: `exec`). Its sign-in page opens in the profile's own browser, which leaves this Mac as the
        // agent will; the code to type there is on the terminal's screen. Not Codex's own first screen: its `Sign in
        // with ChatGPT` opens the system's browser, past the `open` above (seen on 0.163).
        if (req.signIn) {
          return { file: "/bin/sh", args: ["-c", CODEX_SIGN_IN, "agentswitch-codex-sign-in", file, ...args], hooks: hooked,
            env: { ...env, ...(req.browserKey ? { AGENTSWITCH_SIGN_IN_PAGE: CODEX_DEVICE_PAGE } : {}) } };
        }
        const companion = opts.codexServer ? new CodexCompanion({ binary: file, cwd: req.cwd, env, args, dir, daybreak, ...heldServer(dir, req.id) }) : undefined;
        return { file, args, env, hooks: hooked, ...(companion ? { companion } : {}) };
      }
      case "opencode": {
        // A private server — the service's own, which it watches (opencodeTerminal.ts), else the TUI's `--standalone` one:
        // by default OpenCode 2 runs the session in the user's shared background service, where this terminal's
        // environment (its config, the gate) never arrives.
        // A variant is part of the model's name (`provider/model#variant`): none without a model.
        const named = effortArgs("opencode", req.effort, req.model).model;
        const rest: string[] = [];
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
        // The model is configuration, not a flag: the main command of OpenCode 2.0.25 takes no `-m` (it prints its usage
        // and exits; `run` and `mini` still do). `model` in OPENCODE_CONFIG_CONTENT is what the TUI opens on, above the
        // folder's own `opencode.json` as the flag was — in the OPENCODE_CONFIG file it would be below it
        // (scripts/opencode_model_probe.ts). What the user's own environment had there stays, but for its model.
        if (named) own = { ...own, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...inlineConfig(own.OPENCODE_CONFIG_CONTENT), model: named }) };
        // A session gone on with keeps the model it was on, whatever the configuration names: the companion sets it there.
        const onto = req.resume && req.model ? { model: req.model, variant: named && named !== req.model ? named.slice(req.model.length + 1) : null } : null;
        const companion = opts.opencodeServer ? new OpenCodeCompanion({ binary: file, cwd: req.cwd, env: own, args: rest, asks: req.mode === "manual", ...(onto ? { model: onto } : {}), ...heldServer(dir, req.id) }) : undefined;
        return { file, args: ["--standalone", ...rest], env: own, hooks: false, ...(companion ? { companion } : {}) };
      }
      case "pi": {
        const args = ["--extension", opts.piExtension ?? PI_EXTENSION];
        if (req.model) args.push("--model", req.model);
        args.push(...effortArgs("pi", req.effort, req.model).args);
        // The same session goes on (docs/terminal-v0.md §5): pi keeps a folder's sessions under that folder and, started
        // there, opens the one with this id. Started in another folder it would find it and ask, in the terminal,
        // whether to fork it (the service asks for the fork itself then, api/terminals.ts). A fork is a new session
        // under the terminal's folder with the whole history; pi finds its source under any folder.
        if (req.resume) args.push(req.fork ? "--fork" : "--session", req.resume);
        return { file, args, env, hooks: true };
      }
    }
  };
  return (req: LaunchRequest): LaunchPlan => {
    minted = null;
    const plan = plans(req);
    return minted ? { ...plan, browser: minted } : plan;
  };
}

/** A TOML inline table of strings (a `-c` value). JSON's string escapes are TOML's. */
const tomlInline = (table: Record<string, string>): string => {
  const pairs = Object.entries(table).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return pairs.length ? `{ ${pairs.join(", ")} }` : "{}";
};

/** Where Codex's device-code sign-in is finished: the page asks for the account, then for the code Codex shows. */
export const CODEX_DEVICE_PAGE = "https://auth.openai.com/codex/device";

/** `sh -c` for a Codex terminal whose profile nobody is signed in to: `$1` is Codex, the rest its arguments. The page
 *  goes to the profile's browser through the terminal's `BROWSER` (openInProfileBrowser), when it has one. A sign-in
 *  that does not finish ends the terminal, saying so: Codex's own first screen would offer the system's browser. */
export const CODEX_SIGN_IN = `codex="$1"; shift
if [ -n "$AGENTSWITCH_SIGN_IN_PAGE" ]; then "$BROWSER" "$AGENTSWITCH_SIGN_IN_PAGE" >/dev/null 2>&1 & fi
"$codex" -c 'cli_auth_credentials_store="file"' login --device-auth || { printf '\\n%s\\n' "AgentSwitch：没有登录上。关掉这个终端，在这个配置名下再开一个，会重新开始登录。" >&2; exit 1; }
exec "$codex" "$@"`;

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

/** OpenCode's inline configuration (OPENCODE_CONFIG_CONTENT) as an object; nothing where it is not one. */
function inlineConfig(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** OPENCODE_CONFIG for one terminal: only the refusals of the managed executors' table (reads by path, commands by
 *  their text, writes and outside folders by path), on top of the user's own settings, which stay as they are. */
export function opencodeTerminalConfig(prot: ProtectedPaths, env: NodeJS.ProcessEnv): object {
  const d = protectedDeny(prot, env);
  const denied = (rules: Record<string, string>) => Object.fromEntries(Object.entries(rules).filter(([, v]) => v === "deny"));
  return { $schema: "https://opencode.ai/config.json", permission: { read: denied(d.read), bash: denied(d.bash), edit: denied(d.edit), external_directory: denied(d.external) } };
}

/** A held terminal's companion again (docs/terminal-v0.md §10), from what it kept: its server still runs on its own
 *  holder. Null for what this version does not know. */
export function restoreCompanion(harness: TerminalHarness, kept: Record<string, unknown>, _holding: Holding | null): Companion | null {
  if (harness === "opencode" && kept.kind === "opencode") return OpenCodeCompanion.restore(kept);
  if (harness === "codex" && kept.kind === "codex") return CodexCompanion.restore(kept);
  return null;
}
