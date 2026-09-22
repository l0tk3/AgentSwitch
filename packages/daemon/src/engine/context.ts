/** What every engine module needs: the store, the event bus, a clock, and the way to emit a task event. */

import type { Bus } from "./bus.js";
import type { Store } from "./store.js";
import type { TaskEvent, TaskEventType } from "./types.js";

export type EngineContext = {
  readonly store: Store;
  readonly bus: Bus;
  readonly now: () => number;
  /** Persist and fan out one task event. */
  readonly emit: (taskId: string, type: TaskEventType, payload?: Record<string, unknown>) => TaskEvent;
};

export function engineContext(store: Store, bus: Bus, now: () => number = Date.now): EngineContext {
  return {
    store, bus, now,
    emit: (taskId, type, payload = {}) => { const ev = store.appendEvent(taskId, type, payload); bus.publish(ev); return ev; },
  };
}
