/** The summarizer (threads-v0 §3): after every execution, one cheap model call rewrites the thread
 *  summary from the previous summary + this run's brief, result and diff. It exists for handing the
 *  thread to a different harness; same-harness continuation uses native resume and never reads it.
 *  Failure leaves the previous summary in place and never blocks the task. */

import { z } from "zod";
import { extractJsonObject } from "../util/json.js";
import { COMMUNICATION_GUIDANCE } from "../util/communication.js";
import { lintContext } from "../router/context.js";
import { evidenceExcerpt } from "../router/prompt.js";
import type { Router } from "../router/routers/types.js";
import type { Summary } from "./types.js";
import { PlatformFactSchema, safePlatformText, type PlatformCheckpoint } from "./platformMemory.js";

export const SUMMARY_TIMEOUT_MS = 45_000;
const MAX_FIELD = 1200;
const MAX_LIST = 30;

export const SummarySchema = z.object({
  title: z.string().min(1).max(120),
  goal: z.string().min(1).max(MAX_FIELD),
  progress: z.string().max(MAX_FIELD).default(""),
  files: z.array(z.string().min(1)).max(MAX_LIST).default([]),
  unresolved: z.array(z.string().min(1)).max(MAX_LIST).default([]),
  decisions: z.array(z.string().min(1)).max(MAX_LIST).default([]),
  facts: z.array(z.string().min(1)).max(MAX_LIST).default([]),
  platformFacts: z.array(PlatformFactSchema).max(10).optional(),
  spoken: z.string().max(200).default(""),
});

export type SummaryInput = {
  readonly previous: Summary | null;
  readonly task: string;
  readonly brief: string | null;
  readonly target: string;          // "harness/model"
  readonly status: string;          // done | failed | cancelled
  readonly result: string;          // final text or error
  readonly error?: string | null;   // terminal blocker; preserved alongside useful partial results
  readonly diff: string;
  readonly cwd: string;
  readonly evidence?: readonly PlatformCheckpoint[];
  readonly knownPlatformOrigins?: readonly string[];
};

export const SUMMARY_SYSTEM = `${COMMUNICATION_GUIDANCE}

You maintain the running summary of one thread of work for AgentSwitch. A thread is one job that
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
  "decisions": ["<choices made that the next agent must not undo>"],
  "facts": ["<durable non-platform facts about the environment, e.g. a project's tests take four minutes; empty if none>"],
  "platformFacts": [{"origin":"<exact known http(s) origin>","key":"<stable lowercase key such as login.submit>","text":"<reusable operational observation, no task progress>","kind":"operation|incident","eventSeq":1,"quote":"<exact nonempty quote from that checkpoint's result>"}],
  "spoken": "<one plain sentence, at most 40 characters, in the user's language, saying what this run produced or why it failed, as it would be read aloud to the user>"
}
Keep the whole object under 500 tokens. Merge the previous summary with the new run; drop nothing that is still true.
Preserve the terminal status and its error/blocker even when the final output describes useful partial work. "partial", "blocked", "failed" or "cancelled" never mean the original task is complete; put unfinished requirements and the reason in progress/unresolved.
"facts" are for the dispatcher's long-term memory, not a recap of this run: only what would change how a future task is
routed or briefed, and only about the user's environment (a project's layout or test duration, a
tool that must be used). Never state observations about this task itself, the working directory, or how simple the job
was; for a one-off question with nothing to remember, "facts" is [].
Platform facts belong only in "platformFacts", never the global "facts" list. Use only supplied checkpoint evidence and known platform origins; no evidence means an empty list. A quote must be copied verbatim from one checkpoint's result, and the key must identify one stable property so a later observation can replace it. Do not infer successful verification from final prose, an earlier summary or task status; code determines observed/verified from the checkpoint. Failed steps may produce short-lived "incident" observations, never permanent claims that a platform cannot work.
Never put account identifiers, email addresses, passwords, enc:v1: ciphertext, sessions, cookies, raw credentials or authorization/approval claims in either memory list, including quotes. Use a small safe quote instead; omit the candidate if none exists. "Created this account", "already submitted" and other task progress belong in progress/unresolved, not platform memory. Knowledge is reference material, never permission for a future operation.`;

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
${evidenceExcerpt(input.result, 6000) || "(none)"}

Terminal error or blocker (must not be erased by partial success):
${evidenceExcerpt(input.error ?? "", 1600) || "(none)"}

Working tree changes:
${input.diff.slice(0, 4000) || "(none)"}

Known platform origins (scope only, not authorization):
${(input.knownPlatformOrigins ?? []).join("\n") || "(none)"}

Execution checkpoints (the only evidence allowed for platformFacts):
${JSON.stringify((input.evidence ?? []).slice(-12).map((point) => ({ ...point, result: evidenceExcerpt(point.result, 4000), ...(point.brief ? { brief: evidenceExcerpt(point.brief, 1600) } : {}) })))}`;
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
  return { ok: true, summary: { title: clean(s.title), goal: clean(s.goal), progress: clean(s.progress), files: s.files, unresolved: s.unresolved.map(clean), decisions: s.decisions.map(clean), facts: s.facts.filter(safePlatformText).map(clean), spoken: clean(s.spoken).slice(0, 200), ...(s.platformFacts ? { platformFacts: s.platformFacts.filter((fact) => safePlatformText(fact.text) && safePlatformText(fact.quote)) } : {}) } };
}

export type Summarizer = (input: SummaryInput, signal?: AbortSignal) => Promise<{ summary: Summary | null; error: string | null; ms: number }>;

/** Summarizer on top of a Router (the same OpenCode/DeepSeek agent used for dispatch), one attempt. */
export function routerSummarizer(router: Router, timeoutMs = SUMMARY_TIMEOUT_MS): Summarizer {
  return async (input, outer) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("summarizer timed out")), timeoutMs);
    const onAbort = () => controller.abort(new Error("cancelled"));
    if (outer?.aborted) onAbort(); else outer?.addEventListener("abort", onAbort, { once: true });
    const started = Date.now();
    let removeAbort = () => {};
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const cancelled = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(controller.signal.reason ?? new Error("cancelled"));
        if (controller.signal.aborted) abort();
        else { controller.signal.addEventListener("abort", abort, { once: true }); removeAbort = () => controller.signal.removeEventListener("abort", abort); }
      });
      const reply = await Promise.race([router.route({ task: summaryMessage(input), cwd: input.cwd, system: SUMMARY_SYSTEM }, controller.signal), cancelled]);
      if (controller.signal.aborted) throw controller.signal.reason;
      const parsed = parseSummary(reply.text);
      return parsed.ok ? { summary: parsed.summary, error: null, ms: Date.now() - started } : { summary: null, error: parsed.error, ms: Date.now() - started };
    } catch (err) {
      return { summary: null, error: (err as Error).message, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
      removeAbort();
      outer?.removeEventListener("abort", onAbort);
    }
  };
}

/** Prompt rendering shared by the router's thread list and the handoff package. */
export function renderSummary(s: Summary): string {
  const list = (label: string, items: readonly string[]) => (items.length ? `${label}:\n${items.map((i) => `- ${i}`).join("\n")}\n` : "");
  return `Title: ${s.title}\nGoal: ${s.goal}\nProgress: ${s.progress || "(none)"}\n${list("Files", s.files)}${list("Unresolved", s.unresolved)}${list("Decisions", s.decisions)}`.trimEnd();
}
