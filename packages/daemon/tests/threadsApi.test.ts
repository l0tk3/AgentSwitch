import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDaemon, sweepThreads, type DaemonConfig } from "../src/daemon.js";
import { Client } from "../src/client.js";
import { QuotaService } from "../src/quota/index.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, TARGETS_PATH } from "./helpers.js";

function daemon(replies: string[]) {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-thapi-"));
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4 };
  const quota = new QuotaService([]);
  const d = buildDaemon(cfg, { router: echoRouter(replies), quota });
  const fetchImpl: typeof fetch = (input, init) => Promise.resolve(d.app.request(input instanceof Request ? input : String(input).replace("http://test", ""), init));
  return { d, client: new Client("http://test", fetchImpl), home };
}

const tid = async (client: Client, id: string): Promise<string> => (await client.task(id)).threadId!;
/** Wait until routing has put the task in a thread (the echo router answers within a tick). */
async function waitThread(client: Client, id: string): Promise<string> {
  for (let i = 0; i < 50; i++) { const t = await client.task(id); if (t.threadId) return t.threadId; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("no thread assigned");
}

describe("threads over HTTP", () => {
  it("tasks open threads; handoff makes a follow-up in the same thread excluding the executor; thread detail lists both", async () => {
    const { d, client, home } = daemon([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null }), decisionJson({ harness: "claude-code", model: "claude-sonnet-5", effort: null })]);
    const a = await client.submit("do x", "/tmp");
    await client.watch(a.id, () => undefined);
    const list = await client.threads();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: (await tid(client, a.id)), cwd: "/tmp", status: "open", taskCount: 1, lastTarget: { harness: "codex", model: "gpt-5.5" } });
    expect(list[0]!.home.startsWith(join(home, "threads"))).toBe(true);
    const b = await client.handoff(a.id);
    expect(b).toMatchObject({ threadId: (await tid(client, a.id)), parentId: a.id, exclude: [{ harness: "codex", model: "gpt-5.5" }] });
    await client.watch(b.id, () => undefined);
    const detail = await client.thread((await tid(client, a.id)));
    expect(detail.tasks.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(detail.state.handoffs).toHaveLength(1);
    expect(detail.state.tasks.map((t) => t.status)).toEqual(["done", "done"]);
    expect((await client.task(b.id)).harness).toBe("claude-code");
    // a task can be submitted straight into the thread
    const c = await client.submit("more", "/tmp", { threadId: (await tid(client, a.id)) });
    expect(c.threadId).toBe((await tid(client, a.id)));
    await client.watch(c.id, () => undefined);
    await expect(client.submit("x", "/tmp", { threadId: "nope" })).rejects.toThrow(/thread not found/);
    await expect(client.handoff("nope")).rejects.toThrow(/not found/);
    d.close();
  });

  it("handoff with a pin; an ephemeral task's successor gets a fresh work dir", async () => {
    const { d, client } = daemon([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]);
    const a = await client.submit("do y", undefined, { ephemeral: true });
    await client.watch(a.id, () => undefined);
    const b = await client.handoff(a.id, { harness: "claude-code", model: "claude-haiku-4-5-20251001" });
    expect(b.pin).toEqual({ harness: "claude-code", model: "claude-haiku-4-5-20251001" });
    expect(b.exclude).toEqual([]);
    expect(b.cwd).not.toBe(a.cwd);
    expect(b.ephemeral).toBe(true);
    await client.watch(b.id, () => undefined);
    expect((await client.task(b.id)).status).toBe("done");
    d.close();
  });

  it("rename, archive (7 days), reopen, delete; archived threads refuse new tasks; sweep removes expired homes", async () => {
    const { d, client } = daemon([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]);
    const a = await client.submit("do z", "/tmp");
    await client.watch(a.id, () => undefined);
    const id = (await tid(client, a.id));
    const renamed = await client.patchThread(id, { title: "我的线程" });
    expect(renamed.title).toBe("我的线程");
    const archived = await client.archiveThread(id);
    expect(archived.status).toBe("archived");
    expect(archived.expiresAt! - Date.now()).toBeGreaterThan(6.9 * 86400_000);
    expect(await client.threads("open")).toEqual([]);
    expect((await client.threads("archived")).map((t) => t.id)).toEqual([id]);
    await expect(client.submit("x", "/tmp", { threadId: id })).rejects.toThrow(/archived/);
    await expect(client.handoff(a.id)).rejects.toThrow(/archived/);
    const custom = await client.patchThread(id, { expires_at: 5 });
    expect(custom.expiresAt).toBe(5);
    const home = custom.home;
    expect(existsSync(home)).toBe(true);
    expect(sweepThreads(d.store)).toEqual([id]);
    expect(existsSync(home)).toBe(false);
    await expect(client.thread(id)).rejects.toThrow(/not found/);
    const b = await client.submit("again", "/tmp");
    await client.watch(b.id, () => undefined);
    expect((await client.reopenThread((await tid(client, b.id)))).status).toBe("open");
    expect(await client.deleteThread((await tid(client, b.id)))).toEqual({ ok: true });
    await expect(client.deleteThread((await tid(client, b.id)))).rejects.toThrow(/not found/);
    await expect(client.patchThread("nope", { title: "x" })).rejects.toThrow(/not found/);
    d.close();
  });

  it("archive/delete refuse while a task in the thread is still running", async () => {
    const { d, client } = daemon([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]);
    const a = await client.submit('slow @echo {"delayMs":300}', "/tmp");
    const threadId = await waitThread(client, a.id);
    await expect(client.archiveThread(threadId)).rejects.toThrow(/still/);
    await expect(client.deleteThread(threadId)).rejects.toThrow(/still/);
    await client.watch(a.id, () => undefined);
    expect((await client.archiveThread((await tid(client, a.id)))).status).toBe("archived");
    d.close();
  });
});

describe("memory and records over HTTP", () => {
  it("GET/PUT /memory lints like CONTEXT.md; GET /records aggregates finished tasks", async () => {
    const { d, client } = daemon([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null, kind: "chat" })]);
    expect(await client.memory()).toMatchObject({ text: "" });
    const put = await client.putMemory("# m\n- site x needs secret_fill\n- password: hunter2secret\n");
    expect(put.warnings).toHaveLength(1);
    const got = await client.memory();
    expect(got.text).toContain("secret_fill");
    expect(got.text).not.toContain("hunter2secret");
    const a = await client.submit("hello", "/tmp");
    await client.watch(a.id, () => undefined);
    const recs = await client.records() as { kind: string; targets: { harness: string; runs: number }[] }[];
    expect(recs).toEqual([{ kind: "chat", targets: [expect.objectContaining({ harness: "codex", runs: 1, ok: 1 })] }]);
    d.close();
  });
});
