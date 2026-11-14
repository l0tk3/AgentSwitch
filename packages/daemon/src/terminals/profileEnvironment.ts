import { join } from "node:path";
import type { LaunchRequest } from "./host.js";

/** Separate launch credentials from the daemon and other profiles before explicit profile values are injected. */
export function profileEnvironment(source: Record<string, string>, req: Pick<LaunchRequest, "harness" | "configHome" | "isolated">): Record<string, string> {
  const env = { ...source };
  if (req.harness !== "claude-code" || !req.configHome) return env;
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|AWS_|BEDROCK_|GOOGLE_|GCLOUD_|CLOUD_ML_|AZURE_|OPENAI_|CODEX_)/.test(key)) delete env[key];
  }
  if (req.isolated) {
    // Unknown provider tokens must not slip through a denylist. Only basic process/terminal variables survive.
    for (const key of Object.keys(env)) if (!/^(PATH|LANG|LC_[A-Z_]+|TERM|COLORTERM|TMPDIR|TMP|TEMP|USER|LOGNAME|SHELL|SYSTEMROOT|WINDIR)$/.test(key)) delete env[key];
    env.HOME = join(req.configHome, "..", "system-home");
    env.XDG_CONFIG_HOME = join(env.HOME, ".config");
    env.XDG_CACHE_HOME = join(env.HOME, ".cache");
    env.XDG_DATA_HOME = join(env.HOME, ".local", "share");
    env.XDG_STATE_HOME = join(env.HOME, ".local", "state");
  }
  return env;
}

