import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { claudeProjectKey, cleanupEphemeral, isDeletableWorkDir, spellings, type CleanupPaths } from "../src/engine/cleanup.js";
import { Bus } from "../src/engine/bus.js";
import { Engine } from "../src/engine/engine.js";
import { Store } from "../src/engine/store.js";
import type { TaskEvent } from "../src/engine/types.js";
import { echoExecutor } from "../src/executors/echo.js";
import { echoRouter } from "../src/router/routers/echo.js";
import { decisionJson, realTargets } from "./helpers.js";

function fakeHomes(): CleanupPaths & { root: string } {
  const root = mkdtempSync(join(tmpdir(), "agentswitch-cleanup-"));
  const paths = { claudeHome: join(root, "claude"), opencodeData: join(root, "opencode"), workRoot: join(root, "work") };
  mkdirSync(join(paths.claudeHome, "projects"), { recursive: true });
  mkdirSync(paths.opencodeData, { recursive: true });
  mkdirSync(paths.workRoot, { recursive: true });
  return { ...paths, root };
}

function fakeOpenCodeDb(dataDir: string, cwd: string): void {
  const db = new DatabaseSync(join(dataDir, "opencode.db"));
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE project_directory (project_id TEXT, directory TEXT);
    CREATE TABLE worktree (id TEXT, project_id TEXT);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT);
    CREATE TABLE session_message (id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE session_pending (session_id TEXT); CREATE TABLE session_inbox (session_id TEXT);`);
  db.exec(`INSERT INTO project VALUES ('p1', '${cwd}'), ('keep', '/Users/x/keep');
    INSERT INTO project_directory VALUES ('p1', '${cwd}'), ('keep', '/Users/x/keep');
    INSERT INTO worktree VALUES ('w1', 'p1');
    INSERT INTO session_v2 VALUES ('s1', 'p1', '${cwd}'), ('s2', 'keep', '/Users/x/keep');
    INSERT INTO session_message VALUES ('m1', 's1', 'secret'), ('m2', 's1', 'x'), ('m3', 's2', 'keep');
    INSERT INTO session_pending VALUES ('s1'); INSERT INTO session_inbox VALUES ('s2');`);
  db.close();
  mkdirSync(join(dataDir, "snapshot", "p1", "x"), { recursive: true });
  mkdirSync(join(dataDir, "snapshot", "keep"), { recursive: true });
}

describe("cleanupEphemeral", () => {
  it("removes the work dir, Claude's project transcripts and OpenCode's rows for that directory only", () => {
    const h = fakeHomes();
    const cwd = mkdtempSync(join(h.workRoot, "task-"));
    writeFileSync(join(cwd, "hello.txt"), "hi");
    for (const p of spellings(cwd)) mkdirSync(join(h.claudeHome, "projects", claudeProjectKey(p)), { recursive: true });
    mkdirSync(join(h.claudeHome, "projects", "-Users-x-keep"));
    writeFileSync(join(h.claudeHome, "history.jsonl"), [JSON.stringify({ display: "a", project: cwd }), JSON.stringify({ display: "b", project: "/Users/x/keep" }), "not json", ""].join("\n"));
    fakeOpenCodeDb(h.opencodeData, cwd);

    const r = cleanupEphemeral(cwd, h);
    expect(r.errors).toEqual([]);
    expect(r.workDirRemoved).toBe(true);
    expect(existsSync(cwd)).toBe(false);
    expect(r.claudeProjectsRemoved.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(h.claudeHome, "projects", claudeProjectKey(cwd)))).toBe(false);
    expect(existsSync(join(h.claudeHome, "projects", "-Users-x-keep"))).toBe(true);
    expect(r.claudeHistoryLinesRemoved).toBe(1);
    expect(readFileSync(join(h.claudeHome, "history.jsonl"), "utf8")).toContain("/Users/x/keep");
    expect(r.opencodeSessionsRemoved).toBe(1);
    expect(r.opencodeProjectsRemoved).toBe(1);
    expect(r.opencodeSnapshotsRemoved).toEqual([join(h.opencodeData, "snapshot", "p1")]);
    const db = new DatabaseSync(join(h.opencodeData, "opencode.db"));
    expect(db.prepare("SELECT count(*) AS n FROM session_message").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM project").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM session_pending").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM session_inbox").get()).toEqual({ n: 1 });
    db.close();
    expect(existsSync(join(h.opencodeData, "snapshot", "keep"))).toBe(true);
  });

  it("never deletes a directory outside tmp or the work root, but still scrubs harness records", () => {
    const h = fakeHomes();
    const project = join(process.cwd(), `.tmp-real-project-${Date.now()}`);   // not under tmp or the work root
    mkdirSync(project);
    mkdirSync(join(h.claudeHome, "projects", claudeProjectKey(project)));
    expect(isDeletableWorkDir(project, h)).toBe(false);
    expect(isDeletableWorkDir(join(h.workRoot, "x"), h)).toBe(true);
    expect(isDeletableWorkDir(join(tmpdir(), "x"), h)).toBe(true);
    const r = cleanupEphemeral(project, h);
    expect(r.workDirRemoved).toBe(false);
    expect(existsSync(project)).toBe(true);
    expect(r.errors[0]).toContain("work dir kept");
    expect(r.claudeProjectsRemoved).toHaveLength(1);
    expect(r.opencodeSessionsRemoved).toBe(0);   // no db: nothing to do, no error
    rmSync(project, { recursive: true, force: true });
  });

  it("claude project key and path spellings", () => {
    expect(claudeProjectKey("/Users/me/Desktop/WorkSpace/Projects/AgentSwitch")).toBe("-Users-me-Desktop-WorkSpace-Projects-AgentSwitch");
    expect(claudeProjectKey("/private/var/folders/_c/x.y")).toBe("-private-var-folders--c-x-y");
    expect(spellings("/private/var/folders/x")).toContain("/var/folders/x");
    expect(spellings("/var/folders/x")).toContain("/private/var/folders/x");
  });
});

describe("engine ephemeral tasks", () => {
  it("emits a cleaned event after the task ends and the work dir is gone", async () => {
    const h = fakeHomes();
    const cwd = mkdtempSync(join(h.workRoot, "t-"));
    const store = new Store({ dbPath: ":memory:" });
    const bus = new Bus();
    const events: TaskEvent[] = [];
    bus.subscribe("*", (e) => events.push(e));
    const engine = new Engine({ store, bus, executors: [echoExecutor("codex")], targets: realTargets(), router: echoRouter([decisionJson({ harness: "codex", model: "gpt-5.5", effort: null })]), quota: () => ({}), cleanupPaths: h });
    const t = engine.submit({ task: "x", cwd, ephemeral: true });
    await engine.idle();
    expect(store.getTask(t.id)).toMatchObject({ status: "done", ephemeral: true });
    expect(events.filter((e) => e.taskId === t.id).map((e) => e.type).at(-1)).toBe("cleaned");
    expect(events.at(-1)!.payload).toMatchObject({ workDirRemoved: true });
    expect(existsSync(cwd)).toBe(false);
    const keep = engine.submit({ task: "y", cwd: mkdtempSync(join(h.workRoot, "k-")) });
    await engine.idle();
    expect(events.filter((e) => e.taskId === keep.id).map((e) => e.type)).not.toContain("cleaned");
  });
});
