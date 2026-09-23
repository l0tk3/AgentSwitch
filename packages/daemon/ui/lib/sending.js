/** Submission feedback shared by the home and follow-up composers. */
import { esc } from "./api.js";
import { openTask, refreshSubmission, setTaskSubmission } from "./actions.js";
import { get } from "./state.js";

export function sendState(s, key) {
  const sub = s.taskSubmissions?.[key] || {};
  const busy = ["uploading", "sending"].includes(sub.status);
  return { ...sub, busy, locked: busy || sub.status === "uncertain", label: busy ? sub.phase === "sealing" ? "检查并加密中…" : sub.phase === "creating" ? "创建任务中…" : "发送中…" : sub.status === "uncertain" ? "结果待确认" : sub.status === "error" ? "重新发送" : "发送" };
}

export function sendFeedback(s, key) {
  const sub = sendState(s, key);
  if (!sub.message) return "";
  return `<div class="hint ${sub.status === "error" ? "error" : ""}" role="${sub.status === "error" ? "alert" : "status"}" aria-live="polite" style="margin-top:8px">${esc(sub.message)}</div>
    ${sub.status === "uncertain" ? `<div class="row" style="margin-top:8px"><button class="small" data-send-refresh="${esc(key)}">刷新任务列表</button><button class="small" data-send-unlock="${esc(key)}">核对后允许重发</button></div>` : ""}
    ${sub.status === "sent" && sub.taskId ? `<button class="small" style="margin-top:8px" data-send-open="${esc(sub.taskId)}">查看已发送任务</button>` : ""}`;
}

export const sendBindings = [
  { sel: "[data-send-refresh]", run: (el) => refreshSubmission(el.dataset.sendRefresh) },
  { sel: "[data-send-open]", run: (el) => openTask(el.dataset.sendOpen) },
  { sel: "[data-send-unlock]", run: (el) => {
    const key = el.dataset.sendUnlock;
    const sub = get().taskSubmissions[key];
    if (sub?.status !== "uncertain") return;
    if (!confirm("这条消息可能已经创建任务。请先检查最近任务；再次发送可能重复执行。\n确认没有收到这条消息，并允许重新发送吗？")) return;
    setTaskSubmission(key, { status: "error", message: "已允许重试，请检查保留的草稿后点击重新发送。" });
  } },
];
