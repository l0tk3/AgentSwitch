/** Extensions (docs/ui-v0.md §7.4; 2026-10-01, user: add 和 new 都不知道是给谁的): one column — what they are for,
 *  then MCP servers and skills, each a list of rows with its own named button under it and its form in a box. */

import { HARNESSES, api, esc, lines, parseLines } from "../lib/api.js";
import { extAction } from "../lib/actions.js";
import { set } from "../lib/state.js";

const $ = (s) => document.querySelector(s);
/** `form` marks a form's toggleable chips (data-h); card chips (data-x) only display. */
const chips = (sel, attr, form) => HARNESSES.map((h) => `<span class="chip ${sel.includes(h) ? "on" : ""}" data-${attr}="${h}"${form ? ` data-form="${form}"` : ""}>${h}</span>`).join("");
/** An open form's harnesses: the chips toggled so far, else the entry's own (every harness for a new one). */
const picked = (edit, form) => edit.harnesses[form] ?? edit[form]?.harnesses ?? HARNESSES;
const sel = (v, cur) => (v === cur ? "selected" : "");

/** Which agents an entry is given to, in words. */
const given = (list) => (list.length === HARNESSES.length ? "All Agents" : list.length ? list.join(" · ") : "No Agent");

/** One MCP server as a row (demo console.html #ext): on or off, its name, how it runs, whether its calls are asked
 *  about, what it starts or calls and for whom, then its actions. */
function mcpRow(m) {
  const target = m.kind === "stdio" ? [m.command, ...(m.args || [])].join(" ") : m.url;
  return `<div class="xrow ${m.enabled ? "" : "off"}">
    <span class="sq ${m.enabled ? "ok" : "off hollow"}" title="${m.enabled ? "On" : "Off"}"></span>
    <b class="n">${esc(m.name)}</b>
    <span class="k">${esc(m.kind)}</span>
    <span class="k" title="Claude Code 调用它的工具时">${m.approval === "allow" ? "No Asking" : "Ask"}</span>
    <span class="d"><code>${esc(target)}</code><span class="faint"> · ${esc(given(m.harnesses || []))}</span>${m.note ? `<span class="faint"> · ${esc(m.note)}</span>` : ""}</span>
    <span class="a"><button class="small" data-mcp-edit="${esc(m.name)}">编辑</button><button class="small" data-mcp-toggle="${esc(m.name)}">${m.enabled ? "停用" : "启用"}</button><button class="small bad" data-mcp-del="${esc(m.name)}">删除</button></span>
  </div>`;
}

/** A floating form (a box with a dithered shadow) for one MCP server, new or being edited. */
function mcpForm(s, harnesses) {
  const e = s || { name: "", kind: "stdio", command: "", args: [], env: {}, url: "", headers: {}, approval: "ask", note: "" };
  return `<div class="box xform" id="mcp-form"><div class="hd"><span>${s ? `Edit MCP Server · ${esc(s.name)}` : "New MCP Server"}</span></div>
    <div class="bd"><div class="form">
    <div><label>// Name</label><input id="m-name" value="${esc(e.name)}" ${s ? "readonly" : ""} placeholder="github"></div>
    <div><label>// Kind</label><select id="m-kind"><option value="stdio" ${sel("stdio", e.kind)}>stdio（本地进程）</option><option value="http" ${sel("http", e.kind)}>http（远程）</option></select></div>
    <div class="full"><label>// Command（stdio）</label><input id="m-command" value="${esc(e.command || "")}" placeholder="npx"></div>
    <div><label>// Args，每行一个（stdio）</label><textarea id="m-args" class="code" style="min-height:70px">${esc((e.args || []).join("\n"))}</textarea></div>
    <div><label>// Env，KEY=VALUE 每行一个（stdio）</label><textarea id="m-env" class="code" style="min-height:70px">${esc(lines(e.env, "="))}</textarea></div>
    <div class="full"><label>// URL（http）</label><input id="m-url" value="${esc(e.url || "")}" placeholder="https://…"></div>
    <div class="full"><label>// Headers，Key: Value 每行一个（http）</label><textarea id="m-headers" class="code" style="min-height:60px">${esc(lines(e.headers, ": "))}</textarea></div>
    <div><label>// Claude Code 调用它时</label><select id="m-approval"><option value="ask" ${sel("ask", e.approval)}>需要审批</option><option value="allow" ${sel("allow", e.approval)}>免审批</option></select></div>
    <div><label>// Note</label><input id="m-note" value="${esc(e.note || "")}"></div>
    <div class="full"><label>// Given To</label><div class="chips" id="m-harness">${chips(harnesses, "h", "mcp")}</div></div>
    </div>
    <div class="hint">密钥仅填写 enc:v1 密文：stdio 服务继承凭据网关的代理环境，出网请求中的密文在网络层替换。</div></div>
    <div class="ft"><button id="m-cancel">取消</button><button class="primary" id="m-save">保存</button></div></div>`;
}

function skillRow(k) {
  return `<div class="xrow ${k.enabled ? "" : "off"}">
    <span class="sq ${k.enabled ? "ok" : "off hollow"}" title="${k.enabled ? "On" : "Off"}"></span>
    <b class="n">${esc(k.name)}</b>
    <span class="k">${k.files ? `+${k.files} files` : ""}</span>
    <span class="k"></span>
    <span class="d">${esc(k.description || "（无描述）")}<span class="faint"> · ${esc(given(k.harnesses || []))}</span></span>
    <span class="a"><button class="small" data-skill-edit="${esc(k.name)}">编辑</button><button class="small" data-skill-toggle="${esc(k.name)}">${k.enabled ? "停用" : "启用"}</button><button class="small bad" data-skill-del="${esc(k.name)}">删除</button></span>
  </div>`;
}

function skillForm(s, harnesses) {
  const e = s || { name: "", content: "" };
  return `<div class="box xform" id="skill-form"><div class="hd"><span>${s ? `Edit Skill · ${esc(s.name)}` : "New Skill"}</span></div>
    <div class="bd"><div class="form">
    <div class="full"><label>// Name（目录名）</label><input id="s-name" value="${esc(e.name)}" ${s ? "readonly" : ""} placeholder="deploy-checklist"></div>
    <div class="full"><label>// SKILL.md（未写 frontmatter 时自动补充 name / description）</label><textarea id="s-content" class="code">${esc(e.content || "")}</textarea></div>
    <div class="full"><label>// Given To</label><div class="chips" id="s-harness">${chips(harnesses, "h", "skill")}</div></div>
    </div></div>
    <div class="ft"><button id="s-cancel">取消</button><button class="primary" id="s-save">保存</button></div></div>`;
}

function discovered(found) {
  const rows = found.map((d) => `<div class="xrow"><span></span><b class="n">${esc(d.name)}</b><span class="k">${esc(d.source)}</span><span class="k"></span><span class="d">${esc(d.description)}</span><span class="a"><button class="small" data-skill-import="${esc(d.path)}">导入</button></span></div>`).join("");
  return `<details class="imp" id="skill-discover" data-keep-open><summary>从本机已有的 skill 导入（~/.claude/skills、~/.codex/skills…）${found.length ? ` · ${found.length}` : ""}</summary>${rows || `<div class="empty">没有可导入的 skill（已导入的不再列出）。</div>`}</details>`;
}

export function render(s) {
  const found = s.discovered.filter((d) => !d.installed);
  return `<div class="page-title"><h1>Extensions</h1><span class="faint">执行器可用的 MCP 服务与 skills</span></div>
    <p class="say">路由器派出的任务每次运行时，这里的 MCP 服务与 skill 会注入执行器的私有配置；不修改你的 <code>~/.claude</code>、<code>~/.codex</code> 与 OpenCode 配置，也不影响终端里的 agent。</p>
    ${s.extHint ? `<div class="note warn">${esc(s.extHint)}</div>` : ""}
    <section class="xsec">
      <div class="sh"><span class="lbl">// MCP Servers · ${s.mcp.length}</span><span class="what">执行器可调用的工具服务</span></div>
      ${s.mcp.map(mcpRow).join("") || `<div class="empty">还没有 MCP 服务。凭据网关自带的 secret-gate / playwright 不在这里管理。</div>`}
      ${s.edit.mcp !== null ? mcpForm(s.edit.mcp, picked(s.edit, "mcp")) : `<div class="sacts"><button id="mcp-new">+ Add MCP Server</button></div>`}
    </section>
    <section class="xsec">
      <div class="sh"><span class="lbl">// Skills · ${s.skills.length}</span><span class="what">执行器可用的操作说明（SKILL.md）</span></div>
      ${s.skills.map(skillRow).join("") || `<div class="empty">还没有 skill。</div>`}
      ${s.edit.skill !== null ? skillForm(s.edit.skill, picked(s.edit, "skill")) : `<div class="sacts"><button id="skill-new">+ New Skill</button></div>`}
      ${discovered(found)}
    </section>`;
}

/** Open (undefined = new, object = existing) or close (null) a form; its chip toggles start over. */
const editForm = (form, entry) => set((st) => ({ edit: { ...st.edit, [form]: entry, harnesses: { ...st.edit.harnesses, [form]: null } } }));
const editMcp = (mcp) => editForm("mcp", mcp);
const editSkill = (skill) => editForm("skill", skill);
const toggleHarness = (form, h) => set((st) => {
  const on = picked(st.edit, form);
  return { edit: { ...st.edit, harnesses: { ...st.edit.harnesses, [form]: HARNESSES.filter((x) => (x === h) !== on.includes(x)) } } };
});

async function saveMcp(s) {
  const name = $("#m-name").value.trim();
  const body = {
    kind: $("#m-kind").value, command: $("#m-command").value.trim() || undefined,
    args: $("#m-args").value.split("\n").map((l) => l.trim()).filter(Boolean), env: parseLines($("#m-env").value, "="),
    url: $("#m-url").value.trim() || undefined, headers: parseLines($("#m-headers").value, ":"),
    approval: $("#m-approval").value, note: $("#m-note").value.trim(), harnesses: picked(s.edit, "mcp"),
    enabled: s.edit.mcp ? s.edit.mcp.enabled : true,
  };
  await api("PUT", "/mcp/" + encodeURIComponent(name), body);
  editMcp(null);
}

async function saveSkill(s) {
  const name = $("#s-name").value.trim();
  await api("PUT", "/skills/" + encodeURIComponent(name), { content: $("#s-content").value, harnesses: picked(s.edit, "skill") });
  editSkill(null);
}

export const bindings = [
  { sel: ".chip[data-h]", run: (el) => toggleHarness(el.dataset.form, el.dataset.h) },
  { sel: "#mcp-new", run: () => editMcp(undefined) },
  { sel: "#m-cancel", run: () => editMcp(null) },
  { sel: "#m-save", run: (_el, _e, s) => extAction(() => saveMcp(s)) },
  { sel: "#skill-new", run: () => editSkill(undefined) },
  { sel: "#s-cancel", run: () => editSkill(null) },
  { sel: "#s-save", run: (_el, _e, s) => extAction(() => saveSkill(s)) },
  { sel: "[data-mcp-toggle]", run: (el, _e, s) => { const m = s.mcp.find((x) => x.name === el.dataset.mcpToggle); return extAction(() => api("PUT", "/mcp/" + encodeURIComponent(m.name), { ...m, enabled: !m.enabled })); } },
  { sel: "[data-mcp-edit]", run: (el, _e, s) => editMcp(s.mcp.find((x) => x.name === el.dataset.mcpEdit)) },
  { sel: "[data-mcp-del]", run: (el) => { if (!confirm(`删除 MCP 服务 ${el.dataset.mcpDel}？`)) return; return extAction(() => api("DELETE", "/mcp/" + encodeURIComponent(el.dataset.mcpDel))); } },
  { sel: "[data-skill-toggle]", run: (el, _e, s) => { const k = s.skills.find((x) => x.name === el.dataset.skillToggle); return extAction(() => api("PUT", "/skills/" + encodeURIComponent(k.name), { enabled: !k.enabled })); } },
  { sel: "[data-skill-edit]", run: async (el) => editSkill(await api("GET", "/skills/" + encodeURIComponent(el.dataset.skillEdit))) },
  { sel: "[data-skill-del]", run: (el) => { if (!confirm(`删除 skill ${el.dataset.skillDel}？`)) return; return extAction(() => api("DELETE", "/skills/" + encodeURIComponent(el.dataset.skillDel))); } },
  { sel: "[data-skill-import]", run: (el) => extAction(() => api("POST", "/skills/import", { path: el.dataset.skillImport })) },
];
