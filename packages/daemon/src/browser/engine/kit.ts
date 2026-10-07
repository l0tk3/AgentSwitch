/** The browser engine as the service has it (docs/browser-v0.md §7.2 第 6 条): Camoufox with the Playwright that drives
 *  it — what is installed, what could be, and updating the pair. Called "kit" in code because "engine" already names
 *  the task engine and the agents' MCP engine; people see "Engine". Nothing here starts a browser except the check a
 *  new pair runs on itself. */

import { join } from "node:path";
import { camoufoxExecutable, downloadArchive, unpackArchive } from "./files.js";
import { activePlaywright, bundledPlaywright, firefoxVersion, type PlaywrightCopy } from "./loader.js";
import { camoufoxReleases, newestCamoufox, playwrightRelease, type CamoufoxRelease } from "./releases.js";
import { EngineStore, type Installed } from "./store.js";
import { EngineUpdater, type EngineSource, type UpdateDeps, type UpdateState } from "./update.js";

export const CAMOUFOX_RELEASES_URL = "https://api.github.com/repos/daijro/camoufox/releases?per_page=30";
export const PLAYWRIGHT_REGISTRY_URL = "https://registry.npmjs.org/playwright-core";

export type EngineAvailable = {
  /** The newest build for the Firefox in use that is not the one installed; null: none, or it is installed already. */
  readonly camoufox: { readonly version: string; readonly bytes: number; readonly prerelease: boolean } | null;
  readonly checkedAt: number;
  readonly problem?: string;
};

export type EngineStatus = {
  readonly camoufox: { readonly installed: Installed | null; /** Its program is there to start. */ readonly ready: boolean };
  readonly playwright: { readonly bundled: string; readonly installed: Installed | null; readonly active: "bundled" | "installed"; readonly version: string; readonly firefox: string | null };
  readonly update: UpdateState;
  /** Since the last check. */
  readonly available?: EngineAvailable;
};

export type EngineUpdateRequest = {
  /** A version (`156.0.1-beta.34`), or `latest`: the newest build for the Firefox in use. */
  readonly camoufox?: string | undefined;
  /** A version of playwright-core, or `bundled`: back to the copy that came with the app. */
  readonly playwright?: string | undefined;
  /** `latest` may be a pre-release. */
  readonly prerelease?: boolean | undefined;
};

export type EngineUpdateAnswer = { readonly ok: true } | { readonly ok: false; readonly status: 400 | 409 | 502; readonly error: string };

export type EngineKitOptions = {
  /** `$AGENTSWITCH_HOME/browser/engine`. */
  readonly root: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly now?: () => number;
  readonly fetchJson?: (url: string) => Promise<unknown>;
  readonly download?: UpdateDeps["download"];
  readonly unpack?: UpdateDeps["unpack"];
  readonly selfCheck?: UpdateDeps["selfCheck"];
};

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "AgentSwitch" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export class EngineKit {
  readonly store: EngineStore;
  private readonly updater: EngineUpdater;
  private readonly platform: string;
  private readonly arch: string;
  private readonly now: () => number;
  private readonly fetchJson: (url: string) => Promise<unknown>;
  private available: EngineAvailable | undefined;
  private switching: ((apply: () => void) => Promise<void>) | undefined;

  constructor(opts: EngineKitOptions) {
    this.store = new EngineStore(opts.root);
    this.platform = opts.platform ?? process.platform;
    this.arch = opts.arch ?? process.arch;
    this.now = opts.now ?? Date.now;
    this.fetchJson = opts.fetchJson ?? fetchJson;
    this.updater = new EngineUpdater({
      store: this.store, now: this.now,
      download: opts.download ?? downloadArchive,
      unpack: opts.unpack ?? ((part, archive, into, signal) => unpackArchive(part, archive, into, signal, this.platform)),
      selfCheck: opts.selfCheck ?? (async () => ({ ok: false, reason: "此服务未配置自检，不能更新引擎。" })),
      switching: (apply) => this.switching ? this.switching(apply) : Promise.resolve(apply()),
    });
  }

  /** Whoever runs a browser on the engine says how a new copy is switched to around it: stopped before, started again
   *  with its tabs after (the host's `restart`). */
  aroundSwitch(switching: (apply: () => void) => Promise<void>): void {
    this.switching = switching;
  }

  /** As the service starts: what an interrupted update left is cleared. */
  start(): string[] {
    return this.store.sweep();
  }

  /** The Playwright to use now. */
  playwright(): PlaywrightCopy {
    return activePlaywright(this.store);
  }

  /** The installed Camoufox's program, or null when there is none to start. */
  executable(): string | null {
    return this.store.installed("camoufox") ? camoufoxExecutable(this.store.dir("camoufox"), this.platform) : null;
  }

  status(): EngineStatus {
    const active = this.playwright();
    return {
      camoufox: { installed: this.store.installed("camoufox"), ready: this.executable() !== null },
      playwright: { bundled: bundledPlaywright().version, installed: this.store.installed("playwright"), active: active.from, version: active.version, firefox: firefoxVersion(active) },
      update: this.updater.state(),
      ...(this.available ? { available: this.notInstalled(this.available) } : {}),
    };
  }

  /** What a check found, without the build that has been installed since. */
  private notInstalled(available: EngineAvailable): EngineAvailable {
    return available.camoufox?.version === this.store.installed("camoufox")?.version ? { ...available, camoufox: null } : available;
  }

  /** Once the update under way (or the last one) is over. */
  settled(): Promise<UpdateState> {
    return this.updater.done();
  }

  cancel(): void {
    this.updater.cancel();
  }

  private async releases(): Promise<CamoufoxRelease[]> {
    return camoufoxReleases(await this.fetchJson(CAMOUFOX_RELEASES_URL), { platform: this.platform, arch: this.arch });
  }

  /** Asks what could be installed. */
  async check(opts: { readonly prerelease?: boolean | undefined } = {}): Promise<EngineStatus> {
    try {
      const firefox = firefoxVersion(this.playwright());
      const newest = firefox ? newestCamoufox(await this.releases(), { firefox, ...(opts.prerelease ? { prerelease: true } : {}) }) : null;
      const fresh = newest && newest.version !== this.store.installed("camoufox")?.version ? newest : null;
      this.available = { camoufox: fresh && { version: fresh.version, bytes: fresh.bytes, prerelease: fresh.prerelease }, checkedAt: this.now() };
    } catch (err) {
      this.available = { camoufox: null, checkedAt: this.now(), problem: `无法读取可用的版本：${(err as Error).message}` };
    }
    return this.status();
  }

  /** Starts an update; the answer says whether it began (its progress is in `status().update`). */
  async update(req: EngineUpdateRequest): Promise<EngineUpdateAnswer> {
    const refuse = (error: string, status: 400 | 409 | 502 = 400): EngineUpdateAnswer => ({ ok: false, status, error });
    if (this.updater.state().running) return refuse("引擎正在更新中。", 409);
    if (!req.camoufox && !req.playwright) return refuse("未指定要更新的内容。");
    if (req.playwright === "bundled") {
      if (req.camoufox) return refuse("改回应用自带的 Playwright 时不能同时更新 Camoufox。");
      this.store.remove("playwright");
      return { ok: true };
    }
    const sources: EngineSource[] = [];
    try {
      if (req.playwright) {
        // Which Firefox a new Playwright drives is known only once it is unpacked: the build is named outright then,
        // and the pair's own check decides whether they go together.
        if (req.camoufox === "latest") return refuse("同时更新 Playwright 时请指定 Camoufox 的版本。");
        const source = playwrightRelease(await this.fetchJson(PLAYWRIGHT_REGISTRY_URL), req.playwright);
        if (!source) return refuse(`未找到 playwright-core ${req.playwright}。`);
        sources.push(source);
      }
      if (req.camoufox) {
        const list = await this.releases();
        const firefox = firefoxVersion(this.playwright());
        const source = req.camoufox === "latest"
          ? (firefox ? newestCamoufox(list, { firefox, ...(req.prerelease ? { prerelease: true } : {}) }) : null)
          : list.find((r) => r.version === req.camoufox) ?? null;
        if (!source) return refuse(req.camoufox === "latest" ? `没有适用于 Firefox ${firefox ?? "?"} 的 Camoufox 构建。` : `未找到 Camoufox ${req.camoufox}（或它没有公布校验值）。`);
        if (!req.playwright && firefox && source.version.split(".")[0] !== firefox.split(".")[0]) {
          return refuse(`Camoufox ${source.version} 与当前的 Playwright 不相容：它驱动的是 Firefox ${firefox.split(".")[0]}。`);
        }
        sources.unshift(source);
      }
    } catch (err) {
      return refuse(`无法读取可用的版本：${(err as Error).message}`, 502);
    }
    const started = this.updater.start(sources);
    return started.ok ? { ok: true } : refuse("引擎正在更新中。", 409);
  }
}

/** Where the engine lives under the service's own folder. */
export function engineRoot(home: string): string {
  return join(home, "browser", "engine");
}
