/** The assistant conversation over HTTP (assistant-v0 §1.1): POST a message (the phone's input box), GET the messages
 *  after a sequence number (`?after=`) or the newest ones (`?last=`, for a first load). The phone may use both. */

import type { Hono } from "hono";
import { z } from "zod";
import { TargetRef } from "../core/target.js";
import { MAX_FILES_PER_UPLOAD } from "../files/names.js";
import { issues, limitParam, type ApiDeps } from "./shared.js";

export const MAX_MESSAGE_CHARS = 8000;
const MAX_LAST = 500;

const MessageBody = z.object({
  text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  /** The client's id for this message: a resend with the same id is answered once. */
  client_id: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  attachments: z.array(z.string().min(1)).max(MAX_FILES_PER_UPLOAD).optional(),
  pin: TargetRef.optional(),
});

export function mountAssistant(app: Hono, deps: ApiDeps): void {
  app.post("/assistant", async (c) => {
    if (!deps.assistant) return c.json({ error: "assistant unavailable" }, 503);
    const body = MessageBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    const { text, client_id, attachments, pin } = body.data;
    const r = await deps.assistant.converse({ text, clientId: client_id, ...(attachments ? { attachments } : {}), ...(pin ? { pin } : {}) });
    return r.ok ? c.json({ user: r.user, assistant: r.assistant, ...(r.task ? { task: r.task } : {}) }) : c.json({ error: r.error }, r.status as 400 | 503);
  });

  app.get("/assistant", (c) => {
    if (!deps.assistant) return c.json({ messages: [] });
    const last = Number(c.req.query("last"));
    if (Number.isInteger(last) && last > 0) return c.json({ messages: deps.assistant.latest(Math.min(last, MAX_LAST)) });
    const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
    return c.json({ messages: deps.assistant.messages(after, limitParam(c, 100, 500)) });
  });
}
