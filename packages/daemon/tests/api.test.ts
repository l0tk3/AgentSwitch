import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { Client } from "../src/client.js";
import { QuotaService } from "../src/quota/index.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, TARGETS_PATH } from "./helpers.js";

function daemon(replies: string[] = [decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]) {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-api-"));
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", quotaTtlMs: 1000 };
  const quota = new QuotaService([{ harness: "codex", read: async () => ({ remaining: 0.5, detail: { planType: "pro" }, source: "fake", error: null }) }]);
  const d = buildDaemon(cfg, { router: echoRouter(replies), quota });
  const fetchImpl: typeof fetch = (input, init) => Promise.resolve(d.app.request(input instanceof Request ? input : String(input).replace("http://test", ""), init));
  const client = new Client("http://test", fetchImpl);
  return { d, client, home };
}

describe("HTTP API", () => {
  it("health, submit, list, show, events (SSE) and done", async () => {
    const { d, client } = daemon();
    expect((await client.health()).ok).toBe(true);
    const t = await client.submit("do x", "/tmp");
    expect(t.status).toBe("queued");
    const seen: string[] = [];
    await client.watch(t.id, (ev) => { seen.push(ev.type); });
    expect(seen).toEqual(["queued", "routed", "dispatched", "text", "done"]);
    expect((await client.tasks())[0]!.id).toBe(t.id);
    expect((await client.task(t.id)).status).toBe("done");
    // replay after completion also works, and `after` skips old events
    const replay: number[] = [];
    await client.watch(t.id, (ev) => { replay.push(ev.seq); }, 3);
    expect(replay).toEqual([4, 5]);
    d.close();
  });

  it("approval round trip through the API", async () => {
    const { d, client } = daemon();
    const t = await client.submit('x @echo {"approval":"rm -rf /tmp/x"}', "/tmp");
    let approvalId = "";
    await client.watch(t.id, async (ev) => {
      if (ev.type === "approval_request") {
        approvalId = String(ev.payload.approvalId);
        expect((await client.approvals()).map((a) => a.id)).toEqual([approvalId]);
        expect((await client.task(t.id)).approvals).toHaveLength(1);
        await client.approve(t.id, approvalId, "allow");
      }
    });
    expect((await client.task(t.id)).status).toBe("done");
    await expect(client.approve(t.id, approvalId, "allow")).rejects.toThrow(/no pending approval/);
    d.close();
  });

  it("validation errors, 404s, cancel", async () => {
    const { d, client } = daemon([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]);
    await expect(client.submit("", "/tmp")).rejects.toThrow(/task/);
    await expect(client.task("nope")).rejects.toThrow(/not found/);
    await expect(client.cancel("nope")).rejects.toThrow(/not found/);
    const res = await d.app.request("/tasks/nope/events");
    expect(res.status).toBe(404);
    const t = await client.submit('x @echo {"approval":"rm"}', "/tmp");
    await new Promise((r) => setTimeout(r, 30));
    expect((await client.cancel(t.id)).status).toBe("cancelled");
    await d.engine.idle();
    d.close();
  });

  it("quota, targets, preview, routing log, context", async () => {
    const { d, client, home } = daemon();
    const q = await client.quota(true) as { harness: string; remaining: number }[];
    expect(q).toEqual([expect.objectContaining({ harness: "codex", remaining: 0.5 })]);
    const targets = await (await d.app.request("/targets")).json() as { quota: Record<string, number>; harnesses: object };
    expect(targets.quota).toEqual({ codex: 0.5 });
    expect(Object.keys(targets.harnesses)).toContain("claude-code");
    const preview = await client.preview("summarize", "/tmp") as { verdict: { harness: string } };
    expect(preview.verdict.harness).toBe("codex");
    expect((await client.routingLog()).length).toBe(1);
    expect((await client.context()).text).toBe("");
    const put = await d.app.request("/context", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "- 密码 plain123\n- ok" }) });
    expect(((await put.json()) as { warnings: string[] }).warnings).toHaveLength(1);
    expect((await client.context()).path).toBe(join(home, "CONTEXT.md"));
    expect((await client.context()).text).toContain("[removed");
    d.close();
  });
});
