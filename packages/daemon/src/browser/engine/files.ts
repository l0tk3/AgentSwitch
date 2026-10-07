/** Getting an engine archive and unpacking it (docs/browser-v0.md §7.2 第 6 条), with the system's own tools. */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { EnginePart } from "./store.js";
import type { EngineSource } from "./update.js";

/** Streams `source.url` to `file`. The service's own request: not through the credential gateway's proxy (a public
 *  file, checked against its published digest afterwards). */
export async function downloadArchive(source: EngineSource, file: string, progress: (received: number, total: number) => void, signal: AbortSignal,
                                      fetcher: typeof fetch = fetch): Promise<void> {
  const res = await fetcher(source.url, { signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}）。`);
  const total = Number(res.headers.get("content-length")) || source.bytes;
  let received = 0;
  const counted = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  counted.on("data", (chunk: Buffer) => { received += chunk.length; progress(received, total); });
  await pipeline(counted, createWriteStream(file), { signal });
}

function run(file: string, args: readonly string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-400); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`解包失败（${file} 退出码 ${code}）：${stderr.trim()}`)));
  });
}

/** Camoufox's archive is a zip of the app (`Camoufox.app` on a Mac); playwright-core's is npm's tarball, whose
 *  `package/` becomes `node_modules/playwright-core`. */
export async function unpackArchive(part: EnginePart, archive: string, into: string, signal: AbortSignal, platform: string = process.platform): Promise<void> {
  if (part === "camoufox") {
    // ditto keeps the app's links, modes and signature as zipped; unzip elsewhere.
    await (platform === "darwin" ? run("/usr/bin/ditto", ["-x", "-k", archive, into], signal) : run("unzip", ["-q", "-o", archive, "-d", into], signal));
    return;
  }
  const modules = join(into, "node_modules");
  mkdirSync(modules, { recursive: true });
  await run("tar", ["-xzf", archive, "-C", modules], signal);
  if (!existsSync(join(modules, "package", "package.json"))) throw new Error("解包失败：不是 npm 的包。");
  rmSync(join(modules, "playwright-core"), { recursive: true, force: true });
  renameSync(join(modules, "package"), join(modules, "playwright-core"));
}

/** The program to start in an unpacked Camoufox, or null when it is not there. */
export function camoufoxExecutable(dir: string, platform: string = process.platform): string | null {
  const file = platform === "darwin" ? join(dir, "Camoufox.app", "Contents", "MacOS", "camoufox")
    : platform === "win32" ? join(dir, "camoufox.exe") : join(dir, "camoufox-bin");
  return existsSync(file) ? file : null;
}
