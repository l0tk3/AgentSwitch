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
