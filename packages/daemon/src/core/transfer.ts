/** Authorized field transfer (gate-next-v0 §5.2): the router names, from the user's own task only, which personal-data
 *  fields may move from which exact source systems to which exact destination systems, and why. The grant is checked
 *  here and nowhere else: an invalid grant is dropped whole (never patched up, never widened) with a note for the audit.
 *  Trust: only the first routing decision can grant (`pinTransfer`), and each of its hosts must appear in the user's own
 *  statements. Loop and planner models read executor replies, which can carry page content, so a later step decision
 *  can only carry a subset of that pin (`narrowTransfer`); a step without `transfer` gets none.
 *  Only the browser gate acts on it (SECRET_GATE_TRANSFER), and only inside an execution scope. */

import { z } from "zod";
import { exactHost } from "../util/host.js";
import { zodIssues } from "../util/zod.js";

export const TRANSFER_FIELDS = ["email", "phone", "id_number", "bank_card"] as const;
export type TransferField = (typeof TRANSFER_FIELDS)[number];

const MAX_ENDPOINTS = 8;
const MAX_PURPOSE = 200;
/** Notes about a dropped grant quote each host this long, list this many, and name this many validation issues. */
const QUOTE_CHARS = 80;
const LISTED_ITEMS = 4;
const ISSUES_SHOWN = 3;
const CONTROL = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Exact host or host:port as given (lower-cased): no scheme, path, credentials or wildcard. */
const Endpoint = z.string().transform((value, ctx) => {
  const host = exactHost(value);
  if (!host) { ctx.addIssue({ code: "custom", message: `not an exact host or host:port: ${JSON.stringify(value.slice(0, QUOTE_CHARS))}` }); return z.NEVER; }
  return host;
});
const Endpoints = z.array(Endpoint).min(1).max(MAX_ENDPOINTS).transform((hosts) => [...new Set(hosts)]);

export const TransferGrant = z.strictObject({
  source: Endpoints,
  destination: Endpoints,
  fields: z.array(z.enum(TRANSFER_FIELDS)).min(1).max(TRANSFER_FIELDS.length * 2).transform((fields) => [...new Set(fields)]),
  purpose: z.string().trim().min(1).max(MAX_PURPOSE)
    .refine((s) => !CONTROL.test(s) && !LONE_SURROGATE.test(s), "purpose must be plain one-line text"),
});
export type TransferGrant = z.infer<typeof TransferGrant>;

export type ParsedTransfer = { readonly grant: TransferGrant | null; readonly note: string | null };

/** The router's raw `transfer` value → a valid grant, or null with the reason it was dropped. Absent/null is no grant. */
export function parseTransfer(raw: unknown): ParsedTransfer {
  if (raw === null || raw === undefined) return { grant: null, note: null };
  const parsed = TransferGrant.safeParse(raw);
  if (parsed.success) return { grant: parsed.data, note: null };
  const why = zodIssues(parsed.error, { root: "transfer", limit: ISSUES_SHOWN });
  return { grant: null, note: `transfer grant dropped (invalid, never widened): ${why}` };
}

/** Just the grant, validated but not yet pinned or grounded. */
export function transferGrant(raw: unknown): TransferGrant | null {
  return parseTransfer(raw).grant;
}

const endpoints = (t: TransferGrant): readonly string[] => [...t.source, ...t.destination];
const listed = (items: readonly string[]): string => items.slice(0, LISTED_ITEMS).map((x) => JSON.stringify(x.slice(0, QUOTE_CHARS))).join(", ") + (items.length > LISTED_ITEMS ? ", …" : "");

/** The first routing decision's grant, kept only if every host or host:port it names appears in the user's own statements
 *  (the task chain's user messages, CONTEXT.md, the user's answers). A follow-up's router input also holds earlier
 *  assistant replies, so the router's word alone is not enough. */
export function pinTransfer(raw: unknown, userTexts: readonly string[]): ParsedTransfer {
  const parsed = parseTransfer(raw);
  if (!parsed.grant) return parsed;
  const said = userTexts.join("\n").toLowerCase();
  const unnamed = endpoints(parsed.grant).filter((host) => !said.includes(host));
  if (unnamed.length) return { grant: null, note: `transfer grant dropped: ${listed(unnamed)} not named in the user's own task or context` };
  return parsed;
}

/** A later step decision's grant: absent → none for this step; otherwise only fields, sources and destinations already in
 *  the pin, and the pin's purpose (or none, which means the pin's). Anything beyond drops the step's grant whole. */
export function narrowTransfer(pinned: TransferGrant | null, raw: unknown): ParsedTransfer {
  if (raw === null || raw === undefined) return { grant: null, note: null };
  if (!pinned) return { grant: null, note: "transfer grant dropped: only the first routing decision can grant a field transfer" };
  const withPurpose = raw && typeof raw === "object" && !Array.isArray(raw) && ((raw as { purpose?: unknown }).purpose ?? "") === ""
    ? { ...(raw as Record<string, unknown>), purpose: pinned.purpose } : raw;
  const parsed = parseTransfer(withPurpose);
  if (!parsed.grant) return parsed;
  const g = parsed.grant;
  const beyond = [
    ...g.fields.filter((f) => !pinned.fields.includes(f)).map((f) => `field ${f}`),
    ...g.source.filter((h) => !pinned.source.includes(h)).map((h) => `source ${h}`),
    ...g.destination.filter((h) => !pinned.destination.includes(h)).map((h) => `destination ${h}`),
    ...(g.purpose !== pinned.purpose ? ["a different purpose"] : []),
  ];
  if (beyond.length) return { grant: null, note: `transfer grant dropped: this step asked for ${listed(beyond)} beyond the grant pinned from the first routing decision` };
  return parsed;
}

/** One line for the executor's prompt; values themselves only ever appear as enc:ref: references. */
export function transferNote(t: TransferGrant): string {
  return `Authorized field transfer (from the user's own task; nothing beyond it is authorized): ${t.fields.join(", ")} from ${t.source.join(", ")} to ${t.destination.join(", ")}; purpose: ${t.purpose}. On the source pages the browser gate shows these values only as enc:ref: references; place each one into the matching destination field with secret_fill.`;
}
