/** The model traffic gateway as the service runs it (2026-11-25, user #320-#332): one `secret-gate model-proxy` for
 *  all terminals, each terminal a scope of its own. What a terminal needs to go through it — the proxy address with
 *  its scope, and the gateway's CA added to the ones it trusts — is given at its start (terminals/launch.ts);
 *  nothing of the user's own configuration changes. The table (which words, which hosts, which way out) goes to the
 *  gateway on its stdin, the whole of it each time something changes; it is never written to disk.
 *
 *  Logs: `vault/model-gate/logs/<terminal>/<day>.{before,after}.jsonl` — before: what the agent sent and got (the
 *  words in them); after: what the model's provider got and sent. A folder no terminal's agent may read. */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { VAULT_DIR } from "./key.js";
import type { Pair, RedactionStore } from "./words.js";

/** The models' own addresses, whatever profile a terminal runs under; a profile's own address is added to its scope. */
export const MODEL_HOSTS: readonly string[] = [
  "api.anthropic.com", "api.openai.com", "chatgpt.com", "*.openai.com", "api.deepseek.com", "openrouter.ai",
  "generativelanguage.googleapis.com", "api.moonshot.cn", "api.moonshot.ai", "api.x.ai", "api.groq.com", "api.mistral.ai",
  "open.bigmodel.cn", "dashscope.aliyuncs.com", "api.minimax.chat", "api.siliconflow.cn", "ark.cn-beijing.volces.com",
  "opencode.ai", "api.z.ai",
  // Grok Build (1.0.92): its chat goes to its own proxy of the API.
  "cli-chat-proxy.grok.com",
  // Antigravity CLI (1.5.17): Google's Cloud Code calls for Gemini (docs/terminal-v0.md §3 Antigravity).
  "cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com", "*.cloudcode-pa.googleapis.com",
];

export type GateScope = { readonly terminal: string; readonly profile: string; readonly upstream: string | null; readonly baseUrl?: string };
/** What a terminal is started with to go through the gateway. */
export type GateWay = { readonly proxy: string; readonly ca: string; readonly bundle: string };

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer();
  s.unref();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => resolve(typeof a === "object" && a ? a.port : 0)); });
});

const portFree = (port: number): Promise<boolean> => new Promise((resolve) => {
  const s = createServer();
  s.unref();
  s.on("error", () => resolve(false));
  s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
});

const hostOf = (url: string | undefined): string | null => { try { return url ? new URL(url).hostname.toLowerCase() : null; } catch { return null; } };

export class ModelGate {
  private child: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<boolean> | null = null;
  private readonly scopes = new Map<string, GateScope>();
  private readonly dir: string;
  readonly logDir: string;

  constructor(private readonly o: {
    readonly home: string;
    /** The secret-gate program; null: none on this machine (no gateway, terminals start as before). */
    readonly bin: string | null;
    readonly store: RedactionStore;
    /** The rooms a terminal sits in now (their words are its too). */
    readonly roomsOf: (terminal: string) => readonly string[];
    /** More values the model never sees: the password book's (passwords.ts). */
    readonly more?: () => readonly string[];
    readonly log?: (line: string) => void;
    /** Tests: how a gateway is started. */
    readonly start?: (port: number, confdir: string) => ChildProcess;
  }) {
    this.dir = join(o.home, VAULT_DIR, "model-gate");
    this.logDir = join(this.dir, "logs");
    mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    // A terminal kept across a restart of the service (held) still goes to the same port, under the same scope.
    try {
      const kept = JSON.parse(readFileSync(join(this.dir, "scopes.json"), "utf8")) as { port?: number; scopes?: GateScope[] };
      if (typeof kept.port === "number") this.port = kept.port;
      for (const sc of kept.scopes ?? []) if (sc && typeof sc.terminal === "string") this.scopes.set(sc.terminal, sc);
    } catch { /* none yet */ }
    this.prune();
    this.pruner = setInterval(() => this.prune(), 6 * 3_600_000);
    this.pruner.unref();
  }

  /** The terminals there are now: the others' scopes go. Started again for the ones that are left. */
  keepOnly(terminals: ReadonlySet<string>): void {
    let gone = false;
    for (const id of [...this.scopes.keys()]) if (!terminals.has(id)) { this.scopes.delete(id); gone = true; }
    if (gone) this.persist();
    if (this.scopes.size && this.enabled()) void this.ensure();
  }

  private persist(): void {
    try { writeFileSync(join(this.dir, "scopes.json"), JSON.stringify({ port: this.port, scopes: [...this.scopes.values()] }), { mode: 0o600 }); } catch { /* next time */ }
  }

  private pruner: NodeJS.Timeout | null = null;

  /** Logs older than the days kept go, now and every six hours. */
  prune(now = Date.now()): number {
    const days = this.o.store.settings().keepDays;
    return days > 0 ? this.clean(days, now) : 0;
  }

  /** Whether terminals started now go through it. */
  enabled(): boolean { return this.o.store.settings().enabled && this.o.bin !== null; }

  private get ca(): string { return join(this.dir, "mitmproxy-ca-cert.pem"); }
  private get bundle(): string { return join(this.dir, "trust.pem"); }

  /** Started once, the first time a terminal needs it; again after it ended. */
  private ensure(): Promise<boolean> {
    if (this.child && this.child.exitCode === null) return Promise.resolve(true);
    this.starting ??= this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async launch(): Promise<boolean> {
    if (!this.o.bin) return false;
    if (!this.port || !(await portFree(this.port))) this.port = await freePort();
    const child = this.o.start?.(this.port, this.dir) ?? spawn(this.o.bin, ["model-proxy", "--port", String(this.port), "--confdir", this.dir], {
      stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    this.child = child;
    child.stderr?.on("data", (d: Buffer) => this.o.log?.(`model gate: ${d.toString().trim().slice(0, 300)}`));
    child.on("exit", (code) => { if (this.child === child) { this.child = null; this.o.log?.(`model gate: ended (${code})`); } });
    child.stdin?.on("error", () => undefined);
    this.send();
    // Up once it listens and its CA is there (mitmproxy makes it on its first start).
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) return false;
      if (existsSync(this.ca) && await this.listening()) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!existsSync(this.ca)) return false;
    // What a terminal trusts: the usual roots, and the gateway's own (only the models' connections are its).
    writeFileSync(this.bundle, [...rootCertificates, readFileSync(this.ca, "utf8")].join("\n"), { mode: 0o644 });
    return true;
  }

  private listening(): Promise<boolean> {
    return new Promise((resolve) => {
      const s = connect(this.port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(true); });
      s.on("error", () => resolve(false));
    });
  }

  /** A terminal about to start: its scope, and what it is started with; null: it starts as before. */
  async open(scope: GateScope): Promise<GateWay | null> {
    if (!this.enabled()) return null;
    if (!(await this.ensure())) return null;
    this.scopes.set(scope.terminal, scope);
    this.persist();
    this.send();
    return { proxy: `http://s:${scope.terminal}@127.0.0.1:${this.port}`, ca: this.ca, bundle: this.bundle };
  }

  close(terminal: string): void {
    if (this.scopes.delete(terminal)) { this.persist(); this.send(); }
  }

  /** Words, settings or a terminal's rooms changed. */
  changed(): void { if (this.child) this.send(); }

  /** What a terminal has replaced now (for its card, and the tests). */
  pairsOf(terminal: string): Pair[] {
    const s = this.scopes.get(terminal);
    return s ? this.o.store.pairs(s.profile, this.o.roomsOf(terminal), this.o.more?.() ?? []) : [];
  }

  private send(): void {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) return;
    const settings = this.o.store.settings();
    const scopes: Record<string, unknown> = {};
    const more = this.o.more?.() ?? [];
    for (const [id, s] of this.scopes) {
      const own = hostOf(s.baseUrl);
      scopes[id] = {
        hosts: [...new Set([...MODEL_HOSTS, ...settings.hosts, ...(own && own !== "127.0.0.1" && own !== "localhost" ? [own] : [])])],
        upstream: s.upstream,
        pairs: this.o.store.pairs(s.profile, this.o.roomsOf(id), more),
        log: settings.log,
      };
    }
    child.stdin.write(`${JSON.stringify({ logDir: this.logDir, scopes })}\n`);
  }

  /** The logs, newest first: per terminal and day, each side's size. */
  logs(): { terminal: string; day: string; before: number; after: number }[] {
    const out: { terminal: string; day: string; before: number; after: number }[] = [];
    for (const t of safeList(this.logDir)) {
      const days = new Map<string, { before: number; after: number }>();
      for (const f of safeList(join(this.logDir, t))) {
        const m = /^(\d{4}-\d{2}-\d{2})\.(before|after)\.jsonl$/.exec(f);
        if (!m) continue;
        const d = days.get(m[1]!) ?? { before: 0, after: 0 };
        try { d[m[2] as "before" | "after"] = statSync(join(this.logDir, t, f)).size; } catch { /* gone */ }
        days.set(m[1]!, d);
      }
      for (const [day, d] of days) out.push({ terminal: t, day, ...d });
    }
    return out.sort((a, b) => b.day.localeCompare(a.day) || a.terminal.localeCompare(b.terminal));
  }

  /** Logs removed: all of them, or those older than `days` days. How many files went. */
  clean(days?: number, now = Date.now()): number {
    const cut = days === undefined ? null : new Date(now - days * 86_400_000).toISOString().slice(0, 10);
    let n = 0;
    for (const t of safeList(this.logDir)) {
      const dir = join(this.logDir, t);
      for (const f of safeList(dir)) {
        const day = f.slice(0, 10);
        if (cut === null || day < cut) { rmSync(join(dir, f), { force: true }); n += 1; }
      }
      if (!safeList(dir).length) rmSync(dir, { recursive: true, force: true });
    }
    return n;
  }

  stop(): void {
    if (this.pruner) clearInterval(this.pruner);
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) { c.stdin?.end(); c.kill("SIGTERM"); }
  }
}

function safeList(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
