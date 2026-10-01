/** Router context: edit $AGENTSWITCH_HOME/CONTEXT.md (hand-written) and MEMORY.md (appended by the
 *  summarizer); both show the linted text the router actually sees. */

import { esc, stamp } from "../lib/api.js";
import { deletePlatformMemory, loadCtxExample, loadPlatformMemory, openTask, saveCtx, saveMem, savePolicy } from "../lib/actions.js";
import { get, patch, set } from "../lib/state.js";

const $ = (s) => document.querySelector(s);

/** Bytes as the pane's header says them. */
const size = (text) => { const n = new TextEncoder().encode(text || "").length; return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`; };

/** Two files side by side as on the demo page (console.html #ctx): what you write, what the summarizer learned. */
export function render(s) {
  const c = s.ctx;
  const text = c.draft ?? c.text;
  const m = s.mem;
  const memText = m.draft ?? m.text;
  const warnings = c.warnings.length
    ? `<div class="warnbox"><b>${c.warnings.length} lines removed</b> · 加载时移除了疑似明文凭据的行，调度模型看不到：<div class="warn-list">${c.warnings.map(esc).join("\n")}</div></div>`
    : "";
  return `<div class="page-title"><h1>Context</h1><span class="faint">调度模型每次调度前读取，改了立即生效</span></div>
    ${warnings}
    <div class="panes">
      <section class="pane">
        <div class="hd"><span>// CONTEXT.md</span><span class="sp"></span><span class="faint">${size(text)} / 64 KB</span>${text.trim() ? "" : `<button id="ctx-example">载入示例模板</button>`}<button class="primary" id="ctx-save" ${c.draft === null ? "disabled" : ""}>${c.saved ? "已保存" : "保存"}</button></div>
        ${c.hint ? `<div class="note warn">${esc(c.hint)}</div>` : ""}
        <textarea id="ctx-text" data-keep class="src" spellcheck="false" placeholder="站点与账号（密码仅填写 enc:v1: 密文）、环境限制、各项目偏好的执行器…">${esc(text)}</textarea>
        <div class="say">站点、账号（密码只填 enc:v1: 密文）、环境限制、各项目偏好的执行器。列表项里「密码 / token / api key」之后不是密文的，整行会被移除。<span class="mono faint">${esc(c.path)}</span> · ⌘S 保存</div>
      </section>
      <section class="pane">
        <div class="hd"><span>// MEMORY.md</span><span class="sp"></span><span class="faint">每次执行后追加</span><button class="primary" id="mem-save" ${m.draft === null ? "disabled" : ""}>${m.saved ? "已保存" : "保存"}</button></div>
        ${m.hint ? `<div class="note warn">${esc(m.hint)}</div>` : ""}
        <textarea id="mem-text" data-keep class="src" spellcheck="false" placeholder="每次执行结束后，调度模型提取的长期事实会追加到此处，并注明来源任务。有误的行可直接删除。">${esc(memText)}</textarea>
        <div class="say">调度模型从执行结果里提取的长期事实，注明来源任务；错的行直接删。${m.warnings.length ? `<span class="error"> 已移除 ${m.warnings.length} 行疑似明文凭据。</span>` : ""}</div>
      </section>
    </div>
    ${policyCard(s.policy)}
    ${platformMemory(s.platformMem)}`;
}

function platformMemory(mem = { records: [], loading: false, loaded: false, deletions: {} }) {
  const records = mem.records.map((record) => {
    const removal = mem.deletions[record.id] || {};
    const busy = removal.status === "deleting";
    const expired = record.expiresAt <= Date.now();
    return `<article class="card platform-memory ${expired ? "expired" : ""}" aria-busy="${busy}">
      <div class="row"><b class="grow mono">${esc(record.origin)}</b><button class="small bad" data-delete-memory="${esc(record.id)}" ${busy ? "disabled" : ""}>${busy ? "删除中…" : removal.status === "error" ? "重试删除" : "删除"}</button></div>
      <div class="chips" style="margin-top:8px"><span class="badge">${record.kind === "incident" ? "临时事件" : "操作经验"}</span><span class="badge">${record.status === "verified" ? "已验证" : "待验证"}</span>${expired ? '<span class="badge blocked">已过期</span>' : ""}</div>
      <div class="pre" style="margin-top:8px">${esc(record.text)}</div>
      <div class="dim" style="margin-top:8px">更新 ${stamp(record.updatedAt)} · ${expired ? "已于" : "有效至"} ${stamp(record.expiresAt)}${expired ? " 过期" : ""}</div>
      <details id="memory-source-${esc(record.id)}" data-keep-open style="margin-top:8px"><summary>来源：任务 ${esc(record.source.taskId)} · 事件 #${record.source.eventSeq}</summary>
        <blockquote class="pre dim">${esc(record.source.quote)}</blockquote><button class="small" data-memory-task="${esc(record.source.taskId)}">查看来源任务</button>
      </details>
      ${removal.message ? `<div class="hint ${removal.status === "error" ? "error" : ""}" role="${removal.status === "error" ? "alert" : "status"}" aria-live="polite" style="margin-top:8px">${esc(removal.message)}</div>` : ""}
    </article>`;
  }).join("");
  return `<section class="xsec">
    <div class="sh"><span class="lbl">// Experience</span><span class="what">执行器在具体网站上学到的做法，附来源与有效期；过期的不再用于后续任务，也不代表操作授权</span><button class="small" id="platform-memory-refresh" ${mem.loading ? "disabled" : ""}>${mem.loading ? "加载中…" : "刷新"}</button></div>
    ${mem.hint ? `<div class="card bad error" role="alert">${esc(mem.hint)}</div>` : ""}
    <div class="stack">${records || `<div class="empty">${mem.loading ? "正在加载平台经验…" : mem.loaded ? "暂无平台经验" : "平台经验尚未加载"}</div>`}</div></section>`;
}

/** Who answers approvals (docs/supervisor-v0.md §1b; 2026-10-01, user: 这个选项也不知道是给谁选的): a section that
 *  says what it decides, the three ways one under another, the categories that still ask you under the way they
 *  belong to, and its button under them naming what it saves. */
function policyCard(p) {
  if (!p) return "";
  const mode = p.policy.mode;
  const opt = (v, label, desc, extra = "") => `<div class="way"><label class="opt"><input type="radio" name="pol-mode" value="${v}" ${mode === v ? "checked" : ""}><span><b>${label}</b><span class="d">${desc}</span></span></label>${extra}</div>`;
  const cats = p.categories.map((c) => `<label class="opt cat"><input type="checkbox" class="pol-cat" value="${c.id}" ${p.policy.human.includes(c.id) ? "checked" : ""} ${mode === "scoped" ? "" : "disabled"}><span>${esc(c.title)}</span></label>`).join("");
  return `<section class="policy">
    <div class="sh"><span class="lbl">// Approval</span><span class="what">路由器派出的任务要做需要批准的事（删文件、推送、付款……）时，由谁决定</span></div>
    ${opt("manual", "逐项确认", "每一次都问你，调度模型不介入。")}
    ${opt("scoped", "自动", "调度模型代你批准，但下面勾选的几类仍然问你：", `<div class="cats${mode === "scoped" ? "" : " off"}">${cats}</div>`)}
    ${opt("auto", "全部自动", "调度模型代你批准所有请求，包括删除、推送、支付这类不可逆操作；它判断不了的仍然问你。")}
    <div class="say">AgentSwitch 自身的文件始终禁止修改，不在此列；调度时缺少信息，调度模型会直接问你。终端里的 agent 不受这里影响，按各自终端的权限模式。</div>
    <div class="sacts"><button class="primary" id="pol-save">保存审批方式</button></div>
  </section>`;
}

/** What a draft shows outside its own textarea: the save button (enabled, 已保存) and the example button. */
const shown = (d) => `${d.draft === null}:${d.saved}:${!(d.draft ?? d.text).trim()}`;

/** Keystrokes update the draft silently (`patch`); one that changes `shown` goes through `set` and re-renders. */
export function onInput(el) {
  const key = el.id === "ctx-text" ? "ctx" : el.id === "mem-text" ? "mem" : null;
  if (!key) return;
  const before = get()[key];
  const next = { ...before, draft: el.value, saved: false };
  (shown(before) === shown(next) ? patch : set)({ [key]: next });
}

export const save = () => saveCtx($("#ctx-text").value);

export const bindings = [
  { sel: "[data-delete-memory]", run: (el) => deletePlatformMemory(el.dataset.deleteMemory) },
  { sel: "[data-memory-task]", run: (el) => openTask(el.dataset.memoryTask) },
  { sel: "#platform-memory-refresh", run: () => loadPlatformMemory() },
  { sel: "#ctx-save", run: () => save() },
  { sel: "#mem-save", run: () => saveMem($("#mem-text").value) },
  { sel: "#ctx-example", run: () => loadCtxExample() },
  { sel: "#pol-save", run: () => savePolicy({ mode: document.querySelector("input[name=pol-mode]:checked")?.value || "scoped", human: [...document.querySelectorAll(".pol-cat:checked")].map((el) => el.value) }) },
  { sel: "input[name=pol-mode]", run: (el, e, s) => { if (s.policy) set({ policy: { ...s.policy, policy: { ...s.policy.policy, mode: el.value } } }); } },
];
