/** The real Agent SDK (not mocked) spawning a fake Claude Code executable that records its argv: the execution scope,
 *  the repair key and the transfer grant must never be in argv (`ps -ww` shows argv to every local user); the MCP
 *  config reaches the CLI as a 0600 file path instead, and the file is gone after the run. No model is called. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeExecutor } from "../src/executors/claude.js";
import type { GateOptions } from "../src/executors/gate.js";
import type { ExecutionInput } from "../src/executors/types.js";
import type { TransferGrant } from "../src/core/transfer.js";

const scope = "ArgvScope_0123456789-abcdefghijk";
const repairKey = "argv-repair-key-0123456789";
const transfer: TransferGrant = { source: ["crm.example.com"], destination: ["erp.example.com:8443"], fields: ["email"], purpose: "argv-fixture-purpose" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Seen = { argv: string[]; mcpFile: string | null; mode: number | null; mcp: string | null };

describe("Claude executor argv (real Agent SDK, fake CLI)", () => {
  it("keeps the scope, the repair key and the grant out of argv; the config file is private and removed afterwards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-argv-")); dirs.push(dir);
    const out = join(dir, "seen.json");
    const cli = join(dir, "fake-claude");
    writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
const i = argv.indexOf('--mcp-config');
const file = i >= 0 ? argv[i + 1] : null;
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv, mcpFile: file, mode: file && fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : null, mcp: file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }));
process.exit(1);
`, { mode: 0o700 });
    const gate: GateOptions = { bin: "/g/secret-gate", home: join(dir, "gate-home"), proxy: "http://127.0.0.1:8080", playwrightVersion: "0.0.82", allowedOrigins: [] };
    const input: ExecutionInput = { taskId: "argv", task: "copy the contact", brief: "copy the contact", cwd: dir, model: "fixture-model", effort: null,
      handoffNote: null, context: null, knownTokens: new Set(), threadHome: null, resume: null, attachments: [], browser: true,
      gateScope: scope, transfer, credentialRepair: { url: "http://127.0.0.1:5555/credential-repair", key: repairKey },
      signal: new AbortController().signal, emit: () => undefined, approve: async () => "deny", ask: async () => null };
    const outcome = await claudeExecutor({ gate, executable: cli, maxMs: 20_000 }).run(input);
    expect(outcome.ok).toBe(false);   // the fake CLI exits at once
    const seen = JSON.parse(readFileSync(out, "utf8")) as Seen;
    const argv = seen.argv.join(" ");
    for (const secret of [scope, repairKey, transfer.purpose, "SECRET_GATE_SCOPE", "SECRET_GATE_REPAIR_KEY", "SECRET_GATE_TRANSFER"]) expect(argv).not.toContain(secret);
    expect(seen.mcpFile).toMatch(/agentswitch-claude-[^/]+\/mcp\.json$/);
    expect(seen.mode).toBe(0o600);
    const config = JSON.parse(seen.mcp!) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(config.mcpServers["secret-gate"]!.env).toMatchObject({ SECRET_GATE_SCOPE: scope, SECRET_GATE_REPAIR_KEY: repairKey });
    expect(JSON.parse(config.mcpServers.playwright!.env.SECRET_GATE_TRANSFER!)).toEqual(transfer);
    expect(existsSync(seen.mcpFile!)).toBe(false);
  }, 30_000);
});
