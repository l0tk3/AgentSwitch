/** Task detail: text, result, approvals, live event stream, follow-up composer; meta in the side column. */

import { ACTIVE, esc, stamp, target, taskStatusLabel, when } from "../lib/api.js";
import { approve, archiveThread, cancelTask, goto, handoffTask, openTask, rateTask, submitTask } from "../lib/actions.js";
import { get, set } from "../lib/state.js";
import { approvalCard, answerNotices } from "./home.js";
import { questionBindings } from "../lib/questions.js";
import { fileList, pendingList } from "../lib/files.js";
import { feedbackStrip } from "../lib/feedback.js";
import { deleteBindings, deleteButton, deleteNotice } from "../lib/deletions.js";
import { sendBindings, sendFeedback, sendState } from "../lib/sending.js";

const $ = (s) => document.querySelector(s);
const THREAD_STATUS = { open: "未归档", archived: "已归档" };

function planningFailure(p) {
  const stage = ["initial", "initial_plan"].includes(p.stage) ? "初次规划" : ["next", "next_action"].includes(p.stage) ? "下一步规划" : "规划";
  const kind = { timeout: "调用超时", invalid_response: "回复格式无效", service_error: "服务调用失败", cancelled: "已取消" }[p.failureKind] || "未返回有效动作";
  // The kind above is the event's structured field; routerError is the daemon's fixed diagnostic, shown as is.
  const detail = String(p.routerError || p.note || "");
  const timing = Number.isFinite(p.routerMs) && p.routerMs >= 0 ? ` · 耗时 ${(p.routerMs / 1000).toFixed(1)} 秒` : "";
  const tries = Number.isFinite(p.tries) && p.tries >= 0 ? ` · 尝试 ${p.tries} 次` : "";
  return `${stage}已停止 · ${p.model || "未指定模型"} · ${kind}${timing}${tries}${detail ? "\n原因：" + detail : ""}`;
}

export function eventLine(ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case "queued": return "已排队";
    case "step": return p.action === "intake" ? `已接收 · 敏感字段识别与加密 ${((p.sealingMs || 0) / 1000).toFixed(1)} 秒 · 从接收到创建任务共 ${((p.durationMs || 0) / 1000).toFixed(1)} 秒`
      : p.action === "plan" ? (p.source === "error" ? planningFailure(p) : `多步任务，交由规划模型 ${p.model || ""}${p.reason ? "：" + p.reason : ""}`)
      : p.action === "dispatch" ? `第 ${p.n} 步：派发${p.purpose === "research" ? "调研（只读）" : p.purpose === "verify" ? "复查（只读）" : ""} → ${p.target ? p.target.harness + "/" + p.target.model : "无目标"}${p.reason ? "，" + p.reason : ""}`
      : p.action === "ask_user" ? `第 ${p.n} 步：向你提问：${p.question}`
      : p.action === "finish" ? `第 ${p.n} 步：收尾检查${p.reason ? "，" + p.reason : ""}` : `第 ${p.n} 步：${p.action}`;
    case "checkpoint": {
      const effects = p.sideEffects || {};
      const counts = `文件 ${effects.filesChanged || 0} · 工具/命令 ${effects.commandsRun || 0} · 已批准 ${effects.approvalsGranted || 0}`;
      return `已保存步骤进展 · ${{ research: "调研", do: "执行", verify: "复查" }[p.purpose] || p.purpose} · ${p.ok ? "本步已结束" : "本步未完成"}\n${counts}${p.sideEffectsKnown === true ? "" : " · 副作用记录不完整，继续前请核对现场"}${p.result ? "\n" + p.result : ""}`;
    }
    case "sealed": return `已加密：${(p.entries || []).map((e) => `${e.field || e.label}${e.hosts && e.hosts.length ? " → " + e.hosts.join(", ") : ""}`).join("；")}`;
    case "transfer_grant": {
      const what = `${(p.fields || []).join("、")} · ${(p.source || []).join(", ")} → ${(p.destination || []).join(", ")}${p.purpose ? "（" + p.purpose + "）" : ""}`;
      if (p.status === "pinned") return `授权字段传递（来自首次调度，后续步骤只可缩小范围）：${what}`;
      if (p.status === "offered") return `授权字段传递 → ${p.harness}/${p.model}：${what}${p.attached ? "" : " · 本次未挂载浏览器，未交给执行器"}`;
      if (p.status === "applied") return `授权字段传递已接入 ${p.harness} 的浏览器凭据网关`;
      if (p.status === "inactive") return `授权字段传递本次未生效（${p.harness}）：${p.reason || ""}`;
      if (p.status === "dropped") return `授权字段传递已丢弃${p.stage === "step" ? "（第 " + p.n + " 步）" : ""}：${p.reason || ""}`;
      return `授权字段传递：${what}`;
    }
    case "credential_repair": return p.status === "requested" ? `凭据修复：正在核对种子录入授权 → ${p.host}` : p.status === "repaired" ? `凭据修复：已签发限于 ${p.host} 的种子录入密文，执行器可继续原操作` : `凭据修复未通过：${p.error || "需要补充明确授权"}`;
    case "routed": { if (p.clarify) return `调度模型提问：${p.clarify}`; const v = p.verdict || {}; return `调度 → ${v.ok ? v.harness + "/" + v.model : "无目标"} (${p.source}${p.routerMs ? ", " + (p.routerMs / 1000).toFixed(1) + "s" : ""})${v.notes && v.notes.length ? "\n  " + v.notes.join("; ") : ""}`; }
    case "dispatched": return `派发 ${p.harness}/${p.model}${p.effort ? " effort=" + p.effort : ""}`;
    case "text": return p.text;
    case "tool_call": return `工具 ${p.tool}: ${p.command || (p.input ? JSON.stringify(p.input).slice(0, 160) : "")}`;
    case "approval_request": return p.kind === "question" ? `${p.source === "executor" ? "执行器" : "调度模型"}提问：${(p.questions || [{ text: p.action }]).map((q) => q.text).join("；")}` : `请求批准：${p.action}\n${p.evidence || ""}`;
    case "approval_resolved": return p.decision === "answer" ? `你的答复：${p.text || ""}` : `${p.kind === "question" ? "问题" : "审批"} → ${p.decision === "allow" ? "允许" : p.kind === "question" ? "未回答" : "拒绝"}（${p.by === "router" ? "调度模型代批" : p.by === "timeout" ? "超时" : "由你决定"}）`;
    case "feedback": {
      // The adjacent question/answer events contain the details. This receipt only
      // reports provenance and persistence, without repeating sensitive material.
      if (p.version !== 1 || !["user", "router"].includes(p.source) || !["answered", "unanswered"].includes(p.status)) return "反馈记录（格式待核对）";
      return p.status === "answered" ? `反馈已记录（${p.source === "user" ? "用户确认" : "调度模型答复"}）· 已加入后续上下文` : "反馈待答复 · 尚无有效答复";
    }
    case "supervisor": return p.kind === "question" ? (p.answered ? `执行器提问，调度模型已代为回答：${p.text}` : `执行器提问，调度模型已转交给你${p.reason ? "（" + p.reason + "）" : ""}`)
      : p.kind === "approval" ? `调度模型审批意见：${p.decision === "allow" ? "允许" : p.decision === "deny" ? "拒绝" : "交由你决定"}${p.reason ? "，" + p.reason : ""}`
      : p.kind === "checkin" ? `调度模型检查（${Math.round((p.silentMs || 0) / 1000)} 秒无活动）：${p.action === "continue" ? "继续等待" : p.action === "cancel" ? "取消本次执行并改派" : "交由你决定"}${p.note ? "，" + p.note : ""}`
      : `调度模型验收：${p.accepted ? "通过" : "未通过"}${(p.missing || []).length ? "，缺少：" + p.missing.join("；") : ""}${p.note ? "，" + p.note : ""}`;
    case "attempt_failed": return `执行失败 ${p.harness}/${p.model}：${p.kind} "${p.excerpt}"${p.hadSideEffects ? "（已产生副作用）" : ""}`;
    case "refusal": if (p.reason === "provider_safety") return p.action === "retry" ? "服务商安全拦截：原样重发一次（新会话、同一模型）" : `服务商安全拦截：已停止${p.note ? " · " + p.note : ""}`;
      return `模型拒绝：${p.action === "clarify" ? "补充任务事实后重试一次" : p.action === "ask_user" ? "等待你补充操作范围" : "停止自动重试"}${p.note ? " · " + p.note : ""}${p.facts?.length ? "\n" + p.facts.map((f) => `[${f.sourceId}] ${f.quote}`).join("\n") : ""}`;
    case "redispatch": if (p.kind === "provider_safety") return `原样重发${p.target ? " → " + p.target.harness + "/" + p.target.model : ""}`;
      return `改派 ${p.kind}${p.target ? " → " + p.target.harness + "/" + p.target.model : ""}${p.source ? " (" + p.source + ")" : ""}`;
    case "waiting": return `等待 ${p.for === "parent" ? "父任务 " + p.taskId + " 结束" : p.for === "thread" ? "同一会话的另一个任务" : p.for === "cwd" ? "同一目录的另一个任务" : p.for === "global" ? "并发槽位（已达上限）" : String(p.for).startsWith("harness:") ? String(p.for).slice(8) + " 的空闲槽位" : p.for}`;
    case "agent": return `子任务${p.status === "started" ? "启动" : p.status === "progress" ? "进展" : p.status === "completed" ? "完成" : p.status === "failed" ? "失败" : "停止"}${p.background ? "（后台）" : ""}：${p.description || p.agentId || ""}${p.summary ? "\n  " + p.summary : ""}${p.tokens ? " · " + p.tokens + " tokens" : ""}`;
    case "thread": return `归入会话 ${p.threadId}（${p.source === "router" ? "调度模型判断" + (p.confidence !== null ? "，置信度 " + p.confidence : "") : p.source === "user" ? "由你确认" : p.source === "parent" ? "追问自父任务" : "新建"}）${p.cwd ? "，目录 " + p.cwd : ""}`;
    case "handoff": return `交接 ${p.from ? p.from.harness + "/" + p.from.model + " → " : ""}${p.to && p.to.harness ? p.to.harness + "/" + (p.to.model || "?") : "由调度模型选择"} (${p.reason})${p.taskId && p.taskId !== ev.taskId ? "，新任务 " + p.taskId : ""}`;
    case "summary": return p.ok ? `会话摘要已更新：「${p.title}」（${((p.ms || 0) / 1000).toFixed(1)} 秒）` : `会话摘要更新失败：${p.error}`;
    case "done": return ((p.result || "").length > 200 ? "已完成（结果见上方）" : `已完成：${p.result}`) + (p.agents && p.agents.spawned ? `  · 子任务 ${p.agents.completed}/${p.agents.spawned} 已完成${p.agents.failed ? "，" + p.agents.failed + " 个失败" : ""}` : "");
    case "partial": return `未完成：${p.error || (p.remaining || []).join("；") || "仍有事项待处理"}`;
    case "blocked": return `执行已停止：${p.error || (p.remaining || []).join("；") || "请查看当前进展与未完成原因"}`;
    case "failed": return `失败：${p.error}${p.security ? "（安全事件）" : ""}`;
    case "cancelled": return "已取消";
    case "cleaned": return `已清理临时目录与执行器记录（workdir=${p.workDirRemoved}, claude=${(p.claudeProjectsRemoved || []).length}, opencode=${p.opencodeSessionsRemoved}${p.artifacts ? "，已保留 " + p.artifacts + " 个产物" : ""}）`;
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
  return `<div class="card warn"><div class="dim">校验层已调整调度结果</div><div style="margin-top:4px">调度模型选择 <span class="mono">${esc(picked)}</span>，实际派发给 <span class="mono">${esc(actual)}</span>（${esc(v.chosen)}）</div>${(v.notes || []).length ? `<div class="dim" style="margin-top:4px">${v.notes.map(esc).join("<br>")}</div>` : ""}</div>`;
}

function meta(t, events) {
  const d = t.decision || {};
  const attempts = (t.attempts || []).map((a, i) => `<div class="dim">${i + 1}. ${esc(a.harness)}/${esc(a.model)} → ${esc(a.kind)}${a.excerpt ? `：${esc(a.excerpt.slice(0, 120))}` : ""}</div>`).join("");
  return `<div class="card kv">
      <b>ID</b><span class="mono">${esc(t.id)}</span>
      <b>状态</b><span><span class="badge ${t.status}">${esc(taskStatusLabel(t))}</span></span>
      <b>目标</b><span>${esc(target(t) || "—")}${t.effort ? ` · effort ${esc(t.effort)}` : ""}</span>
      <b>目录</b><span class="mono">${esc(t.cwd)}${t.ephemeral ? "（临时）" : ""}</span>
      <b>创建</b><span>${stamp(t.createdAt)}</span>
      ${t.pin ? `<b>指定</b><span>${esc(t.pin.harness)}/${esc(t.pin.model)}</span>` : ""}
    </div>
    ${overrideNote(t, events)}
    ${d.reason ? `<div class="card"><div class="dim">调度理由</div><div>${esc(d.reason)}</div>${d.confidence !== undefined ? `<div class="dim" style="margin-top:4px">置信度 ${d.confidence}${d.expected_size ? " · " + esc(d.expected_size) : ""}${d.needs_browser ? " · 需要浏览器" : ""}</div>` : ""}</div>` : ""}
    ${t.brief && t.brief !== t.task ? `<div class="card"><div class="dim">调度模型给执行器的简报</div><div class="pre" style="margin-top:4px;font-size:13px">${esc(t.brief)}</div></div>` : ""}
    ${attempts ? `<div class="card"><div class="dim">尝试</div>${attempts}</div>` : ""}
    ${t.decision ? `<details class="card"><summary>完整决策 JSON</summary><pre class="mono pre" style="margin:8px 0 0">${esc(JSON.stringify(t.decision, null, 2))}</pre></details>` : ""}`;
}

function filesCards(t, files) {
  const inputs = files.files.filter((f) => f.path.startsWith("in/"));
  const outputs = files.files.filter((f) => !f.path.startsWith("in/"));
  const where = files.root === "artifacts" ? "任务目录已清理，产物保留 7 天" : files.root === "cwd" ? "工作目录中的文件" : "目录已清理，无 out/ 产物";
  return `${outputs.length || files.root ? `<div class="card"><div class="dim">产物 · ${where}</div><div class="stack" style="margin-top:8px">${fileList(t.id, outputs, "暂无产物。模型交付的文件会放在 out/ 中。")}</div></div>` : ""}
    ${(t.attachments || []).length ? `<div class="card"><div class="dim">上传的附件</div><div class="stack" style="margin-top:8px">${fileList(t.id, inputs.length ? inputs : t.attachments.map((a) => ({ path: a.path, size: a.size })), "")}</div></div>` : ""}`;
}

/** The thread this task belongs to: title, last summary, every execution in it, and archive. */
function threadCard(t, th, s) {
  if (!th) return t.threadId ? `<div class="card dim">会话 <span class="mono">${esc(t.threadId)}</span> 加载中…</div>` : "";
  const sm = th.state && th.state.summary;
  const list = (label, items) => (items && items.length ? `<div class="dim" style="margin-top:6px">${label}</div>${items.map((i) => `<div>· ${esc(i)}</div>`).join("")}` : "");
  const tasks = (th.tasks || []).map((x) => `<div class="${x.id === t.id ? "" : "dim"}" ${x.id === t.id ? "" : `data-open="${x.id}" style="cursor:pointer"`}><span class="badge ${x.status}">${esc(taskStatusLabel(x))}</span> ${esc(target(x) || "—")}${x.handoffFrom ? " ↤ " + esc(x.handoffFrom.harness) : ""} <span class="mono">${esc(x.id)}</span></div>`).join("");
  return `<div class="card">
      <div class="row"><b class="grow">会话 · ${esc(th.title || "（未命名）")}</b><span class="badge ${th.status}">${esc(THREAD_STATUS[th.status] || th.status)}</span></div>
      <div class="dim mono" style="font-size:12px">${esc(th.id)} · ${(th.tasks || []).length} 次执行 · ${th.handoffs || 0} 次交接${th.expiresAt ? " · 将于 " + stamp(th.expiresAt) + " 删除" : ""}</div>
      ${sm ? `<div style="margin-top:8px"><div class="dim">目标</div><div>${esc(sm.goal)}</div><div class="dim" style="margin-top:6px">进展</div><div>${esc(sm.progress || "—")}</div>${list("文件", sm.files)}${list("未解决", sm.unresolved)}${list("决定", sm.decisions)}</div>` : `<div class="dim" style="margin-top:8px">暂无摘要（每次执行结束后由调度模型生成）</div>`}
      <div class="stack" style="margin-top:8px;font-size:13px">${tasks}</div>
      ${th.status === "open" && !(th.tasks || []).some((x) => ACTIVE.has(x.status)) ? `<div class="row" style="margin-top:8px"><span class="grow"></span><button class="small" id="t-archive">归档会话（7 天后删除）</button></div>` : ""}
      ${th.status === "archived" ? `<div style="margin-top:8px">${deleteButton("thread", th.id, s, (th.tasks || []).some((x) => ACTIVE.has(x.status)))}${deleteNotice("thread", th.id, s)}</div>` : ""}
    </div>`;
}

function handoffBar(t) {
  return `<div class="card composer" style="margin-top:10px">
    <div class="row"><span class="dim grow">交接：在同一会话中改由其他执行器继续，排除当前执行器；填写执行器/模型可直接指定。</span></div>
    <div class="row" style="margin-top:6px"><input id="t-handoff-pin" data-keep class="pin grow" placeholder="留空由调度模型选择，或填写 codex/gpt-5.5"><button id="t-handoff">交接</button></div>
  </div>`;
}

function followUp(s) {
  const key = `followup:${s.task.id}`;
  const sub = sendState(s, key);
  const disabled = sub.locked ? "disabled" : "";
  return `<div class="card composer" style="margin-top:10px" data-dropzone data-composer-key="${esc(key)}" aria-busy="${sub.busy}">
    <textarea id="f-task" data-keep ${disabled} rows="2" placeholder="追问（附带本任务的上下文）  ⌘↵ 发送"></textarea>
    <div class="row" style="margin-top:8px"><span class="hint error grow">${esc(s.hint)}</span><button data-attach ${disabled}>添加附件</button><button class="primary" id="f-send" ${disabled}>${sub.status ? sub.label : "追问"}</button></div>
    ${pendingList(s.pending, sub.locked)}
    ${sendFeedback(s, key)}
  </div>`;
}

export function render(s) {
  const t = s.task;
  if (!t) return `<div class="page-title"><a data-nav="home">← 首页</a> 任务</div><div class="empty">${esc(s.hint || "加载中…")}</div>`;
  const pending = s.approvals.filter((a) => a.taskId === t.id);
  const parent = t.parentId ? s.tasks.find((x) => x.id === t.parentId) : null;
  // A tool's result belongs to its call (the phone opens a call to show it); the list shows the calls only.
  const events = s.events.filter((e) => e.type !== "tool_result").map((e) => `<div class="ev ${e.type}"><span class="ts">${when(e.ts)}</span>${esc(eventLine(e))}</div>`).join("");
  const incomplete = ["partial", "blocked"].includes(t.status);
  return `<div class="page-title"><a data-nav="home">← 首页</a><span class="badge ${t.status}">${esc(taskStatusLabel(t))}</span><span class="dim grow ellipsis">${esc(target(t))}</span>${ACTIVE.has(t.status) ? `<button class="bad small" id="t-cancel">取消任务</button>` : `<button class="small ${t.rating === 1 ? "ok" : ""}" data-rate="1" title="结果有用，调度模型后续会参考">👍</button><button class="small ${t.rating === -1 ? "bad" : ""}" data-rate="-1" title="结果无用">👎</button>${deleteButton("task", t.id, s, (s.thread?.tasks || []).some((x) => ACTIVE.has(x.status)))}`}</div>
    ${deleteNotice("task", t.id, s)}
    <div class="cols">
      <div class="stack">
        ${parent ? `<div class="card dim" data-open="${parent.id}" style="cursor:pointer">↩ 追问自：${esc(parent.task.slice(0, 120))}</div>` : ""}
        ${feedbackStrip(t, s.events)}
        <div class="card"><div class="task-text">${esc(t.task)}</div></div>
        ${t.result ? `<div class="card ${incomplete ? "warn" : t.status === "done" ? "ok" : ""}"><div class="dim">${incomplete ? "已保存的进展" : "结果"}</div><div class="pre" style="margin-top:4px">${esc(t.result)}</div></div>` : ""}
        ${t.error ? `<div class="card ${incomplete ? "warn" : "bad"}"><div class="dim">${incomplete ? "未完成原因" : "错误"}</div><div class="pre ${incomplete ? "" : "error"}" style="margin-top:4px">${esc(t.error)}</div></div>` : ""}
        ${pending.length ? `<div class="approvals">${pending.map((a) => approvalCard(a, null, s.answerSubmissions?.[a.id])).join("")}</div>` : ""}
        ${answerNotices(s, t.id)}
        <h2>事件 ${s.events.length}</h2>
        <div class="card events" id="events">${events || '<span class="dim">等待事件…</span>'}</div>
        ${followUp(s)}
        ${t.harness ? handoffBar(t) : ""}
      </div>
      <aside class="stack">${threadCard(t, s.thread, s)}${filesCards(t, s.files)}${meta(t, s.events)}</aside>
    </div>`;
}

export function afterRender() {
  const ev = $("#events");
  if (ev) ev.scrollTop = ev.scrollHeight;
}

async function send(s) {
  if (sendState(get(), `followup:${s.task?.id}`).locked) return;
  const task = $("#f-task").value.trim();
  if (!task || !s.task) { set({ hint: "请填写要发送的消息。" }); return; }
  await submitTask({ task, parent_id: s.task.id }, { onAccepted: () => { const field = $("#f-task"); if (field) field.value = ""; } });
}

export const bindings = [
  ...sendBindings,
  ...deleteBindings,
  { sel: "#f-send", run: (_el, _e, s) => send(s) },
  { sel: "#t-cancel", run: (_el, _e, s) => cancelTask(s.task.id) },
  { sel: "#t-handoff", run: (el, _e, s) => { el.disabled = true; return handoffTask(s.task.id, $("#t-handoff-pin").value.trim()).finally(() => { el.disabled = false; }); } },
  { sel: "#t-archive", run: (_el, _e, s) => archiveThread(s.thread.id) },
  { sel: "[data-rate]", run: (el, _e, s) => rateTask(s.task.id, Number(el.dataset.rate) === s.task.rating ? null : Number(el.dataset.rate)) },
  { sel: "[data-nav]", run: (el) => goto(el.dataset.nav) },
  { sel: "[data-open]", run: (el) => openTask(el.dataset.open) },
  { sel: "[data-approve]", run: (el) => { el.disabled = true; return approve(el.dataset.task, el.dataset.approve, el.dataset.decision); } },
  ...questionBindings,
];

export const submitKeys = { "f-task": "f-send" };
