/** Codex's hooks for AgentSwitch's terminals (docs/terminal-v0.md §3): the same events and answers as Claude Code's
 *  (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop), passed per terminal as `-c`
 *  flags. Codex runs a hook only once it is trusted, and trust cannot come from flags: it is its hash under
 *  `hooks.state."<key>".trusted_hash` in the user's ~/.codex/config.toml. With the user's say-so (2026-09-29, the one
 *  change AgentSwitch makes to that file) the service asks Codex itself — a disposable `codex app-server` with the same
 *  flags, no model call — which of these hooks are not trusted yet and has Codex write their hashes (`config/batchWrite`,
 *  which keeps the rest of the file as it is). A hash covers the exact definition: another command is not trusted by
 *  it. Until trust is confirmed, Codex terminals go without the hooks (no review screen) and their status is guessed. */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { AppServerClient, type Json } from "../harness/appserver.js";

export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"] as const;
/** Events about a tool take a matcher (every tool). */
const TOOL_EVENTS = new Set<string>(["PreToolUse", "PostToolUse", "PermissionRequest"]);

/** The `-c` flags that give a Codex session the hook command for every event (the permission hook waits for an
 *  answer up to `permissionTimeoutS`, the others `quickTimeoutS`). The same flags must go to the trust check and to the
 *  terminal: the hash Codex trusts is of this text. */
export function codexHookArgs(command: string, quickTimeoutS: number, permissionTimeoutS: number): string[] {
  return CODEX_HOOK_EVENTS.flatMap((event) => {
    const timeout = event === "PermissionRequest" ? permissionTimeoutS : quickTimeoutS;
    const matcher = TOOL_EVENTS.has(event) ? 'matcher="*",' : "";
    return ["-c", `hooks.${event}=[{${matcher}hooks=[{type="command",command=${JSON.stringify(command)},timeout=${timeout}}]}]`];
  });
}

export type CodexHookTrustOptions = {
  readonly binary: string;
  /** codexHookArgs(…) as the terminals get them. */
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
};

/** Whether the service's own Codex hooks are trusted, making them so once. */
export class CodexHookTrust {
  private state: "unknown" | "trusted" | "failed" = "unknown";
  private running: Promise<boolean> | null = null;
  private checkedAt = 0;
  /** A check stands this long; the next Codex terminal after it checks again (another AgentSwitch — a developer's
   *  copy — writes its own hashes under the same keys, and the user may edit the file). */
  static readonly FRESH_MS = 10 * 60_000;

  constructor(private readonly o: CodexHookTrustOptions) {}

  /** Trusted as far as this service knows (a failed or pending check is not). */
  get trusted(): boolean { return this.state === "trusted"; }

  /** Checks, and writes what is missing; a second call while one runs waits for it; a recent check stands. True when
   *  all are trusted. */
  ensure(now = Date.now()): Promise<boolean> {
    if (this.state === "trusted" && now - this.checkedAt < CodexHookTrust.FRESH_MS) return Promise.resolve(true);
    this.running ??= this.check().then(
      (ok) => { this.state = ok ? "trusted" : "failed"; this.checkedAt = Date.now(); return ok; },
      (err: Error) => { this.state = "failed"; (this.o.log ?? console.error)(`codex hooks: ${err.message}`); return false; },
    ).finally(() => { this.running = null; });
    return this.running;
  }

  private async check(): Promise<boolean> {
    const log = this.o.log ?? ((l: string) => console.error(l));
    const child = spawn(this.o.binary, [...this.o.args, "app-server"], { env: this.o.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], cwd: tmpdir() });
    const client = new AppServerClient(child.stdin, child.stdout, async () => ({ decision: "decline" }), () => undefined);
    const timeout = this.o.timeoutMs ?? 20_000;
    try {
      await client.request("initialize", { clientInfo: { name: "agentswitch", version: "1" } }, timeout);
      client.notify("initialized");
      const listed = await client.request("hooks/list", { cwds: [tmpdir()] }, timeout);
      const hooks = ((listed.data as Json[] | undefined)?.[0]?.hooks as Json[] | undefined ?? []).filter((h) => h.source === "sessionFlags");
      if (hooks.length !== CODEX_HOOK_EVENTS.length) throw new Error(`Codex lists ${hooks.length} of the ${CODEX_HOOK_EVENTS.length} hooks (too old for hooks?)`);
      const untrusted = hooks.filter((h) => h.trustStatus !== "trusted");
      if (!untrusted.length) return true;
      await client.request("config/batchWrite", {
        edits: untrusted.map((h) => ({ keyPath: `hooks.state.${JSON.stringify(String(h.key))}.trusted_hash`, value: String(h.currentHash), mergeStrategy: "replace" })),
      }, timeout);
      const again = await client.request("hooks/list", { cwds: [tmpdir()] }, timeout);
      const still = ((again.data as Json[] | undefined)?.[0]?.hooks as Json[] | undefined ?? []).filter((h) => h.source === "sessionFlags" && h.trustStatus !== "trusted");
      if (still.length) throw new Error(`${still.length} hooks still not trusted after writing their hashes`);
      log(`codex hooks: trusted ${untrusted.length} in the user's Codex config`);
      return true;
    } finally {
      client.fail(new Error("done"));
      child.kill("SIGKILL");
    }
  }
}
