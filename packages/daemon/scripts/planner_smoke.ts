/** Real-model smoke for loop-v0: the planner (targets.yaml router.planner) decides the first step of a multi-step
 *  task and then the step after a research result. Made-up task, sealed-looking tokens, no real site.
 *  Run from packages/daemon: npx tsx scripts/planner_smoke.ts */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plannerFor } from "../src/daemon.js";
import { nextAction } from "../src/router/loop.js";
import { loadTargets } from "../src/router/targets.js";

const targets = loadTargets(join(import.meta.dirname, "..", "config", "targets.yaml"));
// The router's pick comes from argv (harness/model), else targets.yaml's default.
const pickArg = process.argv[2];
const pick = pickArg ? { harness: pickArg.slice(0, pickArg.indexOf("/")), model: pickArg.slice(pickArg.indexOf("/") + 1) } : null;
const chosen = plannerFor(targets, undefined, () => ({}))(pick);
if (!chosen) throw new Error("no planner usable");
console.log(`planner: ${chosen.target.harness}/${chosen.target.model}`);
const planner = chosen.router;
const T = "enc:v1:" + "A".repeat(200);
const task = `把下面这个账号录进自建邮箱平台 http://mail.internal.example:8095/
${T}|${T}|2024|United States|${T}|${T}

[AgentSwitch sealed the credentials in this message. Each enc:v1: value is a secret-gate token standing for the field named here; use the token exactly where that field goes.]
Record layout: login email | password | birth year | country | app password | session key
- login email (for mail.internal.example:8095): ${T}
- account password (for mail.internal.example:8095): ${T}
- app password (for mail.internal.example:8095): ${T}
- session key (for mail.internal.example:8095): ${T}`;
const deps = { targets, router: planner, quota: {} };
const req = { task, cwd: mkdtempSync(join(tmpdir(), "planner-smoke-")), needsBrowser: true };   // spawn reports ENOENT for a missing cwd
const show = (label: string, r: Awaited<ReturnType<typeof nextAction>>) => {
  const a = r.action;
  console.log(`${label}: ${r.routerMs} ms, error=${r.routerError ?? "none"}`);
  if (!a) return;
  if (a.kind === "dispatch") console.log(`  dispatch [${a.decision.purpose}] ${a.decision.harness}/${a.decision.model} (verdict ${a.verdict.ok ? a.verdict.harness + "/" + a.verdict.model : "no target"})\n  reason: ${a.decision.reason}\n  brief: ${a.decision.brief.slice(0, 600)}`);
  else console.log(`  ${a.kind}: ${JSON.stringify(a).slice(0, 400)}`);
};
const first = await nextAction(planner, deps, { req, steps: [{ kind: "note", text: "The dispatcher triaged this as a multi-step task: the form's fields are unknown. Plan it from the start." }], used: 0, budget: 5, exclude: [] });
show("step 1", first);
const research = { kind: "dispatch" as const, purpose: "research" as const, harness: "codex", model: "gpt-5.6-luna", brief: "open the add-account page and list its fields", ok: true, failureKind: null,
  reply: "The add-account form at /accounts/new has: Email (required), Password (required), App password (optional, for IMAP), Region (dropdown: US/EU/Asia), Display name (optional). No session field. Submit button 'Add account'.", sideEffects: "files changed 0, commands 0, approvals 0", outFiles: [], diff: "" };
const second = await nextAction(planner, deps, { req, steps: [research], used: 1, budget: 5, exclude: [] });
show("step 2", second);
