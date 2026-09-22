/** Real-model smoke for the sealer (router-v0 §9): the router model marks a made-up password, the real gate mints.
 *  Run from packages/daemon: npx tsx scripts/sealer_smoke.ts   (needs the opencode binary and secret-gate). */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTargets } from "../src/router/targets.js";
import { defaultGate } from "../src/executors/gate.js";
import { opencodeRouter } from "../src/router/routers/opencode.js";
import { gateMinter } from "../src/secrets/minter.js";
import { routerSealer } from "../src/secrets/sealer.js";

const gate = defaultGate();
if (!gate) throw new Error("secret-gate not found");
const targets = loadTargets(join(import.meta.dirname, "..", "config", "targets.yaml"));
const router = opencodeRouter({ model: targets.router.model, agentName: "sealer", tools: "none", runIn: mkdtempSync(join(tmpdir(), "sealer-smoke-")) });
const seal = routerSealer(router, gateMinter(gate), () => ["core.internal.cworkspace.tech:8600"]);
const text = "登录财务系统 http://core.internal.cworkspace.tech:8600/ 账号 smoke-user 密码 Sm0ke-Pass-42! 然后导出九月报表";
const started = Date.now();
const r = await seal(text);
console.log(`sealer: ${Date.now() - started} ms`);
if (!r.ok) { console.log("refused:", r.code, r.error); process.exit(1); }
console.log("sealed text:", r.text);
console.log("entries:", JSON.stringify(r.sealed));
for (const token of r.text.match(/enc:v1:[A-Za-z0-9_=-]+/g) ?? []) {
  const check = spawnSync(gate.bin, ["check", token], { env: { ...process.env, SECRET_GATE_HOME: gate.home }, encoding: "utf8" });
  console.log("check:", check.stdout.trim().replace(/\n/g, " | "));
}
