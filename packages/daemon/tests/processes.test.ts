/** Owned process groups (harness/processes.ts): what an agent's program started goes with it. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { spawnOwned, terminateProcess } from "../src/harness/processes.js";

describe("spawnOwned", () => {
  it.skipIf(process.platform === "win32")("starts the harness as the leader of its own process group", async () => {
    const child = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      expect(child.pid).toBeGreaterThan(0);
      const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child.pid)], { encoding: "utf8" }).trim());
      expect(pgid).toBe(child.pid);
      const closed = once(child, "close");
      await terminateProcess(child, 25);
      await closed;
    } finally { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } }
  }, 5000);
});
