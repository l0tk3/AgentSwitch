/** FIFO semaphore and keyed mutex with AbortSignal support (background-v0 §1). A waiter that is
 *  aborted leaves the queue and rejects; a release wakes the next live waiter. */

export type Release = () => void;

type Waiter = { resolve: (r: Release) => void; reject: (e: Error) => void; signal?: AbortSignal; onAbort?: () => void };

export class Semaphore {
  private readonly waiters: Waiter[] = [];
  private active = 0;

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`semaphore limit must be a positive integer, got ${limit}`);
  }

  get inUse(): number { return this.active; }
  get waiting(): number { return this.waiters.length; }
  /** True when acquire() would have to wait. */
  get full(): boolean { return this.active >= this.limit; }

  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.limit) { this.active++; return Promise.resolve(this.releaser()); }
    return new Promise<Release>((resolve, reject) => {
      const w: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        w.onAbort = () => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); reject(abortError(signal)); };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.waiters.push(w);
    });
  }

  private releaser(): Release {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) {
        if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
        next.resolve(this.releaser());   // the slot passes straight to the next waiter
      } else {
        this.active--;
      }
    };
  }
}

/** One mutex per key, created on demand and dropped when idle. */
export class KeyedLock {
  private readonly locks = new Map<string, Semaphore>();

  async acquire(key: string, signal?: AbortSignal): Promise<Release> {
    const sem = this.locks.get(key) ?? new Semaphore(1);
    this.locks.set(key, sem);
    const release = await sem.acquire(signal);
    return () => { release(); if (sem.inUse === 0 && sem.waiting === 0) this.locks.delete(key); };
  }

  isHeld(key: string): boolean {
    return (this.locks.get(key)?.inUse ?? 0) > 0;
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("cancelled");
}
