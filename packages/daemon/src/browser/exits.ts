/** The exits of things that have a proxy of their own — a profile of an agent (docs/profiles-v0.md §4) — each a
 *  forwarder on this Mac's loopback that sends what leaves on to that proxy. What runs under the profile is given the
 *  forwarder's address, never the proxy's own: the proxy's password is not in its environment, and a proxy that is
 *  down lets nothing out (the forwarder answers 502; it does not go straight instead).
 *
 *  Before anything is started on an exit it is checked: one request to a public lookup through it, which says where
 *  the traffic comes out — or that it does not. */

import { exitProbe, type ExitInfo } from "./exit.js";
import { CIPHERTEXT, type FillResolver } from "./fill.js";
import { Forwarder, type ForwarderAddress } from "./forwarder.js";
import { proxyPlace, type ProxySetting } from "./identity.js";

export class ExitError extends Error {}

export type ExitPoolOptions = {
  readonly ownPorts: () => readonly number[];
  /** The gate's answer for a ciphertext (a proxy's password); absent without the gate. */
  readonly resolve?: FillResolver | undefined;
  /** The public lookup an exit is checked against (exit.ts); null: none, an exit cannot be checked. */
  readonly lookup: string | null;
  /** Another way to ask where an exit comes out (tests). */
  readonly probe?: (via: ForwarderAddress) => Promise<ExitInfo>;
  readonly log?: (line: string) => void;
};

type Exit = { readonly setting: string; readonly upstream: string; readonly forwarder: Forwarder };

/** A proxy as it is to be kept: its address in order, a password only as a ciphertext and only with a user name. */
export function checkedProxy(proxy: ProxySetting): ProxySetting {
  const server = proxy.server.trim();
  if (!proxyPlace(server)) throw new ExitError("代理地址须写作 scheme://host:port（http、https、socks4、socks5）。");
  const username = proxy.username?.trim() || undefined, password = proxy.password?.trim() || undefined;
  if (password && !CIPHERTEXT.test(password)) throw new ExitError("代理密码请以密文（enc:v1:）提供。");
  if (password && !username) throw new ExitError("带密码的代理需要用户名。");
  return { server, ...(username ? { username } : {}), ...(password ? { password } : {}) };
}

export class ExitPool {
  private readonly exits = new Map<string, Exit>();

  constructor(private readonly opts: ExitPoolOptions) {}

  /** The forwarder for `key`'s proxy, listening: what a process under it is given as its proxy
   *  (`http://agentswitch:<a password made for this run>@127.0.0.1:<port>`). A proxy with a password is asked of the
   *  gate here; one that cannot be had is refused. */
  async address(key: string, proxy: ProxySetting): Promise<ForwarderAddress> {
    const setting = JSON.stringify(checkedProxy(proxy));
    let exit = this.exits.get(key);
    if (exit?.setting !== setting) {
      await exit?.forwarder.stop();
      const upstream = await this.upstream(checkedProxy(proxy));
      exit = { setting, upstream, forwarder: new Forwarder({ ownPorts: this.opts.ownPorts, upstream: () => upstream, ...(this.opts.log ? { log: this.opts.log } : {}) }) };
      this.exits.set(key, exit);
    }
    return exit.forwarder.start();
  }

  /** Where traffic through `key`'s proxy comes out, asked now. Throws with the reason when it does not come out. */
  async check(key: string, proxy: ProxySetting): Promise<ExitInfo> {
    const via = await this.address(key, proxy);
    try {
      if (this.opts.probe) return await this.opts.probe(via);
      if (!this.opts.lookup) throw new ExitError("没有可用的出口查询。");
      return await exitProbe({ forwarder: async () => via, url: this.opts.lookup })();
    } catch (err) {
      if (err instanceof ExitError) throw err;
      throw new ExitError(`经这个代理连不出去（${(err as Error).message}）。`);
    }
  }

  /** As an environment's proxy: the forwarder with its name and password in the address. */
  static url(via: ForwarderAddress): string {
    const at = new URL(via.server);
    return `http://${encodeURIComponent(via.username)}:${encodeURIComponent(via.password)}@${at.host}`;
  }

  /** Requests and tunnels `key`'s forwarder has been asked for (0: nothing went through it yet, or it has none). */
  requests(key: string): number { return this.exits.get(key)?.forwarder.stats().requests ?? 0; }

  /** `key` has no proxy any more: its forwarder stops. */
  async drop(key: string): Promise<void> {
    const exit = this.exits.get(key);
    this.exits.delete(key);
    await exit?.forwarder.stop();
  }

  async stop(): Promise<void> {
    const all = [...this.exits.values()];
    this.exits.clear();
    await Promise.all(all.map((e) => e.forwarder.stop()));
  }

  private async upstream(proxy: ProxySetting): Promise<string> {
    const place = proxyPlace(proxy.server)!;
    if (!proxy.username && !proxy.password) return proxy.server;
    let secret = "";
    if (proxy.password) {
      if (!this.opts.resolve) throw new ExitError("凭据网关不可用，无法使用带密码的代理。");
      // The gate checks the ciphertext against the proxy's own host, as it would a page's.
      try { secret = (await this.opts.resolve(proxy.password, [`http://${place.host}:${place.port}/`])).value; }
      catch { throw new ExitError("凭据网关没有给出这个代理的密码。"); }
    }
    const user = encodeURIComponent(proxy.username ?? "");
    return `${place.scheme}://${user}${secret ? `:${encodeURIComponent(secret)}` : ""}@${place.host}:${place.port}`;
  }
}
