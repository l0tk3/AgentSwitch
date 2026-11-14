import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReleaseUpdater, releaseAsset, newerRelease, LINUX_INSTALL_HELPER } from "../src/files/releaseUpdate.js";

afterEach(() => vi.unstubAllGlobals());
describe("explicit node release updates", () => {
  it.each([true, false])("watchdog switches only to a healthy version, or rolls back (healthy=%s)", async (healthy) => {
    const root = mkdtempSync(join(tmpdir(), "as-update-watchdog-"));
    const server = createServer((_req, res) => res.end(JSON.stringify({ ok: true, version: healthy ? "0.3.0" : "0.2.0" })));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const previous = join(root, "old"), next = join(root, "new"), current = join(root, "current"), bin = join(root, "bin"), result = join(root, "result.json");
      for (const dir of [previous, next, bin]) mkdirSync(dir);
      symlinkSync(previous, current);
      writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const script = join(root, "install.mjs");
      writeFileSync(script, LINUX_INSTALL_HELPER);
      const port = (server.address() as import("node:net").AddressInfo).port;
      await promisify(execFile)(process.execPath, [script, JSON.stringify({ current, previous, next, result, version: "0.3.0", port, attempts: 1, delay: 0, interval: 1 })],
        { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, timeout: 10_000 });
      expect(realpathSync(current)).toBe(realpathSync(healthy ? next : previous));
      expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({ ok: healthy, reverted: !healthy });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("chooses the platform package and compares versions numerically", () => {
    expect(releaseAsset("linux", "arm64")).toBe("agentswitch-runtime-linux-aarch64.tar.gz");
    expect(releaseAsset("linux", "x64")).toBe("agentswitch-runtime-linux-x86_64.tar.gz");
    expect(releaseAsset("darwin", "arm64")).toBe("AgentSwitch-mac-arm64.zip");
    expect(releaseAsset("win32", "x64")).toBeNull();
    expect(newerRelease("0.10.0", "0.2.0")).toBe(true);
    expect(newerRelease("0.2.0", "0.2.0")).toBe(false);
    expect(newerRelease("0.2.0-beta", "0.1.0")).toBe(false);
  });
  it("checking does not download; bad checksums never reach installation", async () => {
    const home = mkdtempSync(join(tmpdir(), "as-release-"));
    try {
      const asset = releaseAsset(process.platform, process.arch)!;
      const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ tag_name: "v0.2.0", draft: false, prerelease: false,
        assets: [{ name: asset, browser_download_url: `https://github.com/l0tk3/AgentSwitch/releases/download/v0.2.0/${asset}`, digest: `sha256:${"0".repeat(64)}` }] })))
        .mockResolvedValueOnce(new Response("corrupt package"));
      vi.stubGlobal("fetch", fetcher);
      const updater = new ReleaseUpdater(home, "0.1.0", join(home, "AgentSwitch.app"));
      expect((await updater.check()).available).toBe("0.2.0");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(existsSync(join(home, "release-update"))).toBe(false);
      await expect(updater.install("0.2.0")).rejects.toThrow("尚未下载");
      expect(() => updater.prepare("0.3.0")).toThrow("先检查");
      updater.prepare("0.2.0");
      await vi.waitFor(() => expect(updater.snapshot().phase).toBe("failed"));
      expect(updater.snapshot().error).toContain("SHA-256");
      expect(existsSync(join(home, "update-request.json"))).toBe(false);
      await expect(updater.install("0.2.0")).rejects.toThrow("尚未下载");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
