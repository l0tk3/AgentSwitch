/** Task detail: text, result, approvals, live event stream, follow-up composer; meta in the side column. */

import { ACTIVE, esc, stamp, target, when } from "../lib/api.js";
import { approve, cancelTask, goto, openTask, submitTask } from "../lib/actions.js";
import { set } from "../lib/state.js";
import { approvalCard } from "./home.js";

const $ = (s) => document.querySelector(s);

export function eventLine(ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case "queued": return "已排队";
    case "routed": { const v = p.verdict || {}; return `路由 → ${v.ok ? v.harness + "/" + v.model : "无目标"} (${p.source}${p.routerMs ? ", " + (p.routerMs / 1000).toFixed(1) + "s" : ""})${v.notes && v.notes.length ? "\n  " + v.notes.join("; ") : ""}`; }
    case "dispatched": return `派发 ${p.harness}/${p.model}${p.effort ? " effort=" + p.effort : ""}`;
    case "text": return p.text;
    case "tool_call": return `工具 ${p.tool}: ${p.command || (p.input ? JSON.stringify(p.input).slice(0, 160) : "")}`;
    case "approval_request": return `⚠ 需要审批：${p.action}\n${p.evidence || ""}`;
    case "approval_resolved": return `审批 → ${p.decision === "allow" ? "允许" : "拒绝"} (${p.status})`;
    case "attempt_failed": return `失败 ${p.harness}/${p.model}: ${p.kind} "${p.excerpt}"${p.hadSideEffects ? " (已有副作用)" : ""}`;
    case "redispatch": return `重派 ${p.kind}${p.target ? " → " + p.target.harness + "/" + p.target.model : ""}${p.source ? " (" + p.source + ")" : ""}`;
    case "done": return (p.result || "").length > 200 ? "✓ 完成（结果见上方）" : `✓ 完成：${p.result}`;
    case "failed": return `✗ 失败：${p.error}${p.security ? "  [安全事件]" : ""}`;
    case "cancelled": return "已取消";
    case "cleaned": return `已清理临时目录与 harness 记录 (workdir=${p.workDirRemoved}, claude=${(p.claudeProjectsRemoved || []).length}, opencode=${p.opencodeSessionsRemoved})`;
    default: return `${ev.type} ${JSON.stringify(p).slice(0, 160)}`;
  }
}

function meta(t) {
  const d = t.decision || {};
  const attempts = (t.attempts || []).map((a, i) => `<div class="dim">${i + 1}. ${esc(a.harness)}/${esc(a.model)} → ${esc(a.kind)}${a.excerpt ? `：${esc(a.excerpt.slice(0, 120))}` : ""}</div>`).join("");
  return `<div class="card kv">
      <b>ID</b><span class="mono">${esc(t.id)}</span>
      <b>状态</b><span><span class="badge ${t.status}">${t.status}</span></span>
      <b>目标</b><span>${esc(target(t) || "—")}${t.effort ? ` · effort ${esc(t.effort)}` : ""}</span>
      <b>目录</b><span class="mono">${esc(t.cwd)}${t.ephemeral ? "（临时）" : ""}</span>
      <b>创建</b><span>${stamp(t.createdAt)}</span>
      ${t.pin ? `<b>指定</b><span>${esc(t.pin.harness)}/${esc(t.pin.model)}</span>` : ""}
    </div>
    ${d.reason ? `<div class="card"><div class="dim">路由理由</div><div>${esc(d.reason)}</div>${d.confidence !== undefined ? `<div class="dim" style="margin-top:4px">置信度 ${d.confidence}${d.expected_size ? " · " + esc(d.expected_size) : ""}${d.needs_browser ? " · 需要浏览器" : ""}</div>` : ""}</div>` : ""}
    ${t.brief && t.brief !== t.task ? `<div class="card"><div class="dim">路由器给执行者的简报</div><div class="pre" style="margin-top:4px;font-size:13px">${esc(t.brief)}</div></div>` : ""}
    ${attempts ? `<div class="card"><div class="dim">尝试</div>${attempts}</div>` : ""}
    ${t.decision ? `<details class="card"><summary>完整决策 JSON</summary><pre class="mono pre" style="margin:8px 0 0">${esc(JSON.stringify(t.decision, null, 2))}</pre></details>` : ""}`;
}

function followUp(hint) {
  return `<div class="card composer" style="margin-top:10px">
    <textarea id="f-task" data-keep rows="2" placeholder="接着说（带上这条任务的上下文）…  ⌘↵ 发送"></textarea>
    <div class="row" style="margin-top:8px"><span class="hint error grow">${esc(hint)}</span><button class="primary" id="f-send">追问</button></div>
  </div>`;
}

export function render(s) {
  const t = s.task;
  if (!t) return `<div class="page-title"><a data-nav="home">← 首页</a> 任务</div><div class="empty">${esc(s.hint || "加载中…")}</div>`;
  const pending = s.approvals.filter((a) => a.taskId === t.id);
  const parent = t.parentId ? s.tasks.find((x) => x.id === t.parentId) : null;
  const events = s.events.map((e) => `<div class="ev ${e.type}"><span class="ts">${when(e.ts)}</span>${esc(eventLine(e))}</div>`).join("");
  return `<div class="page-title"><a data-nav="home">← 首页</a><span class="badge ${t.status}">${t.status}</span><span class="dim grow ellipsis">${esc(target(t))}</span>${ACTIVE.has(t.status) ? `<button class="bad small" id="t-cancel">取消任务</button>` : ""}</div>
    <div class="cols">
      <div class="stack">
        ${parent ? `<div class="card dim" data-open="${parent.id}" style="cursor:pointer">↩ 追问自：${esc(parent.task.slice(0, 120))}</div>` : ""}
        <div class="card"><div class="task-text">${esc(t.task)}</div></div>
        ${t.result ? `<div class="card ok"><div class="dim">结果</div><div class="pre" style="margin-top:4px">${esc(t.result)}</div></div>` : ""}
        ${t.error ? `<div class="card bad"><div class="dim">错误</div><div class="pre error" style="margin-top:4px">${esc(t.error)}</div></div>` : ""}
        ${pending.length ? `<div class="approvals">${pending.map((a) => approvalCard(a, null)).join("")}</div>` : ""}
        <h2>事件 ${s.events.length}</h2>
        <div class="card events" id="events">${events || '<span class="dim">等待事件…</span>'}</div>
        ${followUp(s.hint)}
      </div>
      <aside class="stack">${meta(t)}</aside>
    </div>`;
}

export function afterRender() {
  const ev = $("#events");
  if (ev) ev.scrollTop = ev.scrollHeight;
}

async function send(s) {
  const task = $("#f-task").value.trim();
  if (!task || !s.task) return;
  $("#f-send").disabled = true;
  try { await submitTask({ task, parent_id: s.task.id }); }
  catch (err) { set({ hint: err.message }); }
}

export const bindings = [
  { sel: "#f-send", run: (_el, _e, s) => send(s) },
  { sel: "#t-cancel", run: (_el, _e, s) => cancelTask(s.task.id) },
  { sel: "[data-nav]", run: (el) => goto(el.dataset.nav) },
  { sel: "[data-open]", run: (el) => openTask(el.dataset.open) },
  { sel: "[data-approve]", run: (el) => { el.disabled = true; return approve(el.dataset.task, el.dataset.approve, el.dataset.decision); } },
];

export const submitKeys = { "f-task": "f-send" };
