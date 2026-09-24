/** Platform observations with exact origins, checkpoint evidence, bounded lifetime and no credentials. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";

export const PLATFORM_MEMORY_TTL = { incident: 86400_000, observed: 7 * 86400_000, verified: 30 * 86400_000 } as const;
export const MAX_PLATFORM_MEMORIES = 500;
/** Candidates one summary may propose (the rest are dropped unread). */
export const MAX_PLATFORM_CANDIDATES = 10;
/** Field bounds: an origin, a fact's text, and the checkpoint quote that backs it. */
const MAX_ORIGIN_CHARS = 2048;
const MAX_FACT_TEXT_CHARS = 600;
const MAX_QUOTE_CHARS = 1200;

export const PlatformFactSchema = z.object({
  origin: z.string().min(1).max(MAX_ORIGIN_CHARS),
  key: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,79}$/),
  text: z.string().min(1).max(MAX_FACT_TEXT_CHARS),
  kind: z.enum(["operation", "incident"]).default("operation"),
  eventSeq: z.number().int().positive(),
  quote: z.string().min(1).max(MAX_QUOTE_CHARS),
});
export type PlatformFactCandidate = z.infer<typeof PlatformFactSchema>;

const CheckpointSchema = z.object({
  seq: z.number().int().positive(), ts: z.number().finite().nonnegative(),
  purpose: z.enum(["research", "do", "verify"]), ok: z.boolean(), result: z.string(),
  sideEffects: z.object({ filesChanged: z.number().nonnegative(), commandsRun: z.number().nonnegative(), approvalsGranted: z.number().nonnegative() }).optional(),
  sideEffectsKnown: z.boolean().optional(), harness: z.string().optional(), model: z.string().optional(), brief: z.string().optional(),
});
export type PlatformCheckpoint = z.infer<typeof CheckpointSchema>;

export type PlatformMemory = {
  readonly id: string; readonly origin: string; readonly key: string; readonly text: string;
  readonly kind: "operation" | "incident"; readonly status: "observed" | "verified";
  readonly source: { readonly taskId: string; readonly eventSeq: number; readonly quote: string };
  readonly createdAt: number; readonly updatedAt: number; readonly expiresAt: number;
};

/** URL.origin preserves scheme and non-default port; credentials, paths and wildcards are not an origin. */
export function exactPlatformOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.hostname.includes("*") || u.search || u.hash || u.pathname !== "/") return null;
    return u.origin;
  } catch { return null; }
}

/** Only concrete HTTP(S) URLs establish platform scope; an invented hostname never adds scope. */
export function platformOrigins(...texts: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const text of texts) for (const raw of text.match(/https?:\/\/[^\s<>"'`，。；、！？）】]+/gi) ?? []) {
    try {
      // Preserve the closing bracket of an IPv6 host, while tolerating Markdown link punctuation.
      const clean = raw.replace(/[),.;}]+$/, "");
      let u: URL;
      try { u = new URL(clean); } catch { u = new URL(clean.replace(/\]+$/, "")); }
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.hostname.includes("*")) continue;
      origins.add(u.origin);
    } catch { /* A malformed URL is not a platform scope. */ }
  }
  return [...origins];
}

/** Reject values, identifiers, session material and authorization claims; allow generic form/field names. */
export function safePlatformText(value: string): boolean {
  if (!value.trim() || /enc:v\d:|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/[^\s/]+@/i.test(value)) return false;
  if (/\b(?:session|cookie|bearer|authorization|authorized|authorised|preapproved|approved|consent|allowed to|permission to)\b|会话|已授权|用户(?:允许|同意|授权)|无需(?:审批|确认)|自动批准|绕过(?:审批|防护|安全)/i.test(value)) return false;
  if (/(?:password|passwd|pwd|api[-_ ]?key|secret|token|seed|totp|account|username|email|phone|密码|口令|密钥|令牌|种子|账号|账户|用户名|邮箱|手机号)\s*(?:[:：=]|\bis\b|是|为)\s*\S+/i.test(value)) return false;
  if (/\b(?:log(?:ged)?\s*in|sign(?:ed)?\s*in|authenticated)\s+as\s+\S+|(?:登录账号|登录账户|登录身份|使用账号|使用账户)\s*[:：=]?\s*\S+/i.test(value)) return false;
  if (/\b[A-Z2-7]{16,}\b|\b[a-f0-9]{32,}\b|\b[A-Za-z0-9_+/-]{40,}={0,2}\b|(?:\+?\d[ -]?){10,15}/.test(value)) return false;
  if (/已(?:完成|创建|新增|删除|发送|提交)|\b(?:created|deleted|submitted|sent)\s+(?:the|an?|\d+)\b/i.test(value)) return false;
  return true;
}

export function platformCheckpoint(event: { readonly seq: number; readonly ts: number; readonly type: string; readonly payload: Readonly<Record<string, unknown>> }): PlatformCheckpoint | null {
  if (event.type !== "checkpoint") return null;
  const parsed = CheckpointSchema.safeParse({ ...event.payload, seq: event.seq, ts: event.ts });
  return parsed.success ? parsed.data : null;
}

const Stored = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/), origin: z.string(), key: PlatformFactSchema.shape.key,
  text: z.string().min(1).max(MAX_FACT_TEXT_CHARS), kind: z.enum(["operation", "incident"]), status: z.enum(["observed", "verified"]),
  source: z.object({ taskId: z.string().min(1), eventSeq: z.number().int().positive(), quote: z.string().min(1).max(MAX_QUOTE_CHARS) }),
  createdAt: z.number().finite(), updatedAt: z.number().finite(), expiresAt: z.number().finite(),
});
const FileSchema = z.object({ version: z.literal(1), entries: z.array(Stored).max(MAX_PLATFORM_MEMORIES) });
const idFor = (origin: string, key: string) => createHash("sha256").update(`${origin}\0${key}`).digest("hex").slice(0, 24);

function read(path: string | undefined): PlatformMemory[] | null {
  if (!path || !existsSync(path)) return [];
  try {
    const data = FileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!data.success) return null;
    return data.data.entries.filter((entry) => exactPlatformOrigin(entry.origin) === entry.origin && entry.id === idFor(entry.origin, entry.key) && safePlatformText(entry.text) && safePlatformText(entry.source.quote));
  } catch { return null; }
}

function write(path: string, entries: readonly PlatformMemory[]): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify({ version: 1, entries }, null, 2) + "\n", { mode: 0o600 }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) rmSync(temporary); }
}

export function loadPlatformMemory(path: string | undefined, now = Date.now(), includeExpired = false): PlatformMemory[] {
  return (read(path) ?? []).filter((entry) => includeExpired || entry.expiresAt > now).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function rememberPlatformFacts(path: string, candidates: readonly PlatformFactCandidate[], source: { taskId: string; task: string; context?: string; checkpoints: readonly PlatformCheckpoint[]; now?: number }): { added: PlatformMemory[]; skipped: string[] } {
  const now = source.now ?? Date.now();
  const current = read(path);
  if (current === null) return { added: [], skipped: ["memory file is invalid; preserved without overwriting"] };
  const known = new Set(platformOrigins(source.task, source.context ?? ""));
  const checkpoints = new Map(source.checkpoints.map((point) => [point.seq, point]));
  const entries = new Map(current.filter((entry) => entry.expiresAt > now).map((entry) => [entry.id, entry]));
  const added: PlatformMemory[] = [], skipped: string[] = [];
  for (const raw of candidates.slice(0, MAX_PLATFORM_CANDIDATES)) {
    const parsed = PlatformFactSchema.safeParse(raw);
    if (!parsed.success) { skipped.push("invalid candidate"); continue; }
    const fact = parsed.data;
    const origin = exactPlatformOrigin(fact.origin);
    const checkpoint = checkpoints.get(fact.eventSeq);
    if (!origin || !known.has(origin)) { skipped.push("unknown platform origin"); continue; }
    if (!checkpoint || !fact.quote.trim() || !checkpoint.result.includes(fact.quote)) { skipped.push("missing checkpoint evidence"); continue; }
    if (!safePlatformText(fact.text) || !safePlatformText(fact.quote)) { skipped.push("sensitive or task-specific content"); continue; }
    // A site merely being listed in CONTEXT is not proof this checkpoint observed it. Prefer result
    // destinations over the planned brief; a redirect or different actual target must not be mislabeled.
    const resultOrigins = platformOrigins(checkpoint.result);
    const observedOrigins = resultOrigins.length ? resultOrigins : platformOrigins(checkpoint.brief ?? "");
    if (observedOrigins.length && !observedOrigins.includes(origin)) { skipped.push("checkpoint belongs to a different platform"); continue; }
    const targetBound = observedOrigins.length === 1 && observedOrigins[0] === origin || platformOrigins(fact.quote).includes(origin);
    // A failed attempt is an incident, not proof of a persistent platform property.
    if (!checkpoint.ok && fact.kind !== "incident") { skipped.push("failed observation cannot establish an operation fact"); continue; }
    const verified = targetBound && checkpoint.purpose === "verify" && checkpoint.ok && checkpoint.sideEffectsKnown === true
      && checkpoint.sideEffects?.filesChanged === 0 && checkpoint.sideEffects.approvalsGranted === 0;
    const status = verified ? "verified" : "observed";
    const ts = Math.min(checkpoint.ts, now);
    const expiresAt = ts + PLATFORM_MEMORY_TTL[fact.kind === "incident" ? "incident" : status];
    const id = idFor(origin, fact.key), previous = entries.get(id);
    if (expiresAt <= now || previous && previous.updatedAt > ts) { skipped.push("expired or older than existing observation"); continue; }
    const entry: PlatformMemory = { id, origin, key: fact.key, text: fact.text, kind: fact.kind, status, source: { taskId: source.taskId, eventSeq: checkpoint.seq, quote: fact.quote }, createdAt: previous?.createdAt ?? ts, updatedAt: ts, expiresAt };
    entries.set(id, entry); added.push(entry);
  }
  if (added.length) write(path, [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PLATFORM_MEMORIES));
  return { added, skipped };
}

export function removeTaskPlatformMemories(path: string | undefined, taskIds: readonly string[]): number {
  if (!path || !taskIds.length) return 0;
  const current = read(path);
  if (!current) return 0;
  const ids = new Set(taskIds), kept = current.filter((entry) => !ids.has(entry.source.taskId));
  if (kept.length !== current.length) write(path, kept);
  return current.length - kept.length;
}

export function deletePlatformMemory(path: string | undefined, id: string): boolean {
  if (!path) return false;
  const current = read(path);
  if (!current) return false;
  const kept = current.filter((entry) => entry.id !== id);
  if (kept.length === current.length) return false;
  write(path, kept); return true;
}
