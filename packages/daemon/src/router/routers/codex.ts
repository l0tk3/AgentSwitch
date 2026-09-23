/** A text-only Router on `codex app-server`: an ephemeral read-only thread, one turn, the agent's messages joined.
 *  Used when the router names a Codex model as the planner (loop-v0 §6). Runs in the user's own CODEX_HOME. */

import { spawn } from "node:child_process";
import { AppServerClient, type Json } from "../../executors/appserver.js";
import { stripProxy } from "../../executors/gate.js";
import type { Router, RouterInput, RouterReply } from "./types.js";

export type CodexRouterOptions = { readonly binary?: string; readonly model: string };

export function codexTextRouter(opts: CodexRouterOptions): Router {
  return {
    name: `codex:${opts.model}`,
    route(input: RouterInput, signal: AbortSignal): Promise<RouterReply> {
      const started = Date.now();
      return new Promise<RouterReply>((resolve, reject) => {
        const child = spawn(opts.binary ?? "codex", ["app-server"], { cwd: input.cwd, env: { ...stripProxy(process.env), GIT_EDITOR: "true" }, stdio: ["pipe", "pipe", "pipe"] });
        const text: string[] = [];
        let settled = false;
        const finish = (err: Error | null) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          child.kill("SIGTERM");
          if (err) reject(err); else resolve({ text: text.join(""), elapsedMs: Date.now() - started });
        };
        const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        const client = new AppServerClient(child.stdin!, child.stdout!, async () => ({ decision: "decline" }), (method, params) => {
          if (method === "item/completed") { const item = (params.item as Json | undefined) ?? {}; if (item.type === "agentMessage") text.push(String(item.text ?? "")); }
          if (method === "turn/completed") finish(null);
          if (method === "error" || method === "turn/error") finish(new Error(`codex router: ${JSON.stringify(params).slice(0, 200)}`));
        });
        child.on("error", (e) => finish(new Error(`codex router: ${e.message}`)));
        child.on("exit", () => finish(new Error("codex router: app-server exited")));
        (async () => {
          await client.request("initialize", { clientInfo: { name: "agentswitch-router", version: "0.1.0" } });
          client.notify("initialized");
          const started = await client.request("thread/start", { cwd: input.cwd, sandbox: "read-only", approvalPolicy: "never", model: opts.model, ephemeral: true });
          const threadId = (started.thread as Json | undefined)?.id;
          if (typeof threadId !== "string") throw new Error("codex router: thread/start returned no id");
          const prompt = `${input.system}\n\n=====\n\n${input.task}${input.previousError ? `\n\n(previous reply rejected: ${input.previousError})` : ""}`;
          await client.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
        })().catch((err: unknown) => finish(err as Error));
      });
    },
  };
}
