/** A text-only Router on the Claude Agent SDK: no tools, one turn, nothing persisted. Used for the planner
 *  (loop-v0 §6) when targets.yaml names a claude-code model for it. */

import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Router, RouterInput, RouterReply } from "./types.js";

export type ClaudeRouterOptions = { readonly model: string; readonly executable?: string; readonly cwd?: string };

export function claudeTextRouter(opts: ClaudeRouterOptions): Router {
  return {
    name: `claude:${opts.model}`,
    async route(input: RouterInput, signal: AbortSignal): Promise<RouterReply> {
      const started = Date.now();
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const options: Options = {
        model: opts.model, maxTurns: 1, tools: [], permissionMode: "default", settingSources: [], persistSession: false,
        systemPrompt: input.system, abortController: abort, cwd: opts.cwd ?? process.cwd(),
        canUseTool: async () => ({ behavior: "deny", message: "text-only" }),
        ...(opts.executable ? { pathToClaudeCodeExecutable: opts.executable } : {}),
      };
      const prompt = input.previousError ? `${input.task}\n\n(previous reply rejected: ${input.previousError})` : input.task;
      const parts: string[] = [];
      try {
        for await (const msg of query({ prompt, options })) {
          if (msg.type === "result") { if (msg.subtype === "success") parts.push(msg.result); else throw new Error(`claude router: ${msg.subtype}`); }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      return { text: parts.join(""), elapsedMs: Date.now() - started };
    },
  };
}
