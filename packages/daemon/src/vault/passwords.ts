/** The password book (2026-11-25, user #345-#351): the user's own logins, kept apart from the replacement words, in
 *  one file under the vault's key (key.ts; AES-256-GCM). Each password, and each 2FA seed's current code, is a
 *  replacement word as long as the model traffic gateway is on (modelGate.ts): the model sees a placeholder, the agent
 *  on this Mac the value (user #349: 总比直接给他发密码强).
 *
 *  The list goes out without the secrets (`shown`); a password, a note or a code only through `reveal`, which the
 *  Mac asks after Touch ID. Never on the remote allowlist. */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VAULT_DIR } from "./key.js";

const FILE = "passwords.enc";
export const MAX_ENTRIES = 5000;

export type PasswordEntry = {
  readonly id: string;
  readonly name: string;
  /** Where it is used: host names (`github.com`). */
  readonly sites: readonly string[];
  readonly account: string;
  readonly password: string;
  /** A 2FA seed (base32). */
  readonly totp?: string;
  readonly note?: string;
  readonly tags: readonly string[];
  readonly updatedAt: number;
};

/** An entry as the list shows it: no password, no seed, no note — only whether there is one. */
export type ShownEntry = Omit<PasswordEntry, "password" | "totp" | "note"> & { readonly hasTotp: boolean; readonly hasNote: boolean; readonly length: number };

export class PasswordError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message); }
}

export type EntryInput = { name?: string; sites?: readonly string[]; account?: string; password?: string; totp?: string; note?: string; tags?: readonly string[] };

const seal = (key: Buffer, data: unknown): Buffer => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(data), "utf8"), c.final()]);
  return Buffer.concat([Buffer.from("ASP1"), iv, c.getAuthTag(), body]);
};

const unseal = (key: Buffer, blob: Buffer): { entries: PasswordEntry[] } => {
  if (blob.subarray(0, 4).toString() !== "ASP1") throw new Error("not a password book");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(4, 16));
  d.setAuthTag(blob.subarray(16, 32));
  return JSON.parse(Buffer.concat([d.update(blob.subarray(32)), d.final()]).toString("utf8")) as { entries: PasswordEntry[] };
};

/** A site as kept: its host name, from whatever was typed (`https://github.com/login` → `github.com`). */
export function siteOf(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(t) ? t : `https://${t}`).hostname || null; } catch { return null; }
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** RFC 6238: the current six digits of a base32 seed, and the seconds it has left. */
export function totpNow(seed: string, now = Date.now()): { code: string; left: number } {
  const clean = seed.replace(/[\s-]/g, "").toUpperCase().replace(/=+$/, "");
  let bits = 0, acc = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new PasswordError(400, "两步验证密钥不是有效的 base32。");
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { bytes.push((acc >> (bits - 8)) & 255); bits -= 8; }
  }
  const step = Math.floor(now / 1000 / 30);
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const mac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const off = mac[mac.length - 1]! & 15;
  const n = ((mac[off]! & 127) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return { code: String(n % 1_000_000).padStart(6, "0"), left: 30 - (Math.floor(now / 1000) % 30) };
}

/** A password made here: `length` characters of letters, digits and (unless asked not to) symbols, each kind at
 *  least once. */
export function generatePassword(length = 20, symbols = true): string {
  const n = Math.min(Math.max(Math.round(length), 8), 128);
  const kinds = ["abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", ...(symbols ? ["!@#$%^&*-_=+?"] : [])];
  const all = kinds.join("");
  const pick = (s: string): string => { let r: number; do { r = randomBytes(1)[0]!; } while (r >= 256 - (256 % s.length)); return s[r % s.length]!; };
  const out = kinds.map(pick);
  while (out.length < n) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) { const j = randomBytes(4).readUInt32BE(0) % (i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out.join("");
}

/** The rows of a browser's or a password manager's CSV export (Chrome, Safari, 1Password, Bitwarden): the columns are
 *  found by their names. */
export function parseCsv(text: string): { entries: EntryInput[]; skipped: number } {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === "\"" && text[i + 1] === "\"") { cur += "\""; i++; } else if (c === "\"") quoted = false; else cur += c;
    } else if (c === "\"") quoted = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]): number => head.findIndex((h) => names.includes(h));
  const at = { name: col("name", "title"), url: col("url", "website", "login_uri", "urls"), user: col("username", "login_username", "user", "email", "login"), pass: col("password", "login_password"),
    totp: col("otpauth", "totp", "otp", "login_totp", "one-time password"), note: col("note", "notes", "extra") };
  if (at.pass < 0) throw new PasswordError(400, "没有找到 password 这一列：请用浏览器或密码管理器导出的 CSV。");
  const entries: EntryInput[] = [];
  let skipped = 0;
  for (const r of rows) {
    const get = (i: number): string => (i >= 0 ? (r[i] ?? "").trim() : "");
    const password = get(at.pass);
    if (!password) { if (r.some((x) => x.trim())) skipped += 1; continue; }
    const url = get(at.url), site = siteOf(url);
    const totpRaw = get(at.totp);
    const totp = totpRaw.startsWith("otpauth://") ? new URL(totpRaw).searchParams.get("secret") ?? "" : totpRaw;
    entries.push({ name: get(at.name) || site || "未命名", sites: site ? [site] : [], account: get(at.user), password, ...(totp ? { totp } : {}), ...(get(at.note) ? { note: get(at.note) } : {}) });
  }
  return { entries, skipped };
}

export class PasswordBook {
  private entries: PasswordEntry[] = [];
  private readonly file: string;

  constructor(home: string, private readonly keys: readonly Buffer[], private readonly now: () => number = Date.now) {
    const dir = join(home, VAULT_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, FILE);
    if (!existsSync(this.file)) return;
    const blob = readFileSync(this.file);
    for (const [i, key] of keys.entries()) {
      try { this.entries = unseal(key, blob).entries; if (i > 0) this.save(); return; } catch { /* the next key */ }
    }
    renameSync(this.file, `${this.file}.unreadable-${this.now()}`);
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, seal(this.keys[0]!, { entries: this.entries }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list(): ShownEntry[] {
    return [...this.entries].sort((a, b) => a.name.localeCompare(b.name, "zh")).map(({ password, totp, note, ...rest }) => ({ ...rest, hasTotp: !!totp, hasNote: !!note, length: [...password].length }));
  }

  private must(id: string): PasswordEntry {
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new PasswordError(404, "没有这一条。");
    return e;
  }

  /** What only the user sees, after the Mac asked for Touch ID. */
  reveal(id: string): { password: string; note?: string; totp?: { code: string; left: number } } {
    const e = this.must(id);
    return { password: e.password, ...(e.note ? { note: e.note } : {}), ...(e.totp ? { totp: totpNow(e.totp, this.now()) } : {}) };
  }

  private made(input: EntryInput, was?: PasswordEntry): PasswordEntry {
    const name = (input.name ?? was?.name ?? "").trim().slice(0, 200);
    const password = input.password ?? was?.password ?? "";
    if (!name) throw new PasswordError(400, "要有名称。");
    if (!password) throw new PasswordError(400, "要有密码。");
    if (password.length > 4000) throw new PasswordError(400, "密码太长。");
    const sites = input.sites === undefined ? was?.sites ?? [] : [...new Set(input.sites.map(siteOf).filter((s): s is string => !!s))].slice(0, 20);
    const totp = input.totp === undefined ? was?.totp : input.totp.replace(/\s/g, "") || undefined;
    if (totp) totpNow(totp);   // a seed that does not decode is refused now, not when a code is asked for
    const note = input.note === undefined ? was?.note : input.note.slice(0, 10_000) || undefined;
    return {
      id: was?.id ?? randomUUID().slice(0, 12), name, sites, account: (input.account ?? was?.account ?? "").trim().slice(0, 300), password,
      ...(totp ? { totp } : {}), ...(note ? { note } : {}),
      tags: (input.tags ?? was?.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 20), updatedAt: this.now(),
    };
  }

  add(input: EntryInput): ShownEntry {
    if (this.entries.length >= MAX_ENTRIES) throw new PasswordError(400, `最多 ${MAX_ENTRIES} 条。`);
    const e = this.made(input);
    this.entries.push(e);
    this.save();
    return this.list().find((x) => x.id === e.id)!;
  }

  update(id: string, input: EntryInput): ShownEntry {
    const at = this.entries.findIndex((x) => x.id === id);
    if (at < 0) throw new PasswordError(404, "没有这一条。");
    this.entries[at] = this.made(input, this.entries[at]);
    this.save();
    return this.list().find((x) => x.id === id)!;
  }

  remove(id: string): void {
    this.must(id);
    this.entries = this.entries.filter((x) => x.id !== id);
    this.save();
  }

  /** Many at once (an import): an entry with the same name and account as one there replaces it. */
  addMany(inputs: readonly EntryInput[]): { added: number; replaced: number } {
    let added = 0, replaced = 0;
    for (const input of inputs) {
      const was = this.entries.findIndex((x) => x.name === input.name?.trim() && x.account === (input.account ?? "").trim());
      if (was >= 0) { this.entries[was] = this.made(input, this.entries[was]); replaced += 1; }
      else if (this.entries.length < MAX_ENTRIES) { this.entries.push(this.made(input)); added += 1; }
    }
    this.save();
    return { added, replaced };
  }

  /** What the model never sees of the book: every password (four characters at least, a shorter one would hit plain
   *  text). */
  words(): string[] {
    return [...new Set(this.entries.map((e) => e.password).filter((p) => p.length >= 4))];
  }
}
