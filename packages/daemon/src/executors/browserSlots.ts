/** Browser session slots (threads-v0 §4b, 2026-09-24): three Chromium profiles under `$AGENTSWITCH_HOME/browser-profiles`
 *  that outlive a task, so a login carries over to the next task instead of being repeated. A browser run takes, among
 *  the slots not in use: the one its thread used last, else one that has been on a site the task names, else a free
 *  one, else the least recently used one — wiped first. With all three in use the run gets a throw-away profile as
 *  before. Deleting a thread wipes its slot. A lost or broken index wipes every slot rather than guess whose login a
 *  profile holds. The directory is read-denied to executors (protected.ts); Chromium's password manager and autofill
 *  are switched off in every slot so a value filled through the gate is never saved and shown again. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BROWSER_SLOTS = 3;
const MAX_HOSTS_PER_SLOT = 20;
const MAX_NAMED_HOSTS = 10;

export type SlotRecord = { readonly id: number; readonly threadId: string | null; readonly hosts: readonly string[]; readonly lastUsed: number };
export type SlotReason = "thread" | "site" | "free" | "evicted";
export type SlotLease = {
  readonly id: number;
  readonly dir: string;
  /** The profile may already be logged in somewhere (its thread's or a same-site slot). */
  readonly reused: boolean;
  readonly reason: SlotReason;
  /** Gives the slot back: records the sites and the time, closes any browser still holding the profile. */
  release(): void;
};

/** Stops browser processes still using `dir` (a Chromium outliving its MCP server would lock the profile). */
export type ProfileCloser = (dir: string) => void;

export class BrowserSlots {
  private records: SlotRecord[];
  private readonly busy = new Set<number>();
  private readonly wipeOnRelease = new Set<number>();

  constructor(private readonly root: string, private readonly count = BROWSER_SLOTS, private readonly now: () => number = Date.now,
              private readonly close: ProfileCloser = closeBrowsersOf) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.records = this.load();
  }

  list(): readonly SlotRecord[] { return this.records; }

  acquire(req: { readonly threadId: string | null; readonly hosts: readonly string[] }): SlotLease | null {
    const idle = this.records.filter((r) => !this.busy.has(r.id));
    const pick = (reason: SlotReason, r: SlotRecord | undefined) => (r ? { reason, record: r } : undefined);
    const chosen = pick("thread", req.threadId ? idle.find((r) => r.threadId === req.threadId) : undefined)
      ?? pick("site", idle.filter((r) => r.hosts.some((h) => req.hosts.includes(h))).sort((a, b) => b.lastUsed - a.lastUsed)[0])
      ?? pick("free", idle.find((r) => r.threadId === null && r.hosts.length === 0))
      ?? pick("evicted", [...idle].sort((a, b) => a.lastUsed - b.lastUsed)[0]);
    if (!chosen) return null;
    const { reason, record } = chosen;
    const dir = this.dir(record.id);
    if (reason === "evicted") this.wipe(record.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    disablePasswordManager(dir);
    this.busy.add(record.id);
    this.update(record.id, { threadId: req.threadId, hosts: reason === "evicted" || reason === "free" ? [] : record.hosts });
    let released = false;
    return {
      id: record.id, dir, reason, reused: reason === "thread" || reason === "site",
      release: () => {
        if (released) return;
        released = true;
        this.close(dir);
        this.busy.delete(record.id);
        if (this.wipeOnRelease.delete(record.id)) { this.reset(record.id); return; }
        const current = this.records.find((r) => r.id === record.id)!;
        const hosts = [...new Set([...current.hosts, ...req.hosts])].slice(-MAX_HOSTS_PER_SLOT);
        this.update(record.id, { hosts, lastUsed: this.now() });
      },
    };
  }

  /** The thread is deleted: its logins go with it (now, or when its running task gives the slot back). */
  forgetThread(threadId: string): void {
    for (const r of this.records.filter((x) => x.threadId === threadId)) {
      if (this.busy.has(r.id)) this.wipeOnRelease.add(r.id);
      else this.reset(r.id);
    }
  }

  private dir(id: number): string { return join(this.root, `slot-${id}`); }
  private indexPath(): string { return join(this.root, "slots.json"); }

  private reset(id: number): void {
    this.wipe(id);
    this.update(id, { threadId: null, hosts: [], lastUsed: 0 });
  }

  private wipe(id: number): void {
    this.close(this.dir(id));
    rmSync(this.dir(id), { recursive: true, force: true });
  }

  private update(id: number, change: Partial<Omit<SlotRecord, "id">>): void {
    this.records = this.records.map((r) => (r.id === id ? { ...r, ...change } : r));
    writeFileSync(this.indexPath(), JSON.stringify(this.records, null, 2), { mode: 0o600 });
  }

  private load(): SlotRecord[] {
    const fresh = Array.from({ length: this.count }, (_, i): SlotRecord => ({ id: i + 1, threadId: null, hosts: [], lastUsed: 0 }));
    let saved: unknown = null;
    try { saved = existsSync(this.indexPath()) ? JSON.parse(readFileSync(this.indexPath(), "utf8")) : null; } catch { saved = null; }
    const valid = Array.isArray(saved) && saved.length === this.count && saved.every((r, i) => isRecord(r) && r.id === i + 1);
    if (valid) return saved as SlotRecord[];
    // No trustworthy index: nobody can say whose login a profile holds.
    for (const r of fresh) rmSync(this.dir(r.id), { recursive: true, force: true });
    writeFileSync(this.indexPath(), JSON.stringify(fresh, null, 2), { mode: 0o600 });
    return fresh;
  }
}

function isRecord(r: unknown): r is SlotRecord {
  const x = r as SlotRecord;
  return typeof x === "object" && x !== null && typeof x.id === "number" && (x.threadId === null || typeof x.threadId === "string")
    && Array.isArray(x.hosts) && x.hosts.every((h) => typeof h === "string") && typeof x.lastUsed === "number";
}

/** Chromium reads these from the profile at start: no password saving or offering, no address or card autofill. */
export function disablePasswordManager(profileDir: string): void {
  const path = join(profileDir, "Default", "Preferences");
  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { prefs = {}; }
  const section = (key: string) => (typeof prefs[key] === "object" && prefs[key] !== null ? prefs[key] as Record<string, unknown> : {});
  const next = {
    ...prefs,
    credentials_enable_service: false,
    profile: { ...section("profile"), password_manager_enabled: false },
    autofill: { ...section("autofill"), profile_enabled: false, credit_card_enabled: false },
  };
  mkdirSync(join(profileDir, "Default"), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(next), { mode: 0o600 });
}

/** Browser processes started with this profile (their command line names it), stopped. Only this slot's own path is
 *  matched, so nothing else the user runs is touched. */
export function closeBrowsersOf(dir: string): void {
  const pattern = `--user-data-dir=${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`;
  spawnSync("pkill", ["-TERM", "-f", pattern], { timeout: 2000, stdio: "ignore" });
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(join(dir, lock), { force: true });
}

// File names models mention all the time; as a "top-level domain" they are never a site.
const NOT_A_TLD = new Set(["md", "ts", "js", "tsx", "jsx", "json", "txt", "csv", "pdf", "png", "jpg", "jpeg", "gif", "svg", "py", "swift", "html", "htm",
  "css", "yaml", "yml", "toml", "log", "sh", "zip", "gz", "tar", "xml", "sql", "db", "lock", "env", "pem", "key", "go", "rs", "rb", "java", "kt", "c", "h", "cpp"]);
const HOST = /(?:https?:\/\/|@|(?<![\w./@-]))((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?::\d{2,5})?(?![\w-])/gi;

/** Sites a task names: host names from URLs, e-mail domains and bare names like x.com; lower case, no "www.". */
export function namedHosts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(HOST)) {
    const host = m[1]!.toLowerCase().replace(/^www\./, "");
    const tld = host.slice(host.lastIndexOf(".") + 1);
    if (NOT_A_TLD.has(tld) || out.includes(host)) continue;
    out.push(host);
    if (out.length >= MAX_NAMED_HOSTS) break;
  }
  return out;
}
