/** User-maintained context documents: CONTEXT.md (sites, accounts as enc:v1: tokens, quirks, preferences) and MEMORY.md
 *  (facts the summarizer appends). Both pass the same lint before any model sees them: list entries that look like a
 *  plaintext credential are stripped, because these files must only ever carry ciphertext. The lint is a guard against
 *  slips, not a boundary: prose lines are not inspected. The router's prompt section is router/context.ts. */

import { existsSync, readFileSync } from "node:fs";

export const MAX_CONTEXT_BYTES = 64 * 1024;
const TOKEN = /enc:v1:[A-Za-z0-9_-]{16,}={0,2}/;
/** A credential label (not part of a hyphenated/underscored word) followed by a value. */
const CRED_LABEL = /(?<![\w-])(密码|口令|密钥|验证码|password|passwd|pwd|secret|token|api[-_ ]?key|2fa|totp|seed)(?![\w-])\s*[:：=]?\s*(\S.*)$/i;
const VALUE_LIKE = /[A-Za-z0-9]{4,}/;
/** Template placeholders, and the lint's own marker so a linted file lints clean. */
const PLACEHOLDER = /REPLACE_WITH|<[^>]+>|\[removed: /;
/** Only entry lines are linted (list items and their indented continuations); prose is left alone. */
const ENTRY_LINE = /^(?:\s*[-*]\s+|\s{2,})/;

export type LoadedContext = {
  readonly text: string;
  readonly warnings: readonly string[];
  readonly source: string | null;
};

export const EMPTY_CONTEXT: LoadedContext = { text: "", warnings: [], source: null };

export function lintContext(raw: string): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const kept: string[] = [];
  raw.split("\n").forEach((line, i) => {
    const m = ENTRY_LINE.test(line) ? CRED_LABEL.exec(line) : null;
    const value = m?.[2] ?? "";
    if (m && VALUE_LIKE.test(value) && !TOKEN.test(value) && !PLACEHOLDER.test(value)) {
      warnings.push(`line ${i + 1}: "${m[1]}" value is not an enc:v1: token; line removed`);
      kept.push(`${line.slice(0, m.index)}${m[1]} [removed: not a secret-gate token]`);
      return;
    }
    kept.push(line);
  });
  let text = kept.join("\n");
  if (Buffer.byteLength(text, "utf8") > MAX_CONTEXT_BYTES) {
    warnings.push(`context exceeds ${MAX_CONTEXT_BYTES} bytes; truncated`);
    text = Buffer.from(text, "utf8").subarray(0, MAX_CONTEXT_BYTES).toString("utf8");
  }
  return { text, warnings };
}

export function loadContext(path: string | undefined): LoadedContext {
  if (!path || !existsSync(path)) return EMPTY_CONTEXT;
  const { text, warnings } = lintContext(readFileSync(path, "utf8"));
  return { text, warnings, source: path };
}
