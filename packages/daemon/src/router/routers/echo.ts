/** Test router: canned replies, optional delay and failure. Never calls a model. */

import { sleep } from "../../util/sleep.js";
import type { Router, RouterInput, RouterReply } from "../../core/modelCall.js";

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

