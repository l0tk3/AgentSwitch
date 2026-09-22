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

export type SealedEntry = { readonly label: string; readonly kind: "secret" | "totp"; readonly hosts: readonly string[]; readonly uses: readonly ("http" | "otp" | "exec")[] };
export type SealResult =
  | { readonly ok: true; readonly text: string; readonly sealed: readonly SealedEntry[]; readonly ms: number }
  | { readonly ok: false; readonly code: "unroutable" | "unavailable"; readonly error: string; readonly ms: number };
/** What the model may use to tell what a value is for: the parent task of a follow-up, and the thread's title. */
export type SealContext = { readonly parentTask?: string; readonly threadTitle?: string };
export type Sealer = (text: string, ctx?: SealContext, signal?: AbortSignal) => Promise<SealResult>;

const Found = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["secret", "totp"]).default("secret"),
  hosts: z.array(z.string()).default([]),
  uses: z.array(z.enum(["http", "otp", "exec"])).min(1).default(["http"]),
});
const Reply = z.object({ secrets: z.array(Found).default([]) });
export type FoundSecret = z.infer<typeof Found>;

export const SEAL_SYSTEM = `You find credentials in a task text so they can be replaced by secret-gate ciphertext before any other model sees the task.
Reply with one JSON object only: {"secrets":[{"value":"…","label":"site/pass","kind":"secret|totp","hosts":["host[:port]"],"uses":["http"|"otp"|"exec"]}]}
Rules:
- "value" is copied character for character from the text; it is the only thing replaced. Never invent or alter a value.
- Mark: passwords, PINs, API keys, tokens, TOTP seeds (kind "totp", uses ["otp"]), account names, emails and phone numbers that log in to something, and any table cell that is one of those. Do not mark URLs, hostnames, product names, file paths, or ordinary words.
- "label" is short: <site>/<what>, e.g. finance/pass, finance/account, mail/totp. Only [A-Za-z0-9._/-].
- "hosts": the site the value is for, as host or host:port. Take it from a URL in the text; when the text only names the site ("the finance system", "grafana"), find that site in the user's environment context or the earlier turn and use its host. Several hosts when the text names several. Leave empty only when nothing names a site.
- "uses": ["http"] for anything typed into a website or sent in a request; ["otp"] for TOTP seeds; ["exec"] for values used by local commands.
- Nothing sensitive: {"secrets":[]}.`;

export function sealMessage(text: string, environment: string, ctx: SealContext = {}): string {
  const env = environment.trim() ? `User's environment context (sites, accounts as enc:v1: tokens, notes):\n<<<\n${environment.trim()}\n>>>\n\n` : "";
  const thread = ctx.threadTitle ? `Thread: ${ctx.threadTitle}\n` : "";
  const parent = ctx.parentTask ? `Earlier turn in this thread:\n<<<\n${ctx.parentTask}\n>>>\n\n` : "";
  return `${env}${thread}${parent}Task text:\n<<<\n${text}\n>>>`;
}

export function parseSealReply(reply: string): { ok: true; secrets: readonly FoundSecret[] } | { ok: false; error: string } {
  const raw = extractJsonObject(reply);
  if (raw === undefined) return { ok: false, error: `no JSON object in reply: ${reply.slice(0, 200)}` };
  try {
    const parsed = Reply.safeParse(JSON.parse(raw));
    return parsed.success ? { ok: true, secrets: parsed.data.secrets } : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
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

export type Plan = { readonly entries: readonly MintEntry[]; readonly unroutable: readonly string[]; readonly skipped: readonly string[] };

/** What to mint. A value the text does not contain, or shorter than MIN_VALUE_LENGTH, is skipped (nothing to
 *  replace, or too short to replace safely). An http secret without a host is unroutable: the gate would refuse it. */
export function planSeal(text: string, found: readonly FoundSecret[]): Plan {
  const seen = new Set<string>();
  const entries: MintEntry[] = [], unroutable: string[] = [], skipped: string[] = [];
  found.forEach((f, i) => {
    if (f.value.length < MIN_VALUE_LENGTH || !text.includes(f.value) || seen.has(f.value)) { skipped.push(f.label); return; }
    seen.add(f.value);
    const hosts = [...new Set(f.hosts.map(hostOf).filter(Boolean))];
    const base = cleanLabel(f.label);
    const label = entries.some((e) => e.label === base) ? `${base}-${i + 1}` : base;
    if (f.uses.includes("http") && !hosts.length) { unroutable.push(label); return; }
    entries.push({ label, value: f.value, kind: f.kind, hosts, uses: [...new Set(f.uses)] });
  });
  return { entries, unroutable, skipped };
}

/** Every occurrence of each value becomes its token; longer values first so a value inside another is not split. */
export function applyTokens(text: string, pairs: readonly { readonly value: string; readonly token: string }[]): string {
  return [...pairs].sort((a, b) => b.value.length - a.value.length).reduce((acc, p) => acc.split(p.value).join(p.token), text);
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
      const reply = await router.route({ task: sealMessage(text, environment(), ctx), cwd: process.cwd(), system: SEAL_SYSTEM }, controller.signal);
      const parsed = parseSealReply(reply.text);
      if (!parsed.ok) return { ok: false, code: "unavailable", error: `sealer: ${parsed.error}`, ms: ms() };
      const plan = planSeal(text, parsed.secrets);
      if (plan.unroutable.length) return { ok: false, code: "unroutable", error: `不知道这些凭据用在哪个站点：${plan.unroutable.join("、")}。任务里点名站点或写上网址，或把站点加进 CONTEXT.md`, ms: ms() };
      const minted = await minter(plan.entries);
      const failed = minted.filter((m) => "error" in m);
      if (failed.length) return { ok: false, code: "unavailable", error: `secret-gate refused: ${failed.map((m) => `${m.label}: ${"error" in m ? m.error : ""}`).join("; ")}`, ms: ms() };
      const pairs = plan.entries.map((e, i) => ({ value: e.value, token: (minted[i] as { token: string }).token }));
      return { ok: true, text: applyTokens(text, pairs), sealed: plan.entries.map(({ label, kind, hosts, uses }) => ({ label, kind, hosts, uses })), ms: ms() };
    } catch (err) {
      return { ok: false, code: "unavailable", error: `sealer: ${(err as Error).message}`, ms: ms() };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  };
}
