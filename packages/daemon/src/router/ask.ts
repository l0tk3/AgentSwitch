/** One router-model call that must come back as JSON of a known shape: timeout per try, one retry that tells the
 *  model what was wrong with its first reply, a timeout ends it at once. Never throws. */

import type { Router } from "./routers/types.js";

export type AskFailureKind = "timeout" | "cancelled" | "invalid_response" | "service_error";
export type Asked<T> = { readonly value: T | null; readonly error: string | null; readonly ms: number; readonly tries: number; readonly failureKind?: AskFailureKind };
export type Parse<T> = (text: string) => { ok: true; value: T } | { ok: false; error: string };

export async function askJson<T>(router: Router, req: { readonly system: string; readonly cwd: string; readonly body: (previousError?: string) => string },
  parse: Parse<T>, timeoutMs: number, outer?: AbortSignal): Promise<Asked<T>> {
  let error: string | null = null;
  let failureKind: AskFailureKind = "invalid_response";
  let ms = 0;
  for (let tries = 1; tries <= 2; tries++) {
    if (outer?.aborted) return { value: null, error: "cancelled", ms, tries: tries - 1, failureKind: "cancelled" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("router timed out")), timeoutMs);
    const onAbort = () => controller.abort(new Error("cancelled"));
    outer?.addEventListener("abort", onAbort, { once: true });
    try {
      const reply = await router.route({ task: req.body(error ?? undefined), cwd: req.cwd, system: req.system, ...(error ? { previousError: error } : {}) }, controller.signal);
      ms += reply.elapsedMs;
      const parsed = parse(reply.text);
      if (parsed.ok) return { value: parsed.value, error: null, ms, tries };
      failureKind = "invalid_response";
      error = `${parsed.error}; reply began: ${JSON.stringify(reply.text.trim().slice(0, 200))}`;
    } catch (err) {
      error = (err as Error).message;
      failureKind = outer?.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : "service_error";
      if (failureKind === "timeout" || failureKind === "cancelled" || /timed out|cancelled/.test(error)) return { value: null, error, ms, tries, failureKind };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }
  return { value: null, error, ms, tries: 2, failureKind };
}
