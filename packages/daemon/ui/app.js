/** Entry (docs/ui-v0.md §7.4 网页控制台): the band, the side, the middle and the task beside it, each patched in place
 *  so live editors stay connected; events routed to the pane they happen in; polling. */

import { get, set, subscribe } from "./lib/state.js";
import { createRenderer } from "./lib/rendering.js";
import { band, sidebar } from "./lib/sidebar.js";
import { addPending, goto, health, loadApprovals, loadArchivedThreads, loadPolicy, loadQuota, loadTasks, loadThreads, openTask, refresh, removePending } from "./lib/actions.js";
import { SPIN, reducedMotion } from "./pixel.js";
import * as home from "./views/home.js";
import * as task from "./views/task.js";
import * as log from "./views/log.js";
import * as ext from "./views/ext.js";
import * as ctx from "./views/ctx.js";

const VIEWS = { home, task, log, ext, ctx };
const $ = (s) => document.querySelector(s);
const main = $("#main");
const detail = $("#detail");
const renderer = createRenderer(main);
const detailRenderer = createRenderer(detail);
const sideRenderer = createRenderer($("#side"));
const bandRenderer = createRenderer($("#band"));
let renderedScope, renderedDetail, renderedEvents;

/** The middle's view: the tasks while one is open beside them. */
const middle = (s) => (s.view === "task" ? home : VIEWS[s.view] || home);

function render(s) {
  bandRenderer.render(band(s), "band");
  sideRenderer.render(sidebar(s), "side");
  const tasks = s.view === "home" || s.view === "task";
  main.className = tasks ? "tasks" : "page";
  document.body.classList.toggle("with-detail", s.view === "task");
  // Opening or closing the task beside keeps the tasks as they are (a draft, the scroll); another page starts afresh.
  const scope = tasks ? "home" : `${s.view}:${s.navigationId}`;
  if (renderer.render(middle(s).render(s), scope) && scope !== renderedScope) middle(s).afterRender?.();
  renderedScope = scope;
  detail.hidden = s.view !== "task";
  if (s.view === "task") {
    const scopeBeside = `task:${s.task?.id || "loading"}:${s.navigationId}`;
    const events = $("#events");
    const following = events && events.scrollHeight - events.scrollTop - events.clientHeight <= 4;
    if (detailRenderer.render(task.render(s), scopeBeside) && (scopeBeside !== renderedDetail || (s.events !== renderedEvents && following))) task.afterRender?.();
    renderedDetail = scopeBeside; renderedEvents = s.events;
  } else {
    renderedDetail = undefined;
  }
}

// Attachments go to the composer they were added in.
const picker = document.createElement("input");
picker.type = "file"; picker.multiple = true; picker.hidden = true;
document.body.appendChild(picker);
let pickFor = "home";
picker.addEventListener("change", () => { addPending(picker.files, pickFor); picker.value = ""; });
const composerKey = (el) => el?.closest?.("[data-composer-key]")?.dataset.composerKey || "home";

document.addEventListener("click", async (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) { e.preventDefault(); return goto(nav.dataset.nav); }
  if (e.target.closest("#refresh")) return refresh();
  if (e.target.closest("#q-refresh")) { const el = e.target.closest("#q-refresh"); el.disabled = true; try { await loadQuota(true); } finally { el.disabled = false; } return; }
  if (e.target.closest("#topics-more")) return set((s) => ({ allTopics: !s.allTopics }));
  const topic = e.target.closest("#side [data-open]");
  if (topic) return openTask(topic.dataset.open);
  const attach = e.target.closest("[data-attach]");
  if (attach) { pickFor = composerKey(attach); return picker.click(); }
  const rm = e.target.closest("[data-pending-remove]");
  if (rm) return removePending(Number(rm.dataset.pendingRemove));
  const s = get();
  const pane = detail.contains(e.target) ? detail : main.contains(e.target) ? main : null;
  if (!pane) return;
  const view = pane === detail ? task : middle(s);
  for (const b of view.bindings) {
    const el = e.target.closest(b.sel);
    if (!el || !pane.contains(el)) continue;
    try { await b.run(el, e, s); } catch (err) { alert(err.message); }
    return;
  }
});

document.addEventListener("input", (e) => ctx.onInput(e.target));

// Drag-over highlighting is the one view detail kept out of state: it follows the pointer, not data, and
// dragleave/dragover alternate every time the pointer crosses one of the composer's children, so a state
// entry would re-render the whole view on each crossing. It is only the `drop` class on the zone; a
// background render may clear it, and the next dragover (they repeat while hovering) sets it again.
const dropZone = (e) => e.target.closest?.("[data-dropzone]");
const highlight = (zone, on) => zone?.classList.toggle("drop", on);
document.addEventListener("dragover", (e) => { const zone = dropZone(e); if (zone) { e.preventDefault(); highlight(zone, true); } });
document.addEventListener("dragleave", (e) => highlight(dropZone(e), false));
document.addEventListener("drop", (e) => {
  const zone = dropZone(e);
  if (!zone) return;
  e.preventDefault();
  highlight(zone, false);
  if (zone.getAttribute("aria-busy") === "true") return;
  addPending(e.dataTransfer.files, composerKey(zone));
});
document.addEventListener("paste", (e) => {
  const zone = dropZone(e);
  if (!zone || zone.getAttribute("aria-busy") === "true") return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addPending(files, composerKey(zone)); }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && get().view === "task" && !e.target.closest?.("input,textarea,select")) { goto("home"); return; }
  if (renderer.isComposing(e) || detailRenderer.isComposing(e)) return;
  if (!(e.metaKey || e.ctrlKey)) return;
  const keys = { ...(middle(get()).submitKeys || {}), ...(get().view === "task" ? task.submitKeys : {}) };
  if (e.key === "Enter" && keys[e.target.id]) { e.preventDefault(); $("#" + keys[e.target.id])?.click(); }
  if (e.key === "s" && e.target.id === "ctx-text") { e.preventDefault(); ctx.save(); }
});

subscribe(render);

let tickRunning = false;
async function tick(n) {
  if (tickRunning) return;
  tickRunning = true;
  const s = get();
  // Quota probes can be slow. One bounded request is shared, and never delays task polling.
  if (!document.hidden && n % 24 === 0) void loadQuota().catch(() => undefined);
  // The side shows the tasks' counts and the topics on every page.
  try { await Promise.allSettled([
    health(), loadApprovals(), loadTasks(),
    n % 3 === 0 ? loadThreads().catch(() => undefined) : null,
    (s.view === "home" || s.view === "task") && n % 3 === 0 ? loadArchivedThreads().catch(() => undefined) : null,
  ]); } finally { tickRunning = false; }
}

// Spinners turn by themselves, without a render.
let frame = 0;
setInterval(() => {
  if (reducedMotion.matches) return;
  frame = (frame + 1) % SPIN.length;
  for (const el of document.querySelectorAll("[data-spin]")) el.textContent = SPIN[frame];
}, 90);

render(get());
// `?task=<id>`: opened on one task (the Mac's Live Activity card); the address goes back to the console's own.
const wantedTask = globalThis.location ? new URLSearchParams(location.search).get("task") : null;
if (wantedTask) { history.replaceState(null, "", location.pathname); openTask(wantedTask); }
void loadPolicy().catch(() => undefined);
void tick(0);
let pollNumber = 0;
setInterval(() => { void tick(++pollNumber); }, 5000);
