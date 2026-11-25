/** The password book (vault/passwords.ts; user #345-#351): this Mac's screens only — none of it is on the remote
 *  allowlist. The list goes out without its secrets; `POST /passwords/:id/reveal` gives one entry's password, note and
 *  current 2FA code, asked by the Mac once the user passed Touch ID. */

import type { Context, Hono } from "hono";
import { z } from "zod";
import { generatePassword, parseCsv, PasswordError, type EntryInput } from "../vault/passwords.js";
import { parseBody, type ApiDeps } from "./shared.js";

const Entry = z.object({
  name: z.string().max(200), sites: z.array(z.string().max(500)).max(20), account: z.string().max(300), password: z.string().max(4000),
  totp: z.string().max(200), note: z.string().max(10_000), tags: z.array(z.string().max(50)).max(20),
}).partial().strict();

const clean = (d: z.infer<typeof Entry>): EntryInput => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) as EntryInput;

export function mountPasswords(app: Hono, deps: ApiDeps): void {
  const off = { error: "密码本只在这台 Mac 的服务上可用。" };
  const failed = (c: Context, err: unknown) => {
    if (err instanceof PasswordError) return c.json({ error: err.message }, err.status);
    throw err;
  };
  const changed = () => deps.redaction?.gate.changed();

  app.get("/passwords", (c) => {
    const b = deps.passwords;
    return b ? c.json({ entries: b.list() }) : c.json(off, 503);
  });
  app.post("/passwords", async (c) => {
    const b = deps.passwords;
    if (!b) return c.json(off, 503);
    const body = await parseBody(c, Entry);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try { const entry = b.add(clean(body.data)); changed(); return c.json({ entry }, 201); } catch (err) { return failed(c, err); }
  });
  app.patch("/passwords/:id", async (c) => {
    const b = deps.passwords;
    if (!b) return c.json(off, 503);
    const body = await parseBody(c, Entry);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try { const entry = b.update(c.req.param("id"), clean(body.data)); changed(); return c.json({ entry }); } catch (err) { return failed(c, err); }
  });
  app.delete("/passwords/:id", (c) => {
    const b = deps.passwords;
    if (!b) return c.json(off, 503);
    try { b.remove(c.req.param("id")); changed(); return c.json({ ok: true }); } catch (err) { return failed(c, err); }
  });
  app.post("/passwords/:id/reveal", (c) => {
    const b = deps.passwords;
    if (!b) return c.json(off, 503);
    try { return c.json(b.reveal(c.req.param("id"))); } catch (err) { return failed(c, err); }
  });
  // A browser's or a password manager's CSV export, as text.
  app.post("/passwords/import", async (c) => {
    const b = deps.passwords;
    if (!b) return c.json(off, 503);
    const body = await parseBody(c, z.object({ csv: z.string().max(20_000_000) }).strict());
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const { entries, skipped } = parseCsv(body.data.csv);
      const done = b.addMany(entries);
      changed();
      return c.json({ ...done, skipped });
    } catch (err) { return failed(c, err); }
  });
  app.get("/passwords/generate", (c) => {
    const length = Number(c.req.query("length") ?? 20);
    return c.json({ password: generatePassword(Number.isFinite(length) ? length : 20, c.req.query("symbols") !== "0") });
  });
}
