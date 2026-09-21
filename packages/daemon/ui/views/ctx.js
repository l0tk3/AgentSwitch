/** Router context: edit $AGENTSWITCH_HOME/CONTEXT.md (hand-written) and MEMORY.md (appended by the
 *  summarizer); both show the linted text the router actually sees. */

import { esc } from "../lib/api.js";
import { loadCtxExample, saveCtx, saveMem } from "../lib/actions.js";
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
];
