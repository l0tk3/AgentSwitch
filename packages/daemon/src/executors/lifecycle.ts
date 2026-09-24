/** The run lifecycle every harness adapter shares: one overall deadline, the engine's abort signal, and how a run they
 *  stop is reported. Adapters compose these with their own stop action (terminate a process group, fail an RPC client,
 *  abort the SDK query). Cleanup order: dispose the watch once the harness has settled, then wait for its process group
 *  (harness/processes.ts), then remove private dirs. The default deadline is core/limits.ts DEFAULT_EXECUTOR_TIMEOUT_MS. */

import type { ExecutionOutcome } from "../core/outcome.js";

export type StopCause = "abort" | "timeout";

/** A running execution's stop conditions. `timedOut` stays readable after `dispose()`. */
export type RunStop = { readonly timedOut: boolean; dispose(): void };

/** Calls `onStop` when the engine aborts `signal` (at once if it already has) and when `maxMs` passes, `timedOut` being
 *  set first. Each cause fires at most once and independently: an abort does not cancel the deadline, so `onStop` must
 *  be idempotent. `maxMs: null` means no deadline. `dispose()` clears both. */
export function watchRunStop(signal: AbortSignal, maxMs: number | null, onStop: (cause: StopCause) => void): RunStop {
  let timedOut = false;
  const onAbort = () => onStop("abort");
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = maxMs === null ? null : setTimeout(() => { timedOut = true; onStop("timeout"); }, maxMs);
  if (signal.aborted) onAbort();
  return {
    get timedOut() { return timedOut; },
    dispose() {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/** A run that was stopped or whose stream broke: never a success, and what it observed is only a lower bound on its
 *  side effects. `patch` carries the adapter's own exit code, error text, last text and timedOut flag. */
export function interruptedOutcome(outcome: ExecutionOutcome, patch: Partial<ExecutionOutcome> = {}): ExecutionOutcome {
  return { ...outcome, ...patch, ok: false, sideEffectsKnown: false };
}
