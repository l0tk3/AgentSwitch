/** The summarizer (threads-v0 §3): after every execution, one cheap model call rewrites the thread
 *  summary from the previous summary + this run's brief, result and diff. It exists for handing the
 *  thread to a different harness; same-harness continuation uses native resume and never reads it.
 *  Failure leaves the previous summary in place and never blocks the task. */

import { z } from "zod";
import { extractJsonObject } from "../router/decision.js";
import { lintContext } from "../router/context.js";
import type { Router } from "../router/routers/types.js";
import type { Summary } from "./types.js";

export const SUMMARY_TIMEOUT_MS = 20_000;
const MAX_FIELD = 1200;
const MAX_LIST = 30;

export const SummarySchema = z.object({
  title: z.string().min(1).max(120),
  goal: z.string().min(1).max(MAX_FIELD),
  progress: z.string().max(MAX_FIELD).default(""),
  files: z.array(z.string().min(1)).max(MAX_LIST).default([]),
  unresolved: z.array(z.string().min(1)).max(MAX_LIST).default([]),
  decisions: z.array(z.string().min(1)).max(MAX_LIST).default([]),
});

export type SummaryInput = {
  readonly previous: Summary | null;
  readonly task: string;
  readonly brief: string | null;
  readonly target: string;          // "harness/model"
  readonly status: string;          // done | failed | cancelled
  readonly result: string;          // final text or error
  readonly diff: string;
  readonly cwd: string;
};

export const SUMMARY_SYSTEM = `You maintain the running summary of one thread of work for AgentSwitch. A thread is one job that
several coding agents may work on in turn. Your summary is what the next agent reads when it takes over,
so it must be concrete: paths, names, commands, numbers. Never include passwords or tokens; values that
look like enc:v1:... are opaque placeholders and may be copied as-is.

Reply with exactly one JSON object and nothing else:
{
  "title": "<at most 8 words naming the job>",
  "goal": "<what the user wants, in one or two sentences>",
  "progress": "<what has been done so far and where things stand; mention the last executor's outcome>",
  "files": ["<paths touched or central to the job>"],
  "unresolved": ["<open questions, failing tests, things the next agent must handle>"],
  "decisions": ["<choices made that the next agent must not undo>"]
}
Keep the whole object under 500 tokens. Merge the previous summary with the new run; drop nothing that is still true.`;

export function summaryMessage(input: SummaryInput): string {
  const prev = input.previous ? JSON.stringify(input.previous) : "(none)";
  return `Working directory: ${input.cwd}

Previous summary:
${prev}

Original request:
${input.task.slice(0, 4000)}

Brief given to the executor (${input.target}):
${(input.brief ?? "(same as the request)").slice(0, 4000)}

Execution ended with status: ${input.status}
Final output:
${input.result.slice(0, 6000) || "(none)"}

Working tree changes:
${input.diff.slice(0, 4000) || "(none)"}`;
}

export type ParsedSummary = { ok: true; summary: Summary } | { ok: false; error: string };

/** Parse + lint: a summary is memory, so credential-looking lines are stripped like CONTEXT.md. */
export function parseSummary(text: string): ParsedSummary {
  const raw = extractJsonObject(text);
  if (raw === undefined) return { ok: false, error: "no JSON object in reply" };
  let value: unknown;
  try { value = JSON.parse(raw); } catch (err) { return { ok: false, error: `invalid JSON: ${(err as Error).message}` }; }
  const parsed = SummarySchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const s = parsed.data;
  const clean = (v: string) => lintContext(`- ${v}`).text.replace(/^- /, "");
  return { ok: true, summary: { title: s.title, goal: clean(s.goal), progress: clean(s.progress), files: s.files, unresolved: s.unresolved.map(clean), decisions: s.decisions.map(clean) } };
}

export type Summarizer = (input: SummaryInput, signal?: AbortSignal) => Promise<{ summary: Summary | null; error: string | null; ms: number }>;

/** Summarizer on top of a Router (the same OpenCode/DeepSeek agent used for dispatch), one attempt. */
export function routerSummarizer(router: Router, timeoutMs = SUMMARY_TIMEOUT_MS): Summarizer {
  return async (input, outer) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("summarizer timed out")), timeoutMs);
    const onAbort = () => controller.abort(new Error("cancelled"));
    outer?.addEventListener("abort", onAbort, { once: true });
    const started = Date.now();
    try {
      const reply = await router.route({ task: summaryMessage(input), cwd: input.cwd, system: SUMMARY_SYSTEM }, controller.signal);
      const parsed = parseSummary(reply.text);
      return parsed.ok ? { summary: parsed.summary, error: null, ms: Date.now() - started } : { summary: null, error: parsed.error, ms: Date.now() - started };
    } catch (err) {
      return { summary: null, error: (err as Error).message, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  };
}

/** Prompt rendering shared by the router's thread list and the handoff package. */
export function renderSummary(s: Summary): string {
  const list = (label: string, items: readonly string[]) => (items.length ? `${label}:\n${items.map((i) => `- ${i}`).join("\n")}\n` : "");
  return `Title: ${s.title}\nGoal: ${s.goal}\nProgress: ${s.progress || "(none)"}\n${list("Files", s.files)}${list("Unresolved", s.unresolved)}${list("Decisions", s.decisions)}`.trimEnd();
}
