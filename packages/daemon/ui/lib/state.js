/** One immutable state object. `set` replaces it and notifies subscribers; `patch` replaces it silently
 *  (for keystroke-level updates that must not re-render the element being typed in). */

const initial = {
  view: "home",
  health: false, version: "",
  tasks: [], task: null, events: [], es: null, approvals: [], quota: [], log: [],
  hint: "",
  mcp: [], skills: [], discovered: [], edit: { mcp: null, skill: null }, extHint: "",
  ctx: { path: "", text: "", warnings: [], draft: null, hint: "", saved: false },
};

let state = initial;
const listeners = new Set();

export const get = () => state;

export function patch(next) {
  state = { ...state, ...(typeof next === "function" ? next(state) : next) };
  return state;
}

export function set(next) {
  patch(next);
  for (const fn of listeners) fn(state);
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
