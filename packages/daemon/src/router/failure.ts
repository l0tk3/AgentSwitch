/** Classify how an execution ended. Pattern table, no model involved (router-v0 §6.2). */

export type FailureKind = "refusal" | "quota" | "transport" | "gate_denied" | "task_failed" | "unknown";

export type SideEffects = {
  readonly filesChanged: number;
  readonly commandsRun: number;
  readonly approvalsGranted: number;
};

export const NO_SIDE_EFFECTS: SideEffects = { filesChanged: 0, commandsRun: 0, approvalsGranted: 0 };

export type ExecutionOutcome = {
  readonly ok: boolean;
  readonly exitCode?: number | null;
  readonly httpStatus?: number;
  readonly stderr?: string;
  readonly lastText?: string;
  readonly timedOut?: boolean;
  readonly gateDenied?: boolean;
  readonly sideEffects?: SideEffects;
  /** Tokens consumed, when the harness reports them (feeds the local Claude quota count). */
  readonly tokens?: number;
};

const REFUSAL = /(I can(?:'|’)?t help|I cannot help|I can(?:'|’)?t assist|unable to assist|won(?:'|’)?t be able to help|against (?:my|our|the) (?:policy|guidelines)|safety (?:policy|guidelines|reasons)|无法协助|不能帮助|不能帮你|无法帮助|违反.{0,6}(政策|准则|规范)|安全(政策|准则)|refus(?:e|al)|stop_reason["']?\s*[:=]\s*["']?refusal)/i;
const QUOTA = /(rate.?limit|insufficient (?:balance|credits|quota|funds)|quota (?:exceeded|exhausted)|usage limit|out of credits|balance is (?:zero|0)|too many requests|余额不足|额度(用完|不足|已满)|配额)/i;
const TRANSPORT = /(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|proxy (?:error|connect|refused|failure)|tunnel (?:failed|error)|CERTIFICATE_VERIFY_FAILED|self.signed certificate|TLS|SSL|socket hang up|network (?:error|unreachable)|connection (?:refused|reset|closed)|代理(错误|连接失败|不可用)|网络(错误|不可达))/i;

export function hasSideEffects(se: SideEffects | undefined): boolean {
  return !!se && (se.filesChanged > 0 || se.commandsRun > 0 || se.approvalsGranted > 0);
}

export function classifyFailure(outcome: ExecutionOutcome): FailureKind | null {
  if (outcome.ok) return null;
  if (outcome.gateDenied) return "gate_denied";
  const status = outcome.httpStatus;
  const text = `${outcome.stderr ?? ""}\n${outcome.lastText ?? ""}`;
  if (status === 429 || status === 402) return "quota";
  if (QUOTA.test(text)) return "quota";
  if (outcome.timedOut && !text.trim()) return "transport";
  if (TRANSPORT.test(text) || (status !== undefined && status >= 500)) return "transport";
  if (REFUSAL.test(text)) return "refusal";
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
