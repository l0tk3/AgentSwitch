/** A Codex profile with a folder all its own (docs/profiles-v0.md, 2026-11-22): nothing of the Mac's own Codex linked
 *  in, a copy of what was picked, its own sessions — listed with the rest, moved when a thread goes on under another
 *  profile — and a terminal started from a few variables only. */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { mountProfiles } from "../src/api/profiles.js";
import type { ApiDeps } from "../src/api/shared.js";
import { moveCodexSession } from "../src/profiles/context.js";
import { ProfileStore } from "../src/profiles/store.js";
import { codexFileOf, SessionMonitor } from "../src/sessions/monitor.js";
import { profileEnvironment } from "../src/terminals/profileEnvironment.js";

const THREAD = "019a3c5e-7f10-7abc-8def-0123456789ab";
function world() {
  const root = mkdtempSync(join(tmpdir(), "agentswitch-codex-isolation-"));
  const userHome = join(root, "user"), own = join(userHome, ".codex");
  mkdirSync(join(own, "skills", "one"), { recursive: true });
  mkdirSync(join(own, "prompts"));
  writeFileSync(join(own, "config.toml"), 'model = "x"\n');
  writeFileSync(join(own, "AGENTS.md"), "mine\n");
  writeFileSync(join(own, "auth.json"), '{"OPENAI_API_KEY":"the-macs-own"}');
  writeFileSync(join(own, "skills", "one", "SKILL.md"), "skill\n");
  symlinkSync(join(own, "auth.json"), join(own, "skills", "one", "link"));
  const store = new ProfileStore({ home: join(root, "service"), userHome });
  return { root, userHome, own, store };
}
function rollout(sessions: string, day: string, text: string) {
  const dir = join(sessions, "2026", "11", day);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-11-${day}T10-00-00-${THREAD}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session_meta", timestamp: new Date().toISOString(), payload: { id: THREAD, cwd: "/Users/u/proj", originator: "codex-tui" } }) + "\n"
    + JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }) + "\n");
  return file;
}

it("is made with nothing linked: a copy of what was picked, never the sign-in or a link; and takes nothing of the Mac's own later", () => {
  const w = world();
  expect(w.store.codexCopyOptions()).toEqual(["config.toml", "AGENTS.md", "skills", "prompts"]);
  const p = w.store.create("codex", "Apart", "subscription", undefined, undefined, ["config.toml", "skills"]);
  expect(p.isolated).toBe(true);
  const home = w.store.homeOf("codex", p.id)!;
  for (const own of ["config.toml", "skills", "sessions", "archived_sessions"]) expect(lstatSync(join(home, own)).isSymbolicLink(), own).toBe(false);
  expect(readFileSync(join(home, "skills", "one", "SKILL.md"), "utf8")).toBe("skill\n");
  for (const absent of ["AGENTS.md", "prompts", "auth.json", join("skills", "one", "link")]) expect(existsSync(join(home, absent)), absent).toBe(false);
  // The copy is the profile's own from then on.
  writeFileSync(join(w.own, "config.toml"), 'model = "changed"\n');
  writeFileSync(join(w.own, "AGENTS.override.md"), "new\n");
  w.store.keepLinked("codex", p.id);
  expect(readFileSync(join(home, "config.toml"), "utf8")).toBe('model = "x"\n');
  expect(existsSync(join(home, "AGENTS.override.md"))).toBe(false);
  // Its sign-in imported: still nothing linked.
  w.store.setCodexAuth(p.id, JSON.stringify({ OPENAI_API_KEY: "its-own" }));
  expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
  expect(readFileSync(join(home, "auth.json"), "utf8")).toContain("its-own");
  expect(w.store.codexSessionRoots()).toEqual([join(home, "sessions")]);
  expect(w.store.codexSessionsOf(p.id)).toBe(join(home, "sessions"));
  // The kind made before shares the Mac's own, linked; only an account profile of Codex's has a folder of its own.
  const shared = w.store.create("codex", "Shared", "subscription");
  expect(shared.isolated).toBeUndefined();
  expect(lstatSync(join(w.store.homeOf("codex", shared.id)!, "config.toml")).isSymbolicLink()).toBe(true);
  expect(w.store.codexSessionsOf(shared.id)).toBe(join(w.own, "sessions"));
  expect(() => w.store.create("claude-code", "No", "subscription", undefined, undefined, [])).toThrow();
  expect(() => w.store.create("codex", "Bad", "subscription", undefined, undefined, ["auth.json" as never])).toThrow();
});

it("a new Codex account profile made by the screens has a folder all its own", async () => {
  const w = world();
  const app = new Hono<any>();
  mountProfiles(app, { profiles: w.store } as ApiDeps);
  expect(await (await app.request("/profiles/codex/copy-options")).json()).toEqual({ items: ["config.toml", "AGENTS.md", "skills", "prompts"] });
  const made = await app.request("/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "codex", name: "Team", copyCodex: ["AGENTS.md"] }) });
  expect(made.status).toBe(201);
  const profile = (await made.json()).profile;
  expect(profile.isolated).toBe(true);
  const home = w.store.homeOf("codex", profile.id)!;
  expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("mine\n");
  expect(existsSync(join(home, "config.toml"))).toBe(false);
  expect((await app.request("/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "codex", name: "Bad", copyCodex: ["auth.json"] }) })).status).toBe(400);
});

it("its threads are listed with the Mac's own, and a thread's record goes to the profile it goes on under, id and all", () => {
  const w = world(), p = w.store.create("codex", "Apart", "subscription", undefined, undefined, []);
  const mine = join(w.own, "sessions"), theirs = w.store.codexSessionsOf(p.id);
  const first = rollout(mine, "20", "first page"), second = rollout(mine, "21", "second page");
  const sessions = new SessionMonitor({ claudeProjects: join(w.root, "none"), codexSessions: mine, codexProfileSessions: () => w.store.codexSessionRoots(), opencodeDb: join(w.root, "none.db"), excluded: [] });
  expect(sessions.list().map((s) => s.id)).toEqual([THREAD]);
  moveCodexSession(sessions.locate("codex", THREAD)!, theirs, (name) => codexFileOf(name, THREAD));
  for (const gone of [first, second]) expect(existsSync(gone)).toBe(false);
  for (const day of ["20", "21"]) expect(existsSync(join(theirs, "2026", "11", day, `rollout-2026-11-${day}T10-00-00-${THREAD}.jsonl`))).toBe(true);
  const after = new SessionMonitor({ claudeProjects: join(w.root, "none"), codexSessions: mine, codexProfileSessions: () => w.store.codexSessionRoots(), opencodeDb: join(w.root, "none.db"), excluded: [] });
  expect(after.list().map((s) => s.id)).toEqual([THREAD]);
  expect(after.locate("codex", THREAD)).toContain(p.id);
  // Never over a record the target has; to the folder it is in already, nothing.
  rollout(mine, "21", "another of the same name");
  expect(() => moveCodexSession(after.locate("codex", THREAD)!, mine, (name) => codexFileOf(name, THREAD))).toThrow();
  expect(existsSync(join(theirs, "2026", "11", "20", `rollout-2026-11-20T10-00-00-${THREAD}.jsonl`))).toBe(true);
  moveCodexSession(join(theirs, "2026", "11", "20", `rollout-2026-11-20T10-00-00-${THREAD}.jsonl`), theirs, (name) => codexFileOf(name, THREAD));
});

it("starts from a few variables only; Codex's other profiles from the service's own environment", () => {
  const source = { PATH: "/bin", HOME: "/Users/u", TERM: "xterm", OPENAI_API_KEY: "sk", GITHUB_TOKEN: "t", LANG: "C" };
  expect(profileEnvironment(source, { harness: "codex", configHome: "/p/home", isolated: true })).toEqual({ PATH: "/bin", HOME: "/Users/u", TERM: "xterm", LANG: "C" });
  expect(profileEnvironment(source, { harness: "codex", configHome: "/p/home" })).toEqual(source);
  expect(profileEnvironment(source, { harness: "codex" })).toEqual(source);
});
