import type { LaunchRequest } from "./host.js";

/** Separate launch credentials from the daemon and other profiles before explicit profile values are injected.
 *  An isolated profile keeps the user's own HOME (2026-11-15): what is its own is the config folder (`CLAUDE_CONFIG_DIR`,
 *  where Claude Code keeps settings, sessions and, by folder, its keychain entry) and the trimmed environment. A private
 *  HOME made it no safer (the keychain and the user's files are reachable by path anyway) but filled the profile with a
 *  second copy of every tool cache, hid the user's git/ssh setup, and raised macOS's "Keychain Not Found" dialog. */
export function profileEnvironment(source: Record<string, string>, req: Pick<LaunchRequest, "harness" | "configHome" | "isolated">): Record<string, string> {
  const env = { ...source };
  // Codex's profiles with a folder all their own (2026-11-22) start from the same few variables; its other profiles
  // from the service's own environment, as before.
  if (req.harness === "codex" ? !(req.configHome && req.isolated) : req.harness !== "claude-code" || !req.configHome) return env;
  if (req.harness === "claude-code") for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|AWS_|BEDROCK_|GOOGLE_|GCLOUD_|CLOUD_ML_|AZURE_|OPENAI_|CODEX_)/.test(key)) delete env[key];
  }
  if (req.isolated) {
    // Unknown provider tokens must not slip through a denylist. Only basic process/terminal variables survive.
    for (const key of Object.keys(env)) if (!/^(HOME|PATH|LANG|LC_[A-Z_]+|TERM|COLORTERM|TMPDIR|TMP|TEMP|USER|LOGNAME|SHELL|SYSTEMROOT|WINDIR)$/.test(key)) delete env[key];
  }
  return env;
}
