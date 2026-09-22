/** The plaintext entrance (router-v0 §9): credentials in a submission become tokens before anything is stored. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { looksSensitive } from "../src/secrets/detect.js";
import { fakeMinter, parseMintOutput, type MintEntry } from "../src/secrets/minter.js";
import { applyTokens, hostOf, parseSealReply, planSeal, routerSealer, sitesFromContext, type Sealer } from "../src/secrets/sealer.js";
import { decisionJson, TARGETS_PATH } from "./helpers.js";

const reply = (secrets: unknown[]) => JSON.stringify({ secrets });

describe("looksSensitive", () => {
  it("fires on credential words in either language and on key=value shapes, not on ordinary tasks", () => {
    expect(looksSensitive("登录财务系统，账号 lotke 密码 Hunter2!")).toBe(true);
    expect(looksSensitive("use API key sk-abc123 for the request")).toBe(true);
    expect(looksSensitive("token=deadbeefcafe")).toBe(true);
    expect(looksSensitive("把 README 里的错别字改一下")).toBe(false);
    expect(looksSensitive("list the files in packages/daemon")).toBe(false);
  });
});

describe("seal helpers", () => {
  it("hostOf strips scheme, credentials, path; sitesFromContext lists the URLs' hosts once", () => {
    expect(hostOf("https://user:pw@Core.internal:8600/login?x=1")).toBe("core.internal:8600");
    expect(hostOf("10.38.120.189:8443")).toBe("10.38.120.189:8443");
    expect(sitesFromContext("- 财务 http://core.internal:8600/ 和 https://core.internal:8600/x\n- 备份 https://10.38.120.189:8443")).toEqual(["core.internal:8600", "10.38.120.189:8443"]);
    expect(sitesFromContext(null)).toEqual([]);
  });

  it("parseSealReply tolerates prose around the JSON and rejects the wrong shape", () => {
    expect(parseSealReply(`Sure: ${reply([{ value: "Hunter2!", label: "finance/pass", hosts: ["http://core:8600/"] }])} done`)).toMatchObject({ ok: true, secrets: [{ value: "Hunter2!", kind: "secret", uses: ["http"] }] });
    expect(parseSealReply("nothing here")).toMatchObject({ ok: false });
    expect(parseSealReply(reply([{ value: "", label: "x" }]))).toMatchObject({ ok: false });
  });

  it("planSeal: short, absent or duplicate values are skipped; http without a host is unroutable; labels are cleaned", () => {
    const text = "账号 lotke 密码 Hunter2! 再来一次 Hunter2!";
    const plan = planSeal(text, [
      { value: "Hunter2!", label: "财务 pass", kind: "secret", hosts: ["http://core:8600/"], uses: ["http"] },
      { value: "Hunter2!", label: "dup", kind: "secret", hosts: ["core"], uses: ["http"] },
      { value: "abc", label: "short", kind: "secret", hosts: ["core"], uses: ["http"] },
      { value: "notthere", label: "absent", kind: "secret", hosts: ["core"], uses: ["http"] },
      { value: "lotke", label: "finance/account", kind: "secret", hosts: [], uses: ["http"] },
      { value: "lotke", label: "x", kind: "secret", hosts: [], uses: ["exec"] },
    ]);
    expect(plan.entries.map((e) => [e.label, e.hosts])).toEqual([["pass", ["core:8600"]]]);
    expect(plan.skipped).toEqual(["dup", "short", "absent", "x"]);
    expect(plan.unroutable).toEqual(["finance/account"]);
  });

  it("applyTokens replaces every occurrence, longest value first", () => {
    expect(applyTokens("pw=abcd; pw2=abcdef; again abcd", [{ value: "abcd", token: "T1" }, { value: "abcdef", token: "T2" }])).toBe("pw=T1; pw2=T2; again T1");
  });

  it("parseMintOutput keeps per-entry errors and rejects junk", () => {
    expect(parseMintOutput('[{"label":"a","token":"enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA"},{"label":"b","error":"invalid label"}]')).toEqual([{ label: "a", token: "enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA" }, { label: "b", error: "invalid label" }]);
    expect(() => parseMintOutput('[{"label":"a","token":"plain"}]')).toThrow(/unexpected output/);
  });
});

describe("routerSealer", () => {
  const found = [{ value: "Hunter2!", label: "finance/pass", hosts: ["http://core.internal:8600/"] }, { value: "lotke@x.io", label: "finance/account", hosts: ["core.internal:8600"] }];

  it("replaces the values the model found with minted tokens and reports labels and hosts only", async () => {
    const router = echoRouter([reply(found)]);
    const minted: MintEntry[][] = [];
    const minter = async (entries: readonly MintEntry[]) => { minted.push([...entries]); return fakeMinter()(entries); };
    const seal = routerSealer(router, minter, () => ["core.internal:8600"]);
    const r = await seal("登录 http://core.internal:8600/ 账号 lotke@x.io 密码 Hunter2!，导出九月报表");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).not.toContain("Hunter2!");
    expect(r.text).not.toContain("lotke@x.io");
    expect(r.text.match(/enc:v1:[A-Za-z0-9_=-]+/g)).toHaveLength(2);
    expect(r.text).toContain("导出九月报表");
    expect(r.sealed).toEqual([{ label: "finance/pass", kind: "secret", hosts: ["core.internal:8600"], uses: ["http"] }, { label: "finance/account", kind: "secret", hosts: ["core.internal:8600"], uses: ["http"] }]);
    expect(minted[0]!.map((e) => e.value)).toEqual(["Hunter2!", "lotke@x.io"]);
    expect(router.calls[0]!.task).toContain("User's site list");
    expect(router.calls[0]!.system).toContain("Reply with one JSON object only");
  });

  it("a table of accounts: every cell the model marks is sealed, the rest of the table stays", async () => {
    const table = "站点 http://core.internal:8600/\n| 用户 | 密码 |\n| alice | Pa55-alice |\n| bob | Pa55-bob |";
    const seal = routerSealer(echoRouter([reply([
      { value: "Pa55-alice", label: "finance/alice-pass", hosts: ["core.internal:8600"] }, { value: "alice", label: "finance/alice", hosts: ["core.internal:8600"] },
      { value: "Pa55-bob", label: "finance/bob-pass", hosts: ["core.internal:8600"] },
    ])]), fakeMinter(), () => []);
    const r = await seal(table);
    expect(r.ok && r.text).toMatch(/\| enc:v1:\S+ \| enc:v1:\S+ \|\n\| bob \| enc:v1:\S+ \|/);
  });

  it("nothing found leaves the text as is; a missing host, a bad reply, a minter failure or a timeout refuse the submission", async () => {
    expect(await routerSealer(echoRouter([reply([])]), fakeMinter(), () => [])("plain")).toMatchObject({ ok: true, text: "plain", sealed: [] });
    expect(await routerSealer(echoRouter([reply([{ value: "Hunter2!", label: "x/pass", hosts: [] }])]), fakeMinter(), () => [])("pw Hunter2!")).toMatchObject({ ok: false, code: "unroutable", error: expect.stringContaining("x/pass") });
    expect(await routerSealer(echoRouter(["no json"]), fakeMinter(), () => [])("pw Hunter2!")).toMatchObject({ ok: false, code: "unavailable" });
    const refusing = async (entries: readonly MintEntry[]) => entries.map((e) => ({ label: e.label, error: "invalid label" }));
    expect(await routerSealer(echoRouter([reply([{ value: "Hunter2!", label: "x/pass", hosts: ["a"] }])]), refusing, () => [])("pw Hunter2!")).toMatchObject({ ok: false, code: "unavailable", error: expect.stringContaining("secret-gate refused") });
    const slow = echoRouter([reply([])], { delayMs: 200 });
    expect(await routerSealer(slow, fakeMinter(), () => [], 20)("pw Hunter2!")).toMatchObject({ ok: false, code: "unavailable", error: expect.stringContaining("timed out") });
  });
});

describe("POST /tasks with plaintext credentials", () => {
  function daemon(sealer?: Sealer) {
    const home = mkdtempSync(join(tmpdir(), "agentswitch-seal-"));
    const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
    const d = buildDaemon(cfg, { router: echoRouter([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]), ...(sealer ? { sealer } : {}) });
    const post = (body: unknown) => d.app.request("/tasks", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { d, post };
  }

  it("the stored task, its events and the routing log only ever hold tokens; the sealed event names labels and hosts", async () => {
    const seal = routerSealer(echoRouter([reply([{ value: "Hunter2!", label: "finance/pass", hosts: ["core.internal:8600"] }])]), fakeMinter(), () => []);
    const { d, post } = daemon(seal);
    const res = await post({ task: "登录 http://core.internal:8600/ 密码 Hunter2!", cwd: "/tmp" });
    expect(res.status).toBe(201);
    const task = await res.json() as { id: string; task: string };
    expect(task.task).not.toContain("Hunter2!");
    expect(task.task).toMatch(/enc:v1:/);
    await d.engine.idle();
    expect(d.store.getTask(task.id)!.task).not.toContain("Hunter2!");
    const events = d.store.eventsSince(task.id, 0);
    expect(JSON.stringify(events)).not.toContain("Hunter2!");
    expect(events.find((e) => e.type === "sealed")?.payload).toEqual({ entries: [{ label: "finance/pass", kind: "secret", hosts: ["core.internal:8600"], uses: ["http"] }] });
    expect(JSON.stringify(d.store.getTask(task.id))).not.toContain("Hunter2!");
  });

  it("seal: true forces the sealer; without one the request is refused rather than stored in plaintext; a non-sensitive text skips it", async () => {
    const calls: string[] = [];
    const seal = async (text: string) => { calls.push(text); return { ok: true as const, text, sealed: [], ms: 1 }; };
    const { post } = daemon(seal);
    expect((await post({ task: "改一下 README", cwd: "/tmp" })).status).toBe(201);
    expect(calls).toEqual([]);
    expect((await post({ task: "改一下 README", cwd: "/tmp", seal: true })).status).toBe(201);
    expect(calls).toEqual(["改一下 README"]);
    const bare = daemon();
    expect((await bare.post({ task: "改一下 README", cwd: "/tmp", seal: true })).status).toBe(503);
    expect((await bare.post({ task: "密码 Hunter2!", cwd: "/tmp" })).status).toBe(201);   // echo mode without the gate: nothing to seal with, text goes as is
    const unroutable = routerSealer(echoRouter([reply([{ value: "Hunter2!", label: "x/pass", hosts: [] }])]), fakeMinter(), () => []);
    const r = await daemon(unroutable).post({ task: "密码 Hunter2!", cwd: "/tmp" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("x/pass");
  });
});
