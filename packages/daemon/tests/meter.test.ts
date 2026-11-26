/** How full a terminal's context and the account's allowances are (terminals/meter.ts; user #599): Claude Code's status
 *  line read through AgentSwitch's own (hookClient.js `status`), the user's own still drawn; Codex's in its record. */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalHost, type Launcher, type TerminalEvent } from "../src/terminals/host.js";
import { HOOK_SCRIPT } from "../src/terminals/launch.js";
import { claudeMeter, claudeStatusLine, codexLimits, ownStatusLine, windowLabel } from "../src/terminals/meter.js";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-meter-")));

/** What Claude Code 2.1 hands its status line (the parts that matter, and some that must not cross). */
const SAID = {
  session_id: "s1", cwd: "/Users/you/proj", model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  context_window: { total_input_tokens: 90_000, context_window_size: 1_000_000, used_percentage: 28, remaining_percentage: 72,
    current_usage: { input_tokens: 2_000, output_tokens: 500, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 270_000 } },
  rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_795_600_000 }, seven_day: { used_percentage: 83.4, resets_at: 1_796_116_500 } },
  cost: { total_cost_usd: 1.5 },
};

/** Runs the hook program's `status` with `input` on stdin; what it printed, and what the stand-in service was told. */
async function runStatus(input: string, ownFile: string, service = true): Promise<{ out: string; told: { event: string; payload: Record<string, unknown> }[] }> {
  const told: { event: string; payload: Record<string, unknown> }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => { told.push(JSON.parse(Buffer.concat(parts).toString("utf8"))); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    // Not spawnSync: the stand-in server answers on this process's own loop.
    const out = await new Promise<string>((resolve, reject) => {
      const env = { ...process.env, ...(service ? { AGENTSWITCH_TERMINAL_URL: `http://127.0.0.1:${port}`, AGENTSWITCH_TERMINAL_ID: "t1", AGENTSWITCH_TERMINAL_HOOK_TOKEN: "tok" } : {}) };
      if (!service) { delete env.AGENTSWITCH_TERMINAL_URL; delete env.AGENTSWITCH_TERMINAL_ID; delete env.AGENTSWITCH_TERMINAL_HOOK_TOKEN; }
      const child = spawn(process.execPath, [HOOK_SCRIPT, "status", ownFile], { env, stdio: ["pipe", "pipe", "inherit"] });
      const parts: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => parts.push(c));
      child.on("error", reject);
      child.on("close", () => resolve(Buffer.concat(parts).toString("utf8")));
      child.stdin.end(input);
    });
    return { out, told };
  } finally { server.close(); }
}

describe("Claude Code's status line", () => {
  it("hands the service the context's and the allowances' numbers and nothing else, and draws the user's own line from the same input", async () => {
    const dir = temp();
    const seen = join(dir, "seen.json");
    // The user's own (claude-hud, say): reads the input, prints two coloured lines.
    writeFileSync(join(dir, "own.json"), JSON.stringify({ command: `cat > ${JSON.stringify(seen)}; printf '\\033[2mhud\\033[0m line 1\\nline 2'` }));
    const { out, told } = await runStatus(JSON.stringify(SAID), join(dir, "own.json"));
    expect(out).toBe("\u001b[2mhud\u001b[0m line 1\nline 2");
    expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual(SAID);
    expect(told).toHaveLength(1);
    expect(told[0]!.event).toBe("ClaudeMeter");
    const { at, ...rest } = told[0]!.payload;
    expect(typeof at).toBe("number");
    expect(rest).toEqual({
      context: { used_percentage: 28, size: 1_000_000, used: 280_000 },
      five_hour: { used_percentage: 12, resets_at: 1_795_600_000 }, seven_day: { used_percentage: 83.4, resets_at: 1_796_116_500 },
    });
    // What the service keeps of it.
    expect(claudeMeter(told[0]!.payload)).toEqual({
      context: { percent: 28, used: 280_000, window: 1_000_000 },
      limits: [{ label: "5h", percent: 12, resetsAt: 1_795_600_000_000 }, { label: "7d", percent: 83.4, resetsAt: 1_796_116_500_000 }], at,
    });
  });

  it("prints nothing where the user had no status line of their own, and still tells the service", async () => {
    const dir = temp();
    writeFileSync(join(dir, "own.json"), "{}");
    const { out, told } = await runStatus(JSON.stringify({ context_window: { context_window_size: 200_000, used_percentage: null, current_usage: null } }), join(dir, "own.json"));
    expect(out).toBe("");
    // Before the first answer there is no fill yet, and an API-key account has no allowances.
    expect(claudeMeter(told[0]!.payload)).toMatchObject({ context: null, limits: [] });
  });

  it("draws the user's own line outside AgentSwitch's service too, and with input that is not JSON", async () => {
    const dir = temp();
    writeFileSync(join(dir, "own.json"), JSON.stringify({ command: "echo own" }));
    expect((await runStatus(JSON.stringify(SAID), join(dir, "own.json"), false))).toEqual({ out: "own\n", told: [] });
    expect((await runStatus("not json", join(dir, "own.json"))).out).toBe("own\n");
  });

  it("is the nearest of the folder's local and shared settings and the user's, as Claude Code reads them", () => {
    const dir = temp(), cwd = join(dir, "proj"), config = join(dir, "config");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    mkdirSync(config);
    expect(ownStatusLine(cwd, config)).toBeNull();
    writeFileSync(join(config, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "hud", padding: 0 } }));
    expect(ownStatusLine(cwd, config)).toEqual({ type: "command", command: "hud", padding: 0 });
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "shared" } }));
    expect(ownStatusLine(cwd, config)).toMatchObject({ command: "shared" });
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ statusLine: { type: "command", command: "local" } }));
    expect(ownStatusLine(cwd, config)).toMatchObject({ command: "local" });
    // Started with `--setting-sources user`: the folder's are not read.
    expect(ownStatusLine(cwd, config, true)).toMatchObject({ command: "hud" });
    // A broken file is passed over.
    writeFileSync(join(cwd, ".claude", "settings.local.json"), "{");
    expect(ownStatusLine(cwd, config)).toMatchObject({ command: "shared" });
  });

  it("goes into the terminal's settings as ours, with the user's padding, theirs kept beside it", () => {
    const dir = temp(), file = join(dir, "statusline.json");
    expect(claudeStatusLine("\"node\" \"hook.js\"", file, { type: "command", command: "hud", padding: 2 })).toEqual({ type: "command", command: `"node" "hook.js" status "${file}"`, padding: 2 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ command: "hud" });
    expect(claudeStatusLine("\"node\" \"hook.js\"", file, null)).toEqual({ type: "command", command: `"node" "hook.js" status "${file}"` });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });
});

const FAKE = resolve(import.meta.dirname, "fixtures", "fakeTerminalAgent.mjs");
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });
const fakeLauncher: Launcher = (req) => ({
  file: process.execPath, args: [FAKE],
  env: { ...(process.env as Record<string, string>), FAKE_HOOK_SCRIPT: HOOK_SCRIPT, AGENTSWITCH_TERMINAL_ID: req.id, AGENTSWITCH_TERMINAL_URL: "http://127.0.0.1:9", AGENTSWITCH_TERMINAL_HOOK_TOKEN: req.hookToken },
  hooks: true,
});

describe("a terminal's meter", () => {
  it("is what Claude Code's status line said last: screens are told of a change, not of the same again, nor of an earlier reading that arrives late", async () => {
    const host = new TerminalHost({ launcher: fakeLauncher });
    closers.push(() => host.closeAll());
    const info = await host.spawn({ harness: "claude-code", cwd: tmpdir(), mode: "manual" });
    expect(info.meter).toBeNull();
    const token = (host as unknown as { sessions: Map<string, { hookToken: string }> }).sessions.get(info.id)!.hookToken;
    const told: TerminalEvent[] = [];
    host.subscribe(info.id, null, (e) => { if (e.type === "meter") told.push(e); });
    const says = (at: number, used: number) => host.hook(info.id, token, { event: "ClaudeMeter", payload: { at, context: { used_percentage: used, size: 1_000_000, used: used * 10_000 }, five_hour: { used_percentage: 12, resets_at: 1_795_600_000 }, seven_day: { used_percentage: 40, resets_at: 1_796_116_500 } } });
    await says(10, 28);
    await says(11, 28);
    await says(9, 5);
    expect(host.get(info.id)!.meter).toEqual({ context: { percent: 28, used: 280_000, window: 1_000_000 }, limits: [{ label: "5h", percent: 12, resetsAt: 1_795_600_000_000 }, { label: "7d", percent: 40, resetsAt: 1_796_116_500_000 }], at: 11 });
    await says(12, 30);
    expect(told.map((e) => e.type === "meter" ? e.meter.context?.percent : null)).toEqual([28, 30]);
  });
});

describe("Codex's allowances", () => {
  it("are its rate limits, named by their window, the shorter first", () => {
    expect(codexLimits({ primary: { used_percent: 8, window_minutes: 10080, resets_at: 1_796_116_500 }, secondary: null })).toEqual([{ label: "7d", percent: 8, resetsAt: 1_796_116_500_000 }]);
    expect(codexLimits({ primary: { used_percent: 40, window_minutes: 10080 }, secondary: { used_percent: 101, window_minutes: 300, resets_at: 1 } }).map((l) => [l.label, l.percent])).toEqual([["5h", 100], ["7d", 40]]);
    expect(codexLimits(null)).toEqual([]);
    expect([windowLabel(300), windowLabel(10080), windowLabel(90)]).toEqual(["5h", "7d", "90m"]);
  });
});
