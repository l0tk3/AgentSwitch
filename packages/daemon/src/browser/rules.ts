/** Where the shared browser may go (docs/browser-v0.md §2 安全). People may open http(s), `about:blank`, files of the
 *  Mac's and `localhost:<port>`; agents only http(s) and `about:blank` (`file:` stays with the gate). Nobody opens
 *  AgentSwitch's own ports, AgentSwitch's data (`defaultProtected` and its read-denied paths, and copies of AgentSwitch's
 *  and the gate's folders elsewhere) or credentials: the folders and file names below, checked on the path as asked and
 *  again on its real path, by spelling and by identity (core/paths.ts), so neither `..`, a symlink, the letter case nor
 *  the data volume's spelling (`/System/Volumes/Data/Users/…`) gets past. The same checks run before a tab opens (the
 *  API answers 403 with the reason) and on every request the browser makes (host.ts's guard), so a page cannot link or
 *  embed its way to a refused file. */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isWithin, lineage, withoutDataVolume } from "../core/paths.js";
import type { ProtectedPaths } from "../executors/protected.js";
import { BrowserError, type PlaceKind, type TabOwner } from "./types.js";

/** Folders that hold logins and keys. A single dot-folder (`.ssh`) is refused wherever it is (a backup's too); a longer
 *  one only under the home folder. */
export const CREDENTIAL_DIRS: readonly string[] = [
  ".ssh", ".aws", ".gnupg", ".kube", ".azure", ".docker", ".password-store",
  ".config/gh", ".config/gcloud", "Library/Keychains",
];

/** File names that are credentials wherever they are: environment files, private keys and certificates (the gate's
 *  `*.priv` too), SSH keys (not their `.pub` halves), the package managers' and git's token files, cloud credential
 *  files. */
export const CREDENTIAL_NAMES: readonly RegExp[] = [
  /^\.env$/i, /^\.env\..+$/i,
  /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.priv$/i,
  /^id_[a-z0-9_-]+$/i,
  /^\.netrc$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.git-credentials$/i, /^\.pgpass$/i,
  /^credentials/i,
];

/** AgentSwitch's and the gate's folder names, refused wherever they are (a copy, a backup) besides the real ones. */
export const AGENTSWITCH_DIRS: readonly string[] = [".agentswitch", ".secret-gate"];

/** What people's `file:` paths are checked against: AgentSwitch's protected table, the (real) home folder, and
 *  AgentSwitch's own folders (its home, the gate's home), whose names are refused anywhere outside them too: a dot-folder
 *  by its name, another (`Application Support/AgentSwitch`) by its last two parts. */
export type FileRules = { readonly protected: ProtectedPaths; readonly home: string; readonly ownFolders?: readonly string[] };

const MAX_URL_CHARS = 8192;

export const OWN_PORT_REFUSAL = "该端口是 AgentSwitch 自己的服务，不在浏览器中打开。";
export const AGENT_FILE_REFUSAL = "Agent 的标签不可打开 Mac 上的文件。";
const PEOPLE_SCHEMES_REFUSAL = "仅可打开 http(s) 网址、Mac 上的文件路径和 localhost。";
const AGENT_SCHEMES_REFUSAL = "Agent 的标签仅可打开 http(s) 网址。";
const UNKNOWN_ADDRESS = "无法识别的地址。";

type Denied = "agentswitch" | "credential-dir" | "credential-file";
const DENIED_TEXT: Record<Denied, string> = {
  "agentswitch": "属于 AgentSwitch 自己的数据或凭据网关，不在浏览器中打开。",
  "credential-dir": "位于凭据目录中（SSH、云服务、GPG、钥匙串等），不在浏览器中打开。",
  "credential-file": "属于凭据文件（.env、私钥、证书、令牌配置等），不在浏览器中打开。",
};

/** The Mac's disk ignores case, so every comparison does too. */
const under = (p: string, root: string): boolean => {
  const a = p.toLowerCase();
  const b = root.toLowerCase();
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/** `~/x` for a path under the home folder, as the screens show it. */
export function tilde(path: string, home: string): string {
  return under(path, home) ? `~${path.slice(home.length)}` : path;
}

/** The runs of folder names (lower case) that name AgentSwitch's or the gate's folder anywhere. */
function ownNames(rules: FileRules): string[][] {
  const named = (rules.ownFolders ?? []).map((f) => (basename(f).startsWith(".") ? [basename(f)] : [basename(dirname(f)), basename(f)]));
  return [...AGENTSWITCH_DIRS.map((d) => [d]), ...named].map((run) => run.map((p) => p.toLowerCase()));
}

const hasRun = (parts: readonly string[], run: readonly string[]): boolean =>
  parts.some((_, i) => run.every((name, j) => parts[i + j] === name));

/** Why `path` (absolute, resolved) is refused, or null. Folders by spelling and by identity: the real ones wherever
 *  the path leads (firmlinks, case, symlinked folders above it); names as the path spells them. */
function deniedAs(path: string, rules: FileRules): Denied | null {
  const prot = rules.protected;
  const chain = lineage(path);
  const inside = (root: string): boolean => isWithin(path, root, chain);
  if ((prot.readDenied ?? []).some(inside)) return "agentswitch";
  const parts = path.toLowerCase().split(sep);
  // Inside AgentSwitch's own folders the table decides (its work folders are open); a copy elsewhere goes by its name.
  if (prot.roots.some(inside)) { if (!prot.exempt.some(inside)) return "agentswitch"; }
  else if (ownNames(rules).some((run) => hasRun(parts, run))) return "agentswitch";
  for (const dir of CREDENTIAL_DIRS) {
    const single = !dir.includes("/");
    if (single ? parts.includes(dir.toLowerCase()) : inside(join(rules.home, dir))) return "credential-dir";
  }
  if (CREDENTIAL_NAMES.some((re) => re.test(basename(path)))) return "credential-file";
  return null;
}

/** The path a person may open (absolute, resolved, as asked), or a refusal: refused as asked, missing, or refused once
 *  its symlinks are followed (and the data volume's prefix taken off). A folder is allowed (Chrome lists it; opening an
 *  entry is checked again). */
export function checkLocalFile(path: string, rules: FileRules): string {
  if (!isAbsolute(path)) throw new BrowserError("invalid", "路径须为绝对路径。");
  const asked = resolve(path);
  const shown = tilde(asked, rules.home);
  const first = deniedAs(asked, rules);
  if (first) throw new BrowserError("forbidden", `${shown} ${DENIED_TEXT[first]}`);
  let real: string;
  try { real = withoutDataVolume(realpathSync.native(asked)); } catch { throw new BrowserError("not_found", `文件不存在：${shown}`); }
  const second = deniedAs(real, rules);
  if (second) throw new BrowserError("forbidden", `${shown}（实际位置 ${tilde(real, rules.home)}）${DENIED_TEXT[second]}`);
  return asked;
}

/** A host name as compared: lower case, without IPv6 brackets or the root's trailing dot (`localhost.`). */
export function normalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

/** True for a host name that reaches this Mac: `localhost` and its subdomains, 127/8, `::1`, the unspecified address. */
export function isLoopbackHost(hostname: string): boolean {
  const h = normalHost(hostname);
  return h === "localhost" || h.endsWith(".localhost") || isLoopbackAddress(h);
}

/** True for an address (as `dns.lookup` gives it) that is this Mac: 127/8, `::1`, the unspecified ones, IPv4 in IPv6. */
export function isLoopbackAddress(address: string): boolean {
  const h = normalHost(address);
  return /^127(\.\d{1,3}){3}$/.test(h) || h === "0.0.0.0" || h === "::1" || h === "::" || /^0{0,4}(:0{0,4}){6}:0{0,3}1$/.test(h)
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h) || /^::ffff:127(\.\d{1,3}){3}$/.test(h) || /^::ffff:0\.0\.0\.0$/.test(h);
}

export function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** The policy for a URL a tab of `owner`'s is sent to; returns it normalized or refuses. */
export function checkUrl(owner: TabOwner, raw: string, rules: FileRules, ownPorts: readonly number[]): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new BrowserError("invalid", UNKNOWN_ADDRESS); }
  if (url.href.length > MAX_URL_CHARS) throw new BrowserError("invalid", "地址过长。");
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (isLoopbackHost(url.hostname) && ownPorts.includes(portOf(url))) throw new BrowserError("forbidden", OWN_PORT_REFUSAL);
    return url.href;
  }
  if (url.href === "about:blank") return url.href;
  if (url.protocol === "file:" && owner.kind === "you") {
    if (url.host && url.host !== "localhost") throw new BrowserError("invalid", UNKNOWN_ADDRESS);
    checkLocalFile(fileURLToPath(url), rules);
    return url.href;
  }
  if (url.protocol === "file:") throw new BrowserError("forbidden", AGENT_FILE_REFUSAL);
  throw new BrowserError("forbidden", owner.kind === "you" ? PEOPLE_SCHEMES_REFUSAL : AGENT_SCHEMES_REFUSAL);
}

/** What a person asked to open (`POST /browser/tabs`, `/navigate`): a URL or what was typed in the address bar, a path
 *  of the Mac's, or a local port. */
export type OpenTarget = { readonly url: string } | { readonly path: string } | { readonly port: number };

const LOCAL_TYPED = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?([/?#].*)?$/i;
const HOST_TYPED = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?([/?#].*)?$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `~` and `~/x` under `home`. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** A target as a URL, before the policy: `localhost:5173` → http, a bare host → https, `/x` and `~/x` → `file:`. */
export function targetUrl(target: OpenTarget, home: string): string {
  if ("port" in target) return `http://localhost:${target.port}/`;
  if ("path" in target) {
    const path = expandHome(target.path.trim(), home);
    if (!isAbsolute(path)) throw new BrowserError("invalid", "路径须为绝对路径。");
    return pathToFileURL(resolve(path)).href;
  }
  const typed = target.url.trim();
  if (!typed) throw new BrowserError("invalid", UNKNOWN_ADDRESS);
  if (typed.startsWith("/") || typed === "~" || typed.startsWith("~/")) return targetUrl({ path: typed }, home);
  try {
    if (LOCAL_TYPED.test(typed)) return new URL(`http://${typed}`).href;
    if (HOST_TYPED.test(typed)) return new URL(`https://${typed}`).href;
    if (SCHEME.test(typed)) return new URL(typed).href;
  } catch { /* falls through */ }
  throw new BrowserError("invalid", UNKNOWN_ADDRESS);
}

/** The list's second line for a URL: the site, the file's path, or the local port. */
export function placeOf(raw: string, home: string): { readonly kind: PlaceKind; readonly site: string } {
  let url: URL;
  try { url = new URL(raw); } catch { return { kind: "web", site: raw }; }
  if (url.href === "about:blank" || raw === "") return { kind: "blank", site: "" };
  if (url.protocol === "file:") {
    try { return { kind: "file", site: tilde(fileURLToPath(url), home) }; } catch { return { kind: "file", site: url.pathname }; }
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname)) return { kind: "local", site: `localhost:${portOf(url)}` };
  if (url.protocol === "http:" || url.protocol === "https:") return { kind: "web", site: url.host.replace(/^www\./, "") };
  return { kind: "web", site: url.protocol.replace(/:$/, "") };
}

/** A URL for the audit: no query, fragment or user info (they can carry tokens). */
export function auditUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "file:") return fileURLToPath(url);
    return url.protocol === "http:" || url.protocol === "https:" ? `${url.origin}${url.pathname}` : url.protocol;
  } catch { return "invalid"; }
}
