/** 设置 › Agents of this node, for another node's screen (docs/agents-v0.md §12). What is installed of the agent CLIs is
 *  found, installed, updated and deleted by this node's Mac app, not by this service: the app hands its board over
 *  here and takes what was asked of it from here; the other node reads the board and asks. This service keeps the
 *  board as it was given (it does not read it) and the actions in the order they came, for a short while. */

import type { Hono } from "hono";
import { z } from "zod";
import { remoteCaller } from "../core/caller.js";
import { parseBody } from "./shared.js";

/** A board is this old at most to be the app's of now (it hands one over every few seconds while it runs). */
const FRESH_MS = 15_000;
/** An action nobody took (the app is not running) is forgotten: it must not run hours later. */
const ACTION_MS = 60_000;
const MAX_ACTIONS = 32, MAX_BOARD = 1024 * 1024;

const Action = z.object({
  kind: z.enum(["refresh", "check", "use", "install", "update", "delete", "clean", "cancel", "dismiss", "restart"]),
  agent: z.enum(["claude", "codex", "opencode", "pi"]).optional(),
  key: z.string().min(1).max(600).optional(),
  source: z.enum(["stable", "beta", "pinned", "app", "other"]).optional(),
  version: z.string().regex(/^[0-9A-Za-z.+_-]{1,64}$/).optional(),
  row: z.string().min(1).max(600).optional(),
}).strict();
type Action = z.infer<typeof Action>;

export function mountAgentsBoard(app: Hono<any>, now: () => number = Date.now): void {
  let board: { readonly value: unknown; readonly at: number } | null = null;
  let asked: { readonly action: Action; readonly at: number }[] = [];
  const local = (c: { env: unknown }): boolean => !remoteCaller(c.env);

  // ---- this node's own app

  app.put("/agents/board", async (c) => {
    if (!local(c)) return c.json({ error: "this is the Mac app's own" }, 403);
    const text = await c.req.text();
    if (text.length > MAX_BOARD) return c.json({ error: "too large" }, 413);
    let value: unknown;
    try { value = JSON.parse(text); } catch { return c.json({ error: "not JSON" }, 400); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return c.json({ error: "not a board" }, 400);
    board = { value, at: now() };
    return c.json({ ok: true });
  });

  app.get("/agents/actions", (c) => {
    if (!local(c)) return c.json({ error: "this is the Mac app's own" }, 403);
    const taken = asked.filter((a) => now() - a.at <= ACTION_MS).map((a) => a.action);
    asked = [];
    return c.json({ actions: taken });
  });

  // ---- whoever looks at this node's page

  app.get("/agents/board", (c) => {
    if (!board) return c.json({ error: "这个节点上的 AgentSwitch 应用没有在运行，或者版本还不支持从别处管理 Agents" }, 404);
    return c.json({ board: board.value, fresh: now() - board.at <= FRESH_MS });
  });

  app.post("/agents/actions", async (c) => {
    const body = await parseBody(c, Action);
    if (!body.ok) return c.json({ error: body.error }, 400);
    // Nobody is there to do it: said now, not found out by waiting.
    if (!board || now() - board.at > FRESH_MS) return c.json({ error: "这个节点上的 AgentSwitch 应用没有在运行" }, 409);
    asked = [...asked.filter((a) => now() - a.at <= ACTION_MS), { action: body.data, at: now() }].slice(-MAX_ACTIONS);
    return c.json({ queued: true }, 202);
  });
}
