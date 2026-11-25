/** The password book (vault/passwords.ts, api/passwords.ts; user #345-#351). */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountPasswords } from "../src/api/passwords.js";
import { remoteAllowed } from "../src/remote/routes.js";
import { generatePassword, parseCsv, PasswordBook, PasswordError, siteOf, totpNow } from "../src/vault/passwords.js";
import { RedactionStore } from "../src/vault/words.js";

const home = () => mkdtempSync(join(tmpdir(), "as-pw-"));
const KEY = Buffer.alloc(32, 3);

describe("the book", () => {
  it("keeps entries encrypted, lists them without their secrets, and reveals one", () => {
    const h = home();
    const b = new PasswordBook(h, [KEY], () => 1_700_000_000_000);
    const e = b.add({ name: "GitHub 工作", sites: ["https://github.com/login", "github.com", "bad host"], account: "lkz", password: "Hunter2-very-secret", totp: "JBSWY3DPEHPK3PXP", note: "恢复码 1234" });
    expect(e).toMatchObject({ name: "GitHub 工作", sites: ["github.com"], account: "lkz", hasTotp: true, hasNote: true, length: 19 });
    expect(JSON.stringify(b.list())).not.toContain("Hunter2");
    const raw = readFileSync(join(h, "vault", "passwords.enc"));
    expect(raw.includes(Buffer.from("Hunter2"))).toBe(false);
    expect(raw.includes(Buffer.from("github"))).toBe(false);
    expect(b.reveal(e.id)).toMatchObject({ password: "Hunter2-very-secret", note: "恢复码 1234", totp: { code: expect.stringMatching(/^\d{6}$/) } });
    expect(new PasswordBook(h, [KEY]).list().map((x) => x.name)).toEqual(["GitHub 工作"]);
    expect(b.update(e.id, { password: "new-one-5678" }).length).toBe(12);
    expect(b.words()).toEqual(["new-one-5678"]);
    expect(() => b.add({ name: "x", password: "" })).toThrow(PasswordError);
    expect(() => b.add({ name: "x", password: "abcd", totp: "not base32!" })).toThrow(/base32/);
    b.remove(e.id);
    expect(b.list()).toEqual([]);
    expect(() => b.reveal(e.id)).toThrow(PasswordError);
  });

  it("gives RFC 6238 codes, makes strong passwords, reads sites", () => {
    // RFC 6238's SHA-1 test seed ("12345678901234567890") at 59 s: 94287082 → its last six digits.
    expect(totpNow("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).toEqual({ code: "287082", left: 1 });
    const p = generatePassword(24);
    expect(p).toHaveLength(24);
    expect(/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p)).toBe(true);
    expect(/[^A-Za-z0-9]/.test(generatePassword(16, false))).toBe(false);
    expect(siteOf("HTTPS://Mail.Example.com/inbox")).toBe("mail.example.com");
    expect(siteOf("")).toBeNull();
  });

  it("imports the CSV exports of browsers and password managers, an entry again replacing itself", () => {
    const chrome = 'name,url,username,password,note\n"Git, Hub",https://github.com/login,lkz,"p""w1",\nempty,https://x.com,u,,\n';
    expect(parseCsv(chrome)).toEqual({ entries: [{ name: "Git, Hub", sites: ["github.com"], account: "lkz", password: 'p"w1' }], skipped: 1 });
    const bitwarden = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Mail,n1,,,https://mail.example.com,me@x,pw2,otpauth://totp/x?secret=JBSWY3DPEHPK3PXP\n";
    expect(parseCsv(bitwarden).entries[0]).toEqual({ name: "Mail", sites: ["mail.example.com"], account: "me@x", password: "pw2", totp: "JBSWY3DPEHPK3PXP", note: "n1" });
    expect(() => parseCsv("a,b\n1,2\n")).toThrow(/password/);
    const b = new PasswordBook(home(), [KEY]);
    expect(b.addMany(parseCsv(chrome).entries)).toEqual({ added: 1, replaced: 0 });
    expect(b.addMany(parseCsv(chrome).entries)).toEqual({ added: 0, replaced: 1 });
  });

  it("keeps a room's own book apart from the book of everything, and drops it with the room (user #416)", () => {
    const h = home();
    const b = new PasswordBook(h, [KEY]);
    b.add({ name: "everywhere", password: "global-pass-1" });
    const mine = b.add({ name: "staging", password: "room-pass-22" }, "r1");
    expect(b.list().map((e) => e.name)).toEqual(["everywhere"]);
    expect(b.list("r1").map((e) => e.name)).toEqual(["staging"]);
    expect(b.list("r2")).toEqual([]);
    // Changed, it stays in its room's book; read again from the file too.
    expect(b.update(mine.id, { account: "ops" })).toMatchObject({ room: "r1", account: "ops" });
    expect(new PasswordBook(h, [KEY]).list("r1").map((e) => e.name)).toEqual(["staging"]);
    // An import into a room replaces that room's entries only.
    expect(b.addMany([{ name: "everywhere", password: "other-pass-3" }], "r1")).toEqual({ added: 1, replaced: 0 });
    expect(b.list()).toHaveLength(1);
    // The model sees none of them, whichever book.
    expect(b.words().sort()).toEqual(["global-pass-1", "other-pass-3", "room-pass-22"]);
    b.dropRoom("r1");
    expect(b.list("r1")).toEqual([]);
    expect(b.words()).toEqual(["global-pass-1"]);
  });

  it("is what the model never sees: its passwords are the gateway's words too", () => {
    const h = home();
    const words = new RedactionStore(h, [KEY], () => 1, { user: "lkz" });
    const b = new PasswordBook(h, [KEY]);
    b.add({ name: "a", password: "longpassword1" });
    b.add({ name: "b", password: "abc" });
    expect(words.pairs("p", [], b.words()).map((p) => p.value)).toEqual(["longpassword1", "lkz"]);
  });
});

describe("over HTTP (this Mac's screens only)", () => {
  it("lists, adds, changes, reveals, imports, removes; generates", async () => {
    const app = new Hono();
    const book = new PasswordBook(home(), [KEY]);
    let changed = 0;
    mountPasswords(app, { passwords: book, redaction: { gate: { changed: () => { changed += 1; } } } } as never);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    const made = await call("POST", "/passwords", { name: "GitHub", sites: ["github.com"], account: "lkz", password: "s3cret-pass" });
    expect(made.status).toBe(201);
    expect(JSON.stringify((await call("GET", "/passwords")).json)).not.toContain("s3cret");
    expect((await call("POST", `/passwords/${made.json.entry.id}/reveal`)).json).toEqual({ password: "s3cret-pass" });
    expect((await call("PATCH", `/passwords/${made.json.entry.id}`, { account: "other" })).json.entry.account).toBe("other");
    expect((await call("POST", "/passwords", { name: "x" })).status).toBe(400);
    expect((await call("POST", "/passwords/import", { csv: "name,url,username,password\nMail,mail.example.com,me,pw-mail\n" })).json).toEqual({ added: 1, replaced: 0, skipped: 0 });
    expect((await call("GET", "/passwords/generate?length=12")).json.password).toHaveLength(12);
    expect((await call("DELETE", `/passwords/${made.json.entry.id}`)).status).toBe(200);
    expect((await call("DELETE", "/passwords/nope")).status).toBe(404);
    expect(changed).toBe(4);
    // A room's own book, by `?room=`.
    expect((await call("POST", "/passwords?room=r1", { name: "Staging", password: "room-only-pw" })).json.entry.room).toBe("r1");
    expect((await call("GET", "/passwords?room=r1")).json.entries.map((e: any) => e.name)).toEqual(["Staging"]);
    expect((await call("GET", "/passwords")).json.entries.map((e: any) => e.name)).toEqual(["Mail"]);
    // Another node's book is seen from a paired Mac (user #356).
    expect(remoteAllowed("GET", "/passwords")).toBe(true);
    expect(remoteAllowed("POST", "/passwords/x/reveal")).toBe(true);
  });
});
