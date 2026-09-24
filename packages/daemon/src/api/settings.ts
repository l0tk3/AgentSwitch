/** Everything the console reads or edits besides tasks: approval policy, route preview, quota, catalog, routing
 *  log, CONTEXT.md, MEMORY.md, the track record. */

import type { Hono } from "hono";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { ApprovalPolicy, CATEGORIES, CATEGORY_TITLES, loadPolicy, savePolicy } from "../engine/approvalPolicy.js";
import { exampleContext } from "../router/context.js";
import { lintContext, loadContext } from "../core/contextDoc.js";
import { keepPrevious } from "../core/contextHistory.js";
import { remoteCaller } from "../core/caller.js";
import { LEGEND_HEADER, type SealedEntry } from "../secrets/sealer.js";
import { route } from "../router/route.js";
import { loadMemory } from "../threads/memory.js";
import { deletePlatformMemory, loadPlatformMemory } from "../threads/platformMemory.js";
import { aggregateRecords, RECORD_WINDOW_MS } from "../router/record.js";
import { checkCwd } from "./cwdPolicy.js";
import { issues, limitParam, type ApiDeps } from "./shared.js";
import { NewTaskBody } from "./tasks.js";
import { DEFAULT_LIST_LIMIT } from "../core/limits.js";

const ContextBody = z.object({ text: z.string() });
const CONTEXT_UNROUTABLE = "有凭据看不出用在哪个站点：在同一条目里写上网址（例如 https://fin.example.com）再保存。";

type SealedContext = { ok: true; text: string; sealed: readonly SealedEntry[] } | { ok: false; status: 400 | 503; error: string };

/** CONTEXT.md is saved the way a task is submitted (router-v0 §9): the sealer marks the credentials in it and the
 *  daemon mints tokens, so passwords can be written in the clear here too. The legend the sealer appends is for
 *  executors and is not kept. A refusal saves nothing. Echo mode (no sealer, no gate): the text as is. */
async function sealContext(deps: ApiDeps, text: string): Promise<SealedContext> {
  if (!deps.sealer || !text.trim()) return { ok: true, text, sealed: [] };
  const r = await deps.sealer(text);
  if (!r.ok) return r.code === "unroutable" ? { ok: false, status: 400, error: CONTEXT_UNROUTABLE } : { ok: false, status: 503, error: r.error };
  const legendAt = r.text.indexOf(`\n\n${LEGEND_HEADER}`);
  return { ok: true, text: legendAt >= 0 ? r.text.slice(0, legendAt) : r.text, sealed: r.sealed };
}

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
  app.get("/routing/log", (c) => c.json(deps.routingLog.recent(limitParam(c, DEFAULT_LIST_LIMIT))));

  app.get("/context/example", (c) => c.json({ text: exampleContext() }));
  app.get("/context", (c) => {
    const ctx = loadContext(deps.contextPath);
    return c.json({ path: deps.contextPath, text: ctx.text, warnings: ctx.warnings });
  });
  app.put("/context", async (c) => {
    const body = ContextBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "text required" }, 400);
    const current = loadContext(deps.contextPath);
    if (current.source && body.data.text === current.text) return c.json({ path: deps.contextPath, warnings: current.warnings, sealed: [] });
    const sealed = await sealContext(deps, body.data.text);
    if (!sealed.ok) return c.json({ error: sealed.error }, sealed.status);
    const lint = lintContext(sealed.text);
    const caller = remoteCaller(c.env);
    keepPrevious(deps.contextPath, lint.text, caller ? `device-${caller.deviceId}` : "local");
    writeFileSync(deps.contextPath, lint.text, { mode: 0o600 }); // the stripped lines never reach disk
    const entries = sealed.sealed.map(({ label, field, hosts, uses }) => ({ label, field, hosts, uses }));
    return c.json({ path: deps.contextPath, warnings: lint.warnings, sealed: entries });
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
  app.get("/platform-memory", (c) => c.json({ records: deps.platformMemoryPath ? loadPlatformMemory(deps.platformMemoryPath, Date.now(), true) : [] }));
  app.delete("/platform-memory/:id", (c) => {
    if (!deps.platformMemoryPath || !deletePlatformMemory(deps.platformMemoryPath, c.req.param("id"))) return c.json({ error: "这条平台经验不存在" }, 404);
    return c.json({ ok: true });
  });
}
