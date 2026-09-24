/** Who sent an API request. The remote listener (app-v0 §2) hands a paired device's allowlisted requests to the API in
 *  process and marks them in the Hono env it passes along; nothing a client sends over HTTP can set or clear the mark,
 *  so a request without it came through the 127.0.0.1 listener (or a test). */

const REMOTE = Symbol("agentswitch.remoteCaller");

export type RemoteCaller = { readonly deviceId: string };

/** `env` plus the mark of a paired device. The original env is left as it is. */
export function markRemote<E extends object>(env: E | undefined, caller: RemoteCaller): E & { readonly [REMOTE]: RemoteCaller } {
  return { ...(env ?? ({} as E)), [REMOTE]: caller };
}

/** The paired device behind a request, or null for a local one. */
export function remoteCaller(env: unknown): RemoteCaller | null {
  if (!env || typeof env !== "object" || !(REMOTE in env)) return null;
  return (env as { readonly [REMOTE]?: RemoteCaller })[REMOTE] ?? null;
}
