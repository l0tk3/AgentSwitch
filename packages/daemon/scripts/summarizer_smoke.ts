/** One real summarizer call through the OpenCode router agent (DeepSeek Flash): does it return the
 *  Summary shape with facts? Costs a fraction of a cent.   npx tsx scripts/summarizer_smoke.ts */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeRouter } from "../src/router/routers/opencode.js";
import { loadTargets } from "../src/router/targets.js";
import { routerSummarizer } from "../src/threads/summary.js";

const HERE = new URL(".", import.meta.url).pathname;
const targets = loadTargets(join(HERE, "..", "config", "targets.yaml"));
const summarize = routerSummarizer(opencodeRouter({ model: targets.router.model, agentName: "summarizer", tools: "none", runIn: tmpdir() }), 45_000);
const r = await summarize({
  previous: null, cwd: process.cwd(), target: "claude-code/claude-haiku-4-5-20251001", status: "done",
  task: "登录 core 控制台（http://core.internal.example:8400/，账号 alice@example.com，密码 enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAA）看首页标题",
  brief: "Log in to the core console with the given enc:v1: credentials via secret_fill and report the home page title.",
  result: "The login form is a React controlled form; browser_type did not register the value, secret_fill did. After login the title is \"MailLab\". Note: the page takes ~8 s to render after submit.",
  diff: "",
});
console.log(JSON.stringify(r, null, 2));
process.exit(r.summary ? 0 : 1);
