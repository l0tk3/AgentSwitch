/** Routing log: every dispatch, re-dispatch and preview, newest first. */

import { esc, stamp } from "../lib/api.js";

function decisionCell(r) {
  if (!r.decision) return "";
  let pretty = r.decision;
  try { pretty = JSON.stringify(JSON.parse(r.decision), null, 1); } catch { /* keep raw */ }
  return `<details><summary>decision</summary><pre class="mono pre" style="margin:6px 0 0">${esc(pretty)}</pre></details>`;
}

function row(r) {
  return `<tr>
    <td class="nowrap dim">${stamp(r.ts)}</td>
    <td class="nowrap"><span class="badge">${esc(r.source)}</span></td>
    <td class="nowrap">${r.harness ? esc(r.harness + "/" + r.model) : '<span class="dim">无目标</span>'}</td>
    <td class="task-cell"><div class="mono ellipsis dim">${esc(r.cwd || "")}</div>${r.routerMs ? `<div class="dim">${(r.routerMs / 1000).toFixed(1)}s</div>` : ""}</td>
    <td>${r.notes ? `<div class="dim">${esc(r.notes)}</div>` : ""}${r.routerError ? `<div class="dim error">${esc(r.routerError)}</div>` : ""}${decisionCell(r)}</td>
  </tr>`;
}

export function render(s) {
  return `<div class="page-title"><h1>log</h1><span class="faint">调度模型每次的决定，新的在上</span></div>
    ${s.log.length
      ? `<table class="list"><thead><tr><th>time</th><th>from</th><th>target</th><th>folder</th><th>notes</th></tr></thead><tbody>${s.log.map(row).join("")}</tbody></table>`
      : `<div class="empty">暂无调度记录</div>`}`;
}

export const bindings = [];
