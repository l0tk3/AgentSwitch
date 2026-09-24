/** The plaintext entrance (router-v0 §9): the user writes tasks as they like, accounts and passwords included.
 *  Every submission passes here before it is stored or routed: the router's text-only model decides what in it
 *  is sensitive and which host each value belongs to (from the text, the user's CONTEXT.md and the parent task),
 *  the daemon mints tokens and puts them where the values were. Nothing downstream ever sees the values. */

import { z } from "zod";
import { extractJsonObject } from "../util/json.js";
import type { Router } from "../core/modelCall.js";
import type { MintEntry, Minter } from "./minter.js";

export const SEAL_TIMEOUT_MS = 30_000;
const MIN_VALUE_LENGTH = 4;
/** The model's quoted grant for a seed import, and a token label. */
const MAX_SEED_EVIDENCE_CHARS = 4000;
const MAX_LABEL_CHARS = 64;
const EXISTING_TOKEN = /\benc:v1:[A-Za-z0-9_=-]{16,}/g;
const SEAL_ERROR = {
  unavailable: "敏感信息检查暂时不可用，请稍后重试。",
  timeout: "敏感信息检查超时，请稍后重试。",
  cancelled: "敏感信息检查已取消，请重新发送。",
  encryption: "凭据加密暂时不可用，请稍后重试。",
  reply: "敏感信息识别回复格式无效。",
} as const;

/** One sealed value: a model-inferred field candidate and its token. Never the value; field is not user confirmation. */
export type CredentialPurpose = "secret" | "totp_code" | "totp_seed_import";
export type SealedEntry = { readonly label: string; readonly field: string; readonly kind: "secret" | "totp"; readonly hosts: readonly string[]; readonly uses: readonly ("http" | "otp" | "exec")[]; readonly token: string; readonly purpose?: CredentialPurpose; readonly seed_import_hosts?: readonly string[] };
export type SealResult =
  | { readonly ok: true; readonly text: string; readonly sealed: readonly SealedEntry[]; readonly ms: number }
  | { readonly ok: false; readonly code: "unroutable" | "unavailable"; readonly error: string; readonly ms: number };
/** What the model may use to tell what a value is for: the parent task of a follow-up, and the thread's title. */
export type SealContext = { readonly parentTask?: string; readonly threadTitle?: string };
export type Sealer = (text: string, ctx?: SealContext, signal?: AbortSignal) => Promise<SealResult>;

const Found = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  field: z.string().default(""),
  kind: z.enum(["secret", "totp"]).default("secret"),
  purpose: z.enum(["secret", "totp_code", "totp_seed_import"]).optional(),
  seed_import_hosts: z.array(z.string()).optional(),
  seed_import_evidence: z.string().max(MAX_SEED_EVIDENCE_CHARS).optional(),
  hosts: z.array(z.string()).default([]),
  uses: z.array(z.enum(["http", "otp", "exec"])).min(1).default(["http"]),
});
const Reply = z.object({ secrets: z.array(Found).default([]), layout: z.string().nullable().default(null) });
export type FoundSecret = z.infer<typeof Found>;
export type SealReply = { readonly secrets: readonly FoundSecret[]; readonly layout: string | null };

export const SEAL_SYSTEM = `You find credentials in a task text so they can be replaced by secret-gate ciphertext before any other model sees the task.
Another model will then carry out the task seeing only the ciphertext. Your "field" and "layout" are candidate interpretations, not confirmed facts or user authorization.
Reply with one JSON object only:
{"layout":"…or null","secrets":[{"value":"…","field":"…","label":"site/what","purpose":"secret|totp_code|totp_seed_import","kind":"secret|totp","hosts":["host[:port]"],"uses":["http"|"otp"|"exec"],"seed_import_hosts":[],"seed_import_evidence":"…exact original quote, or omit"}]}
Rules:
- Records: users paste accounts as delimited lines (a|b|c, tab- or comma-separated, "----"-separated). Split every record into its fields and judge each field on its own. Never mark a whole line or several fields as one value.
- "layout": when the text has delimited records, one line naming each position in order, e.g. "email | password | birth year | country | Google app password | session key". Otherwise null. Preserve positions; when a position's meaning is uncertain, name it "field N (type unconfirmed)" instead of guessing from a familiar record format.
- "value" is copied character for character from the text; it is the only thing replaced. Never invent or alter a value. A value may contain spaces (app passwords like "abcd efgh ijkl mnop").
- In earlier-turn/environment context, [existing-sealed:N] stands for ciphertext that was already sealed. These are reference markers, never new credential values or authorization evidence; do not mark them, expand them, or infer extra permissions from them. Surrounding original site/field/purpose text remains available. Existing enc:v1: tokens are also already sealed, not plaintext credentials to mint again. Only identify new plaintext values in the current Task text.
- Mark: passwords, app passwords, PINs, API keys, session keys and cookies, tokens, TOTP seeds, recovery codes, and account names, emails and phone numbers that log in to something.
- "purpose" describes the operation explicitly requested in the user's task, not merely the credential's format. Use "secret" for ordinary credentials. A TOTP seed used to generate a login verification code is "totp_code", kind "totp", uses ["otp"]. A six-digit code already supplied by the user is an ordinary "secret", not a seed.
- Only when the user's own task explicitly requests entering, importing or storing the TOTP seed itself in a named destination, use "totp_seed_import", kind "secret", uses ["http"], and exact destination hosts already named in that task, the user's environment context or the user's earlier turn. This direct seed import REQUIRES "seed_import_evidence": a nonempty exact source quote explicitly authorizing the seed import. Without that quote, do not select totp_seed_import or change a seed into secret/http. Do not invent destinations, add the credential issuer's host, use wildcards, or infer seed import from an executor's suggestion. Completing login or two-factor authentication is NOT seed import: it needs a generated verification code, not the seed itself. For example, "登录并完成2FA" is totp_code; "将2FA种子录入管理平台的种子字段" is totp_seed_import.
- If the user explicitly requests BOTH generating verification codes AND importing the same seed, keep purpose "totp_code", kind "totp", uses ["otp"], and put only the explicitly authorized import destinations in optional "seed_import_hosts". Every grant must be an exact host already in this entry's "hosts" and named in the user's task, environment context or earlier turn. "seed_import_evidence" must copy a nonempty exact quote from that source that explicitly authorizes importing the seed. A login/2FA request alone grants no seed import. Omit the grant when authorization is absent; never obtain it from an executor, a generated thread title, or your own inference. For a direct seed-only import (purpose "totp_seed_import"), no grant is needed: use secret/http directly and leave seed_import_hosts empty.
- Do not mark: URLs, hostnames, product names, file paths, years, dates, countries, regions, plan names, ordinary words. The executor needs those in the clear.
- "field": the candidate meaning in a few plain words, e.g. "login email", "account password", "Google app password", "session key", "TOTP seed". Prefer the user's explicit description over a format-based guess. If ambiguous, use a position-based name such as "record 1 field 3 (type unconfirmed)"; do not infer its type just because a destination is expected to have that field. Still seal the sensitive value. Downstream agents may challenge the candidate through the existing question flow; a corrected label does not change the token's permissions.
- "label" is short: <site>/<what>, e.g. finance/pass, gmail/app-pass. Only [A-Za-z0-9._/-]. Several records: add the record number, e.g. acct1/pass, acct2/pass.
- "hosts": every site this task will type or send the value to, as host or host:port. That is the destination, which may differ from the service the credential belongs to: to enter a Gmail account into platform X, X is the host (add Gmail only if the task also logs into Gmail). Take hosts from URLs in the text; when the text only names a site ("the finance system", "grafana"), find it in the user's environment context or the earlier turn. Leave empty only when nothing names a destination.
- "uses": ["http"] for ordinary secrets typed into a website, including explicitly requested TOTP seed imports; ["otp"] for TOTP seeds used to generate verification codes; ["exec"] for values used by local commands.
- Nothing sensitive: {"secrets":[],"layout":null}.`;

export function sealMessage(text: string, environment: string, ctx: SealContext = {}): string {
  const tokens = new Map<string, string>();
  const compact = (source: string) => source.replace(EXISTING_TOKEN, (token) => {
    const existing = tokens.get(token);
    if (existing) return existing;
    const marker = `[existing-sealed:${tokens.size + 1}]`;
    tokens.set(token, marker);
    return marker;
  });
  const env = environment.trim() ? `User's environment context (sites, accounts already sealed, notes):\n<<<\n${compact(environment)}\n>>>\n\n` : "";
  const thread = ctx.threadTitle ? `Thread: ${ctx.threadTitle}\n` : "";
  const parent = ctx.parentTask ? `Earlier turn in this thread:\n<<<\n${compact(ctx.parentTask)}\n>>>\n\n` : "";
  return `${env}${thread}${parent}Task text:\n<<<\n${text}\n>>>`;
}

export function parseSealReply(reply: string): ({ ok: true } & SealReply) | { ok: false; error: string } {
  const raw = extractJsonObject(reply);
  if (raw === undefined) return { ok: false, error: SEAL_ERROR.reply };
  try {
    const parsed = Reply.safeParse(JSON.parse(raw));
    return parsed.success ? { ok: true, secrets: parsed.data.secrets, layout: parsed.data.layout } : { ok: false, error: SEAL_ERROR.reply };
  } catch { return { ok: false, error: SEAL_ERROR.reply }; }
}

/** host[:port] from whatever the model wrote: a URL, a host with a path, a host with credentials. */
export function hostOf(site: string): string {
  const s = site.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]*@/, "").replace(/[/?#].*$/, "");
  return s.toLowerCase();
}

const LABEL_OK = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
function cleanLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, MAX_LABEL_CHARS);
  return LABEL_OK.test(cleaned) ? cleaned : "task/secret";
}

export type PlannedEntry = MintEntry & { readonly field: string; readonly purpose?: CredentialPurpose };
export type Plan = { readonly entries: readonly PlannedEntry[]; readonly unroutable: readonly string[]; readonly missingImportAuthorization: readonly string[]; readonly skipped: readonly string[]; readonly records: readonly string[] };

const DELIMITERS = ["|", "\t", "----", ",", ";"] as const;
const MIN_RECORD_FIELDS = 3;

/** The delimiter that splits `line` into 3+ fields, if any. */
export function recordDelimiter(line: string): string | null {
  return DELIMITERS.find((d) => line.split(d).length >= MIN_RECORD_FIELDS) ?? null;
}

/** A marked value that is really a whole record (or several lines): it spans fields instead of being one. */
export function isWholeRecord(text: string, value: string): boolean {
  if (value.includes("\n")) return true;
  const line = text.split("\n").map((l) => l.trim()).find((l) => l === value.trim());
  return line !== undefined && recordDelimiter(line) !== null;
}

/** Last resort when the model keeps marking whole records: every field of the record is sealed on its own. */
export function splitRecord(f: FoundSecret, recordNo: number): FoundSecret[] {
  const d = recordDelimiter(f.value.split("\n")[0] ?? f.value) ?? "|";
  return f.value.split("\n").flatMap((line) => line.split(d)).map((v) => v.trim()).filter((v) => v.length >= MIN_VALUE_LENGTH)
    .map((value, i) => ({ ...f, value, field: `field ${i + 1} of record ${recordNo}`, label: `record${recordNo}/field${i + 1}` }));
}

/** What to mint. A value the text does not contain, or shorter than MIN_VALUE_LENGTH, is skipped (nothing to
 *  replace, or too short to replace safely). An http secret without a host is unroutable: the gate would refuse it. */
export function planSeal(text: string, found: readonly FoundSecret[], destinationEvidence: string | readonly string[] = text): Plan {
  const sources = typeof destinationEvidence === "string" ? [destinationEvidence] : destinationEvidence;
  const hostEvidence = sources.join("\n");
  const seen = new Set<string>();
  const entries: PlannedEntry[] = [], unroutable: string[] = [], missingImportAuthorization: string[] = [], skipped: string[] = [], records: string[] = [];
  found.forEach((f, i) => {
    if (f.value.length < MIN_VALUE_LENGTH || !text.includes(f.value) || seen.has(f.value)
      || /^\[existing-sealed:\d+\]$/.test(f.value) || /^enc:v1:[A-Za-z0-9_=-]{16,}$/.test(f.value)) { skipped.push(f.label); return; }
    if (isWholeRecord(text, f.value)) { records.push(f.label); return; }
    seen.add(f.value);
    const hosts = [...new Set(f.hosts.map(hostOf).filter(Boolean))];
    const base = cleanLabel(f.label);
    const label = entries.some((e) => e.label === base) ? `${base}-${i + 1}` : base;
    const kind = f.purpose === "totp_seed_import" ? "secret" : f.purpose === "totp_code" ? "totp" : f.kind;
    const uses: MintEntry["uses"] = f.purpose === "totp_seed_import" ? ["http"] : f.purpose === "totp_code" ? ["otp"] : [...new Set(f.uses)];
    const importHosts = f.purpose === "totp_seed_import" ? [] : [...new Set((f.seed_import_hosts ?? []).map(hostOf))];
    const sourceQuote = f.seed_import_evidence;
    if ((f.purpose === "totp_seed_import" || importHosts.length) && (!sourceQuote?.trim() || !sources.some((source) => source.includes(sourceQuote)))) {
      unroutable.push(label); missingImportAuthorization.push(label); return;
    }
    if (uses.includes("http") && !hosts.length || f.purpose === "totp_seed_import" && hosts.some((host) => !evidencedExactHost(host, hostEvidence))) { unroutable.push(label); return; }
    if (importHosts.length && (kind !== "totp" || !uses.includes("otp")
      || importHosts.some((host) => !hosts.includes(host) || !evidencedExactHost(host, hostEvidence)))) { unroutable.push(label); return; }
    entries.push({ label, field: f.field.trim() || label, value: f.value, kind, hosts, uses, ...(f.purpose ? { purpose: f.purpose } : {}), ...(importHosts.length ? { seed_import_hosts: importHosts } : {}) });
  });
  return { entries, unroutable, missingImportAuthorization, skipped, records };
}

/** Seed import may not silently expand to an invented host, subdomain, port or wildcard. */
function evidencedExactHost(host: string, evidence: string): boolean {
  if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::\d{1,5})?$/i.test(host)) return false;
  const literal = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9._:\\[\\]-])${literal}(?![a-z0-9._:\\[\\]-])`, "i").test(evidence);
}

/** The iPhone app cuts a task's text at "\n\n[AgentSwitch sealed the credentials" to show it (ios-app MessageDisplay);
 *  keep that prefix when rewording, and CONTEXT.md saves cut it off the same way (api/settings.ts). */
export const LEGEND_HEADER = "[AgentSwitch sealed the credentials in this message. The following field names and record layout are model-inferred candidates, not user-confirmed facts. Copy each enc:v1: token whole only after checking its mapping. If evidence conflicts, ask through the existing question flow; do not infer an input's type merely from a field on the page. Correcting a label does not change token host/use permissions.]";

/** Keep inferred labels separate from the user's text; downstream models may challenge these candidates. */
export function legend(entries: readonly SealedEntry[], layout: string | null): string {
  if (!entries.length) return "";
  const lines = entries.map((e) => `- ${e.field}${e.hosts.length ? ` (for ${e.hosts.join(", ")})` : ""}${e.purpose ? ` [purpose=${e.purpose}]` : ""}: ${e.token}`);
  return `\n\n${LEGEND_HEADER}\n${layout ? `Candidate record layout: ${layout}\n` : ""}${lines.join("\n")}`;
}

/** Every occurrence of each value becomes its token; longer values first so a value inside another is not split. */
export function applyTokens(text: string, pairs: readonly { readonly value: string; readonly token: string }[]): string {
  return [...pairs].sort((a, b) => b.value.length - a.value.length).reduce((acc, p) => acc.split(p.value).join(p.token), text);
}

const RECORD_FEEDBACK = (labels: readonly string[]) => `Your previous reply marked whole records as single values (${labels.join(", ")}). Split each record into its fields and mark only the fields that are credentials.`;

async function askModel(router: Router, message: string, signal: AbortSignal, assertActive: () => void): Promise<({ ok: true } & SealReply) | { ok: false; error: string }> {
  assertActive();
  const reply = await router.route({ task: message, cwd: process.cwd(), system: SEAL_SYSTEM }, signal);
  assertActive();
  return parseSealReply(reply.text);
}

/** Ask, and once more with feedback if whole records came back marked; still whole → split them mechanically. */
async function planWithRetry(router: Router, text: string, message: string, destinationEvidence: readonly string[], signal: AbortSignal, assertActive: () => void): Promise<{ ok: true; plan: Plan; layout: string | null } | { ok: false; error: string }> {
  let parsed = await askModel(router, message, signal, assertActive);
  if (!parsed.ok) return parsed;
  let plan = planSeal(text, parsed.secrets, destinationEvidence);
  if (plan.records.length) {
    const again = await askModel(router, `${message}\n\n${RECORD_FEEDBACK(plan.records)}`, signal, assertActive);
    if (again.ok) { parsed = again; plan = planSeal(text, again.secrets, destinationEvidence); }
  }
  if (plan.records.length) {
    const whole = parsed.secrets.filter((f) => plan.records.includes(f.label));
    const rest = parsed.secrets.filter((f) => !plan.records.includes(f.label));
    plan = planSeal(text, [...rest, ...whole.flatMap((f, i) => splitRecord(f, i + 1))], destinationEvidence);
  }
  return { ok: true, plan, layout: parsed.layout };
}

export function routerSealer(router: Router, minter: Minter, environment: () => string, timeoutMs = SEAL_TIMEOUT_MS): Sealer {
  return async (text, ctx = {}, outer) => {
    const started = Date.now();
    const ms = () => Date.now() - started;
    const unavailable = (error: string): SealResult => ({ ok: false, code: "unavailable", error, ms: ms() });
    if (outer?.aborted) return unavailable(SEAL_ERROR.cancelled);
    const controller = new AbortController();
    const deadline = started + Math.max(0, timeoutMs);
    let timedOut = false;
    const expire = () => { if (!controller.signal.aborted) { timedOut = true; controller.abort(new Error("sealer timed out")); } };
    const timer = setTimeout(expire, Math.max(0, timeoutMs));
    const onAbort = () => controller.abort(new Error("cancelled"));
    outer?.addEventListener("abort", onAbort, { once: true });
    const assertActive = () => {
      if (!controller.signal.aborted && Date.now() >= deadline) expire();
      controller.signal.throwIfAborted();
    };
    let rejectAbort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason ?? new Error("cancelled"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      const work = async (): Promise<SealResult> => {
        assertActive();
        const userEnvironment = environment();
        assertActive();
        // Only the model view is compacted. Authorization quotes and hosts are checked against original sources.
        const planned = await planWithRetry(router, text, sealMessage(text, userEnvironment, ctx), [text, userEnvironment, ctx.parentTask ?? ""], controller.signal, assertActive);
        assertActive();
        if (!planned.ok) return unavailable(SEAL_ERROR.unavailable);
        const { plan, layout } = planned;
        if (plan.missingImportAuthorization.length) return { ok: false, code: "unroutable", error: "缺少这些 TOTP 种子录入操作的原文授权依据。请在消息中明确说明将种子录入哪个站点的哪个字段；仅登录或生成验证码不会授予种子导入权限。", ms: ms() };
        if (plan.unroutable.length) return { ok: false, code: "unroutable", error: "不知道这些凭据要用在哪个站点。任务里点名站点或写上网址，或把站点加进 CONTEXT.md。", ms: ms() };
        assertActive();
        const minted = await minter(plan.entries);
        assertActive();
        if (minted.length !== plan.entries.length || minted.some((entry) => "error" in entry || !/^enc:v1:[A-Za-z0-9_=-]{16,}$/.test(entry.token))) return unavailable(SEAL_ERROR.encryption);
        const sealed: SealedEntry[] = plan.entries.map((e, i) => ({ label: e.label, field: e.field, kind: e.kind, hosts: e.hosts, uses: e.uses, token: (minted[i] as { token: string }).token, ...(e.purpose ? { purpose: e.purpose } : {}), ...(e.seed_import_hosts?.length ? { seed_import_hosts: e.seed_import_hosts } : {}) }));
        const replaced = applyTokens(text, plan.entries.map((e, i) => ({ value: e.value, token: sealed[i]!.token })));
        const assembled = replaced + legend(sealed, layout);
        assertActive();
        return { ok: true, text: assembled, sealed, ms: ms() };
      };
      const result = await Promise.race([work(), aborted]);
      assertActive();
      return result;
    } catch {
      return unavailable(controller.signal.aborted ? timedOut ? SEAL_ERROR.timeout : SEAL_ERROR.cancelled : SEAL_ERROR.unavailable);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
      controller.signal.removeEventListener("abort", rejectAbort);
    }
  };
}
