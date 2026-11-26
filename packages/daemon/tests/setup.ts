/** Every test file (vitest.config.ts setupFiles): a real agent binary a test reaches must not write the user's own
 *  configuration — Codex writes hook trust into $CODEX_HOME/config.toml, and a Grok terminal started by the service
 *  has AgentSwitch's hook file written into $GROK_HOME/hooks (terminals/grokHooks.ts); an Antigravity terminal has a
 *  trusted folder written into its settings and AgentSwitch's MCP entry into its configuration, both under what
 *  AGENTSWITCH_AGY_HOME names in place of `~/.gemini` (sessions/agy.ts). */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "agentswitch-test-codex-home-"));
process.env.GROK_HOME = mkdtempSync(join(tmpdir(), "agentswitch-test-grok-home-"));
process.env.AGENTSWITCH_AGY_HOME = mkdtempSync(join(tmpdir(), "agentswitch-test-agy-home-"));
