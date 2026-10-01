/** A task beside the tasks (docs/ui-v0.md §7.4 网页控制台): its status line and actions, what was asked and what came of
 *  it, the requests for you, the steps (from its events), files, facts, the live events, a follow-up, its topic. */

import { ACTIVE, esc, stamp, statusTone, statusWord, target, taskStatusLabel, when } from "../lib/api.js";
import { approve, archiveThread, cancelTask, goto, handoffTask, openTask, rateTask, submitTask } from "../lib/actions.js";
import { get, set } from "../lib/state.js";
import { approvalCard, answerNotices, statusLine } from "./home.js";
import { questionBindings } from "../lib/questions.js";
import { fileList, pendingList } from "../lib/files.js";
import { feedback, feedbackStrip, firstLine } from "../lib/feedback.js";
import { spinner, square, topicSquare } from "../lib/sidebar.js";
import { md, mdInline } from "../lib/markdown.js";
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
      : p.action === "plan" ? (p.source === "error" ? planningFailure(p) : p.source === "retry" ? `规划调用超时（${Math.round((p.timeoutMs || 0) / 1000)} 秒），正在重试一次` : `多步任务，交由规划模型 ${p.model || ""}${p.reason ? "：" + p.reason : ""}`)
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
  return `<div class="note warn"><div class="faint">校验层已调整调度结果</div><div>调度模型选择 <code>${esc(picked)}</code>，实际派发给 <code>${esc(actual)}</code>（${esc(v.chosen)}）</div>${(v.notes || []).length ? `<div class="faint">${v.notes.map(esc).join("<br>")}</div>` : ""}</div>`;
}

function meta(t, events) {
  const d = t.decision || {};
  const attempts = (t.attempts || []).map((a, i) => `<div class="faint">${i + 1}. ${esc(a.harness)}/${esc(a.model)} → ${esc(a.kind)}${a.excerpt ? `：${esc(a.excerpt.slice(0, 120))}` : ""}</div>`).join("");
  return `<div class="kv">
      <span>ID</span><b class="mono">${esc(t.id)}</b>
      <span>Status</span><b><span class="badge ${t.status}">${esc(statusWord(t))}</span> <span class="faint">${esc(taskStatusLabel(t))}</span></b>
      <span>Target</span><b>${esc(target(t) || "—")}${t.effort ? ` · effort ${esc(t.effort)}` : ""}</b>
      <span>Folder</span><b class="mono">${esc(t.cwd)}${t.ephemeral ? " <span class=\"faint\">（临时）</span>" : ""}</b>
      <span>Created</span><b>${stamp(t.createdAt)}</b>
      ${t.pin ? `<span>Pinned</span><b>${esc(t.pin.harness)}/${esc(t.pin.model)}</b>` : ""}
    </div>
    ${overrideNote(t, events)}
    ${d.reason ? `<div class="note"><div class="faint">调度理由</div><div>${mdInline(d.reason)}</div>${d.confidence !== undefined ? `<div class="faint">置信度 ${d.confidence}${d.expected_size ? " · " + esc(d.expected_size) : ""}${d.needs_browser ? " · 需要浏览器" : ""}</div>` : ""}</div>` : ""}
    ${t.brief && t.brief !== t.task ? `<details class="note"><summary>调度模型给执行器的简报</summary><div class="md">${md(t.brief)}</div></details>` : ""}
    ${attempts ? `<div class="note"><div class="faint">尝试</div>${attempts}</div>` : ""}
    ${t.decision ? `<details class="note"><summary>完整决策 JSON</summary><pre class="mono pre">${esc(JSON.stringify(t.decision, null, 2))}</pre></details>` : ""}`;
}

function filesCards(t, files) {
  const inputs = files.files.filter((f) => f.path.startsWith("in/"));
  const outputs = files.files.filter((f) => !f.path.startsWith("in/"));
  const where = files.root === "artifacts" ? "任务目录已清理，产物保留 7 天" : files.root === "cwd" ? "工作目录中的文件" : "目录已清理，无 out/ 产物";
  const out = outputs.length || files.root ? `<div class="files-l"><div class="faint">产物 · ${where}</div>${fileList(t.id, outputs, "暂无产物。模型交付的文件会放在 out/ 中。")}</div>` : "";
  const att = (t.attachments || []).length ? `<div class="files-l"><div class="faint">上传的附件</div>${fileList(t.id, inputs.length ? inputs : t.attachments.map((a) => ({ path: a.path, size: a.size })), "")}</div>` : "";
  return out || att ? `<div class="lbl">// Files</div>${out}${att}` : "";
}

/** The topic this task belongs to: title, last summary, every run in it, and archive. */
function threadCard(t, th, s) {
  if (!th) return t.threadId ? `<div class="lbl">// Topic</div><div class="faint">话题 <span class="mono">${esc(t.threadId)}</span> 加载中…</div>` : "";
  const sm = th.state && th.state.summary;
  const list = (label, items) => (items && items.length ? `<div class="faint">${label}</div>${items.map((i) => `<div>· ${mdInline(i)}</div>`).join("")}` : "");
  const tasks = (th.tasks || []).map((x, i, all) => `<div class="trow ${x.id === t.id ? "on" : ""}" ${x.id === t.id ? "" : `data-open="${x.id}"`}><span class="tr">${i === all.length - 1 ? "└─" : "├─"}</span><span class="badge ${x.status}">${esc(statusWord(x))}</span><span>${esc(target(x) || "—")}${x.handoffFrom ? " ↤ " + esc(x.handoffFrom.harness) : ""}</span><span class="faint mono">${esc(x.id)}</span></div>`).join("");
  return `<div class="lbl">// Topic</div>
    <div class="topic-card">
      <div class="th">${topicSquare(th.id)}<b>${esc(th.title || "（未命名）")}</b><span class="sp"></span><span class="faint">${th.status === "archived" ? "Archived" : "Open"}</span></div>
      <div class="faint mono small">${esc(th.id)} · ${(th.tasks || []).length} 次执行 · ${th.handoffs || 0} 次交接${th.expiresAt ? " · 将于 " + stamp(th.expiresAt) + " 删除" : ""}</div>
      ${sm ? `<div class="sum"><div class="faint">目标</div><div>${mdInline(sm.goal)}</div><div class="faint">进展</div><div>${mdInline(sm.progress || "—")}</div>${list("文件", sm.files)}${list("未解决", sm.unresolved)}${list("决定", sm.decisions)}</div>` : `<div class="faint">暂无摘要（每次执行结束后由调度模型生成）</div>`}
      <div class="trows">${tasks}</div>
      ${th.status === "open" && !(th.tasks || []).some((x) => ACTIVE.has(x.status)) ? `<div class="acts"><button id="t-archive" title="归档后 7 天删除">Archive</button></div>` : ""}
      ${th.status === "archived" ? `<div class="acts">${deleteButton("thread", th.id, s, (th.tasks || []).some((x) => ACTIVE.has(x.status)))}${deleteNotice("thread", th.id, s)}</div>` : ""}
    </div>`;
}

function handoffBar(t) {
  return `<div class="handoff"><span class="lbl">// Hand To</span><input id="t-handoff-pin" data-keep class="pin" placeholder="Auto，或 codex/gpt-5.5" title="交接：在同一话题中改由其他执行器继续，排除当前执行器；填写执行器/模型可直接指定"><button id="t-handoff">Hand Off</button></div>`;
}

function followUp(s) {
  const key = `followup:${s.task.id}`;
  const sub = sendState(s, key);
  const disabled = sub.locked ? "disabled" : "";
  return `<div class="compose small-c" data-dropzone data-composer-key="${esc(key)}" aria-busy="${sub.busy}">
    ${s.pendingFor === key ? pendingList(s.pending, sub.locked) : ""}
    <div class="crow"><button class="sqb" data-attach ${disabled} title="添加附件" aria-label="Attach">+</button><textarea id="f-task" data-keep ${disabled} rows="2" placeholder="追问（附带本任务的上下文）"></textarea><button class="sqb go" id="f-send" ${disabled} title="${esc(sub.status ? sub.label : "追问")} ⌘↩" aria-label="${esc(sub.status ? sub.label : "追问")}">${sub.busy ? spinner() : "↑"}</button></div>
    ${sub.status ? `<div class="opts"><span class="sp"></span><kbd>${esc(sub.label)}</kbd></div>` : ""}
    ${sendFeedback(s, key)}
  </div>`;
}

/** The steps, from the events: received, planned, each step sent out, a question, the finish, the outcome. */
function steps(t, events) {
  const rows = [];
  const hm = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const stepped = events.some((e) => e.type === "step" && e.payload?.action === "dispatch");
  for (const e of events) {
    const p = e.payload || {};
    if (e.type === "step" && p.action === "intake") rows.push({ x: "已接收", small: p.sealingMs ? `加密 ${(p.sealingMs / 1000).toFixed(1)} 秒` : "", at: e.ts });
    else if (e.type === "step" && p.action === "plan" && !["error", "retry", "none"].includes(p.source)) rows.push({ x: "规划", small: p.model || "", at: e.ts });
    else if (e.type === "step" && p.action === "dispatch") rows.push({ x: `${p.n} · ${p.purpose === "research" ? "调研" : p.purpose === "verify" ? "复查" : "执行"}${p.target ? " · " + p.target.harness + "/" + p.target.model : ""}`, small: p.reason || "", at: e.ts });
    else if (e.type === "step" && p.action === "ask_user") rows.push({ x: `${p.n} · 向你提问`, small: p.question || "", at: e.ts, wait: true });
    else if (e.type === "step" && p.action === "finish") rows.push({ x: "收尾检查", small: p.reason || "", at: e.ts });
    else if (e.type === "routed" && !stepped && p.verdict?.ok) rows.push({ x: `调度 → ${p.verdict.harness}/${p.verdict.model}`, small: p.routerMs ? `${(p.routerMs / 1000).toFixed(1)} 秒` : "", at: e.ts });
    else if (e.type === "approval_request") rows.push({ x: p.kind === "question" ? "等你回答" : "等你批准", small: String(p.action || "").slice(0, 80), at: e.ts, wait: true });
    else if (e.type === "approval_resolved" && rows.at(-1)?.wait) rows.at(-1).wait = false;
  }
  const ended = !ACTIVE.has(t.status);
  if (ended) {
    const f = feedback(t, events);
    rows.push({ x: t.status === "done" ? "完成" : t.status === "failed" ? "失败" : t.status === "cancelled" ? "已取消" : "未完成", small: t.status === "done" ? "" : f.detail || "", at: t.updatedAt, end: statusTone(t) });
  }
  if (!rows.length) return '<div class="faint">等待事件…</div>';
  const last = rows.length - 1;
  return `<div class="tl">${rows.map((r, i) => {
    const now = !ended && i === last;
    const mark = r.end ? square(r.end, t.status === "cancelled") : now ? (r.wait || t.status === "waiting_approval" ? square("waiting") : spinner()) : square(r.wait ? "waiting" : "ok");
    return `<div class="e${now ? " now" : ""}"><span class="tr">${i === last ? "└─" : "├─"}</span>${mark}<span class="x">${esc(r.x)}${r.small ? `<small>${esc(r.small)}</small>` : ""}</span><span class="r">${r.at ? hm(r.at) : ""}</span></div>`;
  }).join("")}</div>`;
}

export function render(s) {
  const t = s.task;
  if (!t) return `<div class="head"><div class="l1"><span class="faint">Task</span><span class="sp"></span><button class="x" data-nav="home" title="Close · esc" aria-label="Close">×</button></div></div><div class="body"><div class="empty">${esc(s.hint || "加载中…")}</div></div>`;
  const pending = s.approvals.filter((a) => a.taskId === t.id);
  const parent = t.parentId ? s.tasks.find((x) => x.id === t.parentId) : null;
  // A tool's result belongs to its call (the phone opens a call to show it); the list shows the calls only.
  const events = s.events.filter((e) => e.type !== "tool_result").map((e) => `<div class="ev ${e.type}"><span class="ts">${when(e.ts)}</span>${esc(eventLine(e))}</div>`).join("");
  const incomplete = ["partial", "blocked"].includes(t.status);
  const acts = ACTIVE.has(t.status) ? `<button class="warn" id="t-cancel">Cancel</button>`
    : `<button class="${t.rating === 1 ? "on" : ""}" data-rate="1" title="结果有用，调度模型后续会参考">Useful</button><button class="${t.rating === -1 ? "on" : ""}" data-rate="-1" title="结果无用">Not Useful</button>${deleteButton("task", t.id, s, (s.thread?.tasks || []).some((x) => ACTIVE.has(x.status)))}`;
  return `<div class="head">
      <div class="l1">${statusLine(t)}<span class="sp"></span><button class="x" data-nav="home" title="Close · esc" aria-label="Close">×</button></div>
      <h2>${esc(firstLine(t.task).slice(0, 120) || t.task.slice(0, 120))}</h2>
    </div>
    <div class="acts">${acts}</div>
    ${deleteNotice("task", t.id, s)}
    <div class="rule"></div>
    <div class="body">
      ${parent ? `<div class="parent" data-open="${parent.id}">↩ 追问自：${esc(parent.task.slice(0, 120))}</div>` : ""}
      ${feedbackStrip(t, s.events)}
      <div class="lbl">// Asked</div>
      <div class="asked">${esc(t.task)}</div>
      ${t.result ? `<div class="lbl">// ${incomplete ? "Saved" : "Result"}</div><div class="result ${incomplete ? "is-warn" : t.status === "done" ? "is-ok" : ""}"><div class="faint">${incomplete ? "已保存的进展" : "结果"}</div><div class="md">${md(t.result)}</div></div>` : ""}
      ${t.error ? `<div class="result ${incomplete ? "is-warn" : "is-bad"}"><div class="faint">${incomplete ? "未完成原因" : "错误"}</div><div class="md">${md(t.error)}</div></div>` : ""}
      ${pending.map((a) => approvalCard(a, null, s.answerSubmissions?.[a.id])).join("")}
      ${answerNotices(s, t.id)}
      <div class="lbl">// Steps</div>
      ${steps(t, s.events)}
      ${filesCards(t, s.files)}
      <div class="lbl">// Task</div>
      ${meta(t, s.events)}
      <details class="evs" id="events-box" data-keep-open ${ACTIVE.has(t.status) ? "open" : ""}><summary>// Events ${s.events.length}</summary>
        <div class="events" id="events">${events || '<span class="faint">等待事件…</span>'}</div>
      </details>
      <div class="lbl">// Follow Up</div>
      ${followUp(s)}
      ${t.harness ? handoffBar(t) : ""}
      ${threadCard(t, s.thread, s)}
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
