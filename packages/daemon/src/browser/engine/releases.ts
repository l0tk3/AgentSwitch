/** What can be installed (docs/browser-v0.md §7.2 第 6 条), read from what GitHub and the npm registry answer. Pure:
 *  the fetching is the caller's. A Camoufox build must be of the Firefox the Playwright in use drives (measured
 *  2026-10-05: 152 under a Playwright for 156 fails at the first resize), and only builds whose archive has a published
 *  digest are offered — the download is checked against it. */

import type { EngineSource } from "./update.js";

export type CamoufoxRelease = EngineSource & { readonly part: "camoufox"; readonly prerelease: boolean; readonly publishedAt: number };

/** An asset's name: `camoufox-<version>-<system>.<arch>.zip`. */
const ASSET = /^camoufox-(.+)-(mac|lin|win)\.(arm64|x86_64|i686)\.zip$/;
const SYSTEM: Readonly<Record<string, string>> = { darwin: "mac", linux: "lin", win32: "win" };
const ARCH: Readonly<Record<string, string>> = { arm64: "arm64", x64: "x86_64", ia32: "i686" };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null;

/** `GET /repos/daijro/camoufox/releases` → the builds for this system, newest first. */
export function camoufoxReleases(body: unknown, host: { readonly platform: string; readonly arch: string }): CamoufoxRelease[] {
  if (!Array.isArray(body)) return [];
  const system = SYSTEM[host.platform], arch = ARCH[host.arch];
  const found: CamoufoxRelease[] = [];
  for (const release of body) {
    if (!isObject(release) || !Array.isArray(release.assets)) continue;
    for (const asset of release.assets) {
      if (!isObject(asset) || typeof asset.name !== "string") continue;
      const m = ASSET.exec(asset.name);
      if (!m || m[2] !== system || m[3] !== arch) continue;
      if (typeof asset.digest !== "string" || !asset.digest.startsWith("sha256:") || typeof asset.browser_download_url !== "string") continue;
      found.push({ part: "camoufox", version: m[1]!, url: asset.browser_download_url, bytes: Number(asset.size ?? 0), digest: asset.digest,
        prerelease: release.prerelease === true, publishedAt: Date.parse(String(release.published_at ?? "")) || 0 });
    }
  }
  return found.sort((a, b) => b.publishedAt - a.publishedAt);
}

/** The newest build of Firefox `firefox` (as Playwright names it: `156.0`); pre-releases only when asked for. */
export function newestCamoufox(list: readonly CamoufoxRelease[], want: { readonly firefox: string; readonly prerelease?: boolean }): CamoufoxRelease | null {
  const major = want.firefox.split(".")[0];
  return list.find((r) => r.version.split(".")[0] === major && (want.prerelease || !r.prerelease)) ?? null;
}

/** Which Firefox a playwright-core drives, from its `browsers.json`. */
export function firefoxOf(browsers: unknown): string | null {
  if (!isObject(browsers) || !Array.isArray(browsers.browsers)) return null;
  const firefox = browsers.browsers.find((b) => isObject(b) && b.name === "firefox");
  return isObject(firefox) && typeof firefox.browserVersion === "string" ? firefox.browserVersion : null;
}

/** One version of playwright-core from the registry's answer (`GET /playwright-core`). */
export function playwrightRelease(body: unknown, version: string): (EngineSource & { readonly part: "playwright" }) | null {
  if (!isObject(body) || !isObject(body.versions)) return null;
  const entry = body.versions[version];
  if (!isObject(entry) || !isObject(entry.dist)) return null;
  const { tarball, integrity, unpackedSize } = entry.dist;
  if (typeof tarball !== "string" || typeof integrity !== "string" || !integrity.startsWith("sha512-")) return null;
  return { part: "playwright", version, url: tarball, bytes: Number(unpackedSize ?? 0), digest: integrity };
}
