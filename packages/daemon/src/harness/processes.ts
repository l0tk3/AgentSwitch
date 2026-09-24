/** Harness processes our adapters own: started in their own process group, stopped as a group. */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** Start a harness as the leader of its own process group (not on Windows), so terminateProcess reaches its tools too. */
export function spawnOwned(command: string, args: readonly string[], options: Omit<SpawnOptions, "detached">): ChildProcess {
  return spawn(command, args, { ...options, detached: process.platform !== "win32" });
}

/** SIGTERM to SIGKILL for a process group. */
const TERMINATE_GRACE_MS = 500;

const stopping = new WeakMap<ChildProcess, Promise<void>>();

/** Only for children started in their own process group by our adapters (spawnOwned). */
export function terminateProcess(child: ChildProcess, graceMs = TERMINATE_GRACE_MS): Promise<void> {
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
