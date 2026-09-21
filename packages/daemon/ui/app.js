/** Entry: renders the current view into #main on every state change, routes clicks to the view's
 *  bindings, and polls the daemon. Typed-in fields marked data-keep survive re-renders. */

import { get, subscribe } from "./lib/state.js";
import { addPending, goto, health, loadApprovals, loadQuota, loadTasks, refresh, removePending } from "./lib/actions.js";
import * as home from "./views/home.js";
import * as task from "./views/task.js";
import * as log from "./views/log.js";
import * as ext from "./views/ext.js";
import * as ctx from "./views/ctx.js";

const VIEWS = { home, task, log, ext, ctx };
const $ = (s) => document.querySelector(s);
const main = $("#main");

/** Snapshot of data-keep fields so a re-render does not eat what the user is typing. */
function keep() {
  const active = document.activeElement;
  return [...main.querySelectorAll("[data-keep]")].map((el) => ({
    id: el.id, value: el.value, focused: el === active,
    start: el.selectionStart, end: el.selectionEnd,
  }));
}

function restore(saved) {
  for (const k of saved) {
    const el = document.getElementById(k.id);
    if (!el) continue;
    el.value = k.value;
    if (k.focused) { el.focus(); try { el.setSelectionRange(k.start, k.end); } catch { /* selects and inputs without selection */ } }
  }
}

function render(s) {
  $("#dot").classList.toggle("on", s.health);
  $("#version").textContent = s.version ? "v" + s.version : "";
  $("#apCount").textContent = s.approvals.length ? String(s.approvals.length) : "";
  const navView = s.view === "task" ? "home" : s.view;
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === navView));
  const view = VIEWS[s.view] || home;
  const saved = keep();
  main.innerHTML = view.render(s);
  restore(saved);
  view.afterRender?.();
}

const picker = document.createElement("input");
picker.type = "file"; picker.multiple = true; picker.hidden = true;
document.body.appendChild(picker);
picker.addEventListener("change", () => { addPending(picker.files); picker.value = ""; });

document.addEventListener("click", async (e) => {
  const nav = e.target.closest("nav a[data-nav]");
  if (nav) return goto(nav.dataset.nav);
  if (e.target.closest("#refresh")) return refresh();
  if (e.target.closest("[data-attach]")) return picker.click();
  const rm = e.target.closest("[data-pending-remove]");
  if (rm) return removePending(Number(rm.dataset.pendingRemove));
  const s = get();
  const view = VIEWS[s.view] || home;
  for (const b of view.bindings) {
    const el = e.target.closest(b.sel);
    if (!el || !main.contains(el)) continue;
    try { await b.run(el, e, s); } catch (err) { alert(err.message); }
    return;
  }
});

document.addEventListener("input", (e) => ctx.onInput(e.target));

document.addEventListener("dragover", (e) => { if (e.target.closest("[data-dropzone]")) { e.preventDefault(); e.target.closest("[data-dropzone]").classList.add("drop"); } });
document.addEventListener("dragleave", (e) => e.target.closest?.("[data-dropzone]")?.classList.remove("drop"));
document.addEventListener("drop", (e) => {
  const zone = e.target.closest("[data-dropzone]");
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove("drop");
  addPending(e.dataTransfer.files);
});
document.addEventListener("paste", (e) => {
  if (!e.target.closest?.("[data-dropzone]")) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addPending(files); }
});

document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const view = VIEWS[get().view] || home;
  if (e.key === "Enter" && view.submitKeys?.[e.target.id]) { e.preventDefault(); $("#" + view.submitKeys[e.target.id])?.click(); }
  if (e.key === "s" && e.target.id === "ctx-text") { e.preventDefault(); ctx.save(); }
});

subscribe(render);

async function tick(n) {
  const s = get();
  await Promise.all([
    health(), loadApprovals(),
    s.view === "home" ? loadTasks() : null,
    s.view === "home" && n % 6 === 0 ? loadQuota() : null,
  ]);
}

(async () => {
  await Promise.all([health(), loadTasks(), loadApprovals(), loadQuota()]);
  render(get());
  let n = 0;
  setInterval(() => tick(++n), 5000);
})();
