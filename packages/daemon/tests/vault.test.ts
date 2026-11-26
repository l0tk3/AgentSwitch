/** The words the model never sees (vault/words.ts), their key (vault/key.ts), and the model traffic gateway as the
 *  service runs it (vault/modelGate.ts; user #318-#332). */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileKey, vaultKey } from "../src/vault/key.js";
import { ModelGate } from "../src/vault/modelGate.js";
import { foundWords, hashRef, RedactionError, RedactionStore, restorable, saltKey, DEFAULT_SETTINGS } from "../src/vault/words.js";

const home = () => mkdtempSync(join(tmpdir(), "as-vault-"));
const WHO = { user: "lkz", full: "Li Kaizhi", home: "/Users/lkz", host: "lkz-mbp.local" };

describe("the key", () => {
  it("comes from the app on stdin when it says so, else from a file of this account's alone", () => {
    const h = home();
    const env: NodeJS.ProcessEnv = { AGENTSWITCH_VAULT_STDIN: "1" };
    const k = vaultKey(h, env, () => "ab".repeat(32));
    expect(k).toEqual({ key: Buffer.from("ab".repeat(32), "hex"), where: "keychain" });
    expect(env.AGENTSWITCH_VAULT_STDIN).toBeUndefined();
    expect(fileKey(h)).toBeNull();
    const f = vaultKey(h, {});
    expect(f.where).toBe("file");
    expect(statSync(join(h, "vault", "key")).mode & 0o777).toBe(0o600);
    expect(vaultKey(h, {}).key.equals(f.key)).toBe(true);
    expect(fileKey(h)!.equals(f.key)).toBe(true);
  });
});

describe("the words", () => {
  it("are kept encrypted, the user's name found on its own, each profile's placeholders salted apart", () => {
    const h = home();
    const key = Buffer.alloc(32, 7);
    const s = new RedactionStore(h, [key], () => 1, WHO);
    expect(s.settings()).toEqual(DEFAULT_SETTINGS);
    s.add({ value: "AGSW-REAL-秘密" });
    const raw = readFileSync(join(h, "vault", "words.enc"));
    expect(raw.includes(Buffer.from("AGSW"))).toBe(false);
    expect(raw.includes(Buffer.from("lkz"))).toBe(false);
    const a = s.pairs("work", []), b = s.pairs("home", []);
    expect(a.map((p) => p.value)).toEqual(["lkz", "Li Kaizhi", "AGSW-REAL-秘密"]);
    expect(a.every((p) => /^h_[a-z2-7]{10}$/.test(p.ref) && p.restore)).toBe(true);
    expect(a[2]!.ref).not.toBe(b[2]!.ref);
    expect(new RedactionStore(h, [key], () => 1, WHO).pairs("work", [])).toEqual(a);   // the salt is kept
    expect(hashRef("00".repeat(32), "x")).toBe(hashRef("00".repeat(32), "x"));
  });

  it("checks a placeholder the user gives: a plain one goes one way only, a clash is refused", () => {
    const s = new RedactionStore(home(), [Buffer.alloc(32, 1)], () => 1, WHO);
    expect(restorable("A")).not.toBeNull();
    expect(restorable("PERSON_A")).toBeNull();
    expect(s.add({ value: "张三丰", replace: "A" })).toMatchObject({ word: { restore: false }, warning: expect.stringContaining("只替换，不还原") });
    expect(s.add({ value: "李四光", replace: "PERSON_B" })).toMatchObject({ word: { restore: true }, warning: null });
    expect(() => s.add({ value: "王五王", replace: "PERSON_B" })).toThrow(RedactionError);
    expect(() => s.add({ value: "ab" })).toThrow(/至少 3/);
    expect(s.add({ value: "张三丰", replace: "PERSON_C" }).word.restore).toBe(true);   // the same word again: replaced
    expect(s.words()).toHaveLength(2);
  });

  it("has a room's own words for the terminals sitting in it", () => {
    const s = new RedactionStore(home(), [Buffer.alloc(32, 2)], () => 1, WHO);
    s.setSettings({ username: false });
    const { word } = s.add({ value: "project-falcon" }, "r1");
    expect(s.pairs("p", []).map((p) => p.value)).toEqual([]);
    expect(s.pairs("p", ["r1"]).map((p) => p.value)).toEqual(["project-falcon"]);
    s.remove(word.id, "r1");
    expect(s.words("r1")).toEqual([]);
    expect(() => s.remove("nope")).toThrow(RedactionError);
    expect(foundWords({ ...DEFAULT_SETTINGS, host: true, username: false }, WHO)).toEqual(["lkz-mbp.local", "lkz-mbp"]);
  });

  it("moves a store kept under an older key to the new one, and keeps one it can not open aside", () => {
    const h = home();
    const old = Buffer.alloc(32, 3), now = Buffer.alloc(32, 4);
    new RedactionStore(h, [old], () => 1, WHO).add({ value: "secret-word" });
    expect(new RedactionStore(h, [now, old], () => 1, WHO).words().map((w) => w.value)).toEqual(["secret-word"]);
    expect(new RedactionStore(h, [now], () => 1, WHO).words().map((w) => w.value)).toEqual(["secret-word"]);
    expect(new RedactionStore(h, [Buffer.alloc(32, 9)], () => 5, WHO).words()).toEqual([]);
    expect(readdirSync(join(h, "vault")).some((f) => f.startsWith("words.enc.unreadable-5"))).toBe(true);
  });
});

/** A gateway that only reads its table (and makes its CA as mitmproxy would). */
function fakeGateway(tables: unknown[]) {
  return (_port: number, confdir: string): ChildProcess => {
    const stdin = new PassThrough();
    let buf = "";
    stdin.on("data", (d: Buffer) => { buf += d.toString(); for (;;) { const i = buf.indexOf("\n"); if (i < 0) break; tables.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    mkdirSync(confdir, { recursive: true });
    writeFileSync(join(confdir, "mitmproxy-ca-cert.pem"), "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n");
    const child = Object.assign(new EventEmitter(), { stdin, stderr: new PassThrough(), exitCode: null, kill: () => true });
    return child as unknown as ChildProcess;
  };
}

describe("the model gateway as the service runs it", () => {
  it("gives a terminal its proxy and trust, sends the table with its words, rooms and way out, and forgets it when it ends", async () => {
    const h = home();
    const store = new RedactionStore(h, [Buffer.alloc(32, 5)], () => 1, WHO);
    store.add({ value: "project-falcon" }, "r1");
    const tables: { logDir: string; scopes: Record<string, { hosts: string[]; upstream: string | null; pairs: { value: string }[]; log: boolean }> }[] = [];
    const rooms: Record<string, string[]> = { t1: ["r1"] };
    const gate = new ModelGate({ home: h, bin: "/bin/true", store, roomsOf: (t) => rooms[t] ?? [], start: fakeGateway(tables) });
    // The gateway really listening is not faked: a server on its port.
    const net = await import("node:net");
    const way = await (async () => {
      const opened = gate.open({ terminal: "t1", profile: "work", upstream: "http://u:p@127.0.0.1:9", baseUrl: "https://api.vendor.example/v1" });
      for (let i = 0; i < 50 && !tables.length; i++) await new Promise((r) => setTimeout(r, 5));
      const port = Number((gate as unknown as { port: number }).port);
      const srv = net.createServer().listen(port, "127.0.0.1");
      const w = await opened;
      srv.close();
      return w;
    })();
    expect(way).toMatchObject({ proxy: expect.stringMatching(/^http:\/\/s:t1@127\.0\.0\.1:\d+$/), ca: expect.stringContaining("mitmproxy-ca-cert.pem"), bundle: expect.stringContaining("trust.pem") });
    expect(readFileSync(way!.bundle, "utf8")).toContain("FAKE");
    const last = tables.at(-1)!;
    expect(last.scopes.t1!.upstream).toBe("http://u:p@127.0.0.1:9");
    expect(last.scopes.t1!.hosts).toEqual(expect.arrayContaining(["api.anthropic.com", "chatgpt.com", "api.vendor.example"]));
    expect(last.scopes.t1!.pairs.map((p) => p.value)).toEqual(["lkz", "Li Kaizhi", "project-falcon"]);
    rooms.t1 = [];
    gate.changed();
    expect(tables.at(-1)!.scopes.t1!.pairs.map((p) => p.value)).toEqual(["lkz", "Li Kaizhi"]);
    // Logs on: every terminal, or only those picked (user #595).
    store.setSettings({ log: true });
    gate.changed();
    expect(tables.at(-1)!.scopes.t1!.log).toBe(true);
    expect(store.setSettings({ logTerminals: ["t9", "bad id!", "t9"] }).logTerminals).toEqual(["t9"]);
    gate.changed();
    expect(tables.at(-1)!.scopes.t1!.log).toBe(false);
    store.setSettings({ logTerminals: ["t1"] });
    gate.changed();
    expect(tables.at(-1)!.scopes.t1!.log).toBe(true);
    store.setSettings({ log: false, logTerminals: [] });
    gate.close("t1");
    expect(tables.at(-1)!.scopes).toEqual({});
    // Kept for a terminal held across a restart: its scope and port.
    const again = new ModelGate({ home: h, bin: "/bin/true", store, roomsOf: () => [], start: fakeGateway([]) });
    expect((again as unknown as { scopes: Map<string, unknown> }).scopes.size).toBe(0);
    store.setSettings({ enabled: false });
    expect(await gate.open({ terminal: "t2", profile: "", upstream: null })).toBeNull();
    gate.stop();
  });

  it("lists its logs per terminal and day, and cleans them: all, or older than some days", () => {
    const h = home();
    const store = new RedactionStore(h, [Buffer.alloc(32, 6)], () => 1, WHO);
    const gate = new ModelGate({ home: h, bin: null, store, roomsOf: () => [] });
    expect(gate.enabled()).toBe(false);
    const d = join(gate.logDir, "t1");
    mkdirSync(d, { recursive: true });
    for (const f of ["2026-11-20.before.jsonl", "2026-11-20.after.jsonl", "2026-11-25.before.jsonl"]) writeFileSync(join(d, f), "x".repeat(10));
    expect(gate.logs()).toEqual([{ terminal: "t1", day: "2026-11-25", before: 10, after: 0 }, { terminal: "t1", day: "2026-11-20", before: 10, after: 10 }]);
    expect(gate.clean(3, Date.parse("2026-11-25T12:00:00Z"))).toBe(2);
    expect(gate.logs().map((l) => l.day)).toEqual(["2026-11-25"]);
    expect(gate.clean()).toBe(1);
    expect(existsSync(d)).toBe(false);
  });
});

describe("over HTTP (this Mac's screens only)", () => {
  it("shows and changes the settings and words, a room's too, and lists and cleans the logs", async () => {
    const { Hono } = await import("hono");
    const { mountRedaction } = await import("../src/api/redaction.js");
    const { remoteAllowed } = await import("../src/remote/routes.js");
    const h = home();
    const store = new RedactionStore(h, [Buffer.alloc(32, 8)], () => 1, WHO);
    const gate = new ModelGate({ home: h, bin: null, store, roomsOf: () => [] });
    const app = new Hono();
    mountRedaction(app, { redaction: { store, gate }, rooms: { get: (id: string) => { if (id !== "r1") throw Object.assign(new Error("no"), { status: 404 }); return {}; } } } as never);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    expect((await call("GET", "/redaction")).json).toMatchObject({ settings: { enabled: true, username: true }, words: [], gateway: false });
    expect((await call("PATCH", "/redaction/settings", { log: false, keepDays: 7, hosts: ["api.vendor.example", "bad host"] })).json.settings).toMatchObject({ log: false, keepDays: 7, hosts: ["api.vendor.example"] });
    expect((await call("PATCH", "/redaction/settings", { nope: 1 })).status).toBe(400);
    const added = await call("POST", "/redaction/words", { value: "张三丰", replace: "A" });
    expect(added).toMatchObject({ status: 201, json: { word: { value: "张三丰", replace: "A", restore: false }, warning: expect.any(String) } });
    expect((await call("POST", "/redaction/words", { value: "ab" })).status).toBe(400);
    expect((await call("DELETE", `/redaction/words/${added.json.word.id}`)).status).toBe(200);
    expect((await call("DELETE", "/redaction/words/zzz")).status).toBe(404);
    expect((await call("POST", "/rooms/r1/redaction/words", { value: "project-falcon" })).status).toBe(201);
    expect((await call("POST", "/rooms/r9/redaction/words", { value: "project-falcon" })).status).toBe(404);
    expect((await call("GET", "/rooms/r1/redaction/words")).json.words.map((w: { value: string }) => w.value)).toEqual(["project-falcon"]);
    await call("PATCH", "/redaction/settings", { enabled: false });
    expect((await call("POST", "/rooms/r1/redaction/words", { value: "another-word" })).status).toBe(409);
    expect((await call("POST", "/redaction/words", { value: "another-word" })).status).toBe(409);
    await call("PATCH", "/redaction/settings", { enabled: true });
    expect((await call("GET", "/redaction/logs")).json).toEqual({ dir: gate.logDir, logs: [] });
    expect((await call("DELETE", "/redaction/logs?days=x")).status).toBe(400);
    expect((await call("DELETE", "/redaction/logs?days=3")).json).toEqual({ removed: 0 });
    for (const p of ["/redaction", "/redaction/words", "/redaction/logs"]) expect(remoteAllowed("GET", p)).toBe(false);
  });

  it("gives a profile another salt when another account signs in under it, and the old one back with the old account (user #421)", () => {
    const s = new RedactionStore(mkdtempSync(join(tmpdir(), "as-salt-")), [Buffer.alloc(32, 5)], () => 1, { user: "lkz" });
    const ref = (key: string) => s.pairs(key, []).find((p) => p.value === "lkz")!.ref;
    const a = saltKey("claude-code", "", "A@example.com"), b = saltKey("claude-code", "", "b@example.com");
    expect(a).toBe(saltKey("claude-code", "", " a@example.com"));
    expect(a).not.toContain("example");
    expect(ref(a)).not.toBe(ref(b));
    expect(ref(a)).toBe(ref(a));
    // Another agent's profile of the same name, and nobody signed in, are their own too.
    expect(new Set([ref(a), ref(b), ref(saltKey("codex", "", "a@example.com")), ref(saltKey("claude-code", "", null))]).size).toBe(4);
  });
});
