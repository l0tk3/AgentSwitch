import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDaemon, VERSION, type DaemonConfig } from "../src/daemon.js";
import { Client } from "../src/client.js";
import { TARGETS_PATH } from "./helpers.js";

function daemon() {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-api-"));
  const cfg: DaemonConfig = { home, targetsPath: TARGETS_PATH, port: 0, opencodeBinary: "" };
  const d = buildDaemon(cfg);
  const fetchImpl: typeof fetch = (input, init) => Promise.resolve(d.app.request(input instanceof Request ? input : String(input).replace("http://test", ""), init));
  const client = new Client("http://test", fetchImpl);
  return { d, client, home };
}

describe("HTTP API", () => {
  it("health: the version, and the old Dispatch's count the apps still read, always 0", async () => {
    const { d, client } = daemon();
    expect(await client.health()).toEqual({ ok: true, version: VERSION, pendingApprovals: 0 });
    d.close();
  });

  it("the old Dispatch's routes are gone (2026-11-25): 404, whatever is sent", async () => {
    const { d } = daemon();
    for (const [method, path] of [["GET", "/tasks"], ["POST", "/tasks"], ["GET", "/tasks/x"], ["GET", "/tasks/x/events"], ["GET", "/tasks/x/files"], ["GET", "/threads"], ["GET", "/approvals"], ["GET", "/approvals/policy"],
      ["GET", "/quota"], ["POST", "/quota/refresh"], ["GET", "/targets"], ["GET", "/routing/log"], ["POST", "/route/preview"], ["GET", "/context"], ["PUT", "/context"], ["GET", "/memory"], ["GET", "/records"],
      ["GET", "/platform-memory"], ["GET", "/assistant"], ["POST", "/assistant"], ["DELETE", "/history"], ["GET", "/search"], ["GET", "/attachments"], ["GET", "/mcp"], ["GET", "/skills"], ["GET", "/settings/models"]] as const) {
      const res = await d.app.request(path, { method, ...(method === "GET" || method === "DELETE" ? {} : { headers: { "content-type": "application/json" }, body: "{}" }) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    d.close();
  });

  it("uploads are staged for a terminal to take: names made safe, an empty form refused", async () => {
    const { d } = daemon();
    const form = new FormData();
    form.append("files", new File([Buffer.from("PNG")], "shot.png", { type: "image/png" }));
    form.append("files", new File([Buffer.from("spec")], "../spec.md", { type: "text/markdown" }));
    const up = await d.app.request("/uploads", { method: "POST", body: form });
    expect(up.status).toBe(200);
    const { files } = (await up.json()) as { files: { id: string; name: string; size: number; type: string }[] };
    expect(files.map((f) => [f.name, f.size, f.type])).toEqual([["shot.png", 3, "image/png"], ["spec.md", 4, "text/markdown"]]);
    expect((await d.app.request("/uploads", { method: "POST", body: new FormData() })).status).toBe(400);
    expect((await d.app.request("/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    d.close();
  });

  it("serves the web console, which opens on the terminals page and only talks to the API", async () => {
    const { d } = daemon();
    const res = await d.app.request("/ui");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Terminals — AgentSwitch</title>");
    expect(html).toContain('src="/ui/terminal.js"');
    // only its own scripts, never framed (the terminal page can reach the Mac app's bridge)
    for (const path of ["/ui", "/ui/terminal.html"]) {
      const csp = (await d.app.request(path)).headers.get("content-security-policy") ?? "";
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
    }
    const js = await d.app.request("/ui/lib/panes.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect((await d.app.request("/ui/terminal.css")).headers.get("content-type")).toContain("text/css");
    // The old Dispatch's pages went with it.
    for (const gone of ["/ui/app.js", "/ui/app.css", "/ui/index.html", "/ui/lib/actions.js", "/ui/views/home.js"]) expect((await d.app.request(gone)).status, gone).toBe(404);
    expect((await d.app.request("/ui/../package.json")).status).toBe(404);
    expect((await d.app.request("/ui/%2e%2e/package.json")).status).toBe(404);
    expect((await d.app.request("/ui/nope.js")).status).toBe(404);
    const root = await d.app.request("/");
    expect([root.status, root.headers.get("location")]).toEqual([302, "/ui"]);
    d.close();
  });
});
