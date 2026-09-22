/** The plaintext entrance (router-v0 §9): the user may paste accounts and passwords, or a table of them, into a
 *  task. Before the task is stored or routed, the router's text-only model marks which values are secrets and
 *  which host each belongs to; the daemon mints tokens for them and puts the tokens where the values were.
 *  The executors, the store, the logs and the routing prompt only ever see enc:v1: tokens. */

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
export type Sealer = (text: string, signal?: AbortSignal) => Promise<SealResult>;

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
- "hosts": the site the value is for, as host or host:port, taken from a URL in the text or from the user's site list; several when the text names several. Leave empty only when the text gives no site at all.
- "uses": ["http"] for anything typed into a website or sent in a request; ["otp"] for TOTP seeds; ["exec"] for values used by local commands.
- Nothing sensitive: {"secrets":[]}.`;

/** Sites named in CONTEXT.md (URLs and host:port entries), so the model binds tokens to hosts the user already listed. */
export function sitesFromContext(text: string | null | undefined): readonly string[] {
  const urls = (text ?? "").match(/https?:\/\/[^\s)）,，;；'"<>]+/g) ?? [];
  return [...new Set(urls.map(hostOf).filter(Boolean))];
}

export function sealMessage(text: string, knownSites: readonly string[]): string {
  const sites = knownSites.length ? `User's site list (from CONTEXT.md):\n${knownSites.map((s) => `- ${s}`).join("\n")}\n\n` : "";
  return `${sites}Task text:\n<<<\n${text}\n>>>`;
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

export function routerSealer(router: Router, minter: Minter, knownSites: () => readonly string[], timeoutMs = SEAL_TIMEOUT_MS): Sealer {
  return async (text, outer) => {
    const started = Date.now();
    const ms = () => Date.now() - started;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("sealer timed out")), timeoutMs);
    const onAbort = () => controller.abort(new Error("cancelled"));
    outer?.addEventListener("abort", onAbort, { once: true });
    try {
      const reply = await router.route({ task: sealMessage(text, knownSites()), cwd: process.cwd(), system: SEAL_SYSTEM }, controller.signal);
      const parsed = parseSealReply(reply.text);
      if (!parsed.ok) return { ok: false, code: "unavailable", error: `sealer: ${parsed.error}`, ms: ms() };
      const plan = planSeal(text, parsed.secrets);
      if (plan.unroutable.length) return { ok: false, code: "unroutable", error: `these credentials have no site to bind to: ${plan.unroutable.join(", ")}; put the site's URL in the task`, ms: ms() };
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
