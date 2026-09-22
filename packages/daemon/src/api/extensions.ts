/** MCP servers and skills: the registry is the source of truth, executors read it on every run. */

import type { Hono } from "hono";
import { z } from "zod";
import type { Extensions } from "../extensions/index.js";
import { HARNESSES, McpServer, SkillName } from "../extensions/types.js";
import { issues } from "./shared.js";

const SkillBody = z.object({ content: z.string().optional(), enabled: z.boolean().optional(), harnesses: z.array(z.enum(HARNESSES)).optional() });
const ImportBody = z.object({ path: z.string().min(1) });

export function mountExtensions(app: Hono, ext: Extensions): void {
  app.get("/mcp", (c) => c.json(ext.mcp.list()));
  app.put("/mcp/:name", async (c) => {
    const body = McpServer.safeParse({ ...(await c.req.json().catch(() => ({}))), name: c.req.param("name") });
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    return c.json(ext.mcp.upsert(body.data));
  });
  app.delete("/mcp/:name", (c) => (ext.mcp.remove(c.req.param("name")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));

  app.get("/skills", (c) => c.json(ext.skills.list()));
  app.get("/skills/discover", (c) => c.json(ext.skills.discover()));
  app.post("/skills/import", async (c) => {
    const body = ImportBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    try { return c.json(ext.skills.importFrom(body.data.path), 201); } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });
  app.get("/skills/:name", (c) => {
    const name = c.req.param("name");
    const skill = ext.skills.get(name);
    return skill ? c.json({ ...skill, content: ext.skills.content(name) }) : c.json({ error: "not found" }, 404);
  });
  app.put("/skills/:name", async (c) => {
    const name = SkillName.safeParse(c.req.param("name"));
    if (!name.success) return c.json({ error: issues(name.error) }, 400);
    const body = SkillBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    try { return c.json(ext.skills.write(name.data, body.data)); } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });
  app.delete("/skills/:name", (c) => (ext.skills.remove(c.req.param("name")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));
}

