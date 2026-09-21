/** enc:v1: tokens are 200+ random characters; a model that retypes one drops or flips a character now and
 *  then, and the gate then rejects it ("invalid base64url"). The daemon knows the genuine tokens (CONTEXT.md,
 *  MEMORY.md, the task text), so anything that looks like a slightly damaged copy of one is put back verbatim,
 *  in the brief, in the executor prompt and in Claude's tool inputs. Deterministic, never guesses between two. */

export const TOKEN_RE = /enc:v1:[A-Za-z0-9_=-]{16,}/g;
const MIN_PREFIX = 10;
const MIN_SUFFIX = 6;
const MAX_LENGTH_DIFF = 4;

export function knownTokens(...texts: (string | null | undefined)[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").match(TOKEN_RE) ?? []) out.add(m);
  return out;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** The one known token this damaged copy must have been, or null when none (or more than one) qualifies. */
export function closestToken(candidate: string, known: ReadonlySet<string>): string | null {
  if (known.has(candidate)) return candidate;
  const body = candidate.slice("enc:v1:".length);
  const matches = [...known].filter((k) => {
    const kb = k.slice("enc:v1:".length);
    if (Math.abs(kb.length - body.length) > MAX_LENGTH_DIFF) return false;
    return commonPrefix(kb, body) >= MIN_PREFIX && commonSuffix(kb, body) >= MIN_SUFFIX;
  });
  return matches.length === 1 ? matches[0]! : null;
}

export type Repair = { readonly from: string; readonly to: string };

export function repairTokens(text: string, known: ReadonlySet<string>): { text: string; repairs: Repair[] } {
  if (!known.size) return { text, repairs: [] };
  const repairs: Repair[] = [];
  const out = text.replace(TOKEN_RE, (m) => {
    const fixed = closestToken(m, known);
    if (fixed && fixed !== m) repairs.push({ from: m, to: fixed });
    return fixed ?? m;
  });
  return { text: out, repairs };
}

/** Same repair on every string inside a tool input (arrays and objects walked; other values untouched). */
export function repairInValue<T>(value: T, known: ReadonlySet<string>, repairs: Repair[] = []): { value: T; repairs: Repair[] } {
  if (typeof value === "string") {
    const r = repairTokens(value, known);
    repairs.push(...r.repairs);
    return { value: r.text as unknown as T, repairs };
  }
  if (Array.isArray(value)) return { value: value.map((v) => repairInValue(v, known, repairs).value) as unknown as T, repairs };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = repairInValue(v, known, repairs).value;
    return { value: out as T, repairs };
  }
  return { value, repairs };
}

/** Short form for logs: never the whole token. */
export const shortToken = (t: string): string => `${t.slice(0, 19)}…${t.slice(-6)} (${t.length - 7} chars)`;
