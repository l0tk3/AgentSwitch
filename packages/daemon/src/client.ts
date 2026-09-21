/** Thin HTTP client used by the CLI; the phone app will do the same calls. */

import type { Approval, Task, TaskEvent } from "./engine/types.js";
import type { Thread, ThreadState } from "./threads/types.js";

export type ThreadView = Thread & { summary: ThreadState["summary"]; lastTarget: ThreadState["lastTarget"]; lastActivity: number | null; taskCount: number; handoffs: number };

export class Client {
  constructor(private readonly base: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  health() { return this.call<{ ok: boolean; version: string }>("GET", "/healthz"); }
  submit(task: string, cwd: string | undefined, opts: { pin?: { harness: string; model: string }; needsBrowser?: boolean; ephemeral?: boolean; parentId?: string; threadId?: string } = {}) {
    return this.call<Task>("POST", "/tasks", { task, ...(cwd ? { cwd } : {}), ...(opts.pin ? { pin: opts.pin } : {}), ...(opts.needsBrowser ? { needs_browser: true } : {}), ...(opts.ephemeral ? { ephemeral: true } : {}), ...(opts.parentId ? { parent_id: opts.parentId } : {}), ...(opts.threadId ? { thread_id: opts.threadId } : {}) });
  }
  handoff(taskId: string, to?: { harness: string; model: string }) { return this.call<Task>("POST", `/tasks/${taskId}/handoff`, to ? { to } : {}); }
  threads(status?: "open" | "archived") { return this.call<ThreadView[]>("GET", `/threads${status ? `?status=${status}` : ""}`); }
  thread(id: string) { return this.call<ThreadView & { state: ThreadState; tasks: Task[] }>("GET", `/threads/${id}`); }
  patchThread(id: string, patch: { title?: string | null; status?: "open" | "archived"; expires_at?: number | null }) { return this.call<ThreadView>("PATCH", `/threads/${id}`, patch); }
  archiveThread(id: string) { return this.call<ThreadView>("POST", `/threads/${id}/archive`); }
  reopenThread(id: string) { return this.call<ThreadView>("POST", `/threads/${id}/reopen`); }
  deleteThread(id: string) { return this.call<{ ok: true }>("DELETE", `/threads/${id}`); }
  tasks(limit = 20) { return this.call<Task[]>("GET", `/tasks?limit=${limit}`); }
  task(id: string) { return this.call<Task & { approvals: Approval[] }>("GET", `/tasks/${id}`); }
  approve(taskId: string, approvalId: string, decision: "allow" | "deny") { return this.call<{ ok: true }>("POST", `/tasks/${taskId}/approve`, { approval_id: approvalId, decision }); }
  cancel(id: string) { return this.call<Task>("POST", `/tasks/${id}/cancel`); }
  approvals() { return this.call<Approval[]>("GET", "/approvals"); }
  quota(refresh = false) { return this.call<unknown[]>("GET", `/quota${refresh ? "?refresh=1" : ""}`); }
  preview(task: string, cwd: string) { return this.call<unknown>("POST", "/route/preview", { task, cwd }); }
  routingLog(limit = 20) { return this.call<unknown[]>("GET", `/routing/log?limit=${limit}`); }
  context() { return this.call<{ path: string; text: string; warnings: string[] }>("GET", "/context"); }
  files(taskId: string) { return this.call<{ root: "artifacts" | "cwd" | null; files: { path: string; size: number; mtime: number }[] }>("GET", `/tasks/${taskId}/files`); }
  contextExample() { return this.call<{ text: string }>("GET", "/context/example"); }
  mcp() { return this.call<unknown[]>("GET", "/mcp"); }
  skills() { return this.call<unknown[]>("GET", "/skills"); }

  /** Follow a task's SSE stream; calls onEvent for each event, resolves when the task ends. */
  async watch(id: string, onEvent: (ev: TaskEvent) => void | Promise<void>, after = 0): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/tasks/${id}/events?after=${after}`);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data:"));
        if (data) await onEvent(JSON.parse(data.slice(5).trim()) as TaskEvent);
      }
    }
  }
}
