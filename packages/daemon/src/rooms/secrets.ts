/** A room's secrets (2026-11-24, user #194: 每个房间里都可以加一些“加密信息”…生成网关脱敏之后的上下文，放到房间的上下文
 *  里；支持批量导入明文生成密文、导出明文填写模版、批量导出密文导入到其他房间). What the members need to log in, call
 *  an API or run a command with — each sealed on the Mac by the gate (`secret-gate enc`) before it comes here: the
 *  service keeps and gives out ciphertexts only (`enc:v1:…`), never a value. A member reads them with room_info
 *  show=secrets and uses the token where the value would go; the gate puts the value in on the way out (a request's
 *  header or body, a page's field, a command's environment) and takes it out of what comes back. */

import { randomBytes } from "node:crypto";

export const TOKEN = /^enc:v1:[A-Za-z0-9_-]{16,}={0,2}$/;
export const SECRET_KINDS = ["site", "api", "exec"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];
export const MAX_SECRETS = 100;

export type RoomSecret = {
  readonly id: string;
  /** What it is, in the user's words (`GitHub 登录`, `OpenAI key`). */
  readonly name: string;
  readonly kind: SecretKind;
  /** Where it is used: the site or the API's address. */
  readonly url?: string;
  /** The account it goes with (a user name, an email): not secret, said as it is. */
  readonly account?: string;
  /** For `exec`: the environment variable a command reads it from. */
  readonly env?: string;
  readonly token: string;
  readonly addedAt: number;
};

const KIND_WORD: Readonly<Record<SecretKind, string>> = { site: "website login", api: "API key", exec: "for commands" };

/** How a member uses it, in a line. */
export function useOf(s: RoomSecret): string {
  switch (s.kind) {
    case "site": return `log in at ${s.url ?? "its site"}${s.account ? ` as ${s.account}` : ""}: room_secret use http, with the token where the password goes in the login request; the gate puts the password in. The browser tools can not type it: where the site needs its page, ask the user (@you) to fill the field (Fill Ciphertext in the browser).`;
    case "api": return `call ${s.url ?? "its API"}: room_secret use http, with the token where the key goes (e.g. the Authorization header); the gate puts the key in on the way out.`;
    case "exec": return `run a command with it: room_secret use exec, env {"${s.env ?? "NAME"}": "<token>"}; the command sees the value, you never do.`;
  }
}

/** One secret as a member reads it: one line and its use. */
export function lineOf(s: RoomSecret): string {
  return `${s.name} · ${KIND_WORD[s.kind]}${s.url ? ` · ${s.url}` : ""}${s.account ? ` · account ${s.account}` : ""}${s.env ? ` · env ${s.env}` : ""}\n  ${s.token}\n  ${useOf(s)}`;
}

const clean = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/[\r\n\t]+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
};

/** A secret as given (an import, the Mac's add): checked; a value instead of a token is refused, never kept. */
export function secretFrom(raw: unknown, now: number): RoomSecret | string {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = clean(o.name, 64);
  if (!name) return "a secret needs a name";
  const kind = SECRET_KINDS.find((k) => k === o.kind);
  if (!kind) return `${name}: kind is site, api or exec`;
  const token = typeof o.token === "string" ? o.token.trim() : "";
  if (!TOKEN.test(token)) return `${name}: only a ciphertext (enc:v1:…) is taken here — seal the value on the Mac first`;
  const env = clean(o.env, 64);
  if (env !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(env)) return `${name}: env is an upper-case variable name`;
  const url = clean(o.url, 500), account = clean(o.account, 200);
  const id = typeof o.id === "string" && /^[a-z0-9]{6,20}$/.test(o.id) ? o.id : randomBytes(6).toString("hex");
  return { id, name, kind, ...(url ? { url } : {}), ...(account ? { account } : {}), ...(env ? { env } : {}), token, addedAt: typeof o.addedAt === "number" ? o.addedAt : now };
}
