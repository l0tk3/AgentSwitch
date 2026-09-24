import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { AppServerClient } from "../src/harness/appserver.js";
import { terminateProcess } from "../src/harness/processes.js";

describe("executor process stop", () => {
  it.skipIf(process.platform === "win32")("forces an isolated fixture process that ignores graceful termination to exit", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await once(child.stdout!, "data");
      const closed = once(child, "close");
      terminateProcess(child, 25);
      const [, signal] = await closed;
      expect(signal).toBe("SIGKILL");
    } finally { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } }
  }, 2000);

  it("rejects a new RPC immediately after abort closed the app-server", async () => {
    const client = new AppServerClient(new PassThrough(), new PassThrough(), async () => ({}), () => undefined);
    client.fail(new Error("stopped"));
    await expect(client.request("initialize")).rejects.toThrow("closed");
  });

  it("turns an app-server broken pipe into a rejected RPC rather than an unhandled process error", async () => {
    const input = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("EPIPE")); } });
    const client = new AppServerClient(input, new PassThrough(), async () => ({}), () => undefined);
    await expect(client.request("initialize")).rejects.toThrow("EPIPE");
    await expect(client.request("thread/start")).rejects.toThrow("closed");
  });

  it.skipIf(process.platform === "win32")("finishes owned-process cleanup even when a detached fixture descendant holds inherited pipes", async () => {
    const script = "const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});process.stdout.write(String(child.pid)+'\\n');setInterval(()=>{},1000);";
    const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let descendant: number | undefined;
    try {
      const [data] = await once(child.stdout!, "data"); descendant = Number(String(data).trim());
      await terminateProcess(child, 25);
      expect(child.signalCode).toBe("SIGKILL");
      expect(child.stdout!.destroyed).toBe(true);
    } finally {
      for (const pid of [descendant, child.pid]) if (pid) try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }, 2000);
});
