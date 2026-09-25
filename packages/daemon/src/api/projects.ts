/** The project directories a phone task may run in (assistant-v0 §5). Read from anywhere (the phone shows the list and
 *  the assistant picks from it); changed only on the Mac: which of its folders the phone may reach is the Mac's call,
 *  like the approval policy. Every path must pass the cwd rules when saved, and again when a task goes there. */

import type { Hono } from "hono";
import { z } from "zod";
import { remoteCaller } from "../core/caller.js";
import { findProject, loadProjects, ProjectList, saveProjects, type Project } from "../files/projects.js";
import { checkCwd, physicalPath } from "./cwdPolicy.js";
import { issues, type ApiDeps } from "./shared.js";

const PutBody = z.object({ projects: ProjectList });

export type ProjectChoice = { ok: true; path: string } | { ok: false; error: string };

/** The directory of the project named `name`, checked against the cwd rules as they are now. */
export function resolveProject(deps: Pick<ApiDeps, "projectsPath" | "cwdRules">, name: string): ProjectChoice {
  const project = findProject(loadProjects(deps.projectsPath), name);
  if (!project) return { ok: false, error: `no registered project named "${name}"; projects are added on the Mac` };
  const problem = checkCwd(project.path, deps.cwdRules);
  return problem ? { ok: false, error: `project "${project.name}": ${problem}` } : { ok: true, path: project.path };
}

/** Each project with the reason it cannot be used right now (moved, deleted), if any. */
function listed(deps: ApiDeps): (Project & { problem?: string })[] {
  return loadProjects(deps.projectsPath).map((p) => {
    const problem = checkCwd(p.path, deps.cwdRules);
    return problem ? { ...p, problem } : p;
  });
}

export function mountProjects(app: Hono, deps: ApiDeps): void {
  app.get("/projects", (c) => c.json({ projects: listed(deps) }));

  app.put("/projects", async (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "projects are managed on the Mac" }, 403);
    if (!deps.projectsPath) return c.json({ error: "projects are not available" }, 503);
    const body = PutBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    const names = new Set<string>();
    const projects: Project[] = [];
    for (const p of body.data.projects) {
      const key = p.name.toLowerCase();
      if (names.has(key)) return c.json({ error: `two projects are named "${p.name}"` }, 400);
      names.add(key);
      const problem = checkCwd(p.path, deps.cwdRules);
      if (problem) return c.json({ error: `project "${p.name}": ${problem}` }, 400);
      projects.push({ name: p.name, path: physicalPath(p.path) });
    }
    saveProjects(deps.projectsPath, projects);
    return c.json({ projects: listed(deps) });
  });
}
