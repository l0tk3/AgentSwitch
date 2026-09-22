/** The plaintext entrance (router-v0 §9): the user writes tasks as they like, accounts and passwords included.
 *  Every submission passes here before it is stored or routed: the router's text-only model decides what in it
 *  is sensitive and which host each value belongs to (from the text, the user's CONTEXT.md and the parent task),
 *  the daemon mints tokens and puts them where the values were. Nothing downstream ever sees the values. */

import { z } from "zod";
import { extractJsonObject } from "../util/json.js";
import type { Router } from "../router/routers/types.js";
import type { MintEntry, Minter } from "./minter.js";

export const SEAL_TIMEOUT_MS = 30_000;
const MIN_VALUE_LENGTH = 4;

/** One sealed value: what it is (`field`, in words the executor can map onto a form) and its token. Never the value. */
export type SealedEntry = { readonly label: string; readonly field: string; readonly kind: "secret" | "totp"; readonly hosts: readonly string[]; readonly uses: readonly ("http" | "otp" | "exec")[]; readonly token: string };
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
  hosts: z.array(z.string()).default([]),
  uses: z.array(z.enum(["http", "otp", "exec"])).min(1).default(["http"]),
});
const Reply = z.object({ secrets: z.array(Found).default([]), layout: z.string().nullable().default(null) });
export type FoundSecret = z.infer<typeof Found>;
export type SealReply = { readonly secrets: readonly FoundSecret[]; readonly layout: string | null };

export const SEAL_SYSTEM = `You find credentials in a task text so they can be replaced by secret-gate ciphertext before any other model sees the task.
Another model will then carry out the task seeing only the ciphertext, so it must be able to tell from your "field" what each value is.
Reply with one JSON object only:
{"layout":"…or null","secrets":[{"value":"…","field":"…","label":"site/what","kind":"secret|totp","hosts":["host[:port]"],"uses":["http"|"otp"|"exec"]}]}
Rules:
- Records: users paste accounts as delimited lines (a|b|c, tab- or comma-separated, "----"-separated). Split every record into its fields and judge each field on its own. Never mark a whole line or several fields as one value.
- "layout": when the text has delimited records, one line naming each position in order, e.g. "email | password | birth year | country | Google app password | session key". Otherwise null.
- "value" is copied character for character from the text; it is the only thing replaced. Never invent or alter a value. A value may contain spaces (app passwords like "abcd efgh ijkl mnop").
- Mark: passwords, app passwords, PINs, API keys, session keys and cookies, tokens, TOTP seeds (kind "totp", uses ["otp"]), recovery codes, and account names, emails and phone numbers that log in to something.
- Do not mark: URLs, hostnames, product names, file paths, years, dates, countries, regions, plan names, ordinary words. The executor needs those in the clear.
- "field": what the value is, in a few plain words an executor can match to a form label, e.g. "login email", "account password", "Google app password", "session key", "TOTP seed".
- "label" is short: <site>/<what>, e.g. finance/pass, gmail/app-pass. Only [A-Za-z0-9._/-]. Several records: add the record number, e.g. acct1/pass, acct2/pass.
- "hosts": every site this task will type or send the value to, as host or host:port. That is the destination, which may differ from the service the credential belongs to: to enter a Gmail account into platform X, X is the host (add Gmail only if the task also logs into Gmail). Take hosts from URLs in the text; when the text only names a site ("the finance system", "grafana"), find it in the user's environment context or the earlier turn. Leave empty only when nothing names a destination.
- "uses": ["http"] for anything typed into a website or sent in a request; ["otp"] for TOTP seeds; ["exec"] for values used by local commands.
- Nothing sensitive: {"secrets":[],"layout":null}.`;

export function sealMessage(text: string, environment: string, ctx: SealContext = {}): string {
  const env = environment.trim() ? `User's environment context (sites, accounts as enc:v1: tokens, notes):\n<<<\n${environment.trim()}\n>>>\n\n` : "";
  const thread = ctx.threadTitle ? `Thread: ${ctx.threadTitle}\n` : "";
  const parent = ctx.parentTask ? `Earlier turn in this thread:\n<<<\n${ctx.parentTask}\n>>>\n\n` : "";
  return `${env}${thread}${parent}Task text:\n<<<\n${text}\n>>>`;
}

export function parseSealReply(reply: string): ({ ok: true } & SealReply) | { ok: false; error: string } {
  const raw = extractJsonObject(reply);
  if (raw === undefined) return { ok: false, error: `no JSON object in reply: ${reply.slice(0, 200)}` };
  try {
    const parsed = Reply.safeParse(JSON.parse(raw));
    return parsed.success ? { ok: true, secrets: parsed.data.secrets, layout: parsed.data.layout } : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  } catch (err) { return { ok: false, error: `bad JSON: ${(err as Error).message}` }; }
}

/** host[:port] from whatever the model wrote: a URL, a host with a path, a host with credentials. */
export function hostOf(site: string): string {
  const s = site.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]*@/, "").replace(/[/?#].*$/, "");
  return s.toLowerCase();
}

const LABEL_OK = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
function cleanLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  return LABEL_OK.test(cleaned) ? cleaned : "task/secret";
}

export type PlannedEntry = MintEntry & { readonly field: string };
export type Plan = { readonly entries: readonly PlannedEntry[]; readonly unroutable: readonly string[]; readonly skipped: readonly string[]; readonly records: readonly string[] };

const DELIMITERS = ["|", "\t", "----", ",", ";"] as const;

/** The delimiter that splits `line` into 3+ fields, if any. */
export function recordDelimiter(line: string): string | null {
  return DELIMITERS.find((d) => line.split(d).length >= 3) ?? null;
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
export function planSeal(text: string, found: readonly FoundSecret[]): Plan {
  const seen = new Set<string>();
  const entries: PlannedEntry[] = [], unroutable: string[] = [], skipped: string[] = [], records: string[] = [];
  found.forEach((f, i) => {
    if (f.value.length < MIN_VALUE_LENGTH || !text.includes(f.value) || seen.has(f.value)) { skipped.push(f.label); return; }
    if (isWholeRecord(text, f.value)) { records.push(f.label); return; }
    seen.add(f.value);
    const hosts = [...new Set(f.hosts.map(hostOf).filter(Boolean))];
    const base = cleanLabel(f.label);
    const label = entries.some((e) => e.label === base) ? `${base}-${i + 1}` : base;
    if (f.uses.includes("http") && !hosts.length) { unroutable.push(label); return; }
    entries.push({ label, field: f.field.trim() || label, value: f.value, kind: f.kind, hosts, uses: [...new Set(f.uses)] });
  });
  return { entries, unroutable, skipped, records };
}

export const LEGEND_HEADER = "[AgentSwitch sealed the credentials in this message. Each enc:v1: value is a secret-gate token standing for the field named here; use the token exactly where that field goes.]";

/** Appended to the sealed text, so the router and the executor know what each token is. */
export function legend(entries: readonly SealedEntry[], layout: string | null): string {
  if (!entries.length) return "";
  const lines = entries.map((e) => `- ${e.field}${e.hosts.length ? ` (for ${e.hosts.join(", ")})` : ""}: ${e.token}`);
  return `\n\n${LEGEND_HEADER}\n${layout ? `Record layout: ${layout}\n` : ""}${lines.join("\n")}`;
}

/** Every occurrence of each value becomes its token; longer values first so a value inside another is not split. */
export function applyTokens(text: string, pairs: readonly { readonly value: string; readonly token: string }[]): string {
  return [...pairs].sort((a, b) => b.value.length - a.value.length).reduce((acc, p) => acc.split(p.value).join(p.token), text);
}

const RECORD_FEEDBACK = (labels: readonly string[]) => `Your previous reply marked whole records as single values (${labels.join(", ")}). Split each record into its fields and mark only the fields that are credentials.`;

async function askModel(router: Router, message: string, signal: AbortSignal): Promise<({ ok: true } & SealReply) | { ok: false; error: string }> {
  const reply = await router.route({ task: message, cwd: process.cwd(), system: SEAL_SYSTEM }, signal);
  return parseSealReply(reply.text);
}

/** Ask, and once more with feedback if whole records came back marked; still whole → split them mechanically. */
async function planWithRetry(router: Router, text: string, message: string, signal: AbortSignal): Promise<{ ok: true; plan: Plan; layout: string | null } | { ok: false; error: string }> {
  let parsed = await askModel(router, message, signal);
  if (!parsed.ok) return parsed;
  let plan = planSeal(text, parsed.secrets);
  if (plan.records.length) {
    const again = await askModel(router, `${message}\n\n${RECORD_FEEDBACK(plan.records)}`, signal);
    if (again.ok) { parsed = again; plan = planSeal(text, again.secrets); }
  }
  if (plan.records.length) {
    const whole = parsed.secrets.filter((f) => plan.records.includes(f.label));
    const rest = parsed.secrets.filter((f) => !plan.records.includes(f.label));
    plan = planSeal(text, [...rest, ...whole.flatMap((f, i) => splitRecord(f, i + 1))]);
  }
  return { ok: true, plan, layout: parsed.layout };
}

export function routerSealer(router: Router, minter: Minter, environment: () => string, timeoutMs = SEAL_TIMEOUT_MS): Sealer {
  return async (text, ctx = {}, outer) => {
    const started = Date.now();
    const ms = () => Date.now() - started;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("sealer timed out")), timeoutMs);
    const onAbort = () => controller.abort(new Error("cancelled"));
    outer?.addEventListener("abort", onAbort, { once: true });
    try {
      const planned = await planWithRetry(router, text, sealMessage(text, environment(), ctx), controller.signal);
      if (!planned.ok) return { ok: false, code: "unavailable", error: `sealer: ${planned.error}`, ms: ms() };
      const { plan, layout } = planned;
      if (plan.unroutable.length) return { ok: false, code: "unroutable", error: `不知道这些凭据要用在哪个站点：${plan.unroutable.join("、")}。任务里点名站点或写上网址，或把站点加进 CONTEXT.md`, ms: ms() };
      const minted = await minter(plan.entries);
      const failed = minted.filter((m) => "error" in m);
      if (failed.length) return { ok: false, code: "unavailable", error: `secret-gate refused: ${failed.map((m) => `${m.label}: ${"error" in m ? m.error : ""}`).join("; ")}`, ms: ms() };
      const sealed: SealedEntry[] = plan.entries.map((e, i) => ({ label: e.label, field: e.field, kind: e.kind, hosts: e.hosts, uses: e.uses, token: (minted[i] as { token: string }).token }));
      const replaced = applyTokens(text, plan.entries.map((e, i) => ({ value: e.value, token: sealed[i]!.token })));
      return { ok: true, text: replaced + legend(sealed, layout), sealed, ms: ms() };
    } catch (err) {
      return { ok: false, code: "unavailable", error: `sealer: ${(err as Error).message}`, ms: ms() };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  };
}
