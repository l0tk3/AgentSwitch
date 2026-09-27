/** Permanent deletion with immediate feedback and one confirmation per explicit user attempt. */

import { ACTIVE, api, esc } from "./api.js";
import { clearPending, closeStream, loadApprovals, loadArchivedThreads, loadTasks, loadThread, loadThreads } from "./actions.js";
import { get, set } from "./state.js";

const keyFor = (kind, id) => `${kind}:${id}`;
const update = (kind, id, value) => set((s) => ({ deletions: { ...s.deletions, [keyFor(kind, id)]: value } }));

export function deleteButton(kind, id, s, active = false) {
  const status = s.deletions?.[keyFor(kind, id)]?.status;
  if (status === "deleted") return "";
  const busy = status === "sending";
  return `<button class="bad small" data-delete-${kind}="${esc(id)}" ${active || busy ? "disabled" : ""} aria-busy="${busy}"${active ? ' title="请取消进行中的任务后再删除"' : ""}>${busy ? "删除中…" : active ? "取消后可删除" : status === "error" ? "重试删除" : kind === "thread" ? "删除整个会话" : "删除"}</button>`;
}

export function deleteNotice(kind, id, s) {
  const deletion = s.deletions?.[keyFor(kind, id)];
  return deletion?.status === "error" ? `<div class="hint error" role="alert" style="margin-top:6px">${esc(deletion.message)}</div>` : "";
}

function activeTarget(kind, id, s) {
  const tasks = [...s.tasks, ...(s.task ? [s.task] : []), ...(s.thread?.tasks || [])];
  const task = tasks.find((t) => t.id === id);
  const threadId = kind === "thread" ? id : task?.threadId;
  const belongs = (t) => kind === "task" && t.id === id || threadId && (t.threadId === threadId || s.thread?.id === threadId && (s.thread.tasks || []).some((x) => x.id === t.id));
  return tasks.some((t) => belongs(t) && ACTIVE.has(t.status));
}

export async function deleteRecord(kind, id) {
  const prior = get().deletions[keyFor(kind, id)];
  if (prior?.status === "sending" || prior?.status === "deleted") return;
  if (activeTarget(kind, id, get())) {
    update(kind, id, { status: "error", message: "该会话中有进行中的任务。请取消任务并等待结束后再删除。" });
    return;
  }
  const what = kind === "thread" ? "此会话内的全部任务、记录及平台保存的产物" : "此任务的记录及平台保存的产物";
  if (!confirm(`将永久删除${what}，无法恢复。工作目录不受影响。\n确定删除吗？`)) return;
  update(kind, id, { status: "sending", message: "正在删除…" });
  try {
    await api("DELETE", `/${kind === "thread" ? "threads" : "tasks"}/${id}`, undefined, { timeoutMs: 30_000 });
  } catch (err) {
    // A repeated DELETE after a lost response is safe; 404 means the desired state already exists.
    if (err.status !== 404) {
      update(kind, id, { status: "error", message: err.status === 409
        ? "该会话中还有任务正在执行或收尾。请取消任务并等待结束后重试删除。"
        : "删除暂未确认，请稍后重试。" });
      return;
    }
  }
  const s = get();
  const matches = (t) => t && (kind === "task" ? t.id === id : t.threadId === id);
  const removedIds = new Set([...s.tasks, ...(s.task ? [s.task] : []), ...(s.thread?.tasks || [])].filter(matches).map((t) => t.id));
  if (kind === "task") removedIds.add(id);
  const affectedThreadId = kind === "thread" ? id : [...s.tasks, ...(s.task ? [s.task] : []), ...(s.thread?.tasks || [])].find((t) => t.id === id)?.threadId;
  const emptyThread = kind === "task" && affectedThreadId && s.thread?.id === affectedThreadId && (s.thread.tasks || []).every((t) => removedIds.has(t.id));
  const removeThread = (th) => kind === "thread" ? th.id === id : emptyThread && th.id === affectedThreadId;
  const remainingThread = (th) => th.id === affectedThreadId ? { ...th, summary: null, taskCount: Math.max(0, th.taskCount - removedIds.size) } : th;
  const deletingDetail = s.view === "task" && matches(s.task);
  const affectedDetail = s.thread?.id === affectedThreadId;
  if (deletingDetail) { closeStream(); clearPending(); }
  set((current) => ({
    deletions: { ...current.deletions, [keyFor(kind, id)]: { status: "deleted" }, ...(emptyThread ? { [keyFor("thread", affectedThreadId)]: { status: "deleted" } } : {}), ...Object.fromEntries([...removedIds].map((taskId) => [keyFor("task", taskId), { status: "deleted" }])) },
    tasks: current.tasks.filter((t) => !matches(t)),
    threads: current.threads.filter((t) => !removeThread(t)).map(remainingThread),
    archivedThreads: current.archivedThreads.filter((t) => !removeThread(t)).map(remainingThread),
    approvals: current.approvals.filter((a) => !removedIds.has(a.taskId)),
    answerSubmissions: Object.fromEntries(Object.entries(current.answerSubmissions).filter(([, value]) => !removedIds.has(value.taskId))),
    ...(affectedDetail ? { thread: null } : {}),
    ...(matches(current.task) ? { task: null, events: [], files: { root: null, files: [] } } : {}),
    ...(deletingDetail ? { view: "home", hint: "" } : {}),
  }));
  const refreshed = await Promise.allSettled([loadTasks(), loadThreads(), loadArchivedThreads(), loadApprovals(), ...(affectedDetail && !deletingDetail && get().view === "task" ? [loadThread(affectedThreadId)] : [])]);
  if (refreshed.some((r) => r.status === "rejected")) set({ hint: "删除已完成，列表暂未刷新，请点击刷新查看最新状态。" });
}

export const deleteBindings = [
  { sel: "[data-delete-task]", run: (el) => deleteRecord("task", el.dataset.deleteTask) },
  { sel: "[data-delete-thread]", run: (el) => deleteRecord("thread", el.dataset.deleteThread) },
];
