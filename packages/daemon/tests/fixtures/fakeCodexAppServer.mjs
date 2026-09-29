#!/usr/bin/env node
// A stand-in for `codex -c <hooks…> app-server` (codexHooks.test.ts): answers initialize, hooks/list and
// config/batchWrite over JSON lines. The hooks are the -c flags it was given; their trust lives in FAKE_CODEX_STATE (a
// JSON file of key → trusted hash). FAKE_CODEX_MODE=old lists no hooks (a Codex without them).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const flags = [];
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === "-c") flags.push(process.argv[++i]);
const statePath = process.env.FAKE_CODEX_STATE;
const state = () => (statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {});
const snake = (e) => e.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase());
const hooks = () => (process.env.FAKE_CODEX_MODE === "old" ? [] : flags.filter((f) => f.startsWith("hooks.")).map((f) => {
  const event = f.slice("hooks.".length, f.indexOf("="));
  const key = `/<session-flags>/config.toml:${snake(event)}:0:0`;
  const currentHash = "sha256:" + createHash("sha256").update(f).digest("hex");
  const trusted = state()[key];
  return { key, eventName: event, source: "sessionFlags", currentHash, trustStatus: trusted === currentHash ? "trusted" : trusted ? "modified" : "untrusted" };
}));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  else if (m.method === "hooks/list") send({ id: m.id, result: { data: [{ cwd: m.params.cwds[0], hooks: hooks(), warnings: [], errors: [] }] } });
  else if (m.method === "config/batchWrite") {
    const s = state();
    for (const e of m.params.edits) {
      const key = /^hooks\.state\.("[^"]+")\.trusted_hash$/.exec(e.keyPath)?.[1];
      if (key) s[JSON.parse(key)] = e.value;
    }
    writeFileSync(statePath, JSON.stringify(s));
    send({ id: m.id, result: { status: "ok" } });
  }
});
