/** A person's Fill Ciphertext (docs/browser-v0.md §1, `POST /browser/tabs/:id/fill`) on a fake Chrome: the gate is asked
 *  for the value with the focused field's frame chain, the value is typed with `Input.insertText` and appears nowhere
 *  else (answer, audit, logs); only the screen that may drive the tab; only http(s); refused when focus moved meanwhile
 *  or the gate says no. And `gateFill`, the `secret-gate fill-value` call behind it. */

import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountBrowser } from "../src/api/browser.js";
import type { ApiDeps } from "../src/api/shared.js";
import { FillRefused, gateFill, type FillResolver } from "../src/browser/fill.js";
import { AGENT_TAB_FILL } from "../src/browser/host.js";
import { SECRET_FIELD } from "../src/browser/playwrightDriver.js";
import { sharedBrowser } from "../src/browser/setup.js";
import { markRemote } from "../src/core/caller.js";
import { FakeDriver } from "./fakeBrowser.js";

const TOKEN = `enc:v1:${"A".repeat(40)}`;
const PLAIN = "hunter2-plaintext-value";
const LOGIN = "https://login.portal.example/login";
const CODEX = { kind: "terminal" as const, id: "t1", label: "codex · AgentSwitch" };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const c of cleanups.splice(0)) await c(); });

function setup(fill?: FillResolver | null) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-fill-")));
  const driver = new FakeDriver();
  const asked: { token: string; frames: readonly string[] }[] = [];
  const resolver: FillResolver = fill === undefined ? async (token, frames) => { asked.push({ token, frames }); return { value: PLAIN, label: "portal/pw" }; } : fill ?? (undefined as unknown as FillResolver);
  const api = sharedBrowser({ home: root, userHome: root, driver, ownPorts: () => [], protected: { roots: [], exempt: [] }, ...(fill === null ? {} : { fill: resolver }),
    engine: async () => { throw new Error("no agents here"); } });
  cleanups.push(() => api.host.shutdown());
  const app = new Hono();
  mountBrowser(app, { browser: api } as unknown as ApiDeps);
  const call = async (method: string, path: string, body?: unknown, env?: object) => {
    const res = await app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }, env);
    return { status: res.status, text: await res.text() };
  };
  const auditText = () => { const p = join(root, "browser", "audit.jsonl"); return existsSync(p) ? readFileSync(p, "utf8") : ""; };
  const typed = (i = 0) => [...driver.page(i).fills, ...driver.page(i).inputs.filter((x) => x.method === "Input.insertText").map((x) => x.params.text)];
  return { api, driver, call, asked, auditText, typed };
}

describe("POST /browser/tabs/:id/fill", () => {
  it("asks the gate with the field's frame chain and types the value; the value is in no answer, audit or log", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    const { api, driver, call, asked, auditText, typed } = setup();
    const tab = await api.host.open({ kind: "you", id: "you", label: "You" }, LOGIN);
    driver.page(0).focused = { frames: ["https://login.portal.example/frame", LOGIN] };
    const res = await call("POST", `/browser/tabs/${tab.id}/fill`, { token: TOKEN, screen: "phone-1" }, markRemote({}, { deviceId: "dev-phone" }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ tab: { id: tab.id }, filled: { label: "portal/pw", host: "login.portal.example:443" } });
    expect(asked).toEqual([{ token: TOKEN, frames: ["https://login.portal.example/frame", LOGIN] }]);
    expect(typed()).toEqual([PLAIN]);
    const audit = auditText();
    expect(audit).toContain('"action":"fill"');
    expect(audit).toContain('"via":"dev-phone"');
    expect(audit).toContain('"label":"portal/pw"');
    for (const where of [res.text, audit, logs.join("\n")]) {
      expect(where).not.toContain(PLAIN);
      expect(where).not.toContain(TOKEN);
    }
  });

  it("only the screen that may drive the tab: a held tab by its holder", async () => {
    const { api, driver, call, asked, typed } = setup();
    const tab = await api.host.open({ kind: "you", id: "you", label: "You" }, LOGIN);
    driver.page(0).focused = { frames: [LOGIN] };
    api.host.take(tab.id, "phone-1");
    expect((await call("POST", `/browser/tabs/${tab.id}/fill`, { token: TOKEN, screen: "mac-1" })).status).toBe(409);
    expect(asked).toEqual([]);
    expect((await call("POST", `/browser/tabs/${tab.id}/fill`, { token: TOKEN, screen: "phone-1" })).status).toBe(200);
    expect(typed()).toEqual([PLAIN]);
    expect((await call("POST", "/browser/tabs/nope/fill", { token: TOKEN })).status).toBe(404);
  });

  // 2026-10-02 review: a value typed into an agent's tab stays in the page (and in the request the page sends), which
  // the agent reads after the hand-back.
  it("never on an agent's tab, even taken over: 409 with the reason, nothing asked or typed", async () => {
    const { api, driver, call, asked, typed } = setup();
    const tab = await api.host.open(CODEX, LOGIN);
    driver.page(0).focused = { frames: [LOGIN] };
    for (const take of [false, true]) {
      if (take) api.host.take(tab.id, "phone-1");
      const res = await call("POST", `/browser/tabs/${tab.id}/fill`, { token: TOKEN, screen: "phone-1" });
      expect(res.status).toBe(409);
      expect(JSON.parse(res.text).error).toBe(AGENT_TAB_FILL);
    }
    expect(asked).toEqual([]);
    expect(typed()).toEqual([]);
  });

  it("only into a password or one-time-code field: 400 otherwise, nothing asked or typed, the field let go", async () => {
    const { api, driver, call, asked, typed } = setup();
    const tab = await api.host.open({ kind: "you", id: "you", label: "You" }, LOGIN);
    driver.page(0).focused = { frames: [LOGIN], secret: false };
    const res = await call("POST", `/browser/tabs/${tab.id}/fill`, { token: TOKEN });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text).error).toBe("只能填入密码或验证码输入框。");
    expect(asked).toEqual([]);
    expect(typed()).toEqual([]);
    expect(driver.page(0).released).toBe(1);
  });

  it("needs a focused field on http(s) pages all the way up; nothing is asked or typed otherwise", async () => {
    const { api, driver, call, asked, typed, auditText } = setup();
    const tab = await api.host.open({ kind: "you", id: "you", label: "You" }, LOGIN);
    const page = driver.page(0);
    page.focused = null;
    const none = await call("POST", `/browser/tabs/${tab.id}/fill`, { token: TOKEN });
    expect(none.status).toBe(400);
    expect(JSON.parse(none.text).error).toContain("输入框");
    for (const frames of [["about:srcdoc", LOGIN], ["file:///Users/me/site/index.html"], [LOGIN, "data:text/html,x"], ["chrome-error://chromewebdata/"]]) {
      page.focused = { frames };
      const res = await call("POST", `/browser/tabs/${tab.id}/fill`, { token: TOKEN });
      expect(res.status, frames.join(" ")).toBe(403);
      expect(JSON.parse(res.text).error).toContain("http(s)");
    }
    expect(asked).toEqual([]);
    expect(typed()).toEqual([]);
    expect(auditText()).toContain('"kind":"fill"');
  });

  it("the gate's refusal is the answer, in its words, audited; nothing typed", async () => {
    const { api, driver, call, typed, auditText } = setup(async () => { throw new FillRefused("token 'portal/pw' is not allowed on host 'evil.example:443'"); });
    const tab = await api.host.open({ kind: "you", id: "you", label: "You" }, "https://evil.example/");
    driver.page(0).focused = { frames: ["https://evil.example/"] };
    const res = await call("POST", `/browser/tabs/${tab.id}/fill`, { token: TOKEN });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text)).toEqual({ error: "token 'portal/pw' is not allowed on host 'evil.example:443'" });
    expect(typed()).toEqual([]);
    expect(auditText()).toContain("not allowed on host");
  });

  it("an unexpected failure is not quoted (it could hold anything)", async () => {
    const { api, driver, call, typed } = setup(async () => { throw new Error(`boom ${PLAIN}`); });
    const tab = await api.host.open({ kind: "you", id: "you", label: "You" }, LOGIN);
    driver.page(0).focused = { frames: [LOGIN] };
    const res = await call("POST", `/browser/tabs/${tab.id}/fill`, { token: TOKEN });
    expect(res.status).toBe(403);
    expect(res.text).not.toContain(PLAIN);
    expect(typed()).toEqual([]);
  });

  it("focus that moved while the gate answered (another field, another frame) types nothing; the field is let go", async () => {
    const { api, driver, call, typed } = setup();
    const tab = await api.host.open({ kind: "you", id: "you", label: "You" }, LOGIN);
    driver.page(0).focused = { frames: [LOGIN] };
    driver.page(0).focusLater = { frames: ["https://ads.example/frame", LOGIN] };
    const res = await call("POST", `/browser/tabs/${tab.id}/fill`, { token: TOKEN });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.text).error).toContain("输入焦点已改变");
    expect(typed()).toEqual([]);
    expect(driver.page(0).released).toBe(1);
  });

  it("without the gate: 503; a bad body: 400 that does not echo it", async () => {
    const { api, driver, call } = setup(null);
    const tab = await api.host.open({ kind: "you", id: "you", label: "You" }, LOGIN);
    driver.page(0).focused = { frames: [LOGIN] };
    expect((await call("POST", `/browser/tabs/${tab.id}/fill`, { token: TOKEN })).status).toBe(503);
    const bad = await call("POST", `/browser/tabs/${tab.id}/fill`, { token: 7, secret: PLAIN });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain(PLAIN);
  });
});

describe("gateFill: secret-gate fill-value", () => {
  function fakeGate(): { bin: string; dir: string } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentswitch-fake-gate-")));
    const bin = join(dir, "secret-gate");
    writeFileSync(bin, `#!/bin/sh
printf '%s ' "$@" > "${dir}/argv"
printf '%s' "$SECRET_GATE_HOME" > "${dir}/home"
cat > "${dir}/stdin"
if grep -q evil "${dir}/stdin"; then echo "error: token 'portal/pw' is not allowed on host 'evil.example:443'" >&2; exit 2; fi
if grep -q garbage "${dir}/stdin"; then echo 'not json'; exit 0; fi
echo '{"value":"${PLAIN}","label":"portal/pw"}'
`);
    chmodSync(bin, 0o755);
    return { bin, dir };
  }

  it("sends the ciphertext and frames on stdin only, and reads the value and label back", async () => {
    const { bin, dir } = fakeGate();
    const fill = gateFill({ bin, home: "/g/home" });
    expect(await fill(TOKEN, [LOGIN])).toEqual({ value: PLAIN, label: "portal/pw" });
    expect(readFileSync(join(dir, "argv"), "utf8").trim()).toBe("fill-value");
    expect(readFileSync(join(dir, "home"), "utf8")).toBe("/g/home");
    expect(JSON.parse(readFileSync(join(dir, "stdin"), "utf8"))).toEqual({ token: TOKEN, urls: [LOGIN] });
  });

  it("the gate's reason is the refusal; odd output and non-ciphertexts are refused too", async () => {
    const { bin } = fakeGate();
    const fill = gateFill({ bin, home: "/g/home" });
    await expect(fill(TOKEN, ["https://evil.example/"])).rejects.toEqual(new FillRefused("token 'portal/pw' is not allowed on host 'evil.example:443'"));
    await expect(fill(TOKEN, ["https://garbage.example/"])).rejects.toBeInstanceOf(FillRefused);
    await expect(fill("enc:ref:abcdefghijklmnop", [LOGIN])).rejects.toThrow("enc:v1:");
    await expect(fill("hunter2", [LOGIN])).rejects.toThrow("enc:v1:");
    await expect(gateFill({ bin: "/nonexistent/secret-gate", home: "/g" })(TOKEN, [LOGIN])).rejects.toThrow("无响应");
  });
});

describe("which fields count as a secret's", () => {
  it("password fields and fields marked for a password or a one-time code; not other text fields", async () => {
    const { JSDOM } = await import("jsdom");
    const { document } = new JSDOM(`<form>
      <input id="pw" type="password"><input id="PW" type="PASSWORD"><input id="cur" autocomplete="username current-password">
      <input id="new" autocomplete="new-password"><input id="otp" type="text" inputmode="numeric" autocomplete="one-time-code">
      <input id="user" type="text" autocomplete="username"><input id="plain"><textarea id="area" autocomplete="one-time-code"></textarea>
      <input id="mail" type="email" autocomplete="email"></form>`).window;
    const matches = [...document.querySelectorAll(`input, textarea`)].filter((el) => el.matches(SECRET_FIELD)).map((el) => el.id);
    expect(matches).toEqual(["pw", "PW", "cur", "new", "otp"]);
  });
});
