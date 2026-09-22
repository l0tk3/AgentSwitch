/** Process environment helpers shared by executors and routers. */

/** Copy of the environment without proxy variables: harnesses whose own API traffic must not go through the gate. */
export function stripProxy(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^(https?|all)_proxy$/i.test(k)) out[k] = v;
  return out;
}
