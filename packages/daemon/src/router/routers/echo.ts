/** Test router: canned replies, optional delay and failure. Never calls a model. */

import type { Router, RouterInput, RouterReply } from "./types.js";

export type EchoScript = readonly string[] | ((input: RouterInput, call: number) => string);

export function echoRouter(script: EchoScript, opts: { delayMs?: number } = {}): Router & { readonly calls: RouterInput[] } {
  const calls: RouterInput[] = [];
  return {
    name: "echo",
    calls,
    async route(input, signal): Promise<RouterReply> {
      const n = calls.length;
      calls.push(input);
      const started = Date.now();
      if (opts.delayMs) await sleep(opts.delayMs, signal);
      const text = typeof script === "function" ? script(input, n) : (script[Math.min(n, script.length - 1)] ?? "");
      return { text, elapsedMs: Date.now() - started };
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}
