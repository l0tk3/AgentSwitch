/** Cached readings from every provider; `map()` is what the router's floor consumes. */

import type { QuotaProvider, QuotaReading } from "./types.js";

export type { QuotaProvider, QuotaReading } from "./types.js";

export class QuotaService {
  private readings = new Map<string, QuotaReading>();
  private inflight: Promise<QuotaReading[]> | null = null;

  constructor(private readonly providers: readonly QuotaProvider[], private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {}

  async refresh(force = false): Promise<QuotaReading[]> {
    const fresh = [...this.readings.values()].every((r) => this.now() - r.fetchedAt < this.ttlMs) && this.readings.size === this.providers.length;
    if (!force && fresh) return [...this.readings.values()];
    if (this.inflight) return this.inflight;
    this.inflight = Promise.all(this.providers.map(async (p) => {
      const r = await p.read(force);
      const reading: QuotaReading = { harness: p.harness, fetchedAt: this.now(), ...r };
      this.readings.set(p.harness, reading);
      return reading;
    })).finally(() => { this.inflight = null; });
    return this.inflight;
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
