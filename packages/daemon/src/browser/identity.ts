/** The browser's identity (docs/browser-v0.md §7.2 第 5 条), kept beside the profile it belongs to:
 *
 *  - the fingerprint Camoufox is started with. Made once and kept: a profile whose fingerprint changed at every start
 *    would itself be a tell. It is this machine as Firefox would show it — the system, the screen, the window and the
 *    fonts are the real ones (a window with a made-up size could not be sized by its person) — with nothing of Camoufox
 *    in what a page reads and a few values of its own. Changed only when asked: a new one, or one brought from
 *    elsewhere (any of Camoufox's properties); the browser then starts again.
 *  - the proxy the browser's traffic leaves through (the forwarder's upstream): changed while the browser runs. Its
 *    password is a ciphertext for the proxy's own host; the gate turns it into the value when the proxy is set and when
 *    the service starts. The value is held in memory for the forwarder and nowhere else. A proxy that is set but whose
 *    password could not be had lets nothing out — not straight either.
 *  - where that proxy lets traffic out (exit.ts): its address and place, for the person, and its time zone, which the
 *    browser is started in unless the fingerprint names one — a clock that disagrees with the address is a tell. The
 *    zone is given as the browser starts, so after a change of proxy it waits for the next start (`restartNeeded`). */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExitInfo, ExitProbe } from "./exit.js";
import { CIPHERTEXT, type FillResolver } from "./fill.js";

export type FingerprintConfig = Readonly<Record<string, unknown>>;
export type ProxySetting = { readonly server: string; readonly username?: string | undefined; readonly password?: string | undefined };
type Stored = {
  readonly fingerprint: { readonly config: FingerprintConfig; readonly since: number; readonly source: "generated" | "imported"; readonly firefox?: string };
  readonly proxy: ProxySetting | null;
  /** The proxy's exit as last looked up: kept so the next service starts its browser in that zone at once. */
  readonly exit?: (ExitInfo & { readonly checkedAt: number }) | null;
};

export type FingerprintSummary = {
  readonly system: string; readonly browser: string; readonly cores: number | null; readonly language: string | null;
  /** The zone the browser is started in, and whose it is; null with `system`: this machine's own. */
  readonly timezone: string | null; readonly timezoneFrom: "fingerprint" | "exit" | "system";
};
export type ExitView = (ExitInfo & { readonly checkedAt: number }) | { readonly problem: string } | null;
export type IdentityView = {
  readonly fingerprint: { readonly summary: FingerprintSummary; readonly since: number; readonly source: "generated" | "imported"; readonly config: FingerprintConfig };
  /** `sealed`: it has a password (a ciphertext; never shown). */
  readonly proxy: { readonly server: string; readonly username?: string; readonly sealed: boolean } | null;
  /** Where the proxy lets traffic out; null without a proxy or before the first answer. */
  readonly exit: ExitView;
  /** The running browser was started with another configuration than it would be given now. */
  readonly restartNeeded: boolean;
};

/** A proxy's `server`: `scheme://host:port` and nothing else. */
const PROXY = /^(http|https|socks4|socks5):\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/;
const MAX_CONFIG_CHARS = 256 * 1024;
const CORES = [4, 8, 8, 10, 12];

const SYSTEMS: Readonly<Record<string, { readonly ua: string; readonly oscpu: string; readonly platform: string; readonly appVersion: string }>> = {
  darwin: { ua: "Macintosh; Intel Mac OS X 10.15", oscpu: "Intel Mac OS X 10.15", platform: "MacIntel", appVersion: "5.0 (Macintosh)" },
  linux: { ua: "X11; Linux x86_64", oscpu: "Linux x86_64", platform: "Linux x86_64", appVersion: "5.0 (X11)" },
  win32: { ua: "Windows NT 10.0; Win64; x64", oscpu: "Windows NT 10.0; Win64; x64", platform: "Win32", appVersion: "5.0 (Windows)" },
};

const userAgent = (system: string, firefox: string): string => `Mozilla/5.0 (${system}; rv:${firefox}.0) Gecko/20100101 Firefox/${firefox}.0`;

export function generateFingerprint(opts: { readonly firefox: string; readonly platform?: string; readonly random?: () => number }): Record<string, unknown> {
  const system = SYSTEMS[opts.platform ?? process.platform] ?? SYSTEMS.linux!;
  const random = opts.random ?? Math.random;
  const pick = <T>(items: readonly T[]): T => items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
  const ua = userAgent(system.ua, opts.firefox);
  return {
    "navigator.userAgent": ua,
    "headers.User-Agent": ua,
    "navigator.appVersion": system.appVersion,
    "navigator.oscpu": system.oscpu,
    "navigator.platform": system.platform,
    "navigator.hardwareConcurrency": pick(CORES),
    "audio:seed": 1 + Math.floor(random() * 4_294_967_294),
    "AudioContext:sampleRate": pick([44_100, 48_000]),
    "mediaDevices:enabled": true,
    "mediaDevices:micros": 1,
    "mediaDevices:webcams": 1,
    "mediaDevices:speakers": pick([1, 2]),
  };
}

export function summarize(config: FingerprintConfig, exitZone: string | null = null): FingerprintSummary {
  const ua = typeof config["navigator.userAgent"] === "string" ? config["navigator.userAgent"] : "";
  const system = /Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux|X11/.test(ua) ? "Linux" : "—";
  const firefox = /Firefox\/(\d+)/.exec(ua)?.[1];
  const text = (key: string): string | null => typeof config[key] === "string" && config[key] ? config[key] as string : null;
  const cores = config["navigator.hardwareConcurrency"];
  const own = text("timezone");
  return { system, browser: firefox ? `Firefox ${firefox}` : "—", cores: typeof cores === "number" ? cores : null, language: text("navigator.language"),
    timezone: own ?? exitZone, timezoneFrom: own ? "fingerprint" : exitZone ? "exit" : "system" };
}

export function proxyPlace(server: string): { readonly scheme: string; readonly host: string; readonly port: number } | null {
  const m = PROXY.exec(server.trim());
  if (!m) return null;
  const port = Number(m[3]);
  return port > 0 && port < 65_536 ? { scheme: m[1]!, host: m[2]!, port } : null;
}

export type BrowserIdentityOptions = {
  /** `$AGENTSWITCH_HOME/browser/identity.json`. */
  readonly file: string;
  /** The Firefox the installed Camoufox is (`156`): the browser a page is told about is the one that runs. */
  readonly firefox: () => string | null;
  /** The gate's answer for a ciphertext and the pages it goes to (fill.ts); absent without the gate. */
  readonly resolve?: FillResolver | undefined;
  /** Where the proxy in force lets traffic out (exit.ts); absent: not looked up. */
  readonly probe?: ExitProbe | undefined;
  /** The time zone where this browser's traffic comes out, when its proxy is not this identity's own to keep — a
   *  profile's browser, whose proxy is the profile's (docs/profiles-v0.md §5.1). Asked at every launch. */
  readonly zone?: (() => string | null) | undefined;
  readonly platform?: string;
  readonly now?: () => number;
  readonly random?: () => number;
};

export class BrowserIdentity {
  private stored: Stored | null = null;
  /** The proxy with its password's value, for the forwarder; undefined: set but not to be had yet. */
  private upstreamUrl: string | null | undefined = null;
  private exitProblem: string | null = null;
  /** What the running browser was started with. */
  private inForce: string | null = null;

  constructor(private readonly opts: BrowserIdentityOptions) {
    this.upstreamUrl = this.read().proxy ? (this.read().proxy!.password ? undefined : this.read().proxy!.server) : null;
  }

  private read(): Stored {
    if (this.stored) return this.stored;
    try {
      const raw = JSON.parse(readFileSync(this.opts.file, "utf8")) as Partial<Stored>;
      if (raw.fingerprint && typeof raw.fingerprint.config === "object" && raw.fingerprint.config) {
        const proxy = raw.proxy && proxyPlace(raw.proxy.server ?? "") ? raw.proxy : null;
        this.stored = { fingerprint: raw.fingerprint as Stored["fingerprint"], proxy, exit: proxy && raw.exit && typeof raw.exit.ip === "string" ? raw.exit : null };
        return this.stored;
      }
    } catch { /* none yet, or unreadable: a new one */ }
    return this.write({ fingerprint: this.generated(), proxy: null });
  }

  private write(next: Stored): Stored {
    mkdirSync(dirname(this.opts.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.opts.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    this.stored = next;
    return next;
  }

  private firefox(): string {
    return this.opts.firefox() ?? "156";
  }

  private generated(): Stored["fingerprint"] {
    const firefox = this.firefox();
    return { config: generateFingerprint({ firefox, ...(this.opts.platform ? { platform: this.opts.platform } : {}), ...(this.opts.random ? { random: this.opts.random } : {}) }),
      since: (this.opts.now ?? Date.now)(), source: "generated", firefox };
  }

  /** What Camoufox would be started with now: the fingerprint, in the proxy's exit's time zone unless it names one. */
  config(): FingerprintConfig {
    const fingerprint = this.fingerprint();
    const zone = this.exitZone();
    return zone && typeof fingerprint.timezone !== "string" ? { ...fingerprint, timezone: zone } : fingerprint;
  }

  /** `config()`, for a browser that is being started: remembered, to tell later whether it still holds. */
  launchConfig(): FingerprintConfig {
    const config = this.config();
    this.inForce = JSON.stringify(config);
    return config;
  }

  private exitZone(): string | null {
    if (this.opts.zone) return this.opts.zone();
    const { proxy, exit } = this.read();
    return proxy && exit ? exit.timezone : null;
  }

  /** A fingerprint made here keeps up with the Firefox that runs: after an engine update to another Firefox the
   *  browser's name moves on and the rest stays. */
  private fingerprint(): FingerprintConfig {
    const { fingerprint } = this.read();
    const firefox = this.firefox();
    if (fingerprint.source !== "generated" || fingerprint.firefox === firefox) return fingerprint.config;
    const system = /\(([^)]*); rv:/.exec(String(fingerprint.config["navigator.userAgent"] ?? ""))?.[1];
    if (!system) return fingerprint.config;
    const ua = userAgent(system, firefox);
    return this.write({ ...this.read(), fingerprint: { ...fingerprint, firefox, config: { ...fingerprint.config, "navigator.userAgent": ua, "headers.User-Agent": ua } } }).fingerprint.config;
  }

  view(browser: { readonly running: boolean } = { running: false }): IdentityView {
    const config = this.fingerprint();
    const { fingerprint, proxy, exit } = this.read();
    return {
      fingerprint: { summary: summarize(config, this.exitZone()), since: fingerprint.since, source: fingerprint.source, config },
      proxy: proxy ? { server: proxy.server, ...(proxy.username ? { username: proxy.username } : {}), sealed: Boolean(proxy.password) } : null,
      exit: !proxy ? null : exit ?? (this.exitProblem ? { problem: this.exitProblem } : null),
      restartNeeded: browser.running && this.inForce !== null && this.inForce !== JSON.stringify(this.config()),
    };
  }

  /** Another fingerprint: a new one made here, or one brought from elsewhere. In force when the browser next starts. */
  async setFingerprint(next: "new" | { readonly config: FingerprintConfig }): Promise<void> {
    if (next === "new") { this.write({ ...this.read(), fingerprint: this.generated() }); return; }
    const config = next.config;
    if (typeof config !== "object" || config === null || Array.isArray(config)) throw new IdentityError("指纹须是一组 Camoufox 的属性。");
    if (JSON.stringify(config).length > MAX_CONFIG_CHARS) throw new IdentityError("指纹过大。");
    this.write({ ...this.read(), fingerprint: { config, since: (this.opts.now ?? Date.now)(), source: "imported" } });
  }

  /** The proxy from now on (null: none). A password must be a ciphertext the gate gives for the proxy's host; it is
   *  asked for now, so a wrong one is refused here and nothing changes. A password needs a user name. */
  async setProxy(proxy: ProxySetting | null, opts: { readonly keepPassword?: boolean | undefined } = {}): Promise<void> {
    if (!proxy) { this.write({ ...this.read(), proxy: null, exit: null }); this.upstreamUrl = null; this.exitProblem = null; return; }
    const server = proxy.server.trim();
    if (!proxyPlace(server)) throw new IdentityError("代理地址须写作 scheme://host:port（http、https、socks4、socks5）。");
    const username = proxy.username?.trim() || undefined;
    // `keepPassword`: the person changed something else; the ciphertext stored stays (it is never sent back to them).
    const password = proxy.password?.trim() || (opts.keepPassword ? this.read().proxy?.password : undefined) || undefined;
    if (password && !CIPHERTEXT.test(password)) throw new IdentityError("代理密码请以密文（enc:v1:）提供。");
    if (password && !username) throw new IdentityError("带密码的代理需要用户名。");
    const setting: ProxySetting = { server, ...(username ? { username } : {}), ...(password ? { password } : {}) };
    const upstream = await this.withPassword(setting);
    this.write({ ...this.read(), proxy: setting, exit: null });
    this.upstreamUrl = upstream;
    await this.lookUpExit();
  }

  /** Asks where the proxy in force lets traffic out. A failure leaves the proxy as it is and is said in the view. */
  private async lookUpExit(): Promise<void> {
    const asked = this.read().proxy;
    if (!asked || !this.opts.probe) return;
    let found: ExitInfo | null = null;
    try { found = await this.opts.probe(); } catch { /* said below */ }
    // Another proxy was set meanwhile: this answer is about the old one.
    if (this.read().proxy !== asked) return;
    this.exitProblem = found ? null : "未能查到出口地址。";
    if (found) this.write({ ...this.read(), exit: { ...found, checkedAt: (this.opts.now ?? Date.now)() } });
  }

  private async withPassword(proxy: ProxySetting): Promise<string> {
    const place = proxyPlace(proxy.server)!;
    if (!proxy.username && !proxy.password) return proxy.server;
    let secret = "";
    if (proxy.password) {
      if (!this.opts.resolve) throw new IdentityError("凭据网关不可用，无法使用带密码的代理。");
      // The gate checks the ciphertext against the proxy's own host, as it would a page's.
      secret = (await this.opts.resolve(proxy.password, [`http://${place.host}:${place.port}/`])).value;
    }
    const user = encodeURIComponent(proxy.username ?? "");
    return `${place.scheme}://${user}${secret ? `:${encodeURIComponent(secret)}` : ""}@${place.host}:${place.port}`;
  }

  /** As the service starts: a stored proxy's password is asked of the gate (until then nothing leaves), then its exit
   *  is looked up again (the one kept from last time stands meanwhile). */
  async start(): Promise<void> {
    const { proxy } = this.read();
    if (!proxy) return;
    if (this.upstreamUrl === undefined) {
      try { this.upstreamUrl = await this.withPassword(proxy); } catch { return; /* stays unavailable: `upstream` says so */ }
    }
    await this.lookUpExit();
  }

  /** Where what leaves this machine goes: the proxy (with its password), or null for straight out. Throws while a
   *  proxy is set that cannot be used: its traffic must not leave another way. */
  upstream(): string | null {
    if (this.upstreamUrl === undefined) throw new IdentityError("上游代理暂不可用（凭据网关尚未给出它的密码）。");
    return this.upstreamUrl;
  }
}

/** What was asked cannot be taken, in words for the person. */
export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}
