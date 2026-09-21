import { describe, expect, it } from "vitest";
import { KeyedLock, Semaphore } from "../src/engine/locks.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Semaphore", () => {
  it("admits up to the limit, queues FIFO, hands the slot to the next waiter on release", async () => {
    const s = new Semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    expect(s.full).toBe(true);
    const order: string[] = [];
    const p3 = s.acquire().then((r) => { order.push("3"); return r; });
    const p4 = s.acquire().then((r) => { order.push("4"); return r; });
    expect(s.waiting).toBe(2);
    r1();
    await tick();
    expect(order).toEqual(["3"]);
    expect(s.inUse).toBe(2);
    r2(); r2();                                   // double release is a no-op
    const r3 = await p3; const r4 = await p4;
    expect(order).toEqual(["3", "4"]);
    r3(); r4();
    expect(s.inUse).toBe(0);
    expect(() => new Semaphore(0)).toThrow();
  });

  it("an aborted waiter leaves the queue and rejects; an already-aborted signal rejects at once", async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    const ac = new AbortController();
    const p = s.acquire(ac.signal);
    const other = s.acquire();
    ac.abort(new Error("cancelled by user"));
    await expect(p).rejects.toThrow("cancelled by user");
    expect(s.waiting).toBe(1);
    r1();
    (await other)();
    const dead = new AbortController(); dead.abort();
    await expect(s.acquire(dead.signal)).rejects.toThrow();
  });
});

describe("KeyedLock", () => {
  it("serialises per key, independent across keys, forgets idle keys", async () => {
    const l = new KeyedLock();
    const a1 = await l.acquire("a");
    const b1 = await l.acquire("b");
    expect(l.isHeld("a")).toBe(true);
    let got = false;
    const a2 = l.acquire("a").then((r) => { got = true; return r; });
    await tick();
    expect(got).toBe(false);
    a1();
    (await a2)();
    b1();
    expect(l.isHeld("a")).toBe(false);
    expect(l.isHeld("nope")).toBe(false);
  });
});
