/** One immutable state object. Equivalent polling responses retain their references and do not
 * notify subscribers. `patch` remains silent for keystroke-level draft updates. */

const initial = {
  view: "home",
  health: false, version: "",
  tasks: [], threads: [], archivedThreads: [], task: null, events: [], es: null, approvals: [], quota: [], log: [],
  deletions: {},                     // kind:id -> {status, message}; successful deletions also guard against stale polls
  answerSubmissions: {},             // approvalId -> {taskId, status, message}; survives SSE/poll re-renders, never stores answers
  taskSubmissions: {},               // home / followup:taskId -> submission status; no message text is stored here
  navigationId: 0,                   // protects newer drafts from an older request's completion
  hint: "",
  pending: [],                       // [{file, url}] attached to the visible composer
  files: { root: null, files: [] },  // files of the open task (in/ + out/, or the artifacts store)
  thread: null,
  policy: null,                      // {policy:{mode,human}, categories:[{id,title}]} from /approvals/policy                      // the open task's thread (GET /threads/:id), with folded state and tasks
  mcp: [], skills: [], discovered: [], edit: { mcp: null, skill: null }, extHint: "",
  ctx: { path: "", text: "", warnings: [], draft: null, hint: "", saved: false },
  mem: { path: "", text: "", warnings: [], draft: null, hint: "", saved: false },   // MEMORY.md, same shape
  platformMem: { records: [], loaded: false, loading: false, hint: "", deletions: {} },
};

let state = initial;
const listeners = new Set();

export const get = () => state;

function same(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, i) => same(value, b[i]));
  // Files, EventSource and other browser handles are compared by identity, never by empty keys.
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}

export function patch(next) {
  const update = typeof next === "function" ? next(state) : next;
  const changed = Object.entries(update).filter(([key, value]) => !same(state[key], value));
  if (changed.length) state = { ...state, ...Object.fromEntries(changed) };
  return state;
}

export function set(next) {
  const before = state;
  patch(next);
  if (state !== before) for (const fn of listeners) fn(state);
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
