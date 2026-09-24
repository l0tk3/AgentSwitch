/** Cached readings from every provider; `map()` is what the router's floor consumes. */

import type { QuotaProvider, QuotaReading } from "./types.js";

export type { QuotaProvider, QuotaReading } from "./types.js";
import { QUOTA_TTL_MS } from "../core/limits.js";
export const QUOTA_TIMEOUT_MS = 10_000;

/** Arms one provider's deadline and returns its disarm. Tests may expire it on an event instead of elapsed time. */
export type ArmDeadline = (ms: number, expire: () => void) => () => void;
const armTimer: ArmDeadline = (ms, expire) => {
  const timer = setTimeout(expire, ms);
  return () => clearTimeout(timer);
};

export class QuotaService {
  private readings = new Map<string, QuotaReading>();
  private inflight: Promise<QuotaReading[]> | null = null;

  constructor(private readonly providers: readonly QuotaProvider[], private readonly ttlMs = QUOTA_TTL_MS, private readonly now: () => number = Date.now, private readonly timeoutMs = QUOTA_TIMEOUT_MS, private readonly armDeadline: ArmDeadline = armTimer) {}

  async refresh(force = false): Promise<QuotaReading[]> {
    const fresh = [...this.readings.values()].every((r) => this.now() - r.fetchedAt < this.ttlMs) && this.readings.size === this.providers.length;
    if (!force && fresh) return [...this.readings.values()];
    if (this.inflight) return this.inflight;
    this.inflight = Promise.all(this.providers.map((p) => this.readProvider(p, force))).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async readProvider(provider: QuotaProvider, force: boolean): Promise<QuotaReading> {
    const controller = new AbortController();
    let disarm!: () => void;
    const deadline = new Promise<never>((_, reject) => {
      disarm = this.armDeadline(this.timeoutMs, () => {
        const error = new Error(`quota timed out after ${this.timeoutMs} ms`);
        controller.abort(error);  // providers stop their fetch/process, not just the HTTP response
        reject(error);
      });
    });
    let reading: QuotaReading;
    try {
      // Race even providers that ignore cancellation; a late result must never overwrite a later refresh.
      const value = await Promise.race([Promise.resolve().then(() => provider.read(force, controller.signal)), deadline]);
      reading = { harness: provider.harness, fetchedAt: this.now(), ...value };
    } catch (error) {
      const previous = this.readings.get(provider.harness);
      reading = { harness: provider.harness, remaining: previous?.remaining ?? null, detail: previous?.detail ?? {}, source: previous?.source ?? `${provider.harness} quota`, fetchedAt: this.now(), error: error instanceof Error ? error.message : String(error) };
    } finally {
      disarm();
    }
    this.readings.set(provider.harness, reading);
    return reading;
  }

  /** Last known readings without fetching (empty before the first refresh). */
  current(): QuotaReading[] {
    return [...this.readings.values()];
  }

  /** Router input: unknown readings are omitted, which the floor treats as available. */
  map(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.readings.values()) if (r.remaining !== null) out[r.harness] = r.remaining;
    return out;
  }
}
