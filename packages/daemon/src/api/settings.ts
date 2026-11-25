/** Whether the service is up, and the settings every screen shares: the default work folder and the folders trusted
 *  once in AgentSwitch. */

import type { Hono } from "hono";
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { z } from "zod";
import { checkCwd } from "./cwdPolicy.js";
import { issues, type ApiDeps } from "./shared.js";
import { defaultWorkdir, expandWorkdir, loadWorkdir, saveWorkdir } from "../files/workdir.js";
import { loadTrustedFolders, saveTrustedFolders } from "../terminals/trustedFolders.js";

const WorkdirBody = z.object({ path: z.string().min(1).max(1024) });
const TrustedFoldersBody = z.object({ folders: z.array(z.string().min(1).max(4096)).max(500) });

export function mountSettings(app: Hono, deps: ApiDeps): void {
  // `pendingApprovals`: the old Dispatch's count, always 0 since it was removed (2026-11-25), for the apps that read it.
  app.get("/healthz", (c) => c.json({ ok: true, version: deps.version, pendingApprovals: 0 }));

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

    // Folders trusted once in AgentSwitch (terminals/trustedFolders.ts): an agent started in one, or below one, does
    // not ask whether to trust it. Read and set on the Mac only (not in the remote list): a phone's say over which
    // folders an agent runs in unasked stays a step it takes on the Mac. The whole list is sent; `~/x` is the home's.
    app.get("/settings/trusted-folders", (c) => c.json({ folders: loadTrustedFolders(home) }));
    app.put("/settings/trusted-folders", async (c) => {
      const body = TrustedFoldersBody.safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) return c.json({ error: issues(body.error) }, 400);
      const folders: string[] = [];
      for (const raw of body.data.folders) {
        const path = expandWorkdir(raw.trim());
        if (!path) return c.json({ error: `${raw}: a trusted folder must be an absolute path` }, 400);
        folders.push(path);
      }
      try { return c.json({ folders: saveTrustedFolders(home, folders) }); }
      catch (err) { return c.json({ error: (err as Error).message }, 400); }
    });
  }
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
