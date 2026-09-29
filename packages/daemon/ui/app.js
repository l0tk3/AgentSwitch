/** Entry: patch the sidebar and changed view content without disconnecting live editors, route events and poll. */

import { get, subscribe } from "./lib/state.js";
import { createRenderer } from "./lib/rendering.js";
import { sidebar } from "./lib/sidebar.js";
import { addPending, goto, health, loadApprovals, loadArchivedThreads, loadQuota, loadTasks, loadThreads, openTask, refresh, removePending } from "./lib/actions.js";
import * as home from "./views/home.js";
import * as task from "./views/task.js";
import * as log from "./views/log.js";
import * as ext from "./views/ext.js";
import * as ctx from "./views/ctx.js";

const VIEWS = { home, task, log, ext, ctx };
const $ = (s) => document.querySelector(s);
const main = $("#main");
const renderer = createRenderer(main);
const sideRenderer = createRenderer($("aside.side"));
let renderedScope, renderedEvents;

function render(s) {
  sideRenderer.render(sidebar(s), "side");
  const view = VIEWS[s.view] || home;
  const scope = `${s.view}:${s.view === "task" ? s.task?.id || "loading" : ""}:${s.navigationId}`;
  const events = $("#events");
  const following = events && events.scrollHeight - events.scrollTop - events.clientHeight <= 4;
  if (renderer.render(view.render(s), scope) && (scope !== renderedScope || (s.events !== renderedEvents && following))) view.afterRender?.();
  renderedScope = scope; renderedEvents = s.events;
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
  addPending(e.dataTransfer.files);
});
document.addEventListener("paste", (e) => {
  const zone = dropZone(e);
  if (!zone || zone.getAttribute("aria-busy") === "true") return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addPending(files); }
});

document.addEventListener("keydown", (e) => {
  if (renderer.isComposing(e)) return;
  if (!(e.metaKey || e.ctrlKey)) return;
  const view = VIEWS[get().view] || home;
  if (e.key === "Enter" && view.submitKeys?.[e.target.id]) { e.preventDefault(); $("#" + view.submitKeys[e.target.id])?.click(); }
  if (e.key === "s" && e.target.id === "ctx-text") { e.preventDefault(); ctx.save(); }
});

subscribe(render);

let tickRunning = false;
async function tick(n) {
  if (tickRunning) return;
  tickRunning = true;
  const s = get();
  // Quota probes can be slow. One bounded request is shared, and never delays task polling.
  if (s.view === "home" && !document.hidden && n % 24 === 0) void loadQuota().catch(() => undefined);
  try { await Promise.allSettled([
    health(), loadApprovals(),
    s.view === "home" ? loadTasks() : null,
    s.view === "home" && n % 3 === 0 ? loadThreads().catch(() => undefined) : null,
    s.view === "home" && n % 3 === 0 ? loadArchivedThreads().catch(() => undefined) : null,
  ]); } finally { tickRunning = false; }
}

render(get());
// `?task=<id>`: opened on one task (the Mac's Live Activity card); the address goes back to the console's own.
const wantedTask = globalThis.location ? new URLSearchParams(location.search).get("task") : null;
if (wantedTask) { history.replaceState(null, "", location.pathname); openTask(wantedTask); }
void tick(0);
let pollNumber = 0;
setInterval(() => { void tick(++pollNumber); }, 5000);
