/** HTTP helper and formatting utilities shared by every view. */

export const HARNESSES = ["claude-code", "codex", "opencode"];
export const HARNESS_NAMES = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode · DeepSeek" };
export const ACTIVE = new Set(["queued", "routing", "running", "waiting_approval"]);
export const STATUS_LABELS = { queued: "排队中", routing: "分诊中", running: "执行中", waiting_approval: "等待答复", done: "已完成", partial: "部分完成", blocked: "执行受阻", failed: "失败", cancelled: "已取消" };
export const statusLabel = (status) => STATUS_LABELS[status] || status;
const BLOCK_LABELS = { question: "待补充条件", planner_timeout: "规划超时", planner_error: "规划失败" };

/** A blocked task's label comes from the engine's structured `blockCause`, never from parsing the error text. */
export function taskStatusLabel(task) {
  if (task.status !== "blocked") return statusLabel(task.status);
  return BLOCK_LABELS[task.blockCause] ?? "执行受阻";
}

export async function api(method, path, body, { timeoutMs = 15_000 } = {}) {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, ...(controller ? { signal: controller.signal } : {}) });
    const t = await r.text();
    let d = {};
    try { d = t ? JSON.parse(t) : {}; } catch { throw new Error(`HTTP ${r.status}: ${t.slice(0, 120)}（服务端异常，看 daemon 日志）`); }
    if (!r.ok) throw Object.assign(new Error(d.error || ("HTTP " + r.status)), { status: r.status });
    return d;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export const when = (ts) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const stamp = (ts) => new Date(ts).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function until(epochSec) {
  if (!epochSec) return "";
  const ms = epochSec * 1000 - Date.now();
  if (ms <= 0) return "已重置";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)} 天 ${h % 24} 小时后重置`;
  return h ? `${h} 小时 ${m} 分后重置` : `${m} 分后重置`;
}

export const target = (t) => (t.harness ? `${t.harness}/${t.model}` : "");

/** Multi-line "KEY=VALUE" / "Key: Value" text <-> object, for env and header textareas. */
export const lines = (obj, sep) => Object.entries(obj || {}).map(([k, v]) => `${k}${sep}${v}`).join("\n");
export const parseLines = (text, sep) => Object.fromEntries(
  text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(sep);
    return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + sep.length).trim()];
  }),
);
