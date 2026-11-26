/** What the model never sees (2026-11-25, user #318-#332): the user's replacement words — one list for everything, one
 *  more for each room — and the switches for what is found on its own (this account's user name, full name and home
 *  folder; the computer's name). Each becomes a placeholder on its way to the model and the word again on its way back
 *  (model gateway: secret-gate model_gate.py, run by modelGate.ts).
 *
 *  A placeholder is, unless the user gives one, `h_` and ten letters of HMAC-SHA256(salt, word): each profile has a
 *  salt of its own, made here at random and never shown, so the model's provider can not try common words (names,
 *  phone numbers) against it, nor tell the same word under two accounts. A placeholder the user gives is put back only
 *  when it can be told from ordinary text (`restorable`); one too plain goes one way only.
 *
 *  A word may be a regular expression (2026-11-26, user #596: 替换词要支持正则表达式): what it matches is found by the
 *  gateway as the text goes out, and each piece found is a word of its own — the same salted placeholder the same text
 *  would get as a plain word (the gateway is given the pattern and the profile's salt), put back on the way in. One
 *  with a placeholder of the user's own replaces every match with it, one way only. Patterns are checked here
 *  (`checkPattern`): what both JavaScript and the gateway's Python read alike, nothing that matches nothing or
 *  ordinary text, nothing that can run away (a repeated group that repeats inside).
 *
 *  Kept in one file, AES-256-GCM, under the key of key.ts; never written in the clear. */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { VAULT_DIR } from "./key.js";

const FILE = "words.enc";
export const MIN_WORD = 3;
export const MAX_WORDS = 500;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export type Word = {
  readonly id: string;
  readonly value: string;
  /** The user's own placeholder; absent: the salted hash. */
  readonly replace?: string;
  /** Put back on the way in (false: one way only). */
  readonly restore: boolean;
  /** `value` is a regular expression (`checkPattern`). */
  readonly regex?: boolean;
  readonly addedAt: number;
};

export type RedactSettings = {
  /** The gateway at all: terminals started from now on go through it. */
  readonly enabled: boolean;
  /** This account's user name and full name (its home folder, /Users/<name>, with it). */
  readonly username: boolean;
  /** The computer's name. */
  readonly host: boolean;
  /** Both sides of what passes written down (before and after the replacing). */
  readonly log: boolean;
  /** Only these terminals are written down (user #595: 可以指定抓某n个session的); none: every terminal. */
  readonly logTerminals: readonly string[];
  /** Logs older than this many days are removed. */
  readonly keepDays: number;
  /** More of the models' addresses than the ones known (a vendor's own). */
  readonly hosts: readonly string[];
};

export const DEFAULT_SETTINGS: RedactSettings = { enabled: true, username: true, host: false, log: false, logTerminals: [], keepDays: 3, hosts: [] };

type Data = {
  readonly v: 1;
  settings: RedactSettings;
  words: Word[];
  rooms: Record<string, Word[]>;
  /** Per profile (its id; "" for none): hex. */
  salts: Record<string, string>;
};

export type Pair = { readonly value: string; readonly ref: string; readonly restore: boolean };
/** A regular expression as the gateway gets it: each match's placeholder is `ref` when the user gave one (one way
 *  only), else `hashRef(salt, match)`. */
export type PatternPair = { readonly pattern: string; readonly ref?: string; readonly salt?: string; readonly restore: boolean };

export const MAX_PATTERN = 200;
/** Ordinary text a pattern must not touch: if it matches here it would replace what anyone writes. */
const ORDINARY = "The quick brown fox jumps over the lazy dog, 2026-11-26 at 17:30. 这是一段普通的中文文字，用来检查。 Hello world! foo_bar baz-qux 12345 a.b/c";

/** Why a regular expression can not be a word; null: it can. Read by JavaScript here and by Python's `re` in the
 *  gateway (with `re.ASCII`, so `\d` and `\w` mean the same): what the two read differently is refused. */
export function checkPattern(source: string): string | null {
  if (source.length < MIN_WORD) return `正则至少 ${MIN_WORD} 个字符。`;
  if (source.length > MAX_PATTERN) return `正则最长 ${MAX_PATTERN} 个字符。`;
  if (/\\[pPk]|\(\?<|\(\?P|\(\?[a-zA-Z]|\\[uUx]\{/.test(source)) return "不支持命名分组、后行断言、内联标记和 \\p{…} 这类写法（网关读不一样）。";
  let re: RegExp;
  try { re = new RegExp(source, "u"); new RegExp(source); } catch (err) { return `不是有效的正则：${(err as Error).message.replace(/^Invalid regular expression: /, "")}`; }
  if (re.test("")) return "这个正则能匹配空字符串，会到处替换。";
  if (runaway(source)) return "这个正则有嵌套的重复（像 (a+)+），遇到某些文字会卡住，换一种写法。";
  const hit = new RegExp(source, "gu").exec(ORDINARY);
  if (hit) return `这个正则会匹配普通文字（例如「${hit[0].slice(0, 20)}」），太宽了。`;
  return null;
}

/** A group repeated whose inside repeats too — `(a+)+`, `(\w*\s?)*`, `(x{2,})+`: the writing that backtracks without end. */
function runaway(source: string): boolean {
  // What is escaped and what is in brackets is one character for this.
  const s = source.replace(/\\./g, "x").replace(/\[(?:\\.|[^\]])*\]/g, "x");
  const open: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") open.push(i);
    else if (s[i] === ")" && open.length) {
      const from = open.pop()!;
      const inner = s.slice(from + 1, i), after = s.slice(i + 1);
      if (/[+*]|\{\d*,\d*\}/.test(inner) && /^(?:[+*]|\{\d*,)/.test(after)) return true;
    }
  }
  return false;
}

export class RedactionError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

const seal = (key: Buffer, data: unknown): Buffer => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(data), "utf8"), c.final()]);
  return Buffer.concat([Buffer.from("ASV1"), iv, c.getAuthTag(), body]);
};

const open = (key: Buffer, blob: Buffer): Data => {
  if (blob.subarray(0, 4).toString() !== "ASV1") throw new Error("not a store");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(4, 16));
  d.setAuthTag(blob.subarray(16, 32));
  return JSON.parse(Buffer.concat([d.update(blob.subarray(32)), d.final()]).toString("utf8")) as Data;
};

/** The salted placeholder of a word. */
export function hashRef(salt: string, value: string): string {
  const mac = createHmac("sha256", Buffer.from(salt, "hex")).update(value, "utf8").digest();
  let bits = 0, acc = 0, out = "";
  for (const byte of mac) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5 && out.length < 10) { out += BASE32[(acc >> (bits - 5)) & 31]; bits -= 5; }
    if (out.length >= 10) break;
  }
  return `h_${out}`;
}

/** Whether a placeholder the user gave can be told from ordinary text, so that putting it back changes nothing else:
 *  six characters at least, and not a plain word or number. Null: it can; otherwise why not. */
export function restorable(ref: string): string | null {
  if (ref.length < 6) return "少于 6 个字符";
  if (/^[\p{L}]+$/u.test(ref) && !/[A-Z]/.test(ref.slice(1))) return "只是一个普通的词";
  if (/^\d+$/.test(ref)) return "只是数字";
  return null;
}

/** What is found on its own: this account's names and home, the computer's name. */
export function foundWords(s: RedactSettings, who: { user?: string; full?: string; home?: string; host?: string } = whoami()): string[] {
  const out: string[] = [];
  if (s.username) for (const w of [who.user, who.full]) if (w && w.length >= MIN_WORD) out.push(w);
  if (s.host && who.host && who.host.length >= MIN_WORD) out.push(who.host, who.host.replace(/\.local$/, ""));
  return [...new Set(out)];
}

let me: { user?: string; full?: string; home?: string; host?: string } | null = null;
function whoami(): { user?: string; full?: string; home?: string; host?: string } {
  if (me) return me;
  const u = userInfo();
  let full: string | undefined;
  try {
    full = process.platform === "darwin"
      ? execFileSync("id", ["-F"], { encoding: "utf8", timeout: 2000 }).trim()
      : (execFileSync("getent", ["passwd", u.username], { encoding: "utf8", timeout: 2000 }).split(":")[4] ?? "").split(",")[0]!.trim();
  } catch { /* no full name */ }
  me = { user: u.username, ...(full && full !== u.username ? { full } : {}), home: u.homedir, host: hostname() };
  return me;
}

/** What a profile's salt goes by (user #421: 如果我默认profile 换了个账号登录 盐应该也得换): the agent, the profile
 *  and who is signed in under it — another account under the same profile has another salt, and so other
 *  placeholders; the same account again has its old ones. The account is kept as a digest, not as written. */
export function saltKey(harness: string, profile: string, account: string | null): string {
  return `${harness}:${profile || "default"}:${account ? createHash("sha256").update(account.trim().toLowerCase()).digest("hex").slice(0, 16) : "-"}`;
}

export class RedactionStore {
  private data: Data;
  private readonly file: string;

  /** `keys`: the key, then any key it was kept under before (moved to the first on the next save). */
  constructor(home: string, private readonly keys: readonly Buffer[], private readonly now: () => number = Date.now, private readonly who?: Parameters<typeof foundWords>[1]) {
    const dir = join(home, VAULT_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, FILE);
    this.data = this.load();
  }

  private load(): Data {
    const empty: Data = { v: 1, settings: DEFAULT_SETTINGS, words: [], rooms: {}, salts: {} };
    if (!existsSync(this.file)) return empty;
    const blob = readFileSync(this.file);
    for (const [i, key] of this.keys.entries()) {
      try {
        const d = open(key, blob);
        const data: Data = { ...empty, ...d, settings: { ...DEFAULT_SETTINGS, ...d.settings } };
        if (i > 0) { this.data = data; this.save(); }
        return data;
      } catch { /* the next key */ }
    }
    // Not to be opened with any key there is (the Keychain item gone): kept aside, never overwritten.
    renameSync(this.file, `${this.file}.unreadable-${this.now()}`);
    return empty;
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, seal(this.keys[0]!, this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  settings(): RedactSettings { return this.data.settings; }

  setSettings(patch: Partial<RedactSettings>): RedactSettings {
    const keepDays = patch.keepDays === undefined ? this.data.settings.keepDays : Math.min(Math.max(Math.round(patch.keepDays), 0), 365);
    const hosts = patch.hosts === undefined ? this.data.settings.hosts : [...new Set(patch.hosts.map((h) => h.trim().toLowerCase()).filter((h) => /^(\*\.)?[a-z0-9.-]+$/.test(h)))].slice(0, 100);
    const logTerminals = patch.logTerminals === undefined ? this.data.settings.logTerminals : [...new Set(patch.logTerminals.map((t) => t.trim()).filter((t) => /^[A-Za-z0-9_-]{1,64}$/.test(t)))].slice(0, 50);
    this.data.settings = { ...this.data.settings, ...patch, keepDays, hosts, logTerminals };
    this.save();
    return this.data.settings;
  }

  words(room?: string): readonly Word[] { return room === undefined ? this.data.words : this.data.rooms[room] ?? []; }

  /** A word added (to a room's list when `room`); the same word again replaces it. Says whether its placeholder
   *  goes back. */
  add(input: { value: string; replace?: string; restore?: boolean; regex?: boolean }, room?: string): { word: Word; warning: string | null } {
    const value = input.value.trim();
    const regex = input.regex === true;
    if (regex) { const why = checkPattern(value); if (why) throw new RedactionError(400, why); }
    if (value.length < MIN_WORD) throw new RedactionError(400, `替换词至少 ${MIN_WORD} 个字符（太短会把普通文字也换掉）。`);
    if (value.length > 4000) throw new RedactionError(400, "替换词太长。");
    const replace = input.replace?.trim() || undefined;
    if (replace !== undefined) {
      if (regex && new RegExp(value, "u").test(replace)) throw new RedactionError(400, "替换成的内容不能被这个正则匹配到。");
      if (!regex && (replace.includes(value) || value.includes(replace))) throw new RedactionError(400, "替换成的内容不能包含原词，也不能被原词包含。");
      const clash = [...this.data.words, ...Object.values(this.data.rooms).flat()].find((w) => w.value !== value && w.replace !== undefined && (w.replace === replace || w.replace.includes(replace) || replace.includes(w.replace)));
      if (clash) throw new RedactionError(409, `和另一个替换词的替换内容「${clash.replace}」冲突，换一个。`);
    }
    // A pattern's matches all become the one placeholder the user gave: there is no telling which to put back.
    const plain = replace === undefined ? null : regex ? "是所有匹配共用的" : restorable(replace);
    const restore = input.restore !== false && plain === null;
    const warning = plain && input.restore !== false && !regex ? `「${replace}」${plain}，换回时没法和普通文字区分：只替换，不还原（模型看到它，你看到的也是它）。` : null;
    const list = room === undefined ? this.data.words : (this.data.rooms[room] ??= []);
    if (list.length >= MAX_WORDS && !list.some((w) => w.value === value && !w.regex === !regex)) throw new RedactionError(400, `最多 ${MAX_WORDS} 个替换词。`);
    const word: Word = { id: randomUUID().slice(0, 8), value, ...(replace ? { replace } : {}), restore, ...(regex ? { regex } : {}), addedAt: this.now() };
    const at = list.findIndex((w) => w.value === value && !w.regex === !regex);
    if (at >= 0) list[at] = word; else list.push(word);
    this.save();
    return { word, warning };
  }

  remove(id: string, room?: string): void {
    const list = room === undefined ? this.data.words : this.data.rooms[room];
    const at = list?.findIndex((w) => w.id === id) ?? -1;
    if (!list || at < 0) throw new RedactionError(404, "没有这个替换词。");
    list.splice(at, 1);
    if (room !== undefined && !list.length) delete this.data.rooms[room];
    this.save();
  }

  dropRoom(room: string): void {
    if (!this.data.rooms[room]) return;
    delete this.data.rooms[room];
    this.save();
  }

  private salt(profile: string): string {
    let s = this.data.salts[profile];
    if (!s) { s = randomBytes(32).toString("hex"); this.data.salts[profile] = s; this.save(); }
    return s;
  }

  /** The placeholder a word gets under a profile. */
  refOf(profile: string, w: Pick<Word, "value" | "replace">): string { return w.replace ?? hashRef(this.salt(profile), w.value); }

  /** What a terminal of `profile`, sitting in `rooms`, has replaced: the global words, the found ones, its rooms'. */
  pairs(profile: string, rooms: readonly string[], more: readonly string[] = []): Pair[] {
    const out = new Map<string, Pair>();
    const put = (w: Pick<Word, "value" | "replace" | "restore">): void => { out.set(w.value, { value: w.value, ref: this.refOf(profile, w), restore: w.restore }); };
    // The password book's (passwords.ts): hashed, and put back.
    for (const value of more) put({ value, restore: true });
    for (const value of foundWords(this.data.settings, this.who)) put({ value, restore: true });
    for (const w of this.data.words) if (!w.regex) put(w);
    for (const r of rooms) for (const w of this.data.rooms[r] ?? []) if (!w.regex) put(w);
    return [...out.values()];
  }

  /** The regular expressions a terminal of `profile`, sitting in `rooms`, has replaced — each with the profile's salt
   *  (for the gateway to work out each match's placeholder) or the user's own placeholder. */
  patterns(profile: string, rooms: readonly string[]): PatternPair[] {
    const out = new Map<string, PatternPair>();
    for (const w of [...this.data.words, ...rooms.flatMap((r) => this.data.rooms[r] ?? [])]) {
      if (!w.regex) continue;
      out.set(w.value, w.replace ? { pattern: w.value, ref: w.replace, restore: false } : { pattern: w.value, salt: this.salt(profile), restore: w.restore });
    }
    return [...out.values()];
  }
}
