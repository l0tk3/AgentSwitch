/** The browsers of profiles that have a proxy of their own (docs/profiles-v0.md §5.1): beside the browser everyone
 *  shares, one for each such profile, started the first time something under the profile needs it. It is the same
 *  kind of browser — its own folder for cookies and sign-ins, its own tabs and agents' sessions — and everything it
 *  sends leaves through the profile's forwarder (exits.ts), so through the profile's proxy: what an agent under the
 *  profile opens in a browser comes from the same place as what the agent itself sends. */

import type { ExitPool } from "./exits.js";
import type { ForwarderAddress } from "./forwarder.js";
import type { ProxySetting } from "./identity.js";
import type { SharedBrowser } from "./setup.js";

export type ProfileBrowserMaker = (key: string, forwarder: { start(): Promise<ForwarderAddress> }) => SharedBrowser;
// Which browser it is — Camoufox when the engine has one installed, else Chrome — is the maker's choice, the same as
// for the shared browser (setup.ts `engineDriver`); with Camoufox it has a fingerprint of its own too.

export class ProfileBrowsers {
  private readonly made = new Map<string, { readonly setting: string; readonly browser: SharedBrowser }>();

  constructor(private readonly make: ProfileBrowserMaker, private readonly exits: Pick<ExitPool, "address">,
              /** Each profile's proxy now, by its key (null: it has none, or is not there). */ private readonly proxyOf: (key: string) => ProxySetting | null) {}

  /** The browser of profile `key`; null for a profile with no proxy of its own (it uses the shared one). One made
   *  for a proxy that has since been changed is shut down and made anew: its traffic is not to go the old way. */
  of(key: string): SharedBrowser | null {
    const proxy = this.proxyOf(key);
    if (!proxy) { void this.drop(key); return null; }
    const setting = JSON.stringify(proxy), was = this.made.get(key);
    if (was?.setting === setting) return was.browser;
    if (was) void this.shut(was.browser);
    const browser = this.make(key, { start: () => this.exits.address(key, proxy) });
    this.made.set(key, { setting, browser });
    return browser;
  }

  /** The last page a terminal had opened in its own browser for a person to act on (a sign-in): which browser, which
   *  tab, when. The Mac's app brings that browser's window to the front (docs/profiles-v0.md §5.3); null: none yet. */
  shown: { readonly browser: string; readonly tab: string; readonly at: number } | null = null;

  noteShown(browser: string, tab: string, at: number = Date.now()): void { this.shown = { browser, tab, at }; }

  /** The one already made for `key`, as it is (the routes of a browser that runs). */
  get(key: string): SharedBrowser | null { return this.made.get(key)?.browser ?? null; }

  keys(): string[] { return [...this.made.keys()]; }

  async drop(key: string): Promise<void> {
    const was = this.made.get(key);
    this.made.delete(key);
    if (was) await this.shut(was.browser);
  }

  async stop(): Promise<void> {
    const all = [...this.made.values()];
    this.made.clear();
    await Promise.all(all.map((b) => this.shut(b.browser)));
  }

  private async shut(browser: SharedBrowser): Promise<void> {
    await browser.agents.shutdown().catch(() => undefined);
    await browser.host.shutdown().catch(() => undefined);
    await browser.stop().catch(() => undefined);
  }
}
