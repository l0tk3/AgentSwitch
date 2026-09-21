/** Real-model experiment: can `opencode run --standalone` continue a session with `--session <id>` in a
 *  later process, and where does the id show up in `--format json` output? deepseek-flash, a fraction of a cent.
 *    npx tsx scripts/opencode_resume_experiment.ts */

import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripProxy } from "../src/executors/gate.js";
import { opencodeExecConfig } from "../src/executors/opencode.js";

const binary = join(process.env.HOME ?? "", ".opencode", "bin", "opencode");
const model = "deepseek/deepseek-flash";
const word = `zebra-${Math.floor(1000 + Math.random() * 9000)}`;
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-ocres-")));
writeFileSync(join(cwd, "note.txt"), `${word}\n`);
const dir = mkdtempSync(join(tmpdir(), "agentswitch-ocres-cfg-"));
const configPath = join(dir, "opencode.json");
writeFileSync(configPath, JSON.stringify(opencodeExecConfig(null, join(dir, "profile"), false)));

type Run = { ms: number; exit: number | null; text: string; sessionIds: string[]; tools: string[]; keys: string[]; stderr: string };

function run(args: string[]): Promise<Run> {
  const started = Date.now();
  const env = { ...stripProxy(process.env), PWD: cwd, OPENCODE_CONFIG: configPath };
  return new Promise((resolve) => {
    const child = spawn(binary, ["run", "--standalone", "--format", "json", "-m", model, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    child.on("close", (exit) => {
      const text: string[] = []; const ids = new Set<string>(); const tools: string[] = []; const keys = new Set<string>();
      for (const line of out.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line); } catch { continue; }
        for (const k of Object.keys(ev)) keys.add(k);
        const walk = (v: unknown): void => {
          if (!v || typeof v !== "object") return;
          for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
            if (/session/i.test(k) && typeof x === "string") ids.add(`${k}=${x}`);
            walk(x);
          }
        };
        walk(ev);
        const part = ev.part as Record<string, unknown> | undefined;
        if (ev.type === "text" && typeof part?.text === "string") text.push(part.text);
        if (ev.type === "tool_use" && part) tools.push(String(part.tool));
      }
      resolve({ ms: Date.now() - started, exit, text: text.join(""), sessionIds: [...ids], tools, keys: [...keys], stderr: err.slice(0, 300) });
    });
  });
}

const first = await run(["Read note.txt in the working directory and reply with its exact content."]);
console.error(JSON.stringify({ first }, null, 2));
const id = first.sessionIds.map((s) => s.split("=")[1]!).find((s) => s.startsWith("ses"));
if (!id) { console.log(JSON.stringify({ ok: false, why: "no session id in json output", first })); process.exit(1); }
const second = await run(["--session", id, "Without reading any file, what word was in note.txt earlier in this conversation? Reply with only the word."]);
console.log(JSON.stringify({ ok: second.text.includes(word), word, sessionId: id, first: { ms: first.ms, text: first.text.trim().slice(0, 80), tools: first.tools }, second: { ms: second.ms, text: second.text.trim().slice(0, 80), tools: second.tools, sessionIds: second.sessionIds, exit: second.exit, stderr: second.stderr } }, null, 2));
process.exit(second.text.includes(word) ? 0 : 1);
