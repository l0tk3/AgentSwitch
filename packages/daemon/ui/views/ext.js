/** Extensions: MCP servers (left) and skills (right), each with inline add/edit forms. */

import { HARNESSES, api, esc, lines, parseLines } from "../lib/api.js";
import { extAction } from "../lib/actions.js";
import { set } from "../lib/state.js";

const $ = (s) => document.querySelector(s);
/** `form` marks a form's toggleable chips (data-h); card chips (data-x) only display. */
const chips = (sel, attr, form) => HARNESSES.map((h) => `<span class="chip ${sel.includes(h) ? "on" : ""}" data-${attr}="${h}"${form ? ` data-form="${form}"` : ""}>${h}</span>`).join("");
/** An open form's harnesses: the chips toggled so far, else the entry's own (every harness for a new one). */
const picked = (edit, form) => edit.harnesses[form] ?? edit[form]?.harnesses ?? HARNESSES;
const sel = (v, cur) => (v === cur ? "selected" : "");

function mcpCard(s) {
  const target = s.kind === "stdio" ? [s.command, ...(s.args || [])].join(" ") : s.url;
  return `<div class="card ${s.enabled ? "" : "off"}">
    <div class="row"><b class="grow ellipsis">${esc(s.name)}</b><span class="badge">${s.kind}</span><span class="badge">${s.approval === "allow" ? "免审批" : "需审批"}</span></div>
    <div class="mono dim" style="margin-top:4px">${esc(target)}</div>${s.note ? `<div class="dim">${esc(s.note)}</div>` : ""}
    <div class="chips" style="margin-top:6px">${chips(s.harnesses, "x")}</div>
    <div class="actions"><button class="small" data-mcp-toggle="${esc(s.name)}">${s.enabled ? "停用" : "启用"}</button><button class="small" data-mcp-edit="${esc(s.name)}">编辑</button><button class="small bad" data-mcp-del="${esc(s.name)}">删除</button></div>
  </div>`;
}

function mcpForm(s, harnesses) {
  const e = s || { name: "", kind: "stdio", command: "", args: [], env: {}, url: "", headers: {}, approval: "ask", note: "" };
  return `<div class="card" id="mcp-form"><div class="form">
    <div><label>名字</label><input id="m-name" value="${esc(e.name)}" ${s ? "readonly" : ""} placeholder="github"></div>
    <div><label>类型</label><select id="m-kind"><option value="stdio" ${sel("stdio", e.kind)}>stdio（本地进程）</option><option value="http" ${sel("http", e.kind)}>http（远程）</option></select></div>
    <div class="full"><label>命令（stdio）</label><input id="m-command" value="${esc(e.command || "")}" placeholder="npx"></div>
    <div><label>参数，每行一个（stdio）</label><textarea id="m-args" class="code" style="min-height:70px">${esc((e.args || []).join("\n"))}</textarea></div>
    <div><label>环境变量 KEY=VALUE 每行一个（stdio）</label><textarea id="m-env" class="code" style="min-height:70px">${esc(lines(e.env, "="))}</textarea></div>
    <div class="full"><label>URL（http）</label><input id="m-url" value="${esc(e.url || "")}" placeholder="https://…"></div>
    <div class="full"><label>请求头 Key: Value 每行一个（http）</label><textarea id="m-headers" class="code" style="min-height:60px">${esc(lines(e.headers, ": "))}</textarea></div>
    <div><label>Claude Code 调用时</label><select id="m-approval"><option value="ask" ${sel("ask", e.approval)}>需要审批</option><option value="allow" ${sel("allow", e.approval)}>免审批</option></select></div>
    <div><label>备注</label><input id="m-note" value="${esc(e.note || "")}"></div>
    <div class="full"><label>给哪些 harness</label><div class="chips" id="m-harness">${chips(harnesses, "h", "mcp")}</div></div>
  </div>
  <div class="hint" style="margin-top:8px">密钥只放 enc:v1 密文：stdio 服务会继承网关代理环境，出网时密文在网络层替换。</div>
  <div class="actions"><button class="primary" id="m-save">保存</button><button id="m-cancel">取消</button></div></div>`;
}

function skillCard(s) {
  return `<div class="card ${s.enabled ? "" : "off"}">
    <div class="row"><b class="grow ellipsis">${esc(s.name)}</b>${s.files ? `<span class="badge">+${s.files} 文件</span>` : ""}</div>
    <div class="dim" style="margin-top:4px">${esc(s.description || "（无描述）")}</div>
    <div class="chips" style="margin-top:6px">${chips(s.harnesses, "x")}</div>
    <div class="actions"><button class="small" data-skill-toggle="${esc(s.name)}">${s.enabled ? "停用" : "启用"}</button><button class="small" data-skill-edit="${esc(s.name)}">编辑</button><button class="small bad" data-skill-del="${esc(s.name)}">删除</button></div>
  </div>`;
}

function skillForm(s, harnesses) {
  const e = s || { name: "", content: "" };
  return `<div class="card" id="skill-form"><div class="form">
    <div class="full"><label>名字（目录名）</label><input id="s-name" value="${esc(e.name)}" ${s ? "readonly" : ""} placeholder="deploy-checklist"></div>
    <div class="full"><label>SKILL.md（没写 frontmatter 会自动补 name/description）</label><textarea id="s-content" class="code">${esc(e.content || "")}</textarea></div>
    <div class="full"><label>给哪些 harness</label><div class="chips" id="s-harness">${chips(harnesses, "h", "skill")}</div></div>
  </div><div class="actions"><button class="primary" id="s-save">保存</button><button id="s-cancel">取消</button></div></div>`;
}

function discovered(found) {
  const rows = found.map((d) => `<div class="row" style="margin-top:8px"><div class="grow"><b>${esc(d.name)}</b> <span class="dim">${esc(d.source)}</span><div class="dim ellipsis">${esc(d.description)}</div></div><button class="small" data-skill-import="${esc(d.path)}">导入</button></div>`).join("");
  return `<details class="card" id="skill-discover" data-keep-open><summary>从本机导入（~/.claude/skills、~/.codex/skills…）${found.length ? " · " + found.length : ""}</summary>${rows || `<div class="dim" style="margin-top:6px">没有可导入的（已导入的不再列出）</div>`}</details>`;
}

export function render(s) {
  const found = s.discovered.filter((d) => !d.installed);
  return `<div class="page-title">扩展</div>
    ${s.extHint ? `<div class="card bad error" style="margin-bottom:14px">${esc(s.extHint)}</div>` : ""}
    <div class="ext-cols">
      <div class="stack">
        <h2>MCP 服务 ${s.mcp.length}<span class="spacer"></span>${s.edit.mcp === null ? `<button class="small" id="mcp-new">＋ 添加</button>` : ""}</h2>
        ${s.edit.mcp !== null ? mcpForm(s.edit.mcp, picked(s.edit, "mcp")) : ""}
        ${s.mcp.map(mcpCard).join("") || `<div class="empty">还没有 MCP 服务；网关自带的 secret-gate / playwright 不在这里管理</div>`}
      </div>
      <div class="stack">
        <h2>Skills ${s.skills.length}<span class="spacer"></span>${s.edit.skill === null ? `<button class="small" id="skill-new">＋ 新建</button>` : ""}</h2>
        ${s.edit.skill !== null ? skillForm(s.edit.skill, picked(s.edit, "skill")) : ""}
        ${s.skills.map(skillCard).join("") || `<div class="empty">还没有 skill</div>`}
        ${discovered(found)}
      </div>
    </div>
    <p class="dim">MCP 和 skill 每次任务运行时注入到执行器的私有配置里，不改你自己的 ~/.claude、~/.codex、OpenCode 配置。</p>`;
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
