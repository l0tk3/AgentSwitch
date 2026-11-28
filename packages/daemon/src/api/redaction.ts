/** The words the model never sees (vault/words.ts) and the model traffic gateway's logs (vault/modelGate.ts):
 *  this Mac's own screens, and — the switches and the words, not the logs — another paired node's Settings ›
 *  Redaction (2026-11-28, user #89-#91; remote/routes.ts). A phone gets none of it. A word from another node comes
 *  sealed under this node's vault key (`POST /vault/seal` first, as a profile's API key does), never as it is; the
 *  logs stay this Mac's own, holding the text as it was before the words were replaced. */

import type { Context, Hono } from "hono";
import { z } from "zod";
import { fromNode, remoteCaller } from "../core/caller.js";
import { isVaultSealed } from "../vault/seal.js";
import { RedactionError } from "../vault/words.js";
import { parseBody, type ApiDeps } from "./shared.js";

const Settings = z.object({
  enabled: z.boolean(), username: z.boolean(), host: z.boolean(), log: z.boolean(), logTerminals: z.array(z.string().max(64)).max(50),
  keepDays: z.number().int().min(0).max(365), hosts: z.array(z.string().max(253)).max(100),
}).partial().strict();
/** What is kept of the logs: this Mac's own to set. */
const LOG_SETTINGS = ["log", "logTerminals", "keepDays"] as const;
const AddWord = z.object({ value: z.string().min(1).max(4000).optional(), sealed: z.string().min(1).max(12_000).optional(), replace: z.string().max(200).optional(), restore: z.boolean().optional(), regex: z.boolean().optional() }).strict();

export function mountRedaction(app: Hono, deps: ApiDeps): void {
  const off = { error: "替换词只在有终端的 AgentSwitch 服务上可用。" };
  const failed = (c: Context, err: unknown) => {
    if (err instanceof RedactionError) return c.json({ error: err.message }, err.status);
    throw err;
  };
  // A word as the screens show it: its placeholder under no profile in particular is not one (each profile has its
  // own salt), so the screens get the word, its own replacement if any, and whether it goes back.
  const shown = (w: { id: string; value: string; replace?: string; restore: boolean; regex?: boolean; addedAt: number }) => ({ id: w.id, value: w.value, ...(w.replace ? { replace: w.replace } : {}), restore: w.restore, ...(w.regex ? { regex: true } : {}), addedAt: w.addedAt });

  // Another node may; a phone may not. The logs are this Mac's own whoever asks.
  const gatekeeper = async (c: Context, next: () => Promise<void>) => {
    const caller = remoteCaller(c.env);
    if (!caller) return next();
    if (!fromNode(caller)) return c.json({ error: "替换设置在 Mac 上改，手机上不能改。" }, 403);
    if (c.req.path.startsWith("/redaction/logs")) return c.json({ error: "日志只在这个节点自己的 Mac 上看。" }, 403);
    return next();
  };
  app.use("/redaction", gatekeeper);
  app.use("/redaction/*", gatekeeper);
  app.use("/rooms/:id/redaction/*", gatekeeper);

  app.get("/redaction", (c) => {
    const r = deps.redaction;
    if (!r) return c.json(off, 503);
    return c.json({ settings: r.store.settings(), words: r.store.words().map(shown), gateway: r.gate.enabled(), logDir: r.gate.logDir });
  });
  app.patch("/redaction/settings", async (c) => {
    const r = deps.redaction;
    if (!r) return c.json(off, 503);
    const body = await parseBody(c, Settings);
    if (!body.ok) return c.json({ error: body.error }, 400);
    if (remoteCaller(c.env) && LOG_SETTINGS.some((k) => body.data[k] !== undefined)) return c.json({ error: "日志的设置只在这个节点自己的 Mac 上改。" }, 403);
    const settings = r.store.setSettings(Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined)));
    r.gate.changed();
    return c.json({ settings });
  });
  const addTo = (room?: string) => async (c: Context) => {
    const r = deps.redaction;
    if (!r) return c.json(off, 503);
    // Off, the whole of it is (user #343): no words are added, a room's neither.
    if (!r.store.settings().enabled) return c.json({ error: "替换词功能已关闭：先在「设置 › Redaction」打开。" }, 409);
    const body = await parseBody(c, AddWord);
    if (!body.ok) return c.json({ error: body.error }, 400);
    // The word itself, or sealed by this node first (`POST /vault/seal` with `for: "redaction"`): another node sends
    // it only sealed. What was sealed for anything else — a profile's key — does not open here: a word is shown again.
    const { value: plain, sealed } = body.data;
    if ((plain === undefined) === (sealed === undefined)) return c.json({ error: "value or sealed: one of them" }, 400);
    if (plain !== undefined && remoteCaller(c.env)) return c.json({ error: "从别的节点加替换词要先加密（sealed）。" }, 400);
    let value = plain ?? "";
    if (sealed !== undefined) {
      if (!deps.unseal || !isVaultSealed(sealed)) return c.json({ error: "sealed: 不是这个节点加密的内容。" }, 400);
      try { value = deps.unseal(sealed, "redaction"); } catch { return c.json({ error: "sealed: 不是这个节点加密的内容。" }, 400); }
      if (!value || value.length > 4000) return c.json({ error: "value: 1 to 4000 characters" }, 400);
    }
    try {
      if (room !== undefined) deps.rooms?.get(room);   // a room there is
      const { word, warning } = r.store.add({ value, ...(body.data.replace !== undefined ? { replace: body.data.replace } : {}), ...(body.data.restore !== undefined ? { restore: body.data.restore } : {}), ...(body.data.regex ? { regex: true } : {}) }, room);
      r.gate.changed();
      return c.json({ word: shown(word), warning }, 201);
    } catch (err) {
      if (err instanceof RedactionError) return c.json({ error: err.message }, err.status);
      if ((err as { status?: number }).status === 404) return c.json({ error: "没有这个房间。" }, 404);
      throw err;
    }
  };
  const removeFrom = (room?: string) => (c: Context) => {
    const r = deps.redaction;
    if (!r) return c.json(off, 503);
    try { r.store.remove(c.req.param("wid")!, room); r.gate.changed(); return c.json({ ok: true }); } catch (err) { return failed(c, err); }
  };
  app.post("/redaction/words", addTo());
  app.delete("/redaction/words/:wid", removeFrom());
  app.get("/rooms/:id/redaction/words", (c) => {
    const r = deps.redaction;
    if (!r) return c.json(off, 503);
    return c.json({ words: r.store.words(c.req.param("id")).map(shown) });
  });
  app.post("/rooms/:id/redaction/words", (c) => addTo(c.req.param("id"))(c));
  app.delete("/rooms/:id/redaction/words/:wid", (c) => removeFrom(c.req.param("id"))(c));

  app.get("/redaction/logs", (c) => {
    const r = deps.redaction;
    if (!r) return c.json(off, 503);
    return c.json({ dir: r.gate.logDir, logs: r.gate.logs() });
  });
  // `?days=N`: older than N days; none: all of them.
  app.delete("/redaction/logs", (c) => {
    const r = deps.redaction;
    if (!r) return c.json(off, 503);
    const days = c.req.query("days");
    const n = days === undefined ? undefined : Number(days);
    if (n !== undefined && (!Number.isInteger(n) || n < 0)) return c.json({ error: "days: a whole number of days" }, 400);
    return c.json({ removed: r.gate.clean(n) });
  });
}
