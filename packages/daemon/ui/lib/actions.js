/** Everything that talks to the daemon and updates state. Views only render and dispatch here. */

import { api } from "./api.js";
import { get, set } from "./state.js";

export const loadTasks = async () => set({ tasks: await api("GET", "/tasks?limit=50") });
export const loadApprovals = async () => set({ approvals: await api("GET", "/approvals") });
export const loadQuota = async (refresh = false) => set({ quota: await api("GET", "/quota" + (refresh ? "?refresh=1" : "")) });
export const loadLog = async () => set({ log: await api("GET", "/routing/log?limit=50") });

export async function loadExt() {
  const [mcp, skills, discovered] = await Promise.all([api("GET", "/mcp"), api("GET", "/skills"), api("GET", "/skills/discover")]);
  set({ mcp, skills, discovered });
}

export async function loadCtx() {
  const r = await api("GET", "/context");
  set((s) => ({ ctx: { ...s.ctx, path: r.path, text: r.text, warnings: r.warnings, draft: null, hint: "" } }));
}

export async function health() {
  try { const h = await api("GET", "/healthz"); set({ health: true, version: h.version || "" }); }
  catch { set({ health: false }); }
}

export function closeStream() {
  const es = get().es;
  if (es) es.close();
  set({ es: null });
}

const LOADERS = { home: [loadTasks, loadQuota], log: [loadLog], ext: [loadExt], ctx: [loadCtx] };

export async function goto(view) {
  closeStream();
  set({ view, hint: "" });
  await Promise.all((LOADERS[view] || []).map((f) => f()));
}

export async function refresh() {
  const view = get().view;
  await Promise.all([health(), loadTasks(), loadApprovals(), ...(LOADERS[view] || []).map((f) => f())]);
}

const EVENT_TYPES = ["queued", "routed", "dispatched", "text", "tool_call", "approval_request", "approval_resolved", "attempt_failed", "redispatch", "done", "failed", "cancelled", "cleaned"];
const RELOAD_ON = new Set(["approval_request", "approval_resolved", "done", "failed", "cancelled", "redispatch", "dispatched", "routed"]);

/** Open the task view and follow its event stream (`/tasks/${id}/events`, SSE). */
export function openTask(id) {
  closeStream();
  set((s) => ({ view: "task", task: s.tasks.find((t) => t.id === id) || null, events: [], hint: "" }));
  api("GET", "/tasks/" + id).then((task) => set({ task })).catch((err) => set({ hint: err.message }));
  const es = new EventSource(`/tasks/${id}/events`);
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, async (m) => {
      const ev = JSON.parse(m.data);
      set((s) => ({ events: [...s.events, ev] }));
      if (RELOAD_ON.has(type)) {
        const [task] = await Promise.all([api("GET", "/tasks/" + id), loadApprovals()]);
        set({ task });
      }
    });
  }
  es.onerror = () => es.close();
  set({ es });
}

export async function submitTask(body) {
  const t = await api("POST", "/tasks", body);
  await loadTasks();
  openTask(t.id);
}

export async function approve(taskId, approvalId, decision) {
  await api("POST", `/tasks/${taskId}/approve`, { approval_id: approvalId, decision });
  await Promise.all([loadApprovals(), loadTasks()]);
}

export const cancelTask = (id) => api("POST", `/tasks/${id}/cancel`);

/** Run an extension mutation, surface its error in the view, then reload the registries. */
export async function extAction(fn) {
  set({ extHint: "" });
  try { await fn(); } catch (err) { set({ extHint: err.message }); }
  await loadExt();
}

export async function saveCtx(text) {
  set((s) => ({ ctx: { ...s.ctx, hint: "", saved: false } }));
  try {
    await api("PUT", "/context", { text });
    await loadCtx();
    set((s) => ({ ctx: { ...s.ctx, saved: true } }));
  } catch (err) {
    set((s) => ({ ctx: { ...s.ctx, hint: err.message } }));
  }
}

export async function loadCtxExample() {
  const r = await api("GET", "/context/example");
  set((s) => ({ ctx: { ...s.ctx, draft: r.text, saved: false } }));
}
