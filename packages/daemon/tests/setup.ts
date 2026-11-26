/** Every test file (vitest.config.ts setupFiles): a real agent binary a test reaches must not write the user's own
 *  configuration — Codex writes hook trust into $CODEX_HOME/config.toml, and a Grok terminal started by the service
 *  has AgentSwitch's hook file written into $GROK_HOME/hooks (terminals/grokHooks.ts). */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "agentswitch-test-codex-home-"));
process.env.GROK_HOME = mkdtempSync(join(tmpdir(), "agentswitch-test-grok-home-"));
