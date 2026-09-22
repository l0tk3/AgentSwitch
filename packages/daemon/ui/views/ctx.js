/** Router context: edit $AGENTSWITCH_HOME/CONTEXT.md (hand-written) and MEMORY.md (appended by the
 *  summarizer); both show the linted text the router actually sees. */

import { esc } from "../lib/api.js";
import { loadCtxExample, saveCtx, saveMem, savePolicy } from "../lib/actions.js";
import { patch } from "../lib/state.js";

const $ = (s) => document.querySelector(s);

export function render(s) {
  const c = s.ctx;
  const text = c.draft ?? c.text;
  const warnings = c.warnings.length
    ? `<div class="card warn"><div class="dim">加载时被删掉的行（疑似明文凭据，路由器看不到）</div><div class="warn-list" style="margin-top:6px">${c.warnings.map(esc).join("\n")}</div></div>`
    : "";
  const m = s.mem;
  const memText = m.draft ?? m.text;
  return `<div class="page-title">路由器上下文</div>
    <div class="cols">
      <div class="stack">
        ${c.hint ? `<div class="card bad error">${esc(c.hint)}</div>` : ""}
        <textarea id="ctx-text" data-keep class="doc" spellcheck="false" placeholder="站点与账号（密码只放 enc:v1: 密文）、环境限制、哪个项目偏好哪个 harness…">${esc(text)}</textarea>
        <div class="row">
          <button class="primary" id="ctx-save" ${c.draft === null ? "disabled" : ""}>${c.saved ? "已保存" : "保存"}</button>
          ${text.trim() ? "" : `<button id="ctx-example">载入示例模板</button>`}
          <span class="hint">⌘S 保存</span>
        </div>
        <h2 style="margin-top:14px">记忆 MEMORY.md</h2>
        ${m.hint ? `<div class="card bad error">${esc(m.hint)}</div>` : ""}
        <textarea id="mem-text" data-keep class="doc" spellcheck="false" style="min-height:160px" placeholder="每次执行结束后，摘要器发现的持久事实会追加到这里（带来源任务）。删掉不对的行即可。">${esc(memText)}</textarea>
        <div class="row">
          <button class="primary" id="mem-save" ${m.draft === null ? "disabled" : ""}>${m.saved ? "已保存" : "保存"}</button>
          ${m.warnings.length ? `<span class="hint error">${m.warnings.length} 行疑似明文凭据已被删掉</span>` : ""}
        </div>
      </div>
      <aside class="stack">
        ${policyCard(s.policy)}
        ${warnings}
        <div class="card">
          <div class="dim">文件</div><div class="mono" style="margin-top:4px">${esc(c.path)}</div>
          <div class="dim" style="margin-top:10px">路由器每次分诊都重新读，改完立即生效。上限 64KB。</div>
          <div class="dim" style="margin-top:6px">这里显示的是 lint 之后的内容，也就是路由器实际看到的。列表项里「密码 / token / api key」后面若不是 enc:v1: 密文，整行会被删掉并列在上方。</div>
        </div>
        <div class="card"><div class="dim">适合写什么</div>
          <ul class="dim" style="margin:6px 0 0;padding-left:18px">
            <li>站点 URL、账号、对应的 enc:v1: 密文</li>
            <li>环境限制：内网可达条件、代理、别用的版本</li>
            <li>偏好：哪个项目优先哪个 harness，哪类任务别动用 Opus</li>
          </ul>
        </div>
      </aside>
    </div>`;
}

/** Who answers approvals (docs/supervisor-v0.md §1b): manual / auto / scoped with reserved categories. */
function policyCard(p) {
  if (!p) return "";
  const mode = p.policy.mode;
  const opt = (v, label, desc) => `<label class="row" style="gap:8px;align-items:flex-start"><input type="radio" name="pol-mode" value="${v}" ${mode === v ? "checked" : ""}><span><b>${label}</b><div class="dim">${desc}</div></span></label>`;
  const cats = p.categories.map((c) => `<label class="row" style="gap:8px"><input type="checkbox" class="pol-cat" value="${c.id}" ${p.policy.human.includes(c.id) ? "checked" : ""} ${mode === "scoped" ? "" : "disabled"}><span>${esc(c.title)}</span></label>`).join("");
  return `<div class="card"><div class="dim">审批策略</div>
    <div class="stack" style="margin-top:8px">
      ${opt("manual", "全部我来批", "路由器不介入任何审批")}
      ${opt("auto", "全权交给路由器", "包括删除、推送、支付这类不可逆动作；它拿不准仍会问你")}
      ${opt("scoped", "划定范围", "下面勾选的类别留给我，其余路由器批")}
    </div>
    <div class="stack" style="margin:8px 0 0 24px;font-size:13px">${cats}</div>
    <div class="row" style="margin-top:8px"><span class="grow dim">daemon 自己的文件永远不可改，不在此列。路由器分诊时缺信息会直接问你。</span><button class="small" id="pol-save">保存策略</button></div>
  </div>`;
}

export function onInput(el) {
  const key = el.id === "ctx-text" ? "ctx" : el.id === "mem-text" ? "mem" : null;
  if (!key) return;
  patch((s) => ({ [key]: { ...s[key], draft: el.value, saved: false } }));
  const btn = $(key === "ctx" ? "#ctx-save" : "#mem-save");
  if (btn) { btn.disabled = false; btn.textContent = "保存"; }
}

export const save = () => saveCtx($("#ctx-text").value);

export const bindings = [
  { sel: "#ctx-save", run: () => save() },
  { sel: "#mem-save", run: () => saveMem($("#mem-text").value) },
  { sel: "#ctx-example", run: () => loadCtxExample() },
  { sel: "#pol-save", run: () => savePolicy({ mode: document.querySelector("input[name=pol-mode]:checked")?.value || "scoped", human: [...document.querySelectorAll(".pol-cat:checked")].map((el) => el.value) }) },
  { sel: "input[name=pol-mode]", run: (el, e, s) => { if (s.policy) { const next = { ...s.policy, policy: { ...s.policy.policy, mode: el.value } }; import("../lib/state.js").then((m) => m.set({ policy: next })); } } },
];
