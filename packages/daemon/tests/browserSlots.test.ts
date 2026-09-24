/** Browser session slots (threads-v0 §4b): three profiles kept between tasks so a login carries over — the thread's own
 *  slot first, then one that has been on the same site, then a free one, then the least recently used, wiped. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_SLOTS, BrowserSlots, namedHosts } from "../src/executors/browserSlots.js";

function pool(now = { t: 1000 }) {
  const root = join(mkdtempSync(join(tmpdir(), "agentswitch-slots-")), "browser-profiles");
  return { root, now, slots: new BrowserSlots(root, BROWSER_SLOTS, () => now.t, () => undefined) };
}
const cookie = (dir: string) => { mkdirSync(join(dir, "Default"), { recursive: true }); writeFileSync(join(dir, "Default", "Cookies"), "session"); };
const hasCookie = (dir: string) => existsSync(join(dir, "Default", "Cookies"));

describe("browser session slots", () => {
  it("a thread gets its own slot back, with the login still in it", () => {
    const { slots } = pool();
    const first = slots.acquire({ threadId: "t1", hosts: ["x.com"] })!;
    expect(first).toMatchObject({ id: 1, reason: "free", reused: false });
    cookie(first.dir);
    first.release();
    const again = slots.acquire({ threadId: "t1", hosts: [] })!;
    expect(again).toMatchObject({ id: 1, reason: "thread", reused: true });
    expect(hasCookie(again.dir)).toBe(true);
    again.release();
  });

  it("another thread on the same site reuses that slot; an unrelated one gets a free slot", () => {
    const { slots, now } = pool();
    const a = slots.acquire({ threadId: "t1", hosts: ["x.com"] })!;
    cookie(a.dir);
    a.release();
    now.t += 10;
    const b = slots.acquire({ threadId: "t2", hosts: ["www.x.com", "example.org"].flatMap((h) => namedHosts(h)) })!;
    expect(b).toMatchObject({ id: a.id, reason: "site", reused: true });
    b.release();
    const c = slots.acquire({ threadId: "t3", hosts: ["grafana.internal.test"] })!;
    expect(c).toMatchObject({ reason: "free", reused: false });
    expect(c.id).not.toBe(a.id);
    c.release();
  });

  it("with every slot used, the least recently used one is wiped for the newcomer", () => {
    const { slots, now } = pool();
    for (const t of ["t1", "t2", "t3"]) {
      const l = slots.acquire({ threadId: t, hosts: [`${t}.test`] })!;
      cookie(l.dir);
      l.release();
      now.t += 10;
    }
    const d = slots.acquire({ threadId: "t4", hosts: ["t4.test"] })!;
    expect(d).toMatchObject({ id: 1, reason: "evicted", reused: false });
    expect(hasCookie(d.dir)).toBe(false);
    d.release();
    expect(slots.list().map((s) => s.threadId)).toEqual(["t4", "t2", "t3"]);
  });

  it("a slot is used by one run at a time; with all three busy there is none (a throw-away profile then)", () => {
    const { slots } = pool();
    const held = ["t1", "t2", "t3"].map((t) => slots.acquire({ threadId: t, hosts: [] })!);
    expect(slots.acquire({ threadId: "t1", hosts: [] })).toBeNull();
    held[0]!.release();
    expect(slots.acquire({ threadId: "t9", hosts: [] })).toMatchObject({ id: 1 });
  });

  it("deleting a thread wipes its slot, at once or when the running task gives it back", () => {
    const { slots } = pool();
    const idle = slots.acquire({ threadId: "t1", hosts: ["x.com"] })!;
    cookie(idle.dir);
    idle.release();
    slots.forgetThread("t1");
    expect(hasCookie(idle.dir)).toBe(false);
    expect(slots.list()[0]).toMatchObject({ threadId: null, hosts: [] });

    const busy = slots.acquire({ threadId: "t2", hosts: [] })!;
    cookie(busy.dir);
    slots.forgetThread("t2");
    expect(hasCookie(busy.dir)).toBe(true);    // still in use
    busy.release();
    expect(hasCookie(busy.dir)).toBe(false);
  });

  it("the password manager and autofill are off in every slot profile", () => {
    const { slots } = pool();
    const l = slots.acquire({ threadId: "t1", hosts: [] })!;
    const prefs = JSON.parse(readFileSync(join(l.dir, "Default", "Preferences"), "utf8"));
    expect(prefs).toMatchObject({ credentials_enable_service: false, profile: { password_manager_enabled: false }, autofill: { profile_enabled: false, credit_card_enabled: false } });
    l.release();
  });

  it("the index survives a restart; a missing or broken index wipes every slot rather than guess whose login it holds", () => {
    const { slots, root } = pool();
    const l = slots.acquire({ threadId: "t1", hosts: ["x.com"] })!;
    cookie(l.dir);
    l.release();
    const restarted = new BrowserSlots(root, BROWSER_SLOTS, () => 2000, () => undefined);
    expect(restarted.acquire({ threadId: "t1", hosts: [] })).toMatchObject({ id: 1, reason: "thread", reused: true });

    writeFileSync(join(root, "slots.json"), "{broken");
    const reset = new BrowserSlots(root, BROWSER_SLOTS, () => 3000, () => undefined);
    expect(hasCookie(join(root, "slot-1"))).toBe(false);
    expect(reset.list().every((s) => s.threadId === null && s.hosts.length === 0)).toBe(true);
  });

  it("names the sites in a task's text", () => {
    expect(namedHosts("登陆 x.com 搜索 kyc，再去 https://www.Example.org:8443/a?b 和 mail.internal.test 看看")).toEqual(["x.com", "example.org", "mail.internal.test"]);
    expect(namedHosts("改一下 src/app.ts 和 README.md，结果写到 out/a.png")).toEqual([]);
    expect(namedHosts("发邮件到 alice@corp.example.com")).toEqual(["corp.example.com"]);
  });
});
