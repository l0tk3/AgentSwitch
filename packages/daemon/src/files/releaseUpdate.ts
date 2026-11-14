import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requestInstall } from "./appUpdate.js";

const exec = promisify(execFile);
const REPO = "l0tk3/AgentSwitch";
export function releaseAsset(platform: string, arch: string): string | null {
  if (platform === "darwin" && arch === "arm64") return "AgentSwitch-mac-arm64.zip";
  if (platform === "linux" && ["arm64", "x64"].includes(arch)) return `agentswitch-runtime-linux-${arch === "arm64" ? "aarch64" : "x86_64"}.tar.gz`;
  return null;
}
export function newerRelease(next: string, current: string): boolean {
  if (![next, current].every((v) => /^\d+\.\d+\.\d+$/.test(v))) return false;
  const a = next.split(".").map(Number), b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
type Offer = { version: string; url: string; digest: string; asset: string };
type State = { current: string; supported: boolean; reason?: string; phase: string; available?: string; staged?: string; error?: string; last?: unknown };

/** All network input comes from this repository's release API. Preparing never restarts anything. */
export class ReleaseUpdater {
  private offer: Offer | undefined;
  private state: State;
  private readonly dir: string;
  private readonly runtime: string | undefined;
  private readonly asset = releaseAsset(process.platform, process.arch);
  constructor(private readonly home: string, private readonly current: string, private readonly app?: string) {
    this.dir = join(home, "release-update");
    const root = resolve(dirname(process.execPath), "../..");
    const link = join(dirname(root), "current");
    if (process.platform === "linux" && existsSync(join(root, "daemon", "package.json")) && existsSync(link) && realpathSync(link) === realpathSync(root)) this.runtime = root;
    const supported = Boolean(this.asset && (app || this.runtime));
    this.state = { current, supported, phase: "idle", ...(!supported ? { reason: "此节点未使用受支持的安装包运行；请先在节点上安装标准 runtime 或 Mac app。" } : {}) };
  }
  snapshot(): State {
    let last: unknown;
    try { last = JSON.parse(readFileSync(join(this.dir, "result.json"), "utf8")); } catch { /* no install yet */ }
    return { ...this.state, ...(last ? { last } : {}) };
  }
  async check(): Promise<State> {
    if (["downloading", "installing"].includes(this.state.phase)) return this.snapshot();
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "AgentSwitch" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`检查 GitHub 更新失败（HTTP ${r.status}）`);
    const v = await r.json() as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; browser_download_url: string; digest?: string }[] };
    const version = v.tag_name?.replace(/^v/, "") ?? "";
    if (v.draft || v.prerelease || !/^v\d+\.\d+\.\d+$/.test(v.tag_name ?? "")) throw new Error("发布版本格式无效");
    const file = v.assets?.find((a) => a.name === this.asset);
    this.offer = undefined;
    if (newerRelease(version, this.current)) {
      if (!file || !/^sha256:[a-f0-9]{64}$/.test(file.digest ?? "") || file.browser_download_url !== `https://github.com/${REPO}/releases/download/v${version}/${this.asset}`) throw new Error("发布缺少本节点的安装包或 SHA-256 校验信息");
      this.offer = { version, asset: file.name, url: file.browser_download_url, digest: file.digest!.slice(7) };
    }
    this.state = { current: this.current, supported: this.state.supported, ...(this.state.reason ? { reason: this.state.reason } : {}), phase: "checked", ...(this.offer ? { available: version } : {}) };
    return this.snapshot();
  }
  prepare(version: string): State {
    if (!this.state.supported || !this.offer || this.offer.version !== version) throw new Error("请先检查并选择本节点可用的新版本");
    if (["downloading", "installing"].includes(this.state.phase)) throw new Error("更新正在进行");
    const offer = this.offer;
    this.state = { ...this.state, phase: "downloading" };
    delete this.state.error;
    void this.download(offer).catch((e: unknown) => { this.state = { ...this.state, phase: "failed", error: e instanceof Error ? e.message : "下载失败" }; });
    return this.snapshot();
  }
  private async download(offer: Offer): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const archive = join(this.dir, offer.asset), unpack = join(this.dir, "unpack");
    rmSync(unpack, { recursive: true, force: true });
    mkdirSync(unpack, { recursive: true });
    const r = await fetch(offer.url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`下载安装包失败（HTTP ${r.status}）`);
    await pipeline(Readable.fromWeb(r.body as never), createWriteStream(archive, { mode: 0o600 }));
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest("hex") !== offer.digest) throw new Error("安装包 SHA-256 校验失败，未安装");
    if (this.app) {
      await exec("/usr/bin/ditto", ["-x", "-k", archive, unpack]);
      const app = join(unpack, "AgentSwitch.app");
      const version = (await exec("/usr/bin/defaults", ["read", join(app, "Contents", "Info"), "CFBundleShortVersionString"])).stdout.trim();
      if (version !== offer.version) throw new Error("Mac 安装包版本不匹配");
      await exec("/usr/bin/codesign", ["--verify", "--deep", app]);
    } else {
      const entries = (await exec("tar", ["-tzf", archive], { maxBuffer: 32 * 1024 * 1024 })).stdout.split("\n").filter(Boolean);
      if (entries.some((p) => p.startsWith("/") || p.split("/").includes("..") || !p.startsWith("runtime/"))) throw new Error("安装包目录无效");
      await exec("tar", ["-xzf", archive, "-C", unpack], { maxBuffer: 1024 * 1024 });
      const pkg = JSON.parse(readFileSync(join(unpack, "runtime", "daemon", "package.json"), "utf8")) as { version?: string };
      if (pkg.version !== offer.version || !existsSync(join(unpack, "runtime", "node", "bin", "node"))) throw new Error("Linux 安装包版本或内容无效");
    }
    this.state = { ...this.state, phase: "ready", staged: offer.version };
  }
  async install(version: string): Promise<State> {
    if (this.state.phase !== "ready" || this.state.staged !== version) throw new Error("该版本尚未下载并校验完成");
    this.state = { ...this.state, phase: "installing" };
    try {
    if (this.app) {
      const next = join(dirname(this.app), "next");
      mkdirSync(next, { recursive: true });
      if (existsSync(join(next, "AgentSwitch.app"))) throw new Error("节点已有待安装的本地构建，请先处理它再安装 Release");
      const partial = join(next, "AgentSwitch.release.partial");
      rmSync(partial, { recursive: true, force: true });
      await exec("/usr/bin/ditto", [join(this.dir, "unpack", "AgentSwitch.app"), partial]);
      renameSync(partial, join(next, "AgentSwitch.app"));
      requestInstall(this.home, "confirmed remote release update", Date.now());
    } else {
      if (!this.runtime) throw new Error("不支持此安装方式");
      await exec("systemctl", ["--user", "is-active", "agentswitch.service"]);
      const destination = join(dirname(this.runtime), `release-${version}-${Date.now()}`);
      // Copy beside current: the downloaded data directory may be on a different filesystem.
      await exec("cp", ["-a", join(this.dir, "unpack", "runtime"), destination]);
      const script = join(this.dir, "install.mjs");
      writeFileSync(script, LINUX_INSTALL_HELPER, { mode: 0o600 });
      await exec("systemd-run", ["--user", "--collect", `--unit=agentswitch-update-${Date.now()}`, process.execPath, script,
        JSON.stringify({ current: join(dirname(this.runtime), "current"), previous: this.runtime, next: destination, version, port: Number(process.env.AGENTSWITCH_PORT ?? 4711), result: join(this.dir, "result.json") })]);
    }
    return this.snapshot();
    } catch (error) {
      this.state = { ...this.state, phase: "ready" };
      throw error;
    }
  }
}

// Runs outside agentswitch.service so its restart cannot kill the rollback watchdog.
export const LINUX_INSTALL_HELPER = `
import { symlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const o = JSON.parse(process.argv[2]);
const pause = ms => new Promise(r => setTimeout(r, ms));
const swap = path => { rmSync(o.current + '.update', {force:true}); symlinkSync(path, o.current + '.update'); renameSync(o.current + '.update', o.current); };
const restart = () => execFileSync('systemctl', ['--user','restart','agentswitch.service'], {timeout:60000});
const result = value => writeFileSync(o.result, JSON.stringify({...value, version:o.version, at:Date.now()}), {mode:0o600});
await pause(o.delay ?? 2000);
try {
  swap(o.next); restart();
  let healthy = false;
  for (let i=0;i<(o.attempts ?? 90);i++) {
    try { const r=await fetch('http://127.0.0.1:'+o.port+'/healthz',{signal:AbortSignal.timeout(1500)}); const v=await r.json(); if(v.ok && v.version===o.version) {healthy=true;break;} } catch {}
    await pause(o.interval ?? 1000);
  }
  if(!healthy) throw new Error('new version did not become healthy');
  result({ok:true,reverted:false});
} catch(e) {
  try { swap(o.previous); restart(); result({ok:false,reverted:true,error:String(e)}); }
  catch(back) { result({ok:false,reverted:false,error:String(e)+'; rollback: '+String(back)}); }
}
`;
