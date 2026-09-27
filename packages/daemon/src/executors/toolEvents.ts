/** What a tool call looks like in the task's events (2026-09-25: the phone opens a call to show what went in and what
 *  came back, like Claude's own remote view). The input is what the model wrote, the output an excerpt of what the
 *  executor saw; both are clipped so a long file or page does not bloat the log. Credentials in either are the
 *  ciphertext the executor had (pages come masked by the gate; protected folders are unreadable to Claude and
 *  OpenCode). */

export const TOOL_OUTPUT_CHARS = 1500;
const INPUT_VALUE_CHARS = 2000;
const INPUT_TOTAL_CHARS = 4000;

/** The model's arguments, each long string cut; nested values kept while the whole stays small. */
export function clipInput(input: unknown): unknown {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") return clip(input, INPUT_VALUE_CHARS);
  if (typeof input !== "object") return input;
  if (JSON.stringify(input).length <= INPUT_TOTAL_CHARS) return input;
  if (Array.isArray(input)) return clip(JSON.stringify(input), INPUT_TOTAL_CHARS);
  return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) =>
    [k, typeof v === "string" ? clip(v, INPUT_VALUE_CHARS) : clip(JSON.stringify(v) ?? "", INPUT_VALUE_CHARS)]));
}

/** A tool's result as text: a string, or the text parts of a content list (an image says so), clipped. */
export function clipOutput(content: unknown): string {
  return clip(outputText(content).trim(), TOOL_OUTPUT_CHARS);
}

function outputText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as { type?: string; text?: string };
      if (p?.type === "text") return p.text ?? "";
      if (p?.type === "image") return "[图片]";
      return typeof part === "string" ? part : JSON.stringify(part);
    }).join("\n");
  }
  return JSON.stringify(content);
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…（共 ${text.length} 字）` : text;
}
