/** What was kept as a secret-gate ciphertext is sealed anew under the vault's key (vault/seal.ts; 2026-11-25, user
 *  #369: secret-gate 弃用): each profile's API key, proxy password and session key, and the shared browser's proxy
 *  password. Opened by the gate one last time, while there is one; what it will not open stays as it is (and is said),
 *  to be typed again. Done at each start until nothing is left. */

import { proxyPlace } from "./browser/identity.js";
import { apiSite, type ProfileStore } from "./profiles/store.js";
import { isVaultSealed, sealValue, type Opener } from "./vault/seal.js";

const CLAUDE_SITE = "https://claude.ai/";
const proxyFrame = (server: string): string[] => { const at = proxyPlace(server); return at ? [`http://${at.host}:${at.port}/`] : []; };

export async function moveSealed(o: {
  readonly key: Buffer;
  readonly gate: Opener;
  readonly profiles: ProfileStore;
  readonly identity?: { sealedPassword(): { server: string; password: string } | null; moveSealedPassword(password: string): void } | undefined;
  readonly log?: (line: string) => void;
}): Promise<{ moved: number; left: number }> {
  let moved = 0, left = 0;
  const anew = async (token: string | undefined, frames: () => readonly string[], what: string): Promise<string | undefined> => {
    if (!token || isVaultSealed(token)) return undefined;
    try { const { value } = await o.gate(token, frames()); moved += 1; return sealValue(o.key, value); }
    catch { left += 1; o.log?.(`vault: ${what} could not be opened by the gate: it stays as it is, to be entered again`); return undefined; }
  };
  for (const { agent, id } of o.profiles.kept()) {
    const api = o.profiles.apiOf(agent, id), proxy = o.profiles.proxyOf(agent, id), session = o.profiles.sessionKeyOf(agent, id);
    const apiKey = await anew(api?.key, () => [apiSite(agent, api?.baseUrl)], `the API key of ${agent} profile ${id}`);
    const proxyPassword = await anew(proxy?.password, () => proxyFrame(proxy!.server), `the proxy password of ${agent} profile ${id}`);
    const sessionKey = await anew(session?.sealed, () => [CLAUDE_SITE], `the session key of ${agent} profile ${id}`);
    if (apiKey || proxyPassword || sessionKey) o.profiles.moveSealed(agent, id, { ...(apiKey ? { apiKey } : {}), ...(proxyPassword ? { proxyPassword } : {}), ...(sessionKey ? { sessionKey } : {}) });
  }
  const shared = o.identity?.sealedPassword();
  const password = await anew(shared?.password, () => proxyFrame(shared!.server), "the shared browser's proxy password");
  if (password) o.identity!.moveSealedPassword(password);
  if (moved || left) o.log?.(`vault: ${moved} kept secret${moved === 1 ? "" : "s"} moved off the gate${left ? `, ${left} left` : ""}`);
  return { moved, left };
}
