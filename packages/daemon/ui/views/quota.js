/** Quota cards: one per harness, shown on the home page. */

import { HARNESS_NAMES, ago, esc, until } from "../lib/api.js";

export function bar(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return `<div class="bar"><i class="${p >= 90 ? "bad" : p >= 70 ? "warn" : ""}" style="width:${p}%"></i></div>`;
}

function windows(d) {
  return (d.windows || []).map((w) => `<div class="win"><div class="row"><span class="grow">${esc(w.label)} 已用 ${w.usedPercent}%</span><span class="dim">${until(w.resetsAt)}</span></div>${bar(w.usedPercent)}</div>`).join("");
}

function detail(q) {
  const d = q.detail || {};
  if (q.harness === "opencode" && d.balances) {
    const rows = d.balances.map((b) => `<b>余额</b><span>${esc(b.total)} ${esc(b.currency || "")}（充值 ${esc(b.topped_up)}，赠送 ${esc(b.granted)}）</span>`).join("");
    return `<div class="kv" style="margin-top:8px">${rows}</div>${q.remaining !== null ? `<div class="win">${bar(100 - q.remaining * 100)}</div>` : ""}`;
  }
  if (q.harness === "claude-code") {
    const noWindows = d.windowsAgeMs === null || d.windowsAgeMs === undefined;
    return `<div class="kv" style="margin-top:8px"><b>24h 本地统计</b><span>${(d.usedTokens24h || 0).toLocaleString()} tokens</span>${noWindows ? `<b>窗口</b><span class="dim">暂无额度数据。运行一次 Claude 任务，或点击「强制刷新」。</span>` : ""}</div>`;
  }
  if (q.harness === "codex") {
    return `<div class="kv" style="margin-top:8px"><b>套餐</b><span>${esc(d.planType || "?")}</span>${d.credits ? `<b>credits</b><span>${esc(d.credits.balance)}${d.credits.unlimited ? "（不限）" : ""}</span>` : ""}${d.rateLimitReachedType ? `<b>状态</b><span class="error">${esc(d.rateLimitReachedType)}</span>` : ""}</div>`;
  }
  return "";
}

export function quotaCard(q) {
  const remaining = q.remaining === null ? "未知" : "剩余 " + Math.round(q.remaining * 100) + "%";
  return `<div class="card">
    <div class="row"><b class="grow">${HARNESS_NAMES[q.harness] || esc(q.harness)}</b><span class="badge">${remaining}</span></div>
    ${windows(q.detail || {})}${detail(q)}
    ${q.error ? `<div class="dim error" style="margin-top:6px">${esc(q.error)}</div>` : ""}
    <div class="dim" style="margin-top:6px">${esc(q.source)} · ${ago(q.fetchedAt)}</div>
  </div>`;
}

export function quotaPanel(quota) {
  return `<h2>用量<span class="spacer"></span><button class="small" id="q-refresh">强制刷新</button></h2>
    <div class="stack">${quota.length ? quota.map(quotaCard).join("") : `<div class="empty">加载中…</div>`}</div>
    <p class="dim">Claude 的 5h / 7d 窗口来自订阅的限额事件；Codex 的数据来自 app-server；DeepSeek 显示账户余额。</p>`;
}
