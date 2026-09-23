/** Home: composer, pending approvals, task table, quota panel. */

import { ACTIVE, ago, esc, target, taskStatusLabel, when } from "../lib/api.js";
import { approve, loadQuota, openTask, submitTask } from "../lib/actions.js";
import { get, set } from "../lib/state.js";
import { questionsOf, questionBindings } from "../lib/questions.js";
import { pendingList } from "../lib/files.js";
import { quotaPanel } from "./quota.js";
import { firstLine } from "../lib/feedback.js";
import { deleteBindings, deleteButton, deleteNotice } from "../lib/deletions.js";
import { sendBindings, sendFeedback, sendState } from "../lib/sending.js";

const $ = (s) => document.querySelector(s);

function composer(s) {
  const { hint, pending } = s;
  const sub = sendState(s, "home");
  const disabled = sub.locked ? "disabled" : "";
  return `<section class="card composer" data-dropzone data-composer-key="home" aria-busy="${sub.busy}">
    <textarea id="c-task" data-keep ${disabled} rows="3" placeholder="跟路由器说要做什么…  ⌘↵ 发送"></textarea>
    <div class="row opts">
      <input id="c-cwd" data-keep ${disabled} placeholder="工作目录（留空 = 临时目录，用完即删）">
      <input id="c-pin" data-keep ${disabled} class="pin" placeholder="指定 harness/model，留空由路由器决定">
      <select id="c-browser" data-keep ${disabled}><option value="">浏览器：路由器决定</option><option value="1">需要浏览器</option></select>
      <select id="c-approval" data-keep ${disabled} title="这次任务的审批由谁来批；默认按「上下文」页的审批策略"><option value="">审批：按默认策略</option><option value="manual">审批：全部我来批</option><option value="auto">审批：全权交给路由器</option><option value="scoped">审批：按划定范围</option></select>
      <button data-attach ${disabled} title="也可以拖进来或直接粘贴截图">📎 附件</button>
      <button class="primary" id="c-send" ${disabled}>${sub.label}</button>
    </div>
    ${pendingList(pending, sub.locked)}
    ${sendFeedback(s, "home")}
    <div class="hint" style="margin-top:8px">${hint ? `<span class="error">${esc(hint)}</span> · ` : ""}附件放进任务目录的 in/，内容原样进模型上下文：截图里别带密码。任务里可以直接写账号密码或贴账号表：存下来之前会先做成密文，执行者只见密文。模型交付的文件从任务页下载。</div>
  </section>`;
}

function questionBlock(a, q, i, disabled) {
  const box = `q-${a.id}-${i}`;
  const options = (q.options || []).length ? `<div class="chips" style="margin-top:6px">${q.options.map((o) => `<button class="chip" data-opt="${esc(o.label)}" data-for="${box}" data-multi="${!!q.multi}" title="${esc(o.description || "")}" ${disabled ? "disabled" : ""}>${esc(o.label)}</button>`).join("")}</div>` : "";
  return `<div style="margin-top:8px">${q.header ? `<span class="badge">${esc(q.header)}</span> ` : ""}<b>${esc(q.text)}</b>
    ${q.secret ? '<div class="dim error">敏感信息：填 secret-gate 密文（enc:v1:…），不要填明文</div>' : ""}${options}
    <textarea id="${box}" data-keep rows="2" ${disabled ? "disabled" : ""} placeholder="${(q.options || []).length ? "点上面的选项，或自己写" : "写答复"}${q.multi ? "，多个用逗号分开" : ""}" style="margin-top:6px"></textarea></div>`;
}

export function approvalCard(a, task, submission = {}) {
  if (a.kind === "question") {
    const { source, questions } = questionsOf(a);
    const fromExecutor = source === "executor";
    const locked = ["sending", "sent", "uncertain", "resolved"].includes(submission.status);
    const label = { sending: "提交中…", sent: "已提交", uncertain: "结果待确认", resolved: "问题已结束", error: "重新提交" }[submission.status] || "确定";
    return `<div class="card warn" aria-busy="${submission.status === "sending"}">
      <div class="dim">${task ? esc(task.task.slice(0, 80)) + " · " : ""}${when(a.createdAt)} · ${fromExecutor ? "执行者在问你（答复直接回到它手里）" : "路由器在问你"}</div>
      ${["sent", "resolved"].includes(submission.status) ? "" : questions.map((q, i) => questionBlock(a, q, i, locked)).join("")}
      ${submission.message ? `<div class="hint ${submission.status === "error" ? "error" : ""}" role="${submission.status === "error" ? "alert" : "status"}" aria-live="polite" style="margin-top:8px">${esc(submission.message)}</div>` : ""}
      <div class="row" style="margin-top:8px"><button class="primary grow" data-answer="${a.id}" data-task="${a.taskId}" ${locked ? "disabled" : ""}>${label}</button><button class="bad" data-approve="${a.id}" data-task="${a.taskId}" data-decision="deny" ${locked ? "disabled" : ""}>暂不回答，停止执行</button>${["sent", "uncertain"].includes(submission.status) ? `<button data-answer-refresh="${a.id}" data-task="${a.taskId}">刷新状态</button>` : ""}</div>
    </div>`;
  }
  return `<div class="card warn">
    <div class="dim">${task ? esc(task.task.slice(0, 80)) + " · " : ""}${when(a.createdAt)}</div>
    <div style="margin-top:4px"><b>${esc(a.action)}</b></div>
    <div class="dim pre">${esc(a.evidence)}</div>
    <div class="row" style="margin-top:10px"><button class="ok grow" data-approve="${a.id}" data-task="${a.taskId}" data-decision="allow">允许</button><button class="bad grow" data-approve="${a.id}" data-task="${a.taskId}" data-decision="deny">拒绝</button></div>
  </div>`;
}

/** Keep the receipt visible if approvals refreshed before the corresponding task status did. */
export function answerNotices(s, taskId) {
  return Object.entries(s.answerSubmissions || {}).filter(([, sub]) => {
    const t = taskId && s.task?.id === sub.taskId ? s.task : s.tasks.find((t) => t.id === sub.taskId);
    return (!taskId || sub.taskId === taskId) && ["sent", "uncertain"].includes(sub.status) && t?.status === "waiting_approval" && !s.approvals.some((a) => a.taskId === sub.taskId);
  }).map(([id, sub]) => `<div class="card" role="status"><div>${esc(sub.status === "sent" ? sub.message : "问题状态已更新，请查看任务进展。")}</div><button class="small" style="margin-top:8px" data-answer-refresh="${id}" data-task="${sub.taskId}">刷新状态</button></div>`).join("");
}

function taskRow(t, s) {
  const who = target(t) || (t.status === "routing" ? "分诊中…" : "—");
  const tail = t.status === "done" ? `<div class="dim ellipsis">${esc(t.spoken || firstLine(t.result).slice(0, 160))}</div>`
    : ["partial", "blocked"].includes(t.status) ? `<div class="dim ellipsis">${esc(firstLine(t.error || t.result).slice(0, 160))}</div>`
    : t.status === "failed" ? `<div class="dim error ellipsis">${esc(t.spoken || firstLine(t.error).slice(0, 160))}</div>` : "";
  return `<tr data-open="${t.id}">
    <td class="nowrap"><span class="badge ${t.status}">${esc(taskStatusLabel(t))}</span></td>
    <td class="task-cell"><div class="t">${esc(t.task)}</div>${tail}</td>
    <td class="nowrap dim">${esc(who)}${t.ephemeral ? '<div class="dim">临时目录</div>' : ""}</td>
    <td class="nowrap dim">${ago(t.createdAt)}</td>
    <td>${deleteButton("task", t.id, s, ACTIVE.has(t.status))}${deleteNotice("task", t.id, s)}</td>
  </tr>`;
}

function taskTable(tasks, s) {
  if (!tasks.length) return "";
  return `<table class="list task-list"><thead><tr><th>状态</th><th>任务</th><th>目标</th><th>时间</th><th>操作</th></tr></thead><tbody>${tasks.map((t) => taskRow(t, s)).join("")}</tbody></table>`;
}

/** One open thread: title, a line of summary, who did it last; click opens its latest task. */
function threadRow(th, tasks, s, archived = false) {
  const latest = tasks.filter((t) => t.threadId === th.id).sort((a, b) => b.createdAt - a.createdAt)[0];
  const running = tasks.some((t) => t.threadId === th.id && ACTIVE.has(t.status));
  const line = th.summary ? (th.summary.progress || th.summary.goal) : (latest ? latest.task : "");
  return `<tr ${latest ? `data-open="${latest.id}"` : ""}>
    <td class="nowrap">${running ? '<span class="badge running">进行中</span>' : `<span class="badge">${th.taskCount} 次</span>`}</td>
    <td class="task-cell"><div class="t">${esc(th.title || "（未命名）")}</div><div class="dim ellipsis">${esc((line || "").slice(0, 160))}</div></td>
    <td class="nowrap dim">${esc(th.lastTarget ? th.lastTarget.harness + "/" + th.lastTarget.model : "—")}</td>
    <td class="nowrap dim">${ago(th.lastActivity || th.updatedAt)}</td>
    ${archived ? `<td>${deleteButton("thread", th.id, s, running)}${deleteNotice("thread", th.id, s)}</td>` : ""}
  </tr>`;
}

function threadTable(threads, tasks, s, archived = false) {
  if (!threads.length) return "";
  return `<table class="list"><thead><tr><th>执行</th><th>线程</th><th>上次执行者</th><th>活动</th>${archived ? "<th>操作</th>" : ""}</tr></thead><tbody>${threads.map((th) => threadRow(th, tasks, s, archived)).join("")}</tbody></table>`;
}

export function render(s) {
  const active = s.tasks.filter((t) => ACTIVE.has(t.status));
  const recent = s.tasks.filter((t) => !ACTIVE.has(t.status));
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  return `<div class="page-title">首页</div>
    ${composer(s)}
    <div class="cols" style="margin-top:22px">
      <div>
        ${s.approvals.length ? `<h2>待审批 ${s.approvals.length}</h2><div class="approvals">${s.approvals.map((a) => approvalCard(a, byId.get(a.taskId), s.answerSubmissions?.[a.id])).join("")}</div>` : ""}
        ${answerNotices(s)}
        ${active.length ? `<h2>进行中 ${active.length}</h2>${taskTable(active, s)}` : ""}
        ${s.threads.length ? `<h2>线程 ${s.threads.length}</h2>${threadTable(s.threads, s.tasks, s)}` : ""}
        <details id="recent-tasks" data-keep-open ${s.threads.length ? "" : "open"} style="margin-top:14px"><summary><h2 style="display:inline">最近任务</h2></summary>${taskTable(recent, s) || `<div class="empty">还没有任务。上面输入一句话，路由器会决定交给谁；零散的追问会被归到已有线程。</div>`}</details>
        <details id="archived-threads" data-keep-open style="margin-top:14px"><summary><h2 style="display:inline">已归档线程 ${(s.archivedThreads || []).length}</h2></summary>${threadTable(s.archivedThreads || [], s.tasks, s, true) || '<div class="empty">没有已归档线程。</div>'}</details>
      </div>
      <aside>${quotaPanel(s.quota)}</aside>
    </div>`;
}

async function send() {
  if (sendState(get(), "home").locked) return;
  const task = $("#c-task").value.trim();
  if (!task) { set({ hint: "请先填写要发送的消息。" }); return; }
  const cwd = $("#c-cwd").value.trim();
  const pin = $("#c-pin").value.trim();
  const body = { task, ...(cwd ? { cwd } : { ephemeral: true }), ...($("#c-browser").value === "1" ? { needs_browser: true } : {}) };
  if (pin.includes("/")) body.pin = { harness: pin.slice(0, pin.indexOf("/")), model: pin.slice(pin.indexOf("/") + 1) };
  const mode = $("#c-approval").value;
  if (mode) body.approval = mode === "scoped" ? { mode, human: (get().policy?.policy?.human) || undefined } : { mode };
  await submitTask(body, { onAccepted: () => { const field = $("#c-task"); if (field) field.value = ""; } });
}

export const bindings = [
  ...sendBindings,
  { sel: "#c-send", run: () => send() },
  { sel: "#q-refresh", run: async (el) => { el.disabled = true; try { await loadQuota(true); } finally { el.disabled = false; } } },
  ...deleteBindings,
  { sel: "tr[data-open]", run: (el) => openTask(el.dataset.open) },
  { sel: "[data-approve]", run: (el) => { el.disabled = true; return approve(el.dataset.task, el.dataset.approve, el.dataset.decision); } },
  ...questionBindings,
];

export const submitKeys = { "c-task": "c-send" };
