/** Everything the console reads or edits besides tasks: approval policy, route preview, quota, catalog, routing
 *  log, CONTEXT.md, MEMORY.md, the track record. */

import type { Hono } from "hono";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { ApprovalPolicy, CATEGORIES, CATEGORY_TITLES, loadPolicy, savePolicy } from "../engine/approvalPolicy.js";
import { exampleContext, lintContext, loadContext } from "../router/context.js";
import { route } from "../router/route.js";
import { loadMemory } from "../threads/memory.js";
import { aggregateRecords, RECORD_WINDOW_MS } from "../threads/record.js";
import { checkCwd } from "./cwdPolicy.js";
import { issues, limitParam, type ApiDeps } from "./shared.js";
import { NewTaskBody } from "./tasks.js";

const ContextBody = z.object({ text: z.string() });

export function mountSettings(app: Hono, deps: ApiDeps): void {
  app.get("/healthz", (c) => c.json({ ok: true, version: deps.version, pendingApprovals: deps.store.pendingApprovals().length }));
  app.get("/approvals/policy", (c) => c.json({ policy: loadPolicy(deps.policyPath), categories: CATEGORIES.map((c2) => ({ id: c2, title: CATEGORY_TITLES[c2] })) }));
  app.put("/approvals/policy", async (c) => {
    const body = ApprovalPolicy.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    savePolicy(deps.policyPath, body.data);
    return c.json({ policy: body.data });
  });

  app.post("/route/preview", async (c) => {
    const body = NewTaskBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "task and cwd required" }, 400);
    const { pin, needs_browser, ephemeral: _e, parent_id: _p, cwd, ...rest } = body.data;
    if (!cwd) return c.json({ error: "cwd required for preview" }, 400);
    const cwdProblem = checkCwd(cwd, deps.cwdRules);
    if (cwdProblem) return c.json({ error: cwdProblem }, 400);
    const result = await route({ ...rest, cwd, ...(pin ? { pin } : {}), ...(needs_browser !== undefined ? { needsBrowser: needs_browser } : {}) }, deps.routeDeps());
    deps.routingLog.record(rest.task, cwd, result);
    return c.json(result);
  });

  app.get("/quota", async (c) => c.json(await deps.quota.refresh(c.req.query("refresh") === "1")));
  app.post("/quota/refresh", async (c) => c.json(await deps.quota.refresh(true)));

  app.get("/targets", (c) => c.json({ ...deps.targets, quota: deps.quota.map() }));
  app.get("/routing/log", (c) => c.json(deps.routingLog.recent(limitParam(c, 50))));

  app.get("/context/example", (c) => c.json({ text: exampleContext() }));
  app.get("/context", (c) => {
    const ctx = loadContext(deps.contextPath);
    return c.json({ path: deps.contextPath, text: ctx.text, warnings: ctx.warnings });
  });
  app.put("/context", async (c) => {
    const body = ContextBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "text required" }, 400);
    const lint = lintContext(body.data.text);
    writeFileSync(deps.contextPath, lint.text, { mode: 0o600 }); // the stripped lines never reach disk
    return c.json({ path: deps.contextPath, warnings: lint.warnings });
  });

  // MEMORY.md: facts the summarizer appended; same lint as CONTEXT.md, the user edits or clears it here.
  app.get("/memory", (c) => {
    const m = loadMemory(deps.memoryPath);
    return c.json({ path: deps.memoryPath, text: m.text, warnings: m.warnings });
  });
  app.put("/memory", async (c) => {
    const body = ContextBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "text required" }, 400);
    const lint = lintContext(body.data.text);
    writeFileSync(deps.memoryPath, lint.text, { mode: 0o600 });
    return c.json({ path: deps.memoryPath, warnings: lint.warnings });
  });
  app.get("/records", (c) => c.json(aggregateRecords(deps.store.recordsSince(Date.now() - RECORD_WINDOW_MS))));
}
