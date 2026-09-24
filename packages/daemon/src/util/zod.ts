/** Zod validation errors as one line of text. Lives here so router/, threads/ and extensions/ need not import api/. */

import type { z } from "zod";

/** `root` names an issue on the value itself (default "", which reads ": message"); `limit` keeps the first n issues;
 *  `paths: false` keeps only the messages. */
export type IssueFormat = { readonly root?: string; readonly limit?: number; readonly paths?: boolean };

/** `path: message; path: message` in zod's order. */
export function zodIssues(err: z.ZodError, format: IssueFormat = {}): string {
  const { root = "", limit, paths = true } = format;
  const shown = limit === undefined ? err.issues : err.issues.slice(0, limit);
  return shown.map((i) => (paths ? `${i.path.join(".") || root}: ${i.message}` : i.message)).join("; ");
}
