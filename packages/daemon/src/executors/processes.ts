/** Only for children started in their own process group by our adapters. */
import type { ChildProcess } from "node:child_process";

const stopping = new WeakMap<ChildProcess, Promise<void>>();
export function terminateProcess(child: ChildProcess, graceMs = 500): Promise<void> {
  const pending = stopping.get(child);
  if (pending) return pending;
  if (!child.pid) return Promise.resolve();
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch { /* Process/group already exited. */ }
  };
  const done = new Promise<void>((resolve) => {
    let exited = child.exitCode !== null || child.signalCode !== null;
    let killed = false;
    const finish = () => {
      if (!killed || !exited) return;
      // A detached descendant can hold inherited pipes open after the owned process/group exits.
      // Wait for the child's exit, not indefinite EOF on those inherited descriptors.
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      resolve();
    };
    child.once("exit", () => { exited = true; finish(); });
    child.once("close", () => { exited = true; finish(); });
    signal("SIGTERM");
    // Wait through the group deadline even if the harness exits before its browser/MCP children.
    setTimeout(() => {
      signal("SIGKILL"); killed = true;
      finish();
    }, graceMs);
  });
  stopping.set(child, done);
  return done;
}
