/** The console's chrome as a function of state (docs/ui-v0.md §7.4 网页控制台): the band across the top (the app's mark
 *  as the whole state, the service, what waits, the way to the terminals) and the side (where to go, the topics, the
 *  usage). app.js patches both in place with their own renderers; ids key the elements that stay. */
import { ACTIVE, HARNESS_NAMES, agoShort, esc } from "./api.js";
import { AGENT_PX, SPIN, mark, sprite } from "../pixel.js";

const NAV = [["home", "tasks"], ["log", "log"], ["ext", "extensions"], ["ctx", "context"]];
const TOPICS_SHOWN = 8;

/** A square in a status colour (hollow: ended or off). */
export const square = (tone, hollow = false) => `<span class="sq ${tone}${hollow ? " hollow" : ""}"></span>`;
export const spinner = () => `<span class="spin" data-spin>${SPIN[0]}</span>`;
export const agentMark = (harness) => sprite(AGENT_PX[harness] ?? AGENT_PX.pi, { px: 2, cls: "agent" });

/** A topic's own hue: which topic a task belongs to, never a status. */
const HUES = ["#9fb4ff", "#e8a0c8", "#8fd8c4", "#d8c28f", "#b9a0e8", "#a0d0e8"];
export function topicHue(id) {
  let h = 0;
  for (const c of String(id || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}
export const topicSquare = (id) => `<span class="sq" style="background:${topicHue(id)}"></span>`;

export function band(s) {
  const active = s.tasks.filter((t) => ACTIVE.has(t.status)).length;
  const state = !s.health ? "off" : s.approvals.length ? "waiting" : active ? "busy" : "idle";
  return `<div class="who"><span id="bandMark">${mark({ px: 2, state })}</span><b>agentswitch</b>${s.version ? `<span class="faint" id="version">v${esc(s.version)}</span>` : '<span class="faint" id="version"></span>'}</div>
  <span class="sp"></span>
  <div class="st"><span title="${s.health ? "服务运行中" : "服务未连接"}"><span class="dot${s.health ? " on" : ""}" id="dot"></span>service</span>${s.approvals.length ? `<span class="w">${square("waiting")}${s.approvals.length} waiting</span>` : ""}</div>
  <a href="/ui/terminal.html" class="out">terminals ↗</a>`;
}

/** `⠙1 ▪1`: tasks in progress, tasks waiting for you. */
function counts(s) {
  const busy = s.tasks.filter((t) => ACTIVE.has(t.status) && t.status !== "waiting_approval").length;
  return `${busy ? `<span class="busy">${SPIN[1]}${busy}</span>` : ""}<span class="w" id="apCount">${s.approvals.length ? `▪${s.approvals.length}` : ""}</span>`;
}

function topics(s) {
  const threads = s.threads || [];
  if (!threads.length) return '<div class="topic none"><span></span><span class="t faint">暂无话题</span><span></span></div>';
  const latest = (id) => s.tasks.filter((t) => t.threadId === id).sort((a, b) => b.createdAt - a.createdAt)[0];
  const open = s.task?.threadId;
  const shown = s.allTopics ? threads : threads.slice(0, TOPICS_SHOWN);
  return shown.map((th) => {
    const task = latest(th.id);
    const running = s.tasks.some((t) => t.threadId === th.id && ACTIVE.has(t.status));
    // A topic not yet named (its summary comes after a run) goes by what was asked last.
    const name = th.title || (task?.task || "").split("\n")[0].slice(0, 60) || "（未命名）";
    return `<div class="topic${open === th.id ? " on" : ""}" id="topic-${esc(th.id)}" ${task ? `data-open="${task.id}"` : ""} title="${esc(name)}">${topicSquare(th.id)}<span class="t">${esc(name)}</span><span class="age">${running ? spinner() : esc(agoShort(th.lastActivity || th.updatedAt))}</span></div>`;
  }).join("") + (threads.length > TOPICS_SHOWN ? `<div class="topic more" id="topics-more"><span></span><span class="t faint">${s.allTopics ? "▾ less" : `▸ ${threads.length - TOPICS_SHOWN} more`}</span><span></span></div>` : "");
}

/** A character meter: `████░░░░`. */
export function meter(pct, cells = 12) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const on = Math.round((p / 100) * cells);
  return `<span class="meter ${p >= 90 ? "bad" : p >= 70 ? "hi" : ""}">${"█".repeat(on)}<i>${"░".repeat(cells - on)}</i></span>`;
}

function usage(quota) {
  if (!quota.length) return '<div class="u faint">…</div>';
  return quota.map((q) => {
    const d = q.detail || {};
    const name = HARNESS_NAMES[q.harness] || q.harness;
    const head = `<div class="uh">${agentMark(q.harness)}<span>${esc(name)}</span></div>`;
    if (q.harness === "opencode" && d.balances?.length) return `<div class="u">${head}${d.balances.map((b) => `<div class="ul"><span>余额</span><span>${esc(b.total)} ${esc(b.currency || "")}</span></div>`).join("")}</div>`;
    const windows = (d.windows || []).filter((w) => !(w.resetsAt && w.resetsAt * 1000 < Date.now()));
    const lines = windows.length ? windows.map((w) => `<div class="ul"><span>${esc(w.label)}</span>${meter(w.usedPercent)}<span>${Math.round(w.usedPercent)}%</span></div>`).join("")
      : q.remaining !== null && q.remaining !== undefined ? `<div class="ul"><span>left</span>${meter(100 - q.remaining * 100)}<span>${Math.round(q.remaining * 100)}% left</span></div>`
      : '<div class="ul faint"><span>—</span></div>';
    // A failed read says so in a line; the whole error is in its tooltip.
    return `<div class="u">${head}${lines}${q.error ? `<div class="ul err" title="${esc(q.error)}">${esc(q.error.split("\n")[0])}</div>` : ""}</div>`;
  }).join("");
}

export function sidebar(s) {
  const active = s.view === "task" ? "home" : s.view;   // a task opens beside the tasks
  // The id keys each link for the patcher, so moving `active` patches the links instead of reshuffling them.
  const links = NAV.map(([view, label]) => `<a id="nav-${view}" data-nav="${view}"${view === active ? ' class="on"' : ""}><span class="ar">▸</span><span>${label}</span><span class="n">${view === "home" ? counts(s) : ""}</span></a>`);
  return `<div class="sec lbl">// console</div>
  <nav>
    ${links.join("\n    ")}
  </nav>
  <div class="rule"></div>
  <div class="sec lbl">// topics</div>
  <div class="topics">${topics(s)}</div>
  <div class="rule"></div>
  <div class="sec lbl usage-h"><span>// usage</span><button class="link" id="q-refresh" title="强制刷新用量">refresh</button></div>
  <div class="usage">${usage(s.quota || [])}</div>
  <div class="side-foot"><button class="link" id="refresh">reload</button></div>`;
}
