/** Sleep that ends early when the signal aborts (rejecting with the signal's reason). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("cancelled"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal?.reason ?? new Error("cancelled")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
