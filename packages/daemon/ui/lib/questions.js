/** Shared question handling for home and task detail. Both views must submit the same payload. */
import { answer, refreshAnswer, setAnswerSubmission } from "./actions.js";
import { get } from "./state.js";

/** Older question rows used plain text evidence. */
export function questionsOf(a) {
  try { const ev = JSON.parse(a.evidence); if (ev && Array.isArray(ev.questions) && ev.questions.length) return { source: ev.source || "router", questions: ev.questions }; } catch { /* plain evidence */ }
  return { source: "router", questions: [{ id: "clarify", text: a.action, options: [], multi: false, secret: false }] };
}

export function collectAnswers(approvalId) {
  const a = get().approvals.find((x) => x.id === approvalId);
  if (!a) return null;
  const { questions } = questionsOf(a);
  const answers = {};
  for (const [i, q] of questions.entries()) {
    const value = (document.getElementById(`q-${approvalId}-${i}`)?.value || "").trim();
    const values = q.multi ? value.split(/[,，]/).map((v) => v.trim()).filter(Boolean) : value ? [value] : [];
    if (!values.length) return null;
    answers[q.id] = values;
  }
  // Keep the legacy text shape only for a single non-multiple question.
  return questions.length === 1 && !questions[0].multi ? { text: answers[questions[0].id][0] } : { answers };
}

export function submitAnswer(el) {
  const { task: taskId, answer: approvalId } = el.dataset;
  if (["sending", "sent", "uncertain", "resolved"].includes(get().answerSubmissions[approvalId]?.status)) return;
  const given = collectAnswers(approvalId);
  if (!given) {
    setAnswerSubmission(approvalId, { taskId, status: "error", message: "请先回答每个问题，再提交。" });
    return;
  }
  return answer(taskId, approvalId, given);
}

function selectOption(el) {
  const box = document.getElementById(el.dataset.for);
  if (!box || box.disabled) return;
  if (el.dataset.multi !== "true") { box.value = el.dataset.opt; return; }
  const values = box.value.split(/[,，]/).map((v) => v.trim()).filter(Boolean);
  if (!values.includes(el.dataset.opt)) values.push(el.dataset.opt);
  box.value = values.join(", ");
}

export const questionBindings = [
  { sel: "[data-opt]", run: selectOption },
  { sel: "[data-answer]", run: submitAnswer },
  { sel: "[data-answer-refresh]", run: (el) => refreshAnswer(el.dataset.task, el.dataset.answerRefresh) },
];
