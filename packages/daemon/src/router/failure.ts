/** Classify how an execution ended. Pattern table, no model involved (router-v0 §6.2). */

export type FailureKind = "refusal" | "quota" | "transport" | "gate_denied" | "task_failed" | "rejected" | "unknown";

export type SideEffects = {
  readonly filesChanged: number;
  readonly commandsRun: number;
  readonly approvalsGranted: number;
};

export const NO_SIDE_EFFECTS: SideEffects = { filesChanged: 0, commandsRun: 0, approvalsGranted: 0 };

/** Sub-agents the harness spawned during the run (background-v0 §2). */
export type AgentCounts = { readonly spawned: number; readonly completed: number; readonly failed: number };
export const NO_AGENTS: AgentCounts = { spawned: 0, completed: 0, failed: 0 };

/** Provider policy signals are authoritative; text refusals may need factual clarification. */
export type RefusalSignal = { readonly source: "provider" | "text"; readonly reason: string };

export type ExecutionOutcome = {
  readonly ok: boolean;
  readonly exitCode?: number | null;
  readonly httpStatus?: number;
  readonly stderr?: string;
  readonly lastText?: string;
  readonly timedOut?: boolean;
  readonly gateDenied?: boolean;
  readonly refusal?: RefusalSignal;
  readonly sideEffects?: SideEffects;
  /** False when the stream was interrupted: observed counts are a lower bound, never proof of no changes. */
  readonly sideEffectsKnown?: boolean;
  /** Tokens consumed, when the harness reports them (feeds the local Claude quota count). */
  readonly tokens?: number;
  /** The harness's own conversation handle (Claude session_id, Codex thread id), for native resume later. */
  readonly sessionId?: string;
  readonly agents?: AgentCounts;
};

// Deliberately anchored: discussing/quoting a refusal is not the executor refusing.
const ENGLISH_REFUSAL = /^(?:(?:I(?:['’]m| am) sorry|Sorry|I apologize)[\s,.:!—-]+(?:but\s+)?)?I(?:\s+(?:can(?:['’]t|not| not)|won['’]t(?: be able to)?|will not(?: be able to)?|am (?:unable|not able) to)|['’]m (?:unable|not able) to)\s+(?:help|assist|provide|comply|fulfill)\b(?!\s+but\b)/i;
// Limit these verbs to the current task/request, rather than a superseded plan.
const ENGLISH_TASK_REFUSAL = /^(?:(?:I(?:['’]m| am) sorry|Sorry|I apologize)[\s,.:!—-]+(?:but\s+)?)?I(?:(?:['’]m| am) not going to| will not| won['’]t)\s+(?:carry out|fulfill|perform)\s+(?:this|that|your|the requested)\s+(?:task|request|operation)\b/i;
const CHINESE_REFUSAL = /^(?:(?:很抱歉|抱歉|对不起)[\s，,。:：]*(?:我)?|我)(?:无法|不能|不会|不可以)(?:帮助|帮你|协助|提供|满足(?:这个|该|你的)?请求)/;
const CHINESE_IMPLICIT_REFUSAL = /^(?:无法|不能)(?:帮助|协助)(?=你|您|提供|完成|执行|处理|进行|这(?:个|项|类)|该|[。！？.!?]|$)/;
const POLICY_REFUSAL = /^This request (?:goes against|violates) (?:my|our|the) (?:safety )?(?:policy|policies|guidelines)\b/i;
const QUOTA = /(rate.?limit|insufficient (?:balance|credits|quota|funds)|quota (?:exceeded|exhausted)|usage limit|out of credits|balance is (?:zero|0)|too many requests|余额不足|额度(用完|不足|已满)|配额)/i;
const TRANSPORT = /(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|proxy (?:error|connect|refused|failure)|tunnel (?:failed|error)|CERTIFICATE_VERIFY_FAILED|self.signed certificate|TLS|SSL|socket hang up|network (?:error|unreachable)|connection (?:refused|reset|closed)|代理(错误|连接失败|不可用)|网络(错误|不可达))/i;

export function hasSideEffects(se: SideEffects | undefined): boolean {
  return !!se && (se.filesChanged > 0 || se.commandsRun > 0 || se.approvalsGranted > 0);
}

/** Inspect final assistant text only; stderr/tool output is not a model response. */
export function detectRefusal(outcome: ExecutionOutcome): RefusalSignal | null {
  if (outcome.refusal) return outcome.refusal;
  const lastText = outcome.lastText;
  if (!lastText) return null;
  const first = lastText.split(/\r?\n/).find((line) => line.trim());
  if (!first || /^(?: {4}|\t)/.test(first) || /^\s*(?:>|[`~]|["'“‘「『])/.test(first)) return null;
  const text = first.trim().replace(/^(?:\*\*|__)/, "");
  if (!ENGLISH_REFUSAL.test(text) && !ENGLISH_TASK_REFUSAL.test(text) && !CHINESE_REFUSAL.test(text) && !CHINESE_IMPLICIT_REFUSAL.test(text) && !POLICY_REFUSAL.test(text)) return null;
  // Keep policy qualifications that may follow a long explanation. Diagnostic limits
  // must reject oversized input as a whole; only display/log excerpts are shortened.
  return { source: "text", reason: lastText };
}

export function classifyFailure(outcome: ExecutionOutcome): FailureKind | null {
  if (outcome.gateDenied) return "gate_denied";
  if (detectRefusal(outcome)) return "refusal";
  if (outcome.ok) return null;
  const status = outcome.httpStatus;
  const text = `${outcome.stderr ?? ""}\n${outcome.lastText ?? ""}`;
  if (status === 429 || status === 402) return "quota";
  if (QUOTA.test(text)) return "quota";
  if (outcome.timedOut && !text.trim()) return "transport";
  if (TRANSPORT.test(text) || (status !== undefined && status >= 500)) return "transport";
  if (outcome.exitCode !== undefined && outcome.exitCode !== null && outcome.exitCode !== 0 && !text.trim()) return "transport";
  if (outcome.timedOut) return "transport";
  if (outcome.exitCode === 0 || outcome.lastText) return "task_failed";
  return "unknown";
}

/** Short, single-line excerpt for logs and the router; the caller redacts before use. */
export function excerpt(outcome: ExecutionOutcome, max = 240): string {
  const text = (outcome.lastText?.trim() || outcome.stderr?.trim() || "").replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
