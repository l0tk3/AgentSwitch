/** GET /tasks/:id/files[/*] serves a task's own in/ and out/ (or its artifacts), never the rest of a user-chosen cwd, never
 *  through a symlink or hard link, never from a cwd the rules refuse (security review 2026-09-24). */

import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDaemon, type DaemonConfig } from "../src/daemon.js";
import { QuotaService } from "../src/quota/index.js";
import { TARGETS_PATH } from "./helpers.js";

type Listing = { root: string | null; files: { path: string }[] };

function daemon(home = mkdtempSync(join(tmpdir(), "agentswitch-tf-"))) {
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, router: "echo", executors: "echo", browser: false, quotaTtlMs: 1000, maxTasks: 4, opencodePort: 0, opencodeBinary: "" };
  const d = buildDaemon(cfg, { quota: new QuotaService([]) });
  const post = (body: unknown) => d.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { d, home, post };
}

/** A project with a secret next to in/ and out/, and links out of out/. */
function project(daemonHome: string): { dir: string; outside: string } {
  const dir = mkdtempSync(join(tmpdir(), "agentswitch-tf-proj-"));
  const outside = mkdtempSync(join(tmpdir(), "agentswitch-tf-outside-"));
  writeFileSync(join(outside, "id_ed25519"), "PRIVATE KEY");
  writeFileSync(join(dir, "secret.txt"), "project secret");
  mkdirSync(join(dir, "in"));
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "in", "a.txt"), "attachment");
  writeFileSync(join(dir, "out", "report.md"), "# report");
  writeFileSync(join(dir, "out", "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  symlinkSync(join(dir, "secret.txt"), join(dir, "out", "link.txt"));
  symlinkSync(join(daemonHome, "agentswitch.db"), join(dir, "out", "db"));
  symlinkSync(outside, join(dir, "out", "sub"));
  linkSync(join(outside, "id_ed25519"), join(dir, "out", "hard.txt"));
  return { dir, outside };
}

describe("task files", () => {
  it("list and serve only in/ and out/ of a user cwd, without symlinks or hard links", async () => {
    const { d, home, post } = daemon();
    const p = project(home);
    const created = await post({ task: 'x @echo {"result":"ok"}', cwd: p.dir });
    expect(created.status).toBe(201);
    const t = (await created.json()) as { id: string };
    await d.engine.idle();
    const listed = (await (await d.app.request(`/tasks/${t.id}/files`)).json()) as Listing;
    expect(listed.root).toBe("cwd");
    expect(listed.files.map((f) => f.path)).toEqual(["in/a.txt", "out/pic.svg", "out/report.md"]);

    const get = (rel: string) => d.app.request(`/tasks/${t.id}/files/${rel}`);
    expect(await (await get("in/a.txt")).text()).toBe("attachment");
    const report = await get("out/report.md");
    expect(report.status).toBe(200);
    expect(report.headers.get("x-content-type-options")).toBe("nosniff");
    expect(report.headers.get("content-security-policy")).toContain("sandbox");
    expect((await get("out/pic.svg")).headers.get("content-security-policy")).toMatch(/default-src 'none'.*sandbox/);
    for (const rel of ["secret.txt", "out/link.txt", "out/db", "out/sub/id_ed25519", "out/hard.txt", "in", "out/", "out/../secret.txt",
      "out/%2e%2e/secret.txt", "out/..%2fsecret.txt", "in%2f..%2fsecret.txt", "%2e%2e/%2e%2e/etc/passwd", "%2fetc%2fpasswd", "out/%252e%252e/secret.txt", "out/%E0%A4%A"]) {
      expect((await get(rel)).status, rel).toBe(404);
    }
    d.close();
  });

  it("a symlinked in/ or out/ is not the task's", async () => {
    const { d, post } = daemon();
    const dir = mkdtempSync(join(tmpdir(), "agentswitch-tf-links-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "agentswitch-tf-else-"));
    writeFileSync(join(elsewhere, "notes.txt"), "not yours");
    symlinkSync(elsewhere, join(dir, "in"));
    symlinkSync(elsewhere, join(dir, "out"));
    const t = (await (await post({ task: 'x @echo {"result":"ok"}', cwd: dir })).json()) as { id: string };
    await d.engine.idle();
    expect(await (await d.app.request(`/tasks/${t.id}/files`)).json()).toEqual({ root: "cwd", files: [] });
    expect((await d.app.request(`/tasks/${t.id}/files/out/notes.txt`)).status).toBe(404);
    expect((await d.app.request(`/tasks/${t.id}/files/in/notes.txt`)).status).toBe(404);
    d.close();
  });

  it("POST /tasks refuses a cwd that contains the daemon home, or reaches it through a symlink or `..`", async () => {
    const { d, home, post } = daemon();
    const links = mkdtempSync(join(tmpdir(), "agentswitch-tf-cwdlinks-"));
    symlinkSync(home, join(links, "daemon"));
    for (const cwd of [tmpdir(), join(links, "daemon"), join(home, "work", "..", ".."), join(home, "..")]) {
      const res = await post({ task: "x", cwd });
      expect(res.status, cwd).toBe(400);
      expect(((await res.json()) as { error: string }).error, cwd).toMatch(/credentials or the daemon's own state/);
    }
    expect(d.store.listTasks(10)).toEqual([]);
    d.close();
  });

  it("a task whose cwd the rules refuse now (stored before they were tightened) serves nothing", async () => {
    const outer = mkdtempSync(join(tmpdir(), "agentswitch-tf-outer-"));   // holds the daemon home, like /Users holds ~/.agentswitch
    const { d, post } = daemon(join(outer, "state"));
    mkdirSync(join(outer, "out"));
    writeFileSync(join(outer, "out", "anything"), "x");
    const t = d.engine.submit({ task: 'x @echo {"result":"ok"}', cwd: outer, ephemeral: false });
    await d.engine.idle();
    expect(await (await d.app.request(`/tasks/${t.id}/files`)).json()).toEqual({ root: null, files: [] });
    expect((await d.app.request(`/tasks/${t.id}/files/out/anything`)).status).toBe(404);
    // Nor does a follow-up or a handoff take that cwd over; a follow-up that names its own cwd is fine.
    const followUp = await post({ task: "again", parent_id: t.id });
    expect(followUp.status).toBe(400);
    expect(((await followUp.json()) as { error: string }).error).toMatch(/parent task's cwd .* contains/);
    expect((await d.app.request(`/tasks/${t.id}/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    const project = mkdtempSync(join(tmpdir(), "agentswitch-tf-next-"));
    expect((await post({ task: 'again @echo {"result":"ok"}', parent_id: t.id, cwd: project })).status).toBe(201);
    await d.engine.idle();
    d.close();
  });
});
