/** The profiles' own browsers (docs/profiles-v0.md §5.1, §5.5): beside the browser everyone shares, one for each
 *  profile other than the Mac's own, started the first time something under the profile needs it. It is the same
 *  kind of browser — its own folder for cookies and sign-ins, its own tabs and agents' sessions: an account signed
 *  in there is that profile's, whoever is signed in elsewhere. Everything it sends leaves through the profile's
 *  forwarder (exits.ts): through the profile's proxy when it has one — what an agent under the profile opens in a
 *  browser then comes from the same place as what the agent itself sends — and as this Mac does when it has none. */

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
              /** Each profile's way out now, by its key: its own proxy, or none (this Mac's own way out). Null:
               *  no such profile (the Mac's own has no key). */
              private readonly profile: (key: string) => { readonly proxy: ProxySetting | null } | null) {}

  /** The browser of profile `key`; null when there is no such profile. One made for a proxy that has since been
   *  changed, set or taken away is shut down and made anew: its traffic is not to go the old way. */
  of(key: string): SharedBrowser | null {
    const profile = this.profile(key);
    if (!profile) { void this.drop(key); return null; }
    const proxy = profile.proxy;
    const setting = proxy ? JSON.stringify(proxy) : "direct", was = this.made.get(key);
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
