/** Sidebar chrome as a function of state: health dot, approval count, active tab, version. Same markup as the
 *  static shell in index.html, which app.js patches in place with its own renderer. */
import { esc } from "./api.js";

const NAV = [["home", "首页"], ["log", "调度记录"], ["ext", "扩展"], ["ctx", "上下文"]];

export function sidebar(s) {
  const active = s.view === "task" ? "home" : s.view;   // a task detail belongs to 首页
  // The id keys each link for the patcher, so moving `active` patches the links instead of reshuffling them.
  const links = NAV.map(([view, label]) => `<a id="nav-${view}" data-nav="${view}"${view === active ? ' class="active"' : ""}>${label}${view === "home" ? `<span class="count" id="apCount">${s.approvals.length || ""}</span>` : ""}</a>`);
  return `<div class="brand"><span class="dot${s.health ? " on" : ""}" id="dot"></span><b>AgentSwitch</b></div>
  <nav>
    ${links.join("\n    ")}
  </nav>
  <div class="side-foot"><span class="dim" id="version">${s.version ? "v" + esc(s.version) : ""}</span><button class="small" id="refresh">刷新</button></div>`;
}
