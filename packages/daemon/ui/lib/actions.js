/** Everything that talks to the daemon and updates state. Views only render and dispatch here. */

import { api } from "./api.js";
import { get, set } from "./state.js";
import { releasePending, toPending, uploadPending } from "./files.js";

export const loadTasks = async () => set({ tasks: await api("GET", "/tasks?limit=50") });
export const loadThreads = async () => set({ threads: await api("GET", "/threads?status=open&limit=30") });
export const loadApprovals = async () => set({ approvals: await api("GET", "/approvals") });
export const loadQuota = async (refresh = false) => set({ quota: await api("GET", "/quota" + (refresh ? "?refresh=1" : "")) });
export const loadLog = async () => set({ log: await api("GET", "/routing/log?limit=50") });

export async function loadExt() {
  const [mcp, skills, discovered] = await Promise.all([api("GET", "/mcp"), api("GET", "/skills"), api("GET", "/skills/discover")]);
  set({ mcp, skills, discovered });
}

export async function loadCtx() {
  const [r, m] = await Promise.all([api("GET", "/context"), api("GET", "/memory")]);
  set((s) => ({ ctx: { ...s.ctx, path: r.path, text: r.text, warnings: r.warnings, draft: null, hint: "" }, mem: { ...s.mem, path: m.path, text: m.text, warnings: m.warnings, draft: null, hint: "" } }));
}

export async function health() {
  try { const h = await api("GET", "/healthz"); set({ health: true, version: h.version || "" }); }
  catch { set({ health: false }); }
}

export const loadFiles = async (taskId) => set({ files: await api("GET", `/tasks/${taskId}/files`) });
export const loadThread = async (threadId) => set({ thread: threadId ? await api("GET", `/threads/${threadId}`) : null });

export function addPending(fileList) { if (fileList?.length) set((s) => ({ pending: [...s.pending, ...toPending(fileList)] })); }
export function removePending(i) { set((s) => { s.pending[i]?.url && URL.revokeObjectURL(s.pending[i].url); return { pending: s.pending.filter((_, k) => k !== i) }; }); }
export function clearPending() { releasePending(get().pending); set({ pending: [] }); }

export function closeStream() {
  const es = get().es;
  if (es) es.close();
  set({ es: null });
}

const LOADERS = { home: [loadTasks, loadThreads, loadQuota], log: [loadLog], ext: [loadExt], ctx: [loadCtx] };

export async function goto(view) {
  closeStream();
  clearPending();
  set({ view, hint: "" });
  await Promise.all((LOADERS[view] || []).map((f) => f()));
}

export async function refresh() {
  const view = get().view;
  await Promise.all([health(), loadTasks(), loadApprovals(), ...(LOADERS[view] || []).map((f) => f())]);
}

const EVENT_TYPES = ["queued", "routed", "thread", "waiting", "dispatched", "text", "tool_call", "agent", "approval_request", "approval_resolved", "attempt_failed", "redispatch", "handoff", "summary", "done", "failed", "cancelled", "cleaned"];
const RELOAD_ON = new Set(["approval_request", "approval_resolved", "done", "failed", "cancelled", "redispatch", "dispatched", "routed", "cleaned", "handoff", "summary", "thread"]);

/** Open the task view and follow its event stream (`/tasks/${id}/events`, SSE). */
export function openTask(id) {
  closeStream();
  clearPending();
  set((s) => ({ view: "task", task: s.tasks.find((t) => t.id === id) || null, events: [], hint: "", files: { root: null, files: [] }, thread: null }));
  api("GET", "/tasks/" + id).then((task) => { set({ task }); return loadThread(task.threadId); }).catch((err) => set({ hint: err.message }));
  loadFiles(id).catch(() => undefined);
  const es = new EventSource(`/tasks/${id}/events`);
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, async (m) => {
      const ev = JSON.parse(m.data);
      set((s) => ({ events: [...s.events, ev] }));
      if (RELOAD_ON.has(type)) {
        const [task] = await Promise.all([api("GET", "/tasks/" + id), loadApprovals(), loadFiles(id).catch(() => undefined)]);
        set({ task });
        loadThread(task.threadId).catch(() => undefined);
      }
    });
  }
  es.onerror = () => es.close();
  set({ es });
}

/** Upload whatever is pending under the composer, then create the task with those attachment ids. */
export async function submitTask(body) {
  const attachments = await uploadPending(get().pending);
  const t = await api("POST", "/tasks", attachments.length ? { ...body, attachments } : body);
  clearPending();
  await Promise.all([loadTasks(), loadThreads().catch(() => undefined)]);
  openTask(t.id);
}

export async function approve(taskId, approvalId, decision) {
  await api("POST", `/tasks/${taskId}/approve`, { approval_id: approvalId, decision });
  await Promise.all([loadApprovals(), loadTasks()]);
}

export const cancelTask = (id) => api("POST", `/tasks/${id}/cancel`);

/** Hand the task to another executor in the same thread; `pin` = "harness/model" or empty for the router. */
export async function handoffTask(id, pin) {
  const body = pin && pin.includes("/") ? { to: { harness: pin.slice(0, pin.indexOf("/")), model: pin.slice(pin.indexOf("/") + 1) } } : {};
  const next = await api("POST", `/tasks/${id}/handoff`, body);
  await loadTasks();
  openTask(next.id);
}

export async function archiveThread(id) {
  await api("POST", `/threads/${id}/archive`);
  await loadThread(id);
}

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

export async function saveMem(text) {
  set((s) => ({ mem: { ...s.mem, hint: "", saved: false } }));
  try {
    await api("PUT", "/memory", { text });
    await loadCtx();
    set((s) => ({ mem: { ...s.mem, saved: true } }));
  } catch (err) {
    set((s) => ({ mem: { ...s.mem, hint: err.message } }));
  }
}

export async function loadCtxExample() {
  const r = await api("GET", "/context/example");
  set((s) => ({ ctx: { ...s.ctx, draft: r.text, saved: false } }));
}
