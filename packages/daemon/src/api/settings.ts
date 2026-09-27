/** Everything the console reads or edits besides tasks: approval policy, route preview, quota, catalog, routing
 *  log, CONTEXT.md, MEMORY.md, the track record. */

import type { Hono } from "hono";
import { existsSync, mkdirSync, rmdirSync, writeFileSync } from "node:fs";
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
import { defaultWorkdir, expandWorkdir, loadWorkdir, saveWorkdir } from "../files/workdir.js";

const WorkdirBody = z.object({ path: z.string().min(1).max(1024) });

const ContextBody = z.object({ text: z.string() });
const CONTEXT_UNROUTABLE = "部分凭据无法确定所属站点。请在同一条目中写明网址（例如 https://fin.example.com）后保存。";

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

  // The default work folder (docs/control-v0.md §2): read from anywhere, set on the Mac only (not in the remote list).
  if (deps.home) {
    const home = deps.home;
    const problemOf = (path: string) => { const p = checkCwd(path, deps.cwdRules); return p ? workdirProblem(p) : null; };
    const view = (path: string) => ({ path, default: defaultWorkdir(), problem: existsSync(path) ? problemOf(path) : null });
    app.get("/settings/workdir", (c) => c.json(view(loadWorkdir(home))));
    app.put("/settings/workdir", async (c) => {
      const body = WorkdirBody.safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) return c.json({ error: issues(body.error) }, 400);
      const path = expandWorkdir(body.data.path.trim());
      if (!path) return c.json({ error: workdirProblem("cwd must be an absolute path") }, 400);
      const early = checkCwd(path, deps.cwdRules);
      if (early && !/is not an existing directory$/.test(early)) return c.json({ error: workdirProblem(early) }, 400);
      const created = !existsSync(path);
      try { mkdirSync(path, { recursive: true }); } catch (err) { return c.json({ error: `无法创建该文件夹：${(err as Error).message}` }, 400); }
      const problem = problemOf(path);
      if (problem) {
        if (created) try { rmdirSync(path); } catch { /* keep whatever was made */ }
        return c.json({ error: problem }, 400);
      }
      saveWorkdir(home, path);
      return c.json(view(path));
    });
  }

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
    if (!deps.platformMemoryPath || !deletePlatformMemory(deps.platformMemoryPath, c.req.param("id"))) return c.json({ error: "该平台经验不存在" }, 404);
    return c.json({ ok: true });
  });
}

/** The folder rules' reasons (api/cwdPolicy.ts, English for the API and the models) as the Mac and the phone show
 *  them for the default work folder (docs/ui-v0.md §4.1). */
export function workdirProblem(problem: string): string {
  const protectedRoot = /(?:is under|contains) (.+), which holds credentials/.exec(problem)?.[1];
  if (/must be an absolute path/.test(problem)) return "请使用绝对路径。";
  if (/special system path/.test(problem)) return "系统目录无法用作工作目录。请选择其他文件夹。";
  if (/too broad/.test(problem)) return "范围过大，无法用作工作目录。请选择其中的子文件夹。";
  if (/ is under /.test(problem)) return `该文件夹位于受保护的目录 ${protectedRoot} 中，其中存放凭据或 AgentSwitch 的数据。请选择其他文件夹。`;
  if (/ contains /.test(problem)) return `该文件夹包含受保护的目录 ${protectedRoot}，其中存放凭据或 AgentSwitch 的数据。请选择其他文件夹。`;
  if (/is not an existing directory/.test(problem)) return "文件夹不存在。";
  return problem;
}
