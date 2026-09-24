/** Bounded evidence for model prompts (router, loop, supervisor, summarizer): when a result, brief or error has to be
 *  cut, keep its head, its tail and the passages around blocking words, and say that something was left out. Pure. */

/** Budget when the caller names none. */
export const DEFAULT_EVIDENCE_CHARS = 20_000;
/** Context kept around each blocking word ("failed", "未完成", …) taken from the omitted middle. */
const BLOCKER_BEFORE_CHARS = 100;
const BLOCKER_AFTER_CHARS = 260;

/** Keep the conclusion and blocking facts when evidence must be bounded; mark omissions explicitly. */
export function evidenceExcerpt(text: string, limit = DEFAULT_EVIDENCE_CHARS): string {
  if (text.length <= limit) return text;
  const marker = "\n[... evidence abbreviated; omitted material is not proof of completion ...]\n";
  const available = Math.max(0, limit - marker.length * 2);
  const head = Math.floor(available / 3), tail = Math.floor(available / 3);
  const remaining = Math.max(0, limit - head - tail - marker.length * 2);
  const blockers: string[] = [];
  const matches = text.matchAll(/未完成|未能|无法|失败|阻塞|尚未|待确认|待处理|remaining|blocked|not (?:done|complete|finished)|could not|failed|error|timeout|unresolved/gi);
  let end = -1;
  for (const match of matches) {
    const index = match.index!;
    if (index < head || index >= text.length - tail || index <= end) continue;
    const start = Math.max(head, index - BLOCKER_BEFORE_CHARS);
    end = Math.min(text.length - tail, index + BLOCKER_AFTER_CHARS);
    blockers.push(text.slice(start, end));
    if (blockers.join("\n").length >= remaining) break;
  }
  return text.slice(0, head) + marker + blockers.join("\n").slice(0, remaining) + marker + text.slice(-tail);
}
