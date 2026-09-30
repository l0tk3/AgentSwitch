/** Tasks (docs/ui-v0.md §7.4 网页控制台): the phone's tasks page on a desk — what is going on across the top, the record
 *  below it with the requests for you in their place, the composer at the bottom; a task opens beside (task.js). */

import { ACTIVE, agoShort, dayOf, esc, span, statusTone, statusWord, target, when } from "../lib/api.js";
import { approve, openTask, submitTask } from "../lib/actions.js";
import { get, set } from "../lib/state.js";
import { questionsOf, questionBindings } from "../lib/questions.js";
import { pendingList } from "../lib/files.js";
import { feedback, firstLine } from "../lib/feedback.js";
import { deleteBindings, deleteButton, deleteNotice } from "../lib/deletions.js";
import { sendBindings, sendFeedback, sendState } from "../lib/sending.js";
import { agentMark, spinner, square, topicSquare } from "../lib/sidebar.js";

const $ = (s) => document.querySelector(s);

const FEED = 40;

/** The composer, at the bottom as on the phone, with what a desk has room for under it. */
function composer(s) {
  const { hint } = s;
  const sub = sendState(s, "home");
  const disabled = sub.locked ? "disabled" : "";
  return `<section class="compose" data-dropzone data-composer-key="home" aria-busy="${sub.busy}">
    ${s.pendingFor === "home" ? pendingList(s.pending, sub.locked) : ""}
    <div class="crow"><button class="sqb" data-attach ${disabled} title="添加附件（也可拖入文件或粘贴截图）" aria-label="attach">+</button><textarea id="c-task" data-keep ${disabled} rows="1" placeholder="向 Mac 发送任务或问题"></textarea><button class="sqb go" id="c-send" ${disabled} title="${esc(sub.label)} ⌘↩" aria-label="${esc(sub.label)}">${sub.busy ? spinner() : "↑"}</button></div>
    <div class="opts">
      <label><span>// folder</span><input id="c-cwd" data-keep ${disabled} placeholder="临时目录" title="工作目录；留空则使用临时目录，任务结束后删除"></label>
      <label><span>// model</span><input id="c-pin" data-keep ${disabled} class="pin" placeholder="auto" title="指定执行器/模型，如 codex/gpt-5.5；留空由调度模型决定"></label>
      <label><span>// browser</span><select id="c-browser" data-keep ${disabled}><option value="">auto</option><option value="1">yes</option></select></label>
      <label><span>// approval</span><select id="c-approval" data-keep ${disabled} title="本任务的审批方式；默认使用「context」页的审批策略"><option value="">default</option><option value="manual">ask each</option><option value="scoped">auto</option><option value="auto">auto · all</option></select></label>
      <span class="sp"></span><kbd>${esc(sub.busy || sub.status === "uncertain" ? sub.label : "⌘↩ send")}</kbd>
    </div>
    ${sendFeedback(s, "home")}
    ${hint ? `<div class="hint error">${esc(hint)}</div>` : ""}
  </section>`;
}

/** A task's status line, as the phone's: the mark, the word, the agent, who, how long. */
export function statusLine(t) {
  const tone = statusTone(t);
  const mark = tone === "busy" ? spinner() : square(tone, t.status === "cancelled");
  const clock = ACTIVE.has(t.status) ? span(Date.now() - t.createdAt) : span((t.updatedAt || t.createdAt) - t.createdAt);
  return `${mark}<span class="word ${tone}">${esc(statusWord(t))}</span>${t.harness ? agentMark(t.harness) : ""}<span class="who" title="${esc(target(t))}">${esc(target(t) || (t.status === "routing" ? "routing" : ""))}</span><span class="faint">${clock}</span>`;
}

/** A task as the record says it: its outcome, or where it is now. */
function outcome(t, s) {
  const f = feedback(t, []);
  if (t.status === "done") return `<div class="say">${esc(t.spoken || firstLine(t.result) || "已完成")}</div>`;
  if (t.status === "failed") return `<div class="say bad">${esc(t.spoken || firstLine(t.error) || "失败")}</div>`;
  if (t.status === "partial" || t.status === "blocked") return `<div class="say"><span class="w">${esc(f.label)}</span> · ${esc(f.detail)}</div>`;
  if (t.status === "cancelled") return "";
  const waiting = s.approvals.some((a) => a.taskId === t.id);
  return waiting ? "" : `<div class="step"><span class="tr">└─</span>${esc(f.label)}${f.detail ? ` <span class="faint">${esc(f.detail)}</span>` : ""}</div>`;
}

function entry(t, s) {
  const open = s.view === "task" && s.task?.id === t.id ? " sel" : "";
  // A task in progress can be deleted once cancelled (the button says so).
  const actions = deleteButton("task", t.id, s, ACTIVE.has(t.status));
  return `<div class="entry${open}" id="entry-${esc(t.id)}" data-open="${t.id}">
    <div class="l1">${statusLine(t)}<span class="sp"></span><span class="acts">${actions}</span></div>
    ${outcome(t, s)}${deleteNotice("task", t.id, s)}
  </div>`;
}

/** Cards for what is going on: in progress and waiting for you, across the top. */
function strip(s) {
  const active = s.tasks.filter((t) => ACTIVE.has(t.status));
  if (!active.length) return "";
  const cards = active.map((t) => {
    const ask = s.approvals.find((a) => a.taskId === t.id);
    const waiting = t.status === "waiting_approval" || !!ask;
    const f = feedback(t, []);
    const line = ask ? (ask.kind === "question" ? questionsOf(ask).questions[0]?.text || ask.action : ask.action) : f.label;
    return `<div class="card${waiting ? " wait" : ""}${s.task?.id === t.id && s.view === "task" ? " on" : ""}" id="card-${esc(t.id)}" data-open="${t.id}">
      <div class="l1">${statusLine(t)}</div>
      <div class="t">${esc(titleOf(t, s))}</div>
      <div class="s">└─ ${esc(line || "")}</div>
    </div>`;
  }).join("");
  return `<div class="strip">${cards}</div><div class="rule"></div>`;
}

/** The thread's title for its first task, else the first line of what was asked. */
function titleOf(t, s) {
  const th = s.threads.find((x) => x.id === t.threadId);
  const first = th && s.tasks.filter((x) => x.threadId === th.id).sort((a, b) => a.createdAt - b.createdAt)[0];
  return th?.title && first?.id === t.id ? th.title : firstLine(t.task).slice(0, 90) || t.task.slice(0, 90);
}

/** The record, oldest first like a conversation: the day, the topic when it changes, what you asked, the task, and a
 *  request for you right under its task. */
function feed(s) {
  const tasks = s.tasks.slice(0, FEED).sort((a, b) => a.createdAt - b.createdAt);
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  const out = [];
  let day = "", topic = "";
  for (const t of tasks) {
    const d = dayOf(t.createdAt);
    if (d !== day) { out.push(`<div class="day">${esc(d)}</div>`); day = d; topic = ""; }
    if (t.threadId && t.threadId !== topic) {
      const th = s.threads.find((x) => x.id === t.threadId) || (s.archivedThreads || []).find((x) => x.id === t.threadId);
      if (th?.title) out.push(`<div class="tag">${topicSquare(th.id)}<span>${esc(th.title)}</span></div>`);
      topic = t.threadId;
    }
    out.push(`<div class="me"><div>${esc(t.task.length > 600 ? t.task.slice(0, 600) + "…" : t.task)}</div></div>`);
    out.push(entry(t, s));
    for (const a of s.approvals.filter((x) => x.taskId === t.id)) out.push(approvalCard(a, null, s.answerSubmissions?.[a.id]));
  }
  // A request whose task is not in the record (an older one) waits at the end, where the eye is.
  const shown = new Set(tasks.map((t) => t.id));
  for (const a of s.approvals.filter((x) => !shown.has(x.taskId))) out.push(approvalCard(a, byId.get(a.taskId), s.answerSubmissions?.[a.id]));
  out.push(answerNotices(s));
  if (!tasks.length && !s.approvals.length) out.push('<div class="empty">发送任务或问题</div>');
  return out.join("");
}

function archived(s) {
  const list = s.archivedThreads || [];
  return `<details id="archived-threads" data-keep-open class="archived"><summary>// archived topics ${list.length}</summary>
    ${list.length ? list.map((th) => `<div class="arow">${topicSquare(th.id)}<span class="t">${esc(th.title || "（未命名）")}</span><span class="faint">${esc(agoShort(th.lastActivity || th.updatedAt))}</span>${deleteButton("thread", th.id, s, s.tasks.some((t) => t.threadId === th.id && ACTIVE.has(t.status)))}${deleteNotice("thread", th.id, s)}</div>`).join("") : '<div class="faint arow">暂无已归档的话题。</div>'}
  </details>`;
}

export function render(s) {
  return `${strip(s)}<div class="feed" id="feed">${archived(s)}${feed(s)}</div>${composer(s)}`;
}

/** The record opens at its end, as a conversation does. */
export function afterRender() {
  const feedEl = document.getElementById("feed");
  if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
}

function questionBlock(a, q, i, disabled) {
  const box = `q-${a.id}-${i}`;
  const options = (q.options || []).length ? `<div class="chips">${q.options.map((o) => `<button class="chip" data-opt="${esc(o.label)}" data-for="${box}" data-multi="${!!q.multi}" title="${esc(o.description || "")}" ${disabled ? "disabled" : ""}>${esc(o.label)}</button>`).join("")}</div>` : "";
  return `<div class="qb">${q.header ? `<span class="lbl">// ${esc(q.header)}</span> ` : ""}<div class="qt">${esc(q.text)}</div>
    ${q.secret ? '<div class="hint error">敏感信息：请填写凭据网关密文（enc:v1:…），勿填明文</div>' : ""}${options}
    <textarea id="${box}" data-keep rows="2" ${disabled ? "disabled" : ""} placeholder="${(q.options || []).length ? "选择上方选项，或直接输入" : "输入答复"}${q.multi ? "，多项用逗号分隔" : ""}"></textarea></div>`;
}

/** A request for you, a floating box as on the phone and the Mac: amber for a permission, ink for a question. */
export function approvalCard(a, task, submission = {}) {
  const about = `${task ? esc(task.task.slice(0, 60)) + " · " : ""}${when(a.createdAt)}`;
  if (a.kind === "question") {
    const { source, questions } = questionsOf(a);
    const fromExecutor = source === "executor";
    const locked = ["sending", "sent", "uncertain", "resolved"].includes(submission.status);
    const label = { sending: "提交中…", sent: "已提交", uncertain: "结果待确认", resolved: "问题已结束", error: "重新提交" }[submission.status] || "提交";
    return `<div class="box q" id="ask-${esc(a.id)}" aria-busy="${submission.status === "sending"}">
      <div class="hd"><span>? question</span><span class="sp"></span><span>${fromExecutor ? "执行器提问（答复直接交给执行器）" : "调度模型提问"}</span></div>
      <div class="bd"><div class="faint about">${about}</div>
      ${["sent", "resolved"].includes(submission.status) ? "" : questions.map((q, i) => questionBlock(a, q, i, locked)).join("")}
      ${submission.message ? `<div class="hint ${submission.status === "error" ? "error" : ""}" role="${submission.status === "error" ? "alert" : "status"}" aria-live="polite">${esc(submission.message)}</div>` : ""}</div>
      <div class="ft"><span class="hint-l">回答后任务继续</span><button class="warn" data-approve="${a.id}" data-task="${a.taskId}" data-decision="deny" ${locked ? "disabled" : ""}>暂不回答，停止执行</button>${["sent", "uncertain"].includes(submission.status) ? `<button data-answer-refresh="${a.id}" data-task="${a.taskId}">刷新状态</button>` : ""}<button class="primary" data-answer="${a.id}" data-task="${a.taskId}" ${locked ? "disabled" : ""}>${label}</button></div>
    </div>`;
  }
  return `<div class="box ask" id="ask-${esc(a.id)}">
    <div class="hd"><span>[!] approval</span><span class="sp"></span><span>${about}</span></div>
    <div class="bd"><code>${esc(a.action)}</code>${a.evidence ? `<div class="path pre">${esc(a.evidence)}</div>` : ""}</div>
    <div class="ft"><span class="hint-l"></span><button class="warn" data-approve="${a.id}" data-task="${a.taskId}" data-decision="deny">deny</button><button class="primary" data-approve="${a.id}" data-task="${a.taskId}" data-decision="allow">allow</button></div>
  </div>`;
}

/** Keep the receipt visible if approvals refreshed before the corresponding task status did. */
export function answerNotices(s, taskId) {
  return Object.entries(s.answerSubmissions || {}).filter(([, sub]) => {
    const t = taskId && s.task?.id === sub.taskId ? s.task : s.tasks.find((t) => t.id === sub.taskId);
    return (!taskId || sub.taskId === taskId) && ["sent", "uncertain"].includes(sub.status) && t?.status === "waiting_approval" && !s.approvals.some((a) => a.taskId === sub.taskId);
  }).map(([id, sub]) => `<div class="note" role="status"><span>${esc(sub.status === "sent" ? sub.message : "问题状态已更新，请查看任务进展。")}</span><button class="small" data-answer-refresh="${id}" data-task="${sub.taskId}">刷新状态</button></div>`).join("");
}

async function send() {
  if (sendState(get(), "home").locked) return;
  const task = $("#c-task").value.trim();
  if (!task) { set({ hint: "请填写要发送的消息。" }); return; }
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
  ...deleteBindings,
  { sel: "[data-approve]", run: (el) => { el.disabled = true; return approve(el.dataset.task, el.dataset.approve, el.dataset.decision); } },
  ...questionBindings,
  // Anywhere else on a task (its card, its entry) opens it beside.
  { sel: "[data-open]", run: (el) => openTask(el.dataset.open) },
];

export const submitKeys = { "c-task": "c-send" };
