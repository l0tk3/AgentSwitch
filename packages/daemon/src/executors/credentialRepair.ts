/** Per-execution MCP -> router -> gate bridge. It never reruns a business operation itself. */
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Executor } from "./types.js";
import { CredentialIssue, CredentialRepairError, REISSUED_USES, repairCredential, type CredentialGate, type ReissuedCredential } from "../secrets/credentialRepair.js";
import { exactHost } from "../util/host.js";
import type { Router } from "../core/modelCall.js";
import { SUPPORT_CALL_TIMEOUT_MS } from "../core/limits.js";

/** A repair request body, and how many distinct repairs one execution may ask for. */
const MAX_REQUEST_BYTES = 40_000;
const MAX_REPAIRS_PER_RUN = 3;

type Reply = ({ ok: true } & ReissuedCredential) | { ok: false; error: string };
type RepairEvent = { status: "repaired"; originalToken: string; token: string; host: string; purpose: "totp_seed_import"; label: string; kind: "secret"; hosts: string[]; uses: string[] };
/** The task's stored events (the engine's Store satisfies it): earlier repairs are replayed from them. */
export type TaskEventLog = { eventsSince(taskId: string): readonly { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }[] };
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);

export function credentialRepairExecutor(executor: Executor, deps: { gate: CredentialGate; router: Router; store: TaskEventLog; timeoutMs?: number }): Executor {
  return {
    harness: executor.harness,
    async run(input) {
      const known = input.knownTokens instanceof Set ? input.knownTokens : new Set(input.knownTokens);
      const notes: string[] = [];
      const receipts = new Map<string, Reply>();
      for (const event of deps.store.eventsSince(input.taskId)) {
        if (event.type !== "credential_repair" || event.payload.status !== "repaired") continue;
        const p = event.payload as RepairEvent;
        if (!known.has(p.originalToken) || typeof p.token !== "string" || !p.token.startsWith("enc:v1:")) continue;
        notes.push(`Seed import only, destination ${p.host}: ${p.token}. Original OTP token remains valid for generating codes.`);
        known.add(p.token);
        receipts.set(JSON.stringify([p.originalToken, p.host, p.purpose]), { ok: true, token: p.token, label: p.label, kind: "secret", hosts: [p.host], uses: [...REISSUED_USES], seed_import_hosts: [] });
      }
      const inflight = new Map<string, Promise<Reply>>();
      let attempts = 0, active = true;
      const life = new AbortController();
      const signal = AbortSignal.any([input.signal, life.signal]);
      const accessKey = randomBytes(32).toString("base64url");
      const pending = new Set<AbortController>();
      const server = createServer(async (request, response) => {
        const send = (status: number, body: Reply) => { if (!response.destroyed) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); } };
        if (!active || signal.aborted) { send(409, { ok: false, error: "当前执行已结束" }); return; }
        if (request.method !== "POST" || request.url !== "/credential-repair" || request.headers.authorization !== `Bearer ${accessKey}` || request.headers.origin) { send(403, { ok: false, error: "凭据修复通道未授权" }); return; }
        if (!request.headers["content-type"]?.startsWith("application/json")) { send(400, { ok: false, error: "需要 JSON 请求" }); return; }
        try {
          let body = "";
          for await (const chunk of request) { body += String(chunk); if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) { send(413, { ok: false, error: "请求过长" }); return; } }
          const parsed = CredentialIssue.safeParse(JSON.parse(body));
          if (!parsed.success) { send(400, { ok: false, error: "无效的凭据修复请求" }); return; }
          const host = exactHost(parsed.data.host);
          if (!host) { send(400, { ok: false, error: "修复目标必须是明确的 host 或 host:port" }); return; }
          const issue = { ...parsed.data, host };
          if (!known.has(issue.token)) { send(403, { ok: false, error: "该密文不属于当前任务" }); return; }
          const key = JSON.stringify([issue.token, issue.host, issue.purpose]);
          const cached = receipts.get(key);
          if (cached) { send(200, cached); return; }
          let work = inflight.get(key);
          if (!work) {
            if (++attempts > MAX_REPAIRS_PER_RUN) { send(429, { ok: false, error: "本次执行的凭据修复次数已用尽，请停止重试" }); return; }
            const controller = new AbortController();
            pending.add(controller);
            const deadline = setTimeout(() => controller.abort(), deps.timeoutMs ?? SUPPORT_CALL_TIMEOUT_MS);
            const repairSignal = AbortSignal.any([signal, controller.signal]);
            input.emit("credential_repair", { status: "requested", credential: fingerprint(issue.token), host: issue.host, purpose: issue.purpose });
            work = (async (): Promise<Reply> => {
              try {
                // The race also bounds a router implementation that does not observe cancellation.
                const aborted = new Promise<never>((_resolve, reject) => repairSignal.addEventListener("abort", () => reject(new CredentialRepairError("凭据修复已取消或超时")), { once: true }));
                repairSignal.throwIfAborted();
                const token = await Promise.race([repairCredential(issue, { task: input.task, context: input.context ?? "", cwd: input.cwd, knownTokens: known }, deps, repairSignal), aborted]);
                repairSignal.throwIfAborted();
                if (!active) throw new Error("当前执行已结束");
                known.add(token.token);
                input.emit("credential_repair", { status: "repaired", originalToken: issue.token, ...token, host: issue.host, purpose: issue.purpose });
                return { ok: true, ...token };
              } catch (error) {
                const message = error instanceof Error ? error.message : "凭据修复失败";
                // Only our own bounded diagnostics leave the broker; router/provider errors may echo input.
                const safe = error instanceof CredentialRepairError ? message : "凭据修复服务暂不可用，请保留原拒绝并停止重试";
                if (active && !signal.aborted) input.emit("credential_repair", { status: "denied", credential: fingerprint(issue.token), host: issue.host, purpose: issue.purpose, error: safe });
                return { ok: false, error: safe };
              } finally { clearTimeout(deadline); pending.delete(controller); }
            })();
            inflight.set(key, work);
            void work.then((result) => { receipts.set(key, result); inflight.delete(key); });
          }
          send(200, await work);
        } catch { send(400, { ok: false, error: "无效的凭据修复请求" }); }
      });
      try {
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        signal.throwIfAborted();
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("凭据修复通道启动失败");
        return await executor.run({ ...input, handoffNote: [input.handoffNote, notes.length ? `Previously authorized credential repairs (use only for each listed purpose and destination):\n${notes.join("\n")}` : null].filter(Boolean).join("\n\n") || null, knownTokens: known, credentialRepair: { url: `http://127.0.0.1:${address.port}/credential-repair`, key: accessKey } });
      } finally {
        active = false;
        life.abort();
        for (const controller of pending) controller.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
