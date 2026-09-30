/** HTTP helper and formatting utilities shared by every view. */

export const HARNESSES = ["claude-code", "codex", "opencode"];
export const HARNESS_NAMES = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode · DeepSeek" };
export const ACTIVE = new Set(["queued", "routing", "running", "waiting_approval"]);
/** The fixed status words (docs/ui-v0.md §4), the same as the phone's `TaskStatus.label`. */
export const STATUS_LABELS = { queued: "排队", routing: "进行中", running: "进行中", waiting_approval: "等你处理", done: "已完成", partial: "未完成", blocked: "未完成", failed: "失败", cancelled: "已取消" };
export const statusLabel = (status) => STATUS_LABELS[status] || status;
const BLOCK_LABELS = { question: "等你处理" };

/** A blocked task's label comes from the engine's structured `blockCause`, never from parsing the error text. */
export function taskStatusLabel(task) {
  if (task.status !== "blocked") return statusLabel(task.status);
  return BLOCK_LABELS[task.blockCause] ?? "未完成";
}

/** A status line's word (docs/ui-v0.md §7.4 网页控制台): the phone's short English words. */
const STATUS_WORDS = { queued: "queued", routing: "busy", running: "busy", waiting_approval: "waiting", done: "done", partial: "incomplete", blocked: "incomplete", failed: "failed", cancelled: "cancelled" };
export function statusWord(task) {
  if (task.status === "blocked" && task.blockCause === "question") return "waiting";
  return STATUS_WORDS[task.status] || task.status;
}
/** The status's tone: busy, waiting, ok, bad or off (its square's colour). */
export function statusTone(task) {
  const word = statusWord(task);
  return word === "busy" || word === "queued" ? "busy" : word === "waiting" ? "waiting" : word === "done" ? "ok" : word === "incomplete" ? "waiting" : word === "failed" ? "bad" : "off";
}

export async function api(method, path, body, { timeoutMs = 15_000 } = {}) {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, ...(controller ? { signal: controller.signal } : {}) });
    const t = await r.text();
    let d = {};
    try { d = t ? JSON.parse(t) : {}; } catch { throw new Error(`HTTP ${r.status}: ${t.slice(0, 120)}（服务返回异常，详见服务日志）`); }
    // The console's session ends when the daemon restarts (api/localAuth.ts): open it again from the Mac menu bar.
    if (r.status === 401) throw Object.assign(new Error("网页控制台的登录已失效。请从 Mac 菜单栏的 AgentSwitch 重新打开网页控制台。"), { status: 401 });
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

/** Short English times, as the phone and the Mac say them: now, 3m ago, 2h ago, today 21:06, yesterday, 9/20. */
export function agoShort(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  const d = new Date(ts), today = new Date();
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return s < 6 * 3600 ? `${Math.floor(s / 3600)}h ago` : `today ${hm}`;
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `yesterday ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** A day's heading in the record: today, yesterday, else the date. */
export function dayOf(ts) {
  const d = new Date(ts), today = new Date();
  if (d.toDateString() === today.toDateString()) return "today";
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "yesterday";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** How long it ran: 40s, 2m 14s, 1h 05m. */
export function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
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
