/** In-process fan-out of task events to live SSE subscribers. Persistence is the store's job. */

import { EventEmitter } from "node:events";
import type { TaskEvent } from "./types.js";

export class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(1000);
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
