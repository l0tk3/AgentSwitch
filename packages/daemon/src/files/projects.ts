/** Project directories the phone may use (assistant-v0 §5, app-v0 §2): registered on the Mac, by name, in
 *  `$AGENTSWITCH_HOME/projects.json`. A phone task names a project instead of a path; the API checks the directory
 *  against the cwd rules when the list is saved and again whenever a task goes there. */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

export const PROJECTS_FILE = "projects.json";
export const MAX_PROJECTS = 20;
const MAX_NAME_CHARS = 40;
const MAX_PATH_CHARS = 1024;

export const Project = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_CHARS).regex(/^[^\n\r\t"]+$/, "one line, no quotes"),
  path: z.string().min(1).max(MAX_PATH_CHARS),
});
export type Project = z.infer<typeof Project>;
export const ProjectList = z.array(Project).max(MAX_PROJECTS);

/** The registered projects; a missing or unreadable file is an empty list (nothing is allowed rather than guessed). */
export function loadProjects(path: string | undefined): Project[] {
  if (!path || !existsSync(path)) return [];
  try {
    const parsed = z.object({ projects: ProjectList }).safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data.projects : [];
  } catch {
    return [];
  }
}

export function saveProjects(path: string, projects: readonly Project[]): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ projects }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** By name, ignoring case and surrounding spaces. */
export function findProject(projects: readonly Project[], name: string): Project | undefined {
  const wanted = name.trim().toLowerCase();
  return projects.find((p) => p.name.toLowerCase() === wanted);
}
