import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Explicitly transfer only this transcript. Identity, settings, memory and sibling sessions stay behind.
 * A new id keeps the original transcript independently resumable and discoverable. */
export function transferClaudeContext(source: string, projects: string, cwd: string): string {
  const id = randomUUID();
  const records = readFileSync(source, "utf8").split("\n").filter((line) => line.trim()).map((line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid session record");
    return JSON.stringify({ ...value, ...(value.sessionId ? { sessionId: id } : {}), ...(value.cwd ? { cwd } : {}) });
  });
  if (!records.length) throw new Error("session has no transcript yet");
  const directory = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, `${id}.jsonl`), records.join("\n") + "\n", { mode: 0o600, flag: "wx" });
  return id;
}
