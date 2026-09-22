/** The plaintext entrance (router-v0 §9): credentials in a submission become tokens before anything is stored. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { fakeMinter, parseMintOutput, type MintEntry } from "../src/secrets/minter.js";
import { applyTokens, hostOf, isWholeRecord, LEGEND_HEADER, parseSealReply, planSeal, recordDelimiter, routerSealer, splitRecord, type Sealer } from "../src/secrets/sealer.js";
import { composePrompt } from "../src/executors/instructions.js";
import { decisionJson, TARGETS_PATH } from "./helpers.js";

const reply = (secrets: unknown[], layout: string | null = null) => JSON.stringify({ secrets, layout });

describe("seal helpers", () => {
  it("hostOf strips scheme, credentials and path", () => {
    expect(hostOf("https://user:pw@Core.internal:8600/login?x=1")).toBe("core.internal:8600");
    expect(hostOf("10.38.120.189:8443")).toBe("10.38.120.189:8443");
  });

  it("parseSealReply tolerates prose around the JSON and rejects the wrong shape", () => {
    expect(parseSealReply(`Sure: ${reply([{ value: "Hunter2!", label: "finance/pass", hosts: ["http://core:8600/"] }])} done`)).toMatchObject({ ok: true, secrets: [{ value: "Hunter2!", kind: "secret", uses: ["http"] }] });
    expect(parseSealReply("nothing here")).toMatchObject({ ok: false });
    expect(parseSealReply(reply([{ value: "", label: "x" }]))).toMatchObject({ ok: false });
  });

  it("planSeal: short, absent or duplicate values are skipped; http without a host is unroutable; labels are cleaned", () => {
    const text = "账号 lotke 密码 Hunter2! 再来一次 Hunter2!";
    const plan = planSeal(text, [
      { value: "Hunter2!", label: "财务 pass", field: "", kind: "secret", hosts: ["http://core:8600/"], uses: ["http"] },
      { value: "Hunter2!", label: "dup", field: "", kind: "secret", hosts: ["core"], uses: ["http"] },
      { value: "abc", label: "short", field: "", kind: "secret", hosts: ["core"], uses: ["http"] },
      { value: "notthere", label: "absent", field: "", kind: "secret", hosts: ["core"], uses: ["http"] },
      { value: "lotke", label: "finance/account", field: "", kind: "secret", hosts: [], uses: ["http"] },
      { value: "lotke", label: "x", field: "", kind: "secret", hosts: [], uses: ["exec"] },
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
  const found = [{ value: "Hunter2!", label: "finance/pass", field: "account password", hosts: ["http://core.internal:8600/"] }, { value: "lotke@x.io", label: "finance/account", field: "login email", hosts: ["core.internal:8600"] }];

  it("replaces the values the model found with minted tokens and reports labels and hosts only", async () => {
    const router = echoRouter([reply(found)]);
    const minted: MintEntry[][] = [];
    const minter = async (entries: readonly MintEntry[]) => { minted.push([...entries]); return fakeMinter()(entries); };
    const seal = routerSealer(router, minter, () => "- 财务系统 http://core.internal:8600/ 账号 enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA");
    const r = await seal("登录 http://core.internal:8600/ 账号 lotke@x.io 密码 Hunter2!，导出九月报表");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).not.toContain("Hunter2!");
    expect(r.text).not.toContain("lotke@x.io");
    expect(r.text).toContain("导出九月报表");
    expect(r.sealed.map(({ token: _t, ...rest }) => rest)).toEqual([{ label: "finance/pass", field: "account password", kind: "secret", hosts: ["core.internal:8600"], uses: ["http"] }, { label: "finance/account", field: "login email", kind: "secret", hosts: ["core.internal:8600"], uses: ["http"] }]);
    const [body, legendPart] = r.text.split(LEGEND_HEADER);
    expect(body!.match(/enc:v1:[A-Za-z0-9_=-]+/g)).toHaveLength(2);
    expect(legendPart).toContain(`- account password (for core.internal:8600): ${r.sealed[0]!.token}`);
    expect(legendPart).toContain(`- login email (for core.internal:8600): ${r.sealed[1]!.token}`);
    expect(minted[0]!.map((e) => e.value)).toEqual(["Hunter2!", "lotke@x.io"]);
    expect(router.calls[0]!.task).toContain("User's environment context");
    expect(router.calls[0]!.task).toContain("core.internal:8600");
    expect(router.calls[0]!.system).toContain("Reply with one JSON object only");
  });

  it("a table of accounts: every cell the model marks is sealed, the rest of the table stays", async () => {
    const table = "站点 http://core.internal:8600/\n| 用户 | 密码 |\n| alice | Pa55-alice |\n| bob | Pa55-bob |";
    const seal = routerSealer(echoRouter([reply([
      { value: "Pa55-alice", label: "finance/alice-pass", hosts: ["core.internal:8600"] }, { value: "alice", label: "finance/alice", hosts: ["core.internal:8600"] },
      { value: "Pa55-bob", label: "finance/bob-pass", hosts: ["core.internal:8600"] },
    ])]), fakeMinter(), () => "");
    const r = await seal(table);
    expect(r.ok && r.text).toMatch(/\| enc:v1:\S+ \| enc:v1:\S+ \|\n\| bob \| enc:v1:\S+ \|/);
  });

  it("nothing found leaves the text as is; a missing host, a bad reply, a minter failure or a timeout refuse the submission", async () => {
    expect(await routerSealer(echoRouter([reply([])]), fakeMinter(), () => "")("plain")).toMatchObject({ ok: true, text: "plain", sealed: [] });
    expect(await routerSealer(echoRouter([reply([{ value: "Hunter2!", label: "x/pass", hosts: [] }])]), fakeMinter(), () => "")("pw Hunter2!")).toMatchObject({ ok: false, code: "unroutable", error: expect.stringContaining("x/pass") });
    expect(await routerSealer(echoRouter(["no json"]), fakeMinter(), () => "")("pw Hunter2!")).toMatchObject({ ok: false, code: "unavailable" });
    const refusing = async (entries: readonly MintEntry[]) => entries.map((e) => ({ label: e.label, error: "invalid label" }));
    expect(await routerSealer(echoRouter([reply([{ value: "Hunter2!", label: "x/pass", hosts: ["a"] }])]), refusing, () => "")("pw Hunter2!")).toMatchObject({ ok: false, code: "unavailable", error: expect.stringContaining("secret-gate refused") });
    const slow = echoRouter([reply([])], { delayMs: 200 });
    expect(await routerSealer(slow, fakeMinter(), () => "", 20)("pw Hunter2!")).toMatchObject({ ok: false, code: "unavailable", error: expect.stringContaining("timed out") });
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
    const seal = routerSealer(echoRouter([reply([{ value: "Hunter2!", label: "finance/pass", hosts: ["core.internal:8600"] }])]), fakeMinter(), () => "");
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
    const sealedEv = events.find((e) => e.type === "sealed")?.payload as { entries: { label: string; field: string; token: string }[] };
    expect(sealedEv.entries).toMatchObject([{ label: "finance/pass", field: "finance/pass", hosts: ["core.internal:8600"], token: expect.stringMatching(/^enc:v1:/) }]);
    expect(JSON.stringify(d.store.getTask(task.id))).not.toContain("Hunter2!");
  });

  it("every submission passes the sealer, a follow-up with its parent's text; without a sealer (echo mode) the text goes as is", async () => {
    const calls: { text: string; parent?: string; thread?: string }[] = [];
    const seal: Sealer = async (text, ctx = {}) => { calls.push({ text, ...(ctx.parentTask ? { parent: ctx.parentTask } : {}), ...(ctx.threadTitle ? { thread: ctx.threadTitle } : {}) }); return { ok: true, text, sealed: [], ms: 1 }; };
    const { d, post } = daemon(seal);
    const first = await post({ task: "改一下 README", cwd: "/tmp" });
    expect(first.status).toBe(201);
    expect(calls).toEqual([{ text: "改一下 README" }]);
    await d.engine.idle();
    const parentId = ((await first.json()) as { id: string }).id;
    expect((await post({ task: "再改标题", cwd: "/tmp", parent_id: parentId })).status).toBe(201);
    expect(calls[1]).toMatchObject({ text: "再改标题", parent: "改一下 README" });
    const bare = daemon();
    expect((await bare.post({ task: "密码 Hunter2!", cwd: "/tmp" })).status).toBe(201);
    const unroutable = routerSealer(echoRouter([reply([{ value: "Hunter2!", label: "x/pass", hosts: [] }])]), fakeMinter(), () => "");
    const r = await daemon(unroutable).post({ task: "密码 Hunter2!", cwd: "/tmp" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("x/pass");
  });
});

describe("records: pasted account lines (email|password|year|country|app password|session key)", () => {
  const line = "xx@aa.com|Pw-2024-secret|2024|United States|ggff elhf lchd cpkx|sessionkey-01-abcdef";
  const text = `把这个账号录进 http://panel.example:9000/ 的账号管理\n${line}`;
  const fields = [
    { value: "xx@aa.com", field: "login email", label: "acct1/email", hosts: ["panel.example:9000"] },
    { value: "Pw-2024-secret", field: "account password", label: "acct1/pass", hosts: ["panel.example:9000"] },
    { value: "ggff elhf lchd cpkx", field: "Google app password", label: "acct1/app-pass", hosts: ["panel.example:9000"] },
    { value: "sessionkey-01-abcdef", field: "session key", label: "acct1/session", hosts: ["panel.example:9000"] },
  ];
  const layout = "email | password | year | country | Google app password | session key";

  it("recordDelimiter / isWholeRecord / splitRecord", () => {
    expect(recordDelimiter(line)).toBe("|");
    expect(recordDelimiter("a,b")).toBeNull();
    expect(isWholeRecord(text, line)).toBe(true);
    expect(isWholeRecord(text, "Pw-2024-secret")).toBe(false);
    expect(isWholeRecord("a\nb", "a\nb")).toBe(true);
    const split = splitRecord({ value: line, field: "", label: "x", kind: "secret", hosts: ["h"], uses: ["http"] }, 1);
    expect(split.map((f) => f.value)).toEqual(["xx@aa.com", "Pw-2024-secret", "2024", "United States", "ggff elhf lchd cpkx", "sessionkey-01-abcdef"]);
    expect(split[4]).toMatchObject({ label: "record1/field5", field: "field 5 of record 1", hosts: ["h"] });
  });

  it("fields are sealed one by one, year and country stay in the clear, the legend names each token and the layout", async () => {
    const r = await routerSealer(echoRouter([reply(fields, layout)]), fakeMinter(), () => "")(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const recordLine = r.text.split("\n")[1]!;
    expect(recordLine).toMatch(/^enc:v1:\S+\|enc:v1:\S+\|2024\|United States\|enc:v1:\S+\|enc:v1:\S+$/);
    expect(r.text).toContain(`Record layout: ${layout}`);
    expect(r.text).toContain(`- Google app password (for panel.example:9000): ${r.sealed[2]!.token}`);
    for (const f of fields) expect(r.text).not.toContain(f.value);
  });

  it("a whole record marked as one value: asked again with feedback; still whole → every field sealed on its own", async () => {
    const whole = [{ value: line, field: "account", label: "acct/all", hosts: ["panel.example:9000"] }];
    const fixed = echoRouter([reply(whole), reply(fields, layout)]);
    const r1 = await routerSealer(fixed, fakeMinter(), () => "")(text);
    expect(fixed.calls).toHaveLength(2);
    expect(fixed.calls[1]!.task).toContain("marked whole records as single values (acct/all)");
    expect(r1.ok && r1.text).toContain("|2024|United States|");
    const stubborn = echoRouter([reply(whole)]);
    const r2 = await routerSealer(stubborn, fakeMinter(), () => "")(text);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.sealed).toHaveLength(6);
    expect(r2.text).not.toContain("xx@aa.com");
    expect(r2.text).not.toContain(line);
  });
});

describe("composePrompt: the user's own message reaches the executor when it carries tokens", () => {
  it("added after the brief only when it holds a token and differs from the brief", () => {
    const task = `录入账号 enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA\n\n${LEGEND_HEADER}\n- login email: enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA`;
    const p = composePrompt({ brief: "enter the account", task, handoffNote: null, context: null });
    expect(p.startsWith("enter the account\n\nThe user's own message")).toBe(true);
    expect(p).toContain("- login email: enc:v1:");
    expect(composePrompt({ brief: "b", task: "no tokens here", handoffNote: null, context: null })).toBe("b");
    expect(composePrompt({ brief: task, task, handoffNote: null, context: null })).toBe(task);
  });
});
