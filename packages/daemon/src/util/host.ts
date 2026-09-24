/** Exact host names for grants: the credential-repair target and the field-transfer endpoints. Pure. */

const MAX_PORT = 65_535;

/** Requests must name a concrete host, never a URL, credentials, path or wildcard. */
export function exactHost(value: string): string | null {
  if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(value)) return null;
  try {
    const url = new URL(`http://${value}`);
    if (!url.hostname || url.username || url.password || url.pathname !== "/") return null;
    const [name, port] = value.toLowerCase().split(":");
    if (!name || name.endsWith(".") || name.includes("..") || (port && (+port < 1 || +port > MAX_PORT))) return null;
    return name + (port ? `:${Number(port)}` : "");
  } catch { return null; }
}
