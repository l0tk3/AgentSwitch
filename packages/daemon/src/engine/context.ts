/** What every engine module needs: the store, the event bus, a clock, and the way to emit a task event. */

import type { Bus } from "./bus.js";
import type { Store } from "./store.js";
import { TERMINAL, type TaskEvent, type TaskEventType, type TaskStatus } from "./types.js";

export type EngineContext = {
  readonly store: Store;
  readonly bus: Bus;
  readonly now: () => number;
  /** Persist and fan out one task event. */
  readonly emit: (taskId: string, type: TaskEventType, payload?: Record<string, unknown>) => TaskEvent | undefined;
};

export function engineContext(store: Store, bus: Bus, now: () => number = Date.now): EngineContext {
  return {
    store, bus, now,
    emit: (taskId, type, payload = {}) => {
      // Detached supervisor callbacks may finish after a task was deleted. Never recreate its history.
      const task = store.getTask(taskId);
      if (!task) return undefined;
      if (TERMINAL.has(type as TaskStatus) && task.status !== type) return undefined;
      if (TERMINAL.has(task.status) && ["routed", "dispatched", "redispatch", "approval_request", "waiting"].includes(type)) return undefined;
      const ev = store.appendEvent(taskId, type, payload);
      bus.publish(ev);
      return ev;
    },
  };
}
