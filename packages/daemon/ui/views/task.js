/** Task detail: text, result, approvals, live event stream, follow-up composer; meta in the side column. */

import { ACTIVE, esc, stamp, target, when } from "../lib/api.js";
import { answer, approve, archiveThread, cancelTask, goto, handoffTask, openTask, rateTask, submitTask } from "../lib/actions.js";
import { set } from "../lib/state.js";
import { approvalCard } from "./home.js";
import { fileList, pendingList } from "../lib/files.js";
import { feedbackStrip } from "../lib/feedback.js";

const $ = (s) => document.querySelector(s);

export function eventLine(ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case "queued": return "已排队";
    case "sealed": return `已做密文：${(p.entries || []).map((e) => `${e.field || e.label}${e.hosts && e.hosts.length ? " → " + e.hosts.join(", ") : ""}`).join("；")}`;
    case "routed": { if (p.clarify) return `路由器先问你：${p.clarify}`; const v = p.verdict || {}; return `路由 → ${v.ok ? v.harness + "/" + v.model : "无目标"} (${p.source}${p.routerMs ? ", " + (p.routerMs / 1000).toFixed(1) + "s" : ""})${v.notes && v.notes.length ? "\n  " + v.notes.join("; ") : ""}`; }
    case "dispatched": return `派发 ${p.harness}/${p.model}${p.effort ? " effort=" + p.effort : ""}`;
    case "text": return p.text;
    case "tool_call": return `工具 ${p.tool}: ${p.command || (p.input ? JSON.stringify(p.input).slice(0, 160) : "")}`;
    case "approval_request": return p.kind === "question" ? `❓ ${p.source === "executor" ? "执行者" : "路由器"}问你：${(p.questions || [{ text: p.action }]).map((q) => q.text).join("；")}` : `⚠ 需要审批：${p.action}\n${p.evidence || ""}`;
    case "approval_resolved": return p.decision === "answer" ? `你答了：${p.text || ""}` : `${p.kind === "question" ? "问题" : "审批"} → ${p.decision === "allow" ? "允许" : p.kind === "question" ? "没答" : "拒绝"}（${p.by === "router" ? "路由器代批" : p.by === "timeout" ? "超时" : "你"}）`;
    case "supervisor": return p.kind === "approval" ? `监督者对审批的意见：${p.decision === "allow" ? "允许" : p.decision === "deny" ? "拒绝" : "交给你决定"}${p.reason ? "，" + p.reason : ""}`
      : p.kind === "checkin" ? `监督者检查（${Math.round((p.silentMs || 0) / 1000)} 秒无动静）：${p.action === "continue" ? "继续等" : p.action === "cancel" ? "取消这次执行并换人" : "问你"}${p.note ? "，" + p.note : ""}`
      : `监督者验收：${p.accepted ? "通过" : p.overruled ? "仍未通过，但已重做过一次，按完成处理" : "未通过，退回重做"}${(p.missing || []).length ? "，缺：" + p.missing.join("；") : ""}${p.note ? "，" + p.note : ""}`;
    case "attempt_failed": return `失败 ${p.harness}/${p.model}: ${p.kind} "${p.excerpt}"${p.hadSideEffects ? " (已有副作用)" : ""}`;
    case "redispatch": return `重派 ${p.kind}${p.target ? " → " + p.target.harness + "/" + p.target.model : ""}${p.source ? " (" + p.source + ")" : ""}`;
    case "waiting": return `等待 ${p.for === "parent" ? "父任务 " + p.taskId + " 结束" : p.for === "thread" ? "同线程的另一个任务" : p.for === "cwd" ? "同目录的另一个任务" : p.for === "global" ? "并发槽位（已达上限）" : String(p.for).startsWith("harness:") ? String(p.for).slice(8) + " 的空闲槽位" : p.for}`;
    case "agent": return `子 agent ${p.status === "started" ? "启动" : p.status === "progress" ? "进展" : p.status === "completed" ? "完成" : p.status === "failed" ? "失败" : "停止"}${p.background ? "（后台）" : ""}：${p.description || p.agentId || ""}${p.summary ? "\n  " + p.summary : ""}${p.tokens ? " · " + p.tokens + " tok" : ""}`;
    case "thread": return `归入线程 ${p.threadId}（${p.source === "router" ? "路由器判断" + (p.confidence !== null ? "，置信度 " + p.confidence : "") : p.source === "user" ? "你确认的" : p.source === "parent" ? "追问自父任务" : "新开"}）${p.cwd ? "，目录 " + p.cwd : ""}`;
    case "handoff": return `交接 ${p.from ? p.from.harness + "/" + p.from.model + " → " : ""}${p.to && p.to.harness ? p.to.harness + "/" + (p.to.model || "?") : "由路由器选"} (${p.reason})${p.taskId && p.taskId !== ev.taskId ? "，新任务 " + p.taskId : ""}`;
    case "summary": return p.ok ? `线程摘要已更新：「${p.title}」(${((p.ms || 0) / 1000).toFixed(1)}s)` : `线程摘要失败：${p.error}`;
    case "done": return ((p.result || "").length > 200 ? "✓ 完成（结果见上方）" : `✓ 完成：${p.result}`) + (p.agents && p.agents.spawned ? `  · 子 agent ${p.agents.completed}/${p.agents.spawned} 完成${p.agents.failed ? "，" + p.agents.failed + " 失败" : ""}` : "");
    case "failed": return `✗ 失败：${p.error}${p.security ? "  [安全事件]" : ""}`;
    case "cancelled": return "已取消";
    case "cleaned": return `已清理临时目录与 harness 记录 (workdir=${p.workDirRemoved}, claude=${(p.claudeProjectsRemoved || []).length}, opencode=${p.opencodeSessionsRemoved}${p.artifacts ? ", 产物 " + p.artifacts + " 个已保留" : ""})`;
    default: return `${ev.type} ${JSON.stringify(p).slice(0, 160)}`;
  }
}

/** When the floor overrode the router (low confidence, quota, catalog…), say so next to the router's reason. */
function overrideNote(t, events) {
  const routed = [...events].reverse().find((e) => e.type === "routed" || (e.type === "redispatch" && e.payload && e.payload.verdict));
  const v = routed && routed.payload.verdict;
  if (!v || !v.ok || !t.decision) return "";
  const picked = `${t.decision.harness}/${t.decision.model || "默认"}`;
  const actual = `${v.harness}/${v.model}`;
  if (picked === actual && !(v.notes || []).length) return "";
  return `<div class="card warn"><div class="dim">校验层改写了路由结果</div><div style="margin-top:4px">路由器选 <span class="mono">${esc(picked)}</span>，实际派给 <span class="mono">${esc(actual)}</span>（${esc(v.chosen)}）</div>${(v.notes || []).length ? `<div class="dim" style="margin-top:4px">${v.notes.map(esc).join("<br>")}</div>` : ""}</div>`;
}

function meta(t, events) {
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
    ${overrideNote(t, events)}
    ${d.reason ? `<div class="card"><div class="dim">路由理由</div><div>${esc(d.reason)}</div>${d.confidence !== undefined ? `<div class="dim" style="margin-top:4px">置信度 ${d.confidence}${d.expected_size ? " · " + esc(d.expected_size) : ""}${d.needs_browser ? " · 需要浏览器" : ""}</div>` : ""}</div>` : ""}
    ${t.brief && t.brief !== t.task ? `<div class="card"><div class="dim">路由器给执行者的简报</div><div class="pre" style="margin-top:4px;font-size:13px">${esc(t.brief)}</div></div>` : ""}
    ${attempts ? `<div class="card"><div class="dim">尝试</div>${attempts}</div>` : ""}
    ${t.decision ? `<details class="card"><summary>完整决策 JSON</summary><pre class="mono pre" style="margin:8px 0 0">${esc(JSON.stringify(t.decision, null, 2))}</pre></details>` : ""}`;
}

function filesCards(t, files) {
  const inputs = files.files.filter((f) => f.path.startsWith("in/"));
  const outputs = files.files.filter((f) => !f.path.startsWith("in/"));
  const where = files.root === "artifacts" ? "任务目录已清理，产物保留 7 天" : files.root === "cwd" ? "工作目录里的文件" : "目录已清理，没有留下 out/ 产物";
  return `${outputs.length || files.root ? `<div class="card"><div class="dim">产物 · ${where}</div><div class="stack" style="margin-top:8px">${fileList(t.id, outputs, "还没有产物；模型会把交付文件放到 out/")}</div></div>` : ""}
    ${(t.attachments || []).length ? `<div class="card"><div class="dim">你上传的附件</div><div class="stack" style="margin-top:8px">${fileList(t.id, inputs.length ? inputs : t.attachments.map((a) => ({ path: a.path, size: a.size })), "")}</div></div>` : ""}`;
}

/** The thread this task belongs to: title, last summary, every execution in it, and archive. */
function threadCard(t, th) {
  if (!th) return t.threadId ? `<div class="card dim">线程 <span class="mono">${esc(t.threadId)}</span> 加载中…</div>` : "";
  const sm = th.state && th.state.summary;
  const list = (label, items) => (items && items.length ? `<div class="dim" style="margin-top:6px">${label}</div>${items.map((i) => `<div>· ${esc(i)}</div>`).join("")}` : "");
  const tasks = (th.tasks || []).map((x) => `<div class="${x.id === t.id ? "" : "dim"}" ${x.id === t.id ? "" : `data-open="${x.id}" style="cursor:pointer"`}><span class="badge ${x.status}">${x.status}</span> ${esc(target(x) || "—")}${x.handoffFrom ? " ↤ " + esc(x.handoffFrom.harness) : ""} <span class="mono">${esc(x.id)}</span></div>`).join("");
  return `<div class="card">
      <div class="row"><b class="grow">线程 · ${esc(th.title || "（未命名）")}</b><span class="badge ${th.status}">${th.status}</span></div>
      <div class="dim mono" style="font-size:12px">${esc(th.id)} · ${(th.tasks || []).length} 次执行 · ${th.handoffs || 0} 次交接${th.expiresAt ? " · " + stamp(th.expiresAt) + " 删除" : ""}</div>
      ${sm ? `<div style="margin-top:8px"><div class="dim">目标</div><div>${esc(sm.goal)}</div><div class="dim" style="margin-top:6px">进展</div><div>${esc(sm.progress || "—")}</div>${list("文件", sm.files)}${list("未解决", sm.unresolved)}${list("已定", sm.decisions)}</div>` : `<div class="dim" style="margin-top:8px">还没有摘要（每次执行结束后由路由模型生成）</div>`}
      <div class="stack" style="margin-top:8px;font-size:13px">${tasks}</div>
      ${th.status === "open" && !(th.tasks || []).some((x) => ACTIVE.has(x.status)) ? `<div class="row" style="margin-top:8px"><span class="grow"></span><button class="small" id="t-archive">归档线程（7 天后删除）</button></div>` : ""}
    </div>`;
}

function handoffBar(t) {
  return `<div class="card composer" style="margin-top:10px">
    <div class="row"><span class="dim grow">交给别人：在同一线程里换个执行者接着做，当前执行者会被排除；填 harness/model 则直接指定</span></div>
    <div class="row" style="margin-top:6px"><input id="t-handoff-pin" data-keep class="pin grow" placeholder="留空由路由器选，或 codex/gpt-5.5"><button id="t-handoff">交给别人</button></div>
  </div>`;
}

function followUp(hint, pending) {
  return `<div class="card composer" style="margin-top:10px" data-dropzone>
    <textarea id="f-task" data-keep rows="2" placeholder="接着说（带上这条任务的上下文）…  ⌘↵ 发送"></textarea>
    <div class="row" style="margin-top:8px"><span class="hint error grow">${esc(hint)}</span><button data-attach>📎 附件</button><button class="primary" id="f-send">追问</button></div>
    ${pendingList(pending)}
  </div>`;
}

export function render(s) {
  const t = s.task;
  if (!t) return `<div class="page-title"><a data-nav="home">← 首页</a> 任务</div><div class="empty">${esc(s.hint || "加载中…")}</div>`;
  const pending = s.approvals.filter((a) => a.taskId === t.id);
  const parent = t.parentId ? s.tasks.find((x) => x.id === t.parentId) : null;
  const events = s.events.map((e) => `<div class="ev ${e.type}"><span class="ts">${when(e.ts)}</span>${esc(eventLine(e))}</div>`).join("");
  return `<div class="page-title"><a data-nav="home">← 首页</a><span class="badge ${t.status}">${t.status}</span><span class="dim grow ellipsis">${esc(target(t))}</span>${ACTIVE.has(t.status) ? `<button class="bad small" id="t-cancel">取消任务</button>` : `<button class="small ${t.rating === 1 ? "ok" : ""}" data-rate="1" title="这次结果好，路由器下次会参考">👍</button><button class="small ${t.rating === -1 ? "bad" : ""}" data-rate="-1" title="这次结果不好">👎</button>`}</div>
    <div class="cols">
      <div class="stack">
        ${parent ? `<div class="card dim" data-open="${parent.id}" style="cursor:pointer">↩ 追问自：${esc(parent.task.slice(0, 120))}</div>` : ""}
        ${feedbackStrip(t, s.events)}
        <div class="card"><div class="task-text">${esc(t.task)}</div></div>
        ${t.result ? `<div class="card ok"><div class="dim">结果</div><div class="pre" style="margin-top:4px">${esc(t.result)}</div></div>` : ""}
        ${t.error ? `<div class="card bad"><div class="dim">错误</div><div class="pre error" style="margin-top:4px">${esc(t.error)}</div></div>` : ""}
        ${pending.length ? `<div class="approvals">${pending.map((a) => approvalCard(a, null)).join("")}</div>` : ""}
        <h2>事件 ${s.events.length}</h2>
        <div class="card events" id="events">${events || '<span class="dim">等待事件…</span>'}</div>
        ${followUp(s.hint, s.pending)}
        ${t.harness ? handoffBar(t) : ""}
      </div>
      <aside class="stack">${threadCard(t, s.thread)}${filesCards(t, s.files)}${meta(t, s.events)}</aside>
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
  { sel: "#t-handoff", run: (el, _e, s) => { el.disabled = true; return handoffTask(s.task.id, $("#t-handoff-pin").value.trim()).finally(() => { el.disabled = false; }); } },
  { sel: "#t-archive", run: (_el, _e, s) => archiveThread(s.thread.id) },
  { sel: "[data-rate]", run: (el, _e, s) => rateTask(s.task.id, Number(el.dataset.rate) === s.task.rating ? null : Number(el.dataset.rate)) },
  { sel: "[data-nav]", run: (el) => goto(el.dataset.nav) },
  { sel: "[data-open]", run: (el) => openTask(el.dataset.open) },
  { sel: "[data-approve]", run: (el) => { el.disabled = true; return approve(el.dataset.task, el.dataset.approve, el.dataset.decision); } },
  { sel: "[data-answer]", run: (el) => { const text = ($("#q-" + el.dataset.answer)?.value || "").trim(); if (!text) return; el.disabled = true; return answer(el.dataset.task, el.dataset.answer, text); } },
];

export const submitKeys = { "f-task": "f-send" };
