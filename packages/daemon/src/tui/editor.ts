/** Long text — CONTEXT.md, MEMORY.md, a skill, an MCP server — edited in the user's own editor (docs/tui-v0.md §2):
 *  `$VISUAL`, else `$EDITOR`, else vi, on a file in a folder only this user can read, removed afterwards. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function editorOf(env: NodeJS.ProcessEnv): string {
  return env.VISUAL?.trim() || env.EDITOR?.trim() || "vi";
}

/** `text` as saved in the editor. The editor's command may carry its own arguments (`code -w`, `emacs -nw`): it is run
 *  by the shell with the file as its last argument. Throws when the editor cannot be started or ends in failure. */
export function editText(text: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-edit-"));
  try {
    const file = join(dir, name);
    writeFileSync(file, text, { mode: 0o600 });
    const editor = editorOf(env);
    const r = spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit", env });
    if (r.error) throw new Error(`${editor}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`${editor} exited ${r.status ?? r.signal}`);
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
