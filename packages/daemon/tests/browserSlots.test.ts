/** The profile folders of the browsers the daemon holds (core/browserSlots.ts): no saved passwords or autofill in
 *  them, and a Chrome still on a profile is stopped before it is used again. */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeBrowsersOf, disablePasswordManager } from "../src/core/browserSlots.js";

describe("a browser profile's preferences", () => {
  it("the password manager and autofill are switched off, what else the profile says kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-profile-"));
    disablePasswordManager(dir);
    const read = () => JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8"));
    expect(read()).toMatchObject({ credentials_enable_service: false, profile: { password_manager_enabled: false }, autofill: { profile_enabled: false, credit_card_enabled: false } });
    writeFileSync(join(dir, "Default", "Preferences"), JSON.stringify({ profile: { name: "Me", password_manager_enabled: true }, zoom: 2 }));
    disablePasswordManager(dir);
    expect(read()).toMatchObject({ zoom: 2, profile: { name: "Me", password_manager_enabled: false }, credentials_enable_service: false });
  });
});

describe("closeBrowsersOf (review, 2026-10-02)", () => {
  /** Processes of a profile that quit after `quitAfter` polls once signalled (`ignoreTerm`: only SIGKILL works;
   *  `never`: nothing does). Records what was sent, and whether the locks were still there while a process ran. */
  function fakeProcesses(o: { running?: boolean; quitAfter?: number; ignoreTerm?: boolean; never?: boolean }, dir: string) {
    const sent: string[] = [];
    let alive = o.running ?? true;
    let polls = 0;
    let killed = false;
    const locksWhileRunning: boolean[] = [];
    return {
      sent, locksWhileRunning,
      ops: {
        signal: (_pattern: string, signal: "TERM" | "KILL") => { sent.push(signal); if (signal === "KILL") killed = true; return alive; },
        running: () => {
          if (alive && !o.never && (!o.ignoreTerm || killed) && polls++ >= (o.quitAfter ?? 0)) alive = false;
          if (alive) locksWhileRunning.push(existsSync(join(dir, "SingletonLock")));
          return alive;
        },
        sleep: () => undefined,
      },
    };
  }
  const profile = () => {
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-close-"));
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) writeFileSync(join(dir, lock), "x");
    return dir;
  };
  const locks = (dir: string) => ["SingletonLock", "SingletonSocket", "SingletonCookie"].filter((l) => existsSync(join(dir, l)));

  it("removes the locks only once the profile's Chrome has quit", () => {
    const dir = profile();
    const fake = fakeProcesses({ quitAfter: 3 }, dir);
    expect(closeBrowsersOf(dir, fake.ops)).toBe(true);
    expect(fake.sent).toEqual(["TERM"]);
    expect(fake.locksWhileRunning).toEqual([true, true, true]);
    expect(locks(dir)).toEqual([]);
  });

  it("no Chrome on the profile: the locks go at once", () => {
    const dir = profile();
    const fake = fakeProcesses({ running: false }, dir);
    expect(closeBrowsersOf(dir, fake.ops)).toBe(true);
    expect(locks(dir)).toEqual([]);
  });

  it("a Chrome that ignores SIGTERM gets SIGKILL; one that never quits keeps its locks", () => {
    const stubborn = profile();
    const fake = fakeProcesses({ ignoreTerm: true }, stubborn);
    expect(closeBrowsersOf(stubborn, fake.ops)).toBe(true);
    expect(fake.sent).toEqual(["TERM", "KILL"]);
    expect(locks(stubborn)).toEqual([]);
    const stuck = profile();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(closeBrowsersOf(stuck, fakeProcesses({ never: true }, stuck).ops)).toBe(false);
    expect(locks(stuck)).toEqual(["SingletonLock", "SingletonSocket", "SingletonCookie"]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
