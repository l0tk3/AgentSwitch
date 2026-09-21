/** Home: composer, pending approvals, task table, quota panel. */

import { ACTIVE, ago, esc, target, when } from "../lib/api.js";
import { approve, loadQuota, openTask, submitTask } from "../lib/actions.js";
import { set } from "../lib/state.js";
import { pendingList } from "../lib/files.js";
import { quotaPanel } from "./quota.js";
import { firstLine } from "../lib/feedback.js";

const $ = (s) => document.querySelector(s);

function composer(hint, pending) {
  return `<section class="card composer" data-dropzone>
    <textarea id="c-task" data-keep rows="3" placeholder="跟路由器说要做什么…  ⌘↵ 发送"></textarea>
    <div class="row opts">
      <input id="c-cwd" data-keep placeholder="工作目录（留空 = 临时目录，用完即删）">
      <input id="c-pin" data-keep class="pin" placeholder="指定 harness/model，留空由路由器决定">
      <select id="c-browser" data-keep><option value="">浏览器：路由器决定</option><option value="1">需要浏览器</option></select>
      <button data-attach title="也可以拖进来或直接粘贴截图">📎 附件</button>
      <button class="primary" id="c-send">发送</button>
    </div>
    ${pendingList(pending)}
    <div class="hint" style="margin-top:8px">${hint ? `<span class="error">${esc(hint)}</span> · ` : ""}附件放进任务目录的 in/，内容原样进模型上下文：截图里别带密码。模型交付的文件从任务页下载。</div>
  </section>`;
}

export function approvalCard(a, task) {
  return `<div class="card warn">
    <div class="dim">${task ? esc(task.task.slice(0, 80)) + " · " : ""}${when(a.createdAt)}</div>
    <div style="margin-top:4px"><b>${esc(a.action)}</b></div>
    <div class="dim pre">${esc(a.evidence)}</div>
    <div class="row" style="margin-top:10px"><button class="ok grow" data-approve="${a.id}" data-task="${a.taskId}" data-decision="allow">允许</button><button class="bad grow" data-approve="${a.id}" data-task="${a.taskId}" data-decision="deny">拒绝</button></div>
  </div>`;
}

function taskRow(t) {
  const who = target(t) || (t.status === "routing" ? "分诊中…" : "—");
  const tail = t.status === "done" ? `<div class="dim ellipsis">${esc(t.spoken || firstLine(t.result).slice(0, 160))}</div>`
    : t.status === "failed" ? `<div class="dim error ellipsis">${esc(t.spoken || firstLine(t.error).slice(0, 160))}</div>` : "";
  return `<tr data-open="${t.id}">
    <td class="nowrap"><span class="badge ${t.status}">${t.status}</span></td>
    <td class="task-cell"><div class="t">${esc(t.task)}</div>${tail}</td>
    <td class="nowrap dim">${esc(who)}${t.ephemeral ? '<div class="dim">临时目录</div>' : ""}</td>
    <td class="nowrap dim">${ago(t.createdAt)}</td>
  </tr>`;
}

function taskTable(tasks) {
  if (!tasks.length) return "";
  return `<table class="list"><thead><tr><th>状态</th><th>任务</th><th>目标</th><th>时间</th></tr></thead><tbody>${tasks.map(taskRow).join("")}</tbody></table>`;
}

/** One open thread: title, a line of summary, who did it last; click opens its latest task. */
function threadRow(th, tasks) {
  const latest = tasks.filter((t) => t.threadId === th.id).sort((a, b) => b.createdAt - a.createdAt)[0];
  const running = tasks.some((t) => t.threadId === th.id && ACTIVE.has(t.status));
  const line = th.summary ? (th.summary.progress || th.summary.goal) : (latest ? latest.task : "");
  return `<tr ${latest ? `data-open="${latest.id}"` : ""}>
    <td class="nowrap">${running ? '<span class="badge running">进行中</span>' : `<span class="badge">${th.taskCount} 次</span>`}</td>
    <td class="task-cell"><div class="t">${esc(th.title || "（未命名）")}</div><div class="dim ellipsis">${esc((line || "").slice(0, 160))}</div></td>
    <td class="nowrap dim">${esc(th.lastTarget ? th.lastTarget.harness + "/" + th.lastTarget.model : "—")}</td>
    <td class="nowrap dim">${ago(th.lastActivity || th.updatedAt)}</td>
  </tr>`;
}

function threadTable(threads, tasks) {
  if (!threads.length) return "";
  return `<table class="list"><thead><tr><th>执行</th><th>线程</th><th>上次执行者</th><th>活动</th></tr></thead><tbody>${threads.map((th) => threadRow(th, tasks)).join("")}</tbody></table>`;
}

export function render(s) {
  const active = s.tasks.filter((t) => ACTIVE.has(t.status));
  const recent = s.tasks.filter((t) => !ACTIVE.has(t.status));
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  return `<div class="page-title">首页</div>
    ${composer(s.hint, s.pending)}
    <div class="cols" style="margin-top:22px">
      <div>
        ${s.approvals.length ? `<h2>待审批 ${s.approvals.length}</h2><div class="approvals">${s.approvals.map((a) => approvalCard(a, byId.get(a.taskId))).join("")}</div>` : ""}
        ${active.length ? `<h2>进行中 ${active.length}</h2>${taskTable(active)}` : ""}
        ${s.threads.length ? `<h2>线程 ${s.threads.length}</h2>${threadTable(s.threads, s.tasks)}` : ""}
        <details ${s.threads.length ? "" : "open"} style="margin-top:14px"><summary><h2 style="display:inline">最近任务</h2></summary>${taskTable(recent) || `<div class="empty">还没有任务。上面输入一句话，路由器会决定交给谁；零散的追问会被归到已有线程。</div>`}</details>
      </div>
      <aside>${quotaPanel(s.quota)}</aside>
    </div>`;
}

async function send() {
  const task = $("#c-task").value.trim();
  if (!task) return;
  const cwd = $("#c-cwd").value.trim();
  const pin = $("#c-pin").value.trim();
  const body = { task, ...(cwd ? { cwd } : { ephemeral: true }), ...($("#c-browser").value === "1" ? { needs_browser: true } : {}) };
  if (pin.includes("/")) body.pin = { harness: pin.slice(0, pin.indexOf("/")), model: pin.slice(pin.indexOf("/") + 1) };
  $("#c-send").disabled = true;
  try { await submitTask(body); }
  catch (err) { set({ hint: err.message }); }
}

export const bindings = [
  { sel: "#c-send", run: () => send() },
  { sel: "#q-refresh", run: (el) => { el.disabled = true; return loadQuota(true); } },
  { sel: "tr[data-open]", run: (el) => openTask(el.dataset.open) },
  { sel: "[data-approve]", run: (el) => { el.disabled = true; return approve(el.dataset.task, el.dataset.approve, el.dataset.decision); } },
];

export const submitKeys = { "c-task": "c-send" };
