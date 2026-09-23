/** MEMORY.md (threads-v0 §8): routing-level facts the summarizer notices (a site's login is a React form,
 *  a project's tests take four minutes), one fact per line with its source task, appended after the lint
 *  that guards CONTEXT.md. The user edits or deletes lines on the page; the router reads it with CONTEXT.md. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { lintContext, MAX_CONTEXT_BYTES, type LoadedContext } from "../router/context.js";

export const MEMORY_HEADER = "# AgentSwitch 记忆\n\n摘要器在任务结束时追加的持久事实，一行一条，带来源任务。可随意删改；只放路由层知识，不放凭据。\n";
export const MAX_FACT_CHARS = 300;
export const MAX_FACTS_PER_TASK = 5;

export function loadMemory(path: string | undefined): LoadedContext {
  if (!path || !existsSync(path)) return { text: "", warnings: [], source: null };
  const { text, warnings } = lintContext(readFileSync(path, "utf8"));
  return { text, warnings, source: path };
}

/** Existing fact lines without their source suffix, for de-duplication. */
export function factLines(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.replace(/\s*\(task [^)]*\)\s*$/, "").slice(2).trim());
}

export type AppendResult = { readonly added: string[]; readonly skipped: string[] };

/** Remove only generated facts attributed to deleted tasks; keep unrelated and hand-written memory. */
export function removeTaskMemories(path: string | undefined, taskIds: readonly string[]): number {
  if (!path || !taskIds.length || !existsSync(path)) return 0;
  const ids = new Set(taskIds);
  const current = readFileSync(path, "utf8");
  let removed = 0;
  const kept = current.split("\n").filter((line) => {
    const source = /^- .+ \(task ([^,\s)]+), \d{4}-\d{2}-\d{2}\)\s*$/.exec(line);
    if (source?.[1] && ids.has(source[1])) { removed++; return false; }
    return true;
  });
  if (removed) writeFileSync(path, kept.join("\n"), { mode: 0o600 });
  return removed;
}

/** Append facts (linted, deduplicated, capped) to MEMORY.md. Never throws on a bad fact; the file stays ≤ 64 KB. */
export function appendMemory(path: string, facts: readonly string[], source: { taskId: string; ts?: number }): AppendResult {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const known = new Set(factLines(current));
  const added: string[] = [];
  const skipped: string[] = [];
  const date = new Date(source.ts ?? Date.now()).toISOString().slice(0, 10);
  const lines: string[] = [];
  for (const raw of facts.slice(0, MAX_FACTS_PER_TASK)) {
    const fact = raw.replace(/\s+/g, " ").trim().slice(0, MAX_FACT_CHARS);
    if (!fact || known.has(fact)) { skipped.push(raw); continue; }
    const lint = lintContext(`- ${fact}`);
    if (lint.warnings.length) { skipped.push(raw); continue; }
    known.add(fact);
    added.push(fact);
    lines.push(`- ${fact} (task ${source.taskId}, ${date})`);
  }
  if (!lines.length) return { added, skipped };
  const head = current.trim() ? current.replace(/\s*$/, "\n") : MEMORY_HEADER + "\n";
  let next = head + lines.join("\n") + "\n";
  if (Buffer.byteLength(next, "utf8") > MAX_CONTEXT_BYTES) return { added: [], skipped: [...skipped, ...added] };
  writeFileSync(path, next, { mode: 0o600 });
  return { added, skipped };
}
