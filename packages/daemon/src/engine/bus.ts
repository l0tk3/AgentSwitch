/** In-process fan-out of task events to live SSE subscribers. Persistence is the store's job. */

import { EventEmitter } from "node:events";
import type { TaskEvent } from "./types.js";

/** SSE subscribers plus internal listeners; far above normal use, so a leak still warns. */
const MAX_LISTENERS = 1000;

export class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(MAX_LISTENERS);
  }

  publish(event: TaskEvent): void {
    this.emitter.emit(event.taskId, event);
    this.emitter.emit("*", event);
  }

  /** Returns an unsubscribe function. */
  subscribe(taskId: string | "*", listener: (event: TaskEvent) => void): () => void {
    this.emitter.on(taskId, listener);
    return () => this.emitter.off(taskId, listener);
  }
}
