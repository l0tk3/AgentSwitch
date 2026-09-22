/** Questions put to the user, from the router (clarify, supervisor-v0 §1b) or straight from a running executor
 *  (pass-through, §1c). One shape for both, so the card, the API and the store do not care who is asking. */

import { z } from "zod";

export type QuestionSource = "router" | "executor";

export type UserQuestion = {
  readonly id: string;
  readonly header: string;
  readonly text: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly multi: boolean;
  /** The harness flagged the answer as sensitive: the card tells the user to answer with secret-gate ciphertext. */
  readonly secret: boolean;
};

/** question id → chosen labels or free text (one entry unless `multi`). */
export type UserAnswers = Readonly<Record<string, readonly string[]>>;

const Option = z.object({ label: z.string().min(1), description: z.string().default("") });
export const UserQuestionSchema = z.object({
  id: z.string().min(1), header: z.string().default(""), text: z.string().min(1),
  options: z.array(Option).default([]), multi: z.boolean().default(false), secret: z.boolean().default(false),
});
export const UserAnswersSchema = z.record(z.string().min(1), z.array(z.string().min(1).max(4000)).min(1));

export type QuestionEvidence = { readonly source: QuestionSource; readonly questions: readonly UserQuestion[] };
const EvidenceSchema = z.object({ source: z.enum(["router", "executor"]), questions: z.array(UserQuestionSchema).min(1) });

export const CLARIFY_ID = "clarify";

/** What the harness's tool gets back when nobody answered: the model must not invent an answer. */
export const NO_ANSWER_MESSAGE = "The user did not answer within the time limit. Proceed only where a wrong guess is harmless; otherwise stop and report exactly what you need.";

/** The router's one free-text question, in the shared shape. */
export function clarifyQuestion(text: string): UserQuestion {
  return { id: CLARIFY_ID, header: "路由器", text, options: [], multi: false, secret: false };
}

export function encodeEvidence(ev: QuestionEvidence): string { return JSON.stringify(ev); }

/** null when the evidence is not a question record (an allow/deny approval, or a row from before this format). */
export function parseEvidence(evidence: string): QuestionEvidence | null {
  try { const r = EvidenceSchema.safeParse(JSON.parse(evidence)); return r.success ? r.data : null; } catch { return null; }
}

/** A plain-text answer is the answer to the first question; enough for clarify and for one-question cards. */
export function answersFromText(questions: readonly UserQuestion[], text: string): UserAnswers {
  return { [questions[0]!.id]: [text] };
}

/** Every question must be answered with at least one non-empty entry; nothing else may be present. */
export function validateAnswers(questions: readonly UserQuestion[], answers: unknown): { ok: true; answers: UserAnswers } | { ok: false; error: string } {
  const parsed = UserAnswersSchema.safeParse(answers);
  if (!parsed.success) return { ok: false, error: "answers must map every question id to a non-empty list of strings" };
  const ids = new Set(questions.map((q) => q.id));
  const missing = questions.filter((q) => !parsed.data[q.id]).map((q) => q.id);
  if (missing.length) return { ok: false, error: `unanswered: ${missing.join(", ")}` };
  const extra = Object.keys(parsed.data).filter((k) => !ids.has(k));
  if (extra.length) return { ok: false, error: `unknown question ids: ${extra.join(", ")}` };
  return { ok: true, answers: parsed.data };
}

/** One line per answer, for event lines and the store. */
export function describeAnswers(questions: readonly UserQuestion[], answers: UserAnswers): string {
  return questions.map((q) => `${q.text} → ${(answers[q.id] ?? []).join(" / ")}`).join("\n");
}
