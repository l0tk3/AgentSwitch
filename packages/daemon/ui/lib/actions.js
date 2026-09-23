/** Everything that talks to the daemon and updates state. Views only render and dispatch here. */

import { api } from "./api.js";
import { get, set } from "./state.js";
import { releasePending, toPending, uploadPending } from "./files.js";
import { postTask } from "./submission.js";

export const isDeleted = (kind, id) => get().deletions[`${kind}:${id}`]?.status === "deleted";
export const loadTasks = async () => {
  const generation = get().deletions;
  const tasks = await api("GET", "/tasks?limit=50");
  if (get().deletions !== generation) return get();
  return set({ tasks: tasks.filter((t) => !isDeleted("task", t.id) && !isDeleted("thread", t.threadId)) });
};
export const loadThreads = async () => {
  const generation = get().deletions;
  const threads = await api("GET", "/threads?status=open&limit=30");
  if (get().deletions !== generation) return get();
  return set({ threads: threads.filter((t) => !isDeleted("thread", t.id)) });
};
export const loadArchivedThreads = async () => {
  const generation = get().deletions;
  const threads = await api("GET", "/threads?status=archived&limit=100");
  if (get().deletions !== generation) return get();
  return set({ archivedThreads: threads.filter((t) => !isDeleted("thread", t.id)) });
};
export const loadPolicy = async () => set({ policy: await api("GET", "/approvals/policy") });
export const loadApprovals = async () => {
  const generation = get().deletions;
  const approvals = await api("GET", "/approvals");
  if (get().deletions !== generation) return get();
  return set({ approvals: approvals.filter((a) => !isDeleted("task", a.taskId)) });
};
let quotaRequest = null;
export function loadQuota(refresh = false) {
  if (quotaRequest) return quotaRequest;
  quotaRequest = api("GET", "/quota" + (refresh ? "?refresh=1" : ""), undefined, { timeoutMs: 15_000 })
    .then((quota) => set({ quota })).finally(() => { quotaRequest = null; });
  return quotaRequest;
}
export const loadLog = async () => set({ log: await api("GET", "/routing/log?limit=50") });

let platformMemoryRequest = null;
export function loadPlatformMemory() {
  if (platformMemoryRequest) return platformMemoryRequest;
  const generation = get().platformMem.deletions;
  set((s) => ({ platformMem: { ...s.platformMem, loading: true, hint: "" } }));
  platformMemoryRequest = api("GET", "/platform-memory").then(({ records }) => {
    if (!Array.isArray(records)) throw new Error("invalid platform memory response");
    if (get().platformMem.deletions !== generation) return;
    set((s) => ({ platformMem: { ...s.platformMem, records, loaded: true,
      deletions: Object.fromEntries(Object.entries(s.platformMem.deletions).filter(([id, value]) => value.status !== "deleted" || !records.some((r) => r.id === id))) } }));
  }).catch(() => {
    set((s) => ({ platformMem: { ...s.platformMem, hint: "平台经验暂未加载，请重试。" } }));
  }).finally(() => {
    platformMemoryRequest = null;
    set((s) => ({ platformMem: { ...s.platformMem, loading: false } }));
  });
  return platformMemoryRequest;
}

/** Delete one sourced observation; a slow response never enables a second DELETE. */
export async function deletePlatformMemory(id) {
  const current = get().platformMem;
  if (["deleting", "deleted"].includes(current.deletions[id]?.status) || !current.records.some((r) => r.id === id)) return;
  const update = (value) => set((s) => ({ platformMem: { ...s.platformMem, deletions: { ...s.platformMem.deletions, [id]: value } } }));
  update({ status: "deleting", message: "正在删除…" });
  try { await api("DELETE", `/platform-memory/${encodeURIComponent(id)}`); }
  catch (err) {
    if (err.status !== 404) { update({ status: "error", message: "删除暂未确认，请重试。" }); return; }
  }
  set((s) => ({ platformMem: { ...s.platformMem, records: s.platformMem.records.filter((r) => r.id !== id), deletions: { ...s.platformMem.deletions, [id]: { status: "deleted" } } } }));
}

export async function loadExt() {
  const [mcp, skills, discovered] = await Promise.all([api("GET", "/mcp"), api("GET", "/skills"), api("GET", "/skills/discover")]);
  set({ mcp, skills, discovered });
}

export async function loadCtx() {
  const [r, m] = await Promise.all([api("GET", "/context"), api("GET", "/memory")]);
  set((s) => ({ ctx: { ...s.ctx, path: r.path, text: r.text, warnings: r.warnings, draft: null, hint: "" }, mem: { ...s.mem, path: m.path, text: m.text, warnings: m.warnings, draft: null, hint: "" } }));
}

export async function health() {
  try { const h = await api("GET", "/healthz"); set({ health: true, version: h.version || "" }); }
  catch { set({ health: false }); }
}

export const loadFiles = async (taskId) => {
  const files = await api("GET", `/tasks/${taskId}/files`);
  if (get().view === "task" && get().task?.id === taskId && !isDeleted("task", taskId)) set({ files });
};
export const loadThread = async (threadId) => {
  const generation = get().deletions;
  const thread = threadId ? await api("GET", `/threads/${threadId}`) : null;
  if (get().deletions === generation && get().view === "task" && get().task?.threadId === threadId && !isDeleted("thread", threadId)) set({ thread });
};

export function addPending(fileList) { if (fileList?.length) set((s) => ({ pending: [...s.pending, ...toPending(fileList)] })); }
export function removePending(i) { set((s) => { s.pending[i]?.url && URL.revokeObjectURL(s.pending[i].url); return { pending: s.pending.filter((_, k) => k !== i) }; }); }
export function clearPending() { releasePending(get().pending); set({ pending: [] }); }

export function closeStream() {
  const es = get().es;
  if (es) es.close();
  set({ es: null });
}

const LOADERS = { home: [loadTasks, loadThreads, loadArchivedThreads, loadQuota, loadPolicy], log: [loadLog], ext: [loadExt], ctx: [loadCtx, loadPolicy, loadPlatformMemory] };

export async function goto(view) {
  closeStream();
  clearPending();
  set((s) => ({ view, hint: "", navigationId: s.navigationId + 1 }));
  await Promise.all((LOADERS[view] || []).map((f) => f()));
}

export async function refresh() {
  const view = get().view;
  const loaders = new Set([health, loadTasks, loadApprovals, ...(LOADERS[view] || [])]);
  const results = await Promise.allSettled([...loaders].map((fn) => fn()));
  if (results.some((r) => r.status === "rejected") && get().view === view) set({ hint: "部分状态暂未刷新，请稍后重试。" });
}

const EVENT_TYPES = ["queued", "routed", "thread", "waiting", "dispatched", "text", "tool_call", "agent", "supervisor", "feedback", "sealed", "credential_repair", "step", "checkpoint", "approval_request", "approval_resolved", "attempt_failed", "refusal", "redispatch", "handoff", "summary", "done", "partial", "blocked", "failed", "cancelled", "cleaned"];
const RELOAD_ON = new Set(["approval_request", "approval_resolved", "done", "partial", "blocked", "checkpoint", "failed", "cancelled", "redispatch", "dispatched", "routed", "cleaned", "handoff", "summary", "thread"]);

/** Open the task view and follow its event stream (`/tasks/${id}/events`, SSE). */
export function openTask(id) {
  if (isDeleted("task", id)) return;
  closeStream();
  clearPending();
  set((s) => ({ view: "task", task: s.tasks.find((t) => t.id === id) || null, events: [], hint: "", files: { root: null, files: [] }, thread: null, navigationId: s.navigationId + 1 }));
  const es = new EventSource(`/tasks/${id}/events`);
  const current = () => get().view === "task" && get().es === es && !isDeleted("task", id);
  const openingGeneration = get().deletions;
  set({ es });
  api("GET", "/tasks/" + id).then(async (task) => {
    if (!current() || get().deletions !== openingGeneration) return;
    set({ task });
    const thread = task.threadId ? await api("GET", `/threads/${task.threadId}`) : null;
    if (current() && get().deletions === openingGeneration) set({ thread });
  }).catch((err) => { if (current()) set({ hint: err.message }); });
  api("GET", `/tasks/${id}/files`).then((files) => { if (current()) set({ files }); }).catch(() => undefined);
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, async (m) => {
      if (!current()) return;
      const ev = JSON.parse(m.data);
      set((s) => ({ events: [...s.events, ev] }));
      if (RELOAD_ON.has(type)) {
        try {
          const generation = get().deletions;
          const [task, files] = await Promise.all([api("GET", "/tasks/" + id), api("GET", `/tasks/${id}/files`).catch(() => null), loadApprovals()]);
          if (!current() || get().deletions !== generation) return;
          set({ task, ...(files ? { files } : {}) });
          const thread = task.threadId ? await api("GET", `/threads/${task.threadId}`) : null;
          if (current() && get().deletions === generation) set({ thread });
        } catch (err) { if (current()) set({ hint: err.message }); }
      }
    });
  }
  es.onerror = () => es.close();
}

export const submissionKey = (parentId) => parentId ? `followup:${parentId}` : "home";
export function setTaskSubmission(key, submission) {
  set((s) => ({ taskSubmissions: { ...s.taskSubmissions, [key]: submission } }));
}

/** Upload a snapshot of attachments, then show the accepted task without waiting for list refreshes. */
export async function submitTask(body, { onAccepted } = {}) {
  const key = submissionKey(body.parent_id);
  if (["uploading", "sending", "uncertain"].includes(get().taskSubmissions[key]?.status)) return;
  const origin = { navigationId: get().navigationId, view: get().view, taskId: get().task?.id };
  const pending = [...get().pending];
  const startedAt = Date.now();
  const update = (value) => setTaskSubmission(key, { startedAt, ...value });
  const current = () => get().navigationId === origin.navigationId && get().view === origin.view && (origin.view !== "task" || get().task?.id === origin.taskId);
  let stage = pending.length ? "uploading" : "sending";
  update({ status: stage, message: pending.length ? "正在上传附件，请稍候…" : "正在发送消息，请稍候…" });
  const slow = setTimeout(() => {
    const sub = get().taskSubmissions[key];
    if (sub?.status === "uploading" || sub?.status === "sending") update({ ...sub, message: sub.phase === "sealing"
      ? "消息已到达，模型仍在检查敏感字段并准备加密；此时还未开始任务分诊。请勿重复发送。"
      : sub.phase === "creating" ? "敏感信息处理已完成，正在创建任务回执，请勿重复发送。"
      : "发送仍在处理中，可能需要几十秒；后台会先检查敏感字段并加密，再创建任务。请勿重复点击。" });
  }, 8_000);
  let task;
  try {
    const attachments = await uploadPending(pending, { timeoutMs: 120_000 });
    stage = "sending";
    if (pending.length) update({ status: "sending", message: "附件已上传，正在发送消息…" });
    task = await postTask(attachments.length ? { ...body, attachments } : body, { onProgress: ({ stage: phase, elapsedMs }) => {
      const checked = get().taskSubmissions[key]?.phase === "sealing";
      update({ status: "sending", phase, serverElapsedMs: elapsedMs, message: phase === "sealing"
        ? "消息已到达，正在识别敏感字段并加密；完成后进入任务分诊。"
        : checked ? `敏感信息处理完成（${(elapsedMs / 1000).toFixed(1)} 秒），正在创建任务回执…` : "消息已到达，正在创建任务回执…" });
    } });
    if (!task || typeof task.id !== "string") throw new Error("Missing task receipt");
  } catch (err) {
    const rejected = stage === "uploading" || [400, 401, 403, 404, 409, 413, 422, 429, 503].includes(err.status);
    let message = stage === "uploading"
      ? "附件上传失败，消息尚未发送。草稿和附件已保留，请重试。"
      : !rejected ? "发送结果待确认，消息可能已收到。请刷新任务列表核对，暂勿重复发送。草稿已保留。"
      : err.status === 503 || err.status === 429 ? "服务暂时无法接收消息，请稍后重试。草稿已保留。"
      : err.status === 404 ? "原任务已不存在，请回首页发送新消息。草稿已保留。"
      : err.status === 409 ? "线程状态已变化，请检查是否已归档后重试。草稿已保留。"
      : "发送失败，请检查内容、工作目录和选项后重试。草稿已保留。";
    if (!current()) message = message.replace("草稿和附件已保留，", "").replace("草稿已保留。", "");
    update({ status: rejected ? "error" : "uncertain", message });
    return;
  } finally { clearTimeout(slow); }

  // The POST succeeded. No later refresh failure may turn this receipt back into a send failure.
  if (current()) onAccepted?.();
  update({ status: "sent", taskId: task.id, message: "消息已发送。" });
  const consumed = get().pending.filter((entry) => pending.includes(entry));
  releasePending(consumed);
  set((s) => ({ tasks: [task, ...s.tasks.filter((t) => t.id !== task.id)], pending: s.pending.filter((entry) => !pending.includes(entry)) }));
  if (current() && !get().pending.length) openTask(task.id);
  // Navigation is immediate; a slow list GET is never on the critical path of sending.
  void Promise.allSettled([loadTasks(), loadThreads()]).then((results) => {
    if (results.some((r) => r.status === "rejected") && get().taskSubmissions[key]?.taskId === task.id) {
      setTaskSubmission(key, { startedAt, status: "sent", taskId: task.id, message: "消息已发送，任务列表暂未刷新。可打开任务查看进展。" });
    }
  });
}

export async function refreshSubmission(key) {
  const results = await Promise.allSettled([loadTasks(), loadThreads()]);
  const sub = get().taskSubmissions[key];
  if (sub?.status === "uncertain") setTaskSubmission(key, { ...sub, message: results.some((r) => r.status === "rejected")
    ? "暂时无法刷新任务列表，请稍后再试；发送结果仍待确认，请勿重复发送。草稿已保留。"
    : "任务列表已刷新，请核对是否已收到这条消息。发送结果尚待确认，请勿直接重复发送。草稿已保留。" });
}

/** `given` = {text} for one question, {answers: {id: [..]}} for several (docs/supervisor-v0.md §1c). */
export async function answer(taskId, approvalId, given) {
  if (["sending", "sent", "uncertain", "resolved"].includes(get().answerSubmissions[approvalId]?.status)) return;
  setAnswerSubmission(approvalId, { taskId, status: "sending", message: "正在提交答复，请稍候…" });
  try {
    // A slow response can still be accepted by the server. Never automatically resend on timeout.
    await api("POST", `/tasks/${taskId}/answer`, { approval_id: approvalId, ...given }, { timeoutMs: 120_000 });
  } catch (err) {
    const retryable = err.status === 400 || err.status === 422 || err.status === 503;
    setAnswerSubmission(approvalId, { taskId, status: retryable ? "error" : "uncertain", message: retryable
      ? (err.status === 503 ? "暂时无法处理答复，请稍后重试。输入已保留。" : "提交失败，请检查答复后重试。输入已保留。")
      : "提交结果待确认，请稍后刷新状态；暂勿重复提交。输入已保留。" });
    if (!retryable) await refreshAnswer(taskId, approvalId);
    return;
  }
  // Commit success before refresh: a failed GET must never enable a duplicate POST.
  setAnswerSubmission(approvalId, { taskId, status: "sent", message: "答复已提交，继续处理中…" });
  await refreshAnswer(taskId, approvalId);
}

export function setAnswerSubmission(approvalId, submission) {
  set((s) => ({ answerSubmissions: { ...s.answerSubmissions, [approvalId]: submission } }));
}

/** Only reload state; this is also the safe action after a response was lost. */
export async function refreshAnswer(taskId, approvalId) {
  const results = await Promise.allSettled([
    loadApprovals(), loadTasks(),
    api("GET", `/tasks/${taskId}`).then((task) => { if (get().task?.id === taskId) set({ task }); return task; }),
  ]);
  const submission = get().answerSubmissions[approvalId];
  if (submission?.status === "uncertain" && results[0].status === "fulfilled" && results[2].status === "fulfilled"
    && !results[0].value.approvals.some((a) => a.id === approvalId) && results[2].value.status !== "waiting_approval") {
    // The question can also expire or be cancelled. Do not claim the lost answer was accepted.
    setAnswerSubmission(approvalId, { taskId, status: "resolved", message: "问题已结束，请查看任务当前进展。" });
  } else if (results.some((r) => r.status === "rejected") && submission?.status === "sent") {
    setAnswerSubmission(approvalId, { taskId, status: "sent", message: "答复已提交，页面状态暂未刷新，请刷新状态查看进展。" });
  }
}

export async function savePolicy(policy) {
  const r = await api("PUT", "/approvals/policy", policy);
  set((s) => ({ policy: { ...s.policy, policy: r.policy } }));
}

export async function approve(taskId, approvalId, decision) {
  await api("POST", `/tasks/${taskId}/approve`, { approval_id: approvalId, decision });
  await Promise.all([loadApprovals(), loadTasks()]);
}

export const cancelTask = (id) => api("POST", `/tasks/${id}/cancel`);

/** 👍 / 👎 on a finished task; clicking the same one again clears it. */
export async function rateTask(id, rating) {
  await api("POST", `/tasks/${id}/rate`, { rating });
  if (get().view !== "task" || get().task?.id !== id || isDeleted("task", id)) return;
  const task = await api("GET", "/tasks/" + id);
  if (get().view === "task" && get().task?.id === id && !isDeleted("task", id)) set({ task });
}

/** Hand the task to another executor in the same thread; `pin` = "harness/model" or empty for the router. */
export async function handoffTask(id, pin) {
  const body = pin && pin.includes("/") ? { to: { harness: pin.slice(0, pin.indexOf("/")), model: pin.slice(pin.indexOf("/") + 1) } } : {};
  const next = await api("POST", `/tasks/${id}/handoff`, body);
  await loadTasks();
  openTask(next.id);
}

export async function archiveThread(id) {
  await api("POST", `/threads/${id}/archive`);
  await loadThread(id);
}

/** Run an extension mutation, surface its error in the view, then reload the registries. */
export async function extAction(fn) {
  set({ extHint: "" });
  try { await fn(); } catch (err) { set({ extHint: err.message }); }
  await loadExt();
}

export async function saveCtx(text) {
  set((s) => ({ ctx: { ...s.ctx, hint: "", saved: false } }));
  try {
    await api("PUT", "/context", { text });
    await loadCtx();
    set((s) => ({ ctx: { ...s.ctx, saved: true } }));
  } catch (err) {
    set((s) => ({ ctx: { ...s.ctx, hint: err.message } }));
  }
}

export async function saveMem(text) {
  set((s) => ({ mem: { ...s.mem, hint: "", saved: false } }));
  try {
    await api("PUT", "/memory", { text });
    await loadCtx();
    set((s) => ({ mem: { ...s.mem, saved: true } }));
  } catch (err) {
    set((s) => ({ mem: { ...s.mem, hint: err.message } }));
  }
}

export async function loadCtxExample() {
  const r = await api("GET", "/context/example");
  set((s) => ({ ctx: { ...s.ctx, draft: r.text, saved: false } }));
}
