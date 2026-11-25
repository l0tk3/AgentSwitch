/** Claude's subscription windows, asked of Claude Code itself (the Agent SDK): a profile's health check. */

import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { RATE_LIMIT_PROBE_PROMPT } from "../core/probes.js";
import type { RateLimitInfo } from "./windows.js";

/** One-turn query whose only purpose is the rate_limit_event it emits (subscription windows). */
export async function probeRateLimits(model = "claude-haiku-4-5-20251001", executable?: string, signal?: AbortSignal, env?: Record<string, string | undefined>): Promise<RateLimitInfo[]> {
  signal?.throwIfAborted();
  const infos: RateLimitInfo[] = [];
  const abortController = new AbortController();
  let probe: ReturnType<typeof query> | undefined;
  const onAbort = () => { abortController.abort(signal?.reason); probe?.close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  // Neutral cwd, like model discovery: no CLAUDE.md search through privacy-protected parents.
  const options: Options = { model, maxTurns: 1, permissionMode: "default", settingSources: [], abortController, cwd: tmpdir(), canUseTool: async () => ({ behavior: "deny", message: "probe" }), ...(executable ? { pathToClaudeCodeExecutable: executable } : {}), ...(env ? { env } : {}) };
  try {
    probe = query({ prompt: RATE_LIMIT_PROBE_PROMPT, options });
    for await (const msg of probe) {
      if (msg.type === "rate_limit_event") infos.push(msg.rate_limit_info);
      if (env && msg.type === "result" && msg.is_error && !infos.length) throw new Error("subscription probe failed");
    }
    signal?.throwIfAborted();
    return infos;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    probe?.close();
  }
}
