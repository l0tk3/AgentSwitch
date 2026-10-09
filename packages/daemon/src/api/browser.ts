/** The shared browser (docs/browser-v0.md §2 给 App): its tabs, a tab's picture as a stream, input, navigation, taking a
 *  tab over and handing it back, the holder's size, a ciphertext filled in through the gate, and the Mac's local
 *  servers. The same routes for this Mac and a paired phone; people open tabs here, agents get theirs through the agent
 *  bridge (browserAgents.ts, local only). Refusals answer 403 with the reason in words; opening, closing, taking, handing
 *  back and filling are audited. */

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { remoteCaller } from "../core/caller.js";
import { SSE_HEARTBEAT_MS } from "../core/limits.js";
import { KEY_NAMES, MODIFIERS, MOUSE_BUTTONS, type InputEvent } from "../browser/input.js";
import { auditUrl, targetUrl, type OpenTarget } from "../browser/rules.js";
import { DEFAULT_STREAM, MAX_FPS, MAX_SCALE, MAX_VIEW_PIXELS, type StreamOptions } from "../browser/screencast.js";
import { speedBody, speedSize } from "../browser/speed.js";
import { BrowserError, YOU, type BrowserEvent } from "../browser/types.js";
import { mountBrowserAgents } from "./browserAgents.js";
import { mountBrowserIdentity } from "./browserIdentity.js";
import { browserExitProblem } from "./profiles.js";
import { parseBody, type ApiDeps } from "./shared.js";

const MAX_URL = 8192;
const MAX_PATH = 4096;
const MAX_TEXT = 10_000;
const MAX_EVENTS = 50;
/** Events a stalled screen may fall behind by (frames do not count: a newer one replaces the waiting one). */
const MAX_QUEUED = 1_000;
const STATUS: Record<BrowserError["code"], 400 | 403 | 404 | 409 | 503> = { not_found: 404, forbidden: 403, conflict: 409, invalid: 400, unavailable: 503 };

/** A screen's own id (`mac-…`, `phone-…`, `web-…`), as the terminals' screens send it. */
const Screen = z.string().regex(/^[\w-]{1,64}$/);
const TargetFields = {
  url: z.string().min(1).max(MAX_URL).optional(),
  path: z.string().min(1).max(MAX_PATH).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
};
const one = (keys: readonly string[]) => (b: Record<string, unknown>) => keys.filter((k) => b[k] !== undefined).length === 1;
const OpenBody = z.object(TargetFields).refine(one(["url", "path", "port"]), "give exactly one of url, path, port");
const NavigateBody = z.object({ ...TargetFields, action: z.enum(["back", "forward", "reload"]).optional(), screen: Screen.optional() })
  .refine(one(["url", "path", "port", "action"]), "give exactly one of url, path, port, action");
const Hold = z.object({ screen: Screen.optional() });
/** A ciphertext as people pick one (the phone's saved ones are ciphertexts too); its value never comes back. */
const FillBody = z.object({ token: z.string().min(1).max(64 * 1024), screen: Screen.optional() });
/** A tab's size as a screen sets it. A page is no more than the pixels a view is drawn with at most (`MAX_VIEW_PIXELS`,
 *  3840 × 2400): a page zoomed out is drawn at its CSS size, whatever that is (browser-v0 §1 页面缩放, 2026-10-04: 25% of
 *  a 945 × 726 area is 3780 × 2904, 11 million pixels drawn to show fewer than 3). The screens do not use such a step;
 *  one asked for all the same is refused here. */
const ViewportBody = z.object({
  width: z.number().int().min(200).max(4096), height: z.number().int().min(200).max(4096),
  scale: z.number().min(0.5).max(4).default(1), mobile: z.boolean().default(false), screen: Screen.optional(),
}).refine((v) => v.width * v.height <= MAX_VIEW_PIXELS, `the page is more than ${MAX_VIEW_PIXELS} pixels (3840 × 2400)`);
const Coord = z.number().finite().min(-100_000).max(100_000);
const Mods = z.array(z.enum(MODIFIERS)).max(4).default([]);
const Seq = z.number().int().nonnegative().optional();
const InputEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mouse"), action: z.enum(["move", "down", "up", "click"]), x: Coord, y: Coord, button: z.enum(MOUSE_BUTTONS).default("left"),
    clickCount: z.number().int().min(1).max(3).default(1), modifiers: Mods, seq: Seq }),
  z.object({ type: z.literal("wheel"), x: Coord, y: Coord, deltaX: Coord.default(0), deltaY: Coord.default(0), modifiers: Mods, seq: Seq }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(MAX_TEXT) }),
  z.object({ type: z.literal("key"), key: z.enum(KEY_NAMES), modifiers: Mods }),
]);
/** `{screen?, events: [...]}`, or one event on its own (`{type: "text", text, screen?}`). */
const InputBody = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== "object" || !("type" in raw)) return raw;
    const { screen, ...event } = raw as Record<string, unknown>;
    return { ...(screen !== undefined ? { screen } : {}), events: [event] };
  },
  z.object({ screen: Screen.optional(), events: z.array(InputEventSchema).min(1).max(MAX_EVENTS) }),
);

/** `?quality=1..100&fps=1..30&maxWidth=&maxHeight=&scale=1..8`: what a stream asks of the screencast (the phone over a
 *  relay asks for less; `scale`, the frame pixels per CSS pixel its screen shows, 2026-10-03: its device pixels, times
 *  the zoom of a page it zoomed in, which took the most from 3 to 8, browser-v0 §1 页面缩放). Missing or bad values
 *  fall back to the defaults; more than the most is the most. */
export function streamOptions(query: (name: string) => string | undefined): StreamOptions {
  const num = (name: string, min: number, max: number, pattern: RegExp): number | undefined => {
    const raw = query(name);
    const n = raw !== undefined && pattern.test(raw) ? Number(raw) : NaN;
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : undefined;
  };
  const int = (name: string, min: number, max: number) => num(name, min, max, /^\d+$/);
  const maxWidth = int("maxWidth", 100, 8192);
  const maxHeight = int("maxHeight", 100, 8192);
  const scale = num("scale", 1, MAX_SCALE, /^\d+(\.\d+)?$/);
  return {
    quality: int("quality", 1, 100) ?? DEFAULT_STREAM.quality,
    fps: int("fps", 1, MAX_FPS) ?? DEFAULT_STREAM.fps,
    ...(maxWidth !== undefined ? { maxWidth } : {}),
    ...(maxHeight !== undefined ? { maxHeight } : {}),
    ...(scale !== undefined ? { scale } : {}),
  };
}

function targetOf(body: { url?: string | undefined; path?: string | undefined; port?: number | undefined }): OpenTarget {
  if (body.url !== undefined) return { url: body.url };
  if (body.path !== undefined) return { path: body.path };
  return { port: body.port! };
}

/** What the audit says was asked for: the kind and the target (a URL without query or fragment). */
function asked(target: OpenTarget, url: string | null): Record<string, unknown> {
  if ("port" in target) return { kind: "port", target: target.port };
  if ("path" in target) return { kind: "path", target: url ? auditUrl(url) : target.path };
  return { kind: "url", target: url ? auditUrl(url) : "invalid" };
}

/** A profile's own browser (docs/profiles-v0.md §5.1, §5.2) is served exactly as the shared one is, under
 *  `/profile-browser/<key>`: every route below, its identity, and the agents' bridge. Any profile that has a proxy of
 *  its own has one — it is made when first asked for, and started when a tab is first opened in it. `GET /browsers`
 *  lists them after the shared one, for a screen to choose which to show. */
export function mountProfileBrowsers(app: Hono, deps: ApiDeps): void {
  const fleet = deps.profileBrowsers;
  if (!fleet) return;
  app.get("/browsers", (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "not available from a paired device" }, 403);
    const all: Record<string, import("../profiles/store.js").AgentProfiles> = deps.profiles?.all() ?? {};
    const own = Object.entries(all).flatMap(([agent, list]) => list.profiles.filter((p) => p.proxy).map((p) => {
      const key = `${agent}.${p.id}`;
      return { key, name: p.name, agent, ...(p.exit ? { exit: { ip: p.exit.ip, place: p.exit.place } } : {}), running: fleet.get(key)?.host.running ?? false };
    }));
    return c.json({ browsers: [{ key: null, name: "Shared", running: deps.browser?.host.running ?? false }, ...own] });
  });
  const served = new WeakMap<object, Hono>();
  app.all("/profile-browser/:key/*", async (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "not available from a paired device" }, 403);
    const at = /^\/profile-browser\/([a-z0-9.-]+)(\/.*)$/.exec(new URL(c.req.url).pathname);
    const browser = at ? fleet.get(at[1]!) ?? fleet.of(at[1]!) : null;
    if (!at || !browser) return c.json({ error: "no such browser" }, 404);
    // Its proxy is the profile's, set where the profile is: not something this browser's own identity keeps.
    if (c.req.method === "PUT" && at[2] === "/browser/identity" && "proxy" in ((await c.req.raw.clone().json().catch(() => ({}))) as object)) {
      return c.json({ error: "这个浏览器走的是配置的代理：在 Settings › Agents 里这个配置的 Proxy… 里改。" }, 409);
    }
    // The first tab starts the browser: before that its proxy is asked where it lets traffic out, as before a
    // terminal starts — one that does not answer opens nothing.
    if (c.req.method === "POST" && at[2] === "/browser/tabs" && !browser.host.running) {
      const problem = await browserExitProblem(deps, at[1]!);
      if (problem) return c.json({ error: problem }, 502);
    }
    let sub = served.get(browser);
    if (!sub) { sub = new Hono(); mountBrowser(sub, { ...deps, browser }); mountBrowserIdentity(sub, { ...deps, browser }); served.set(browser, sub); }
    const url = new URL(c.req.url);
    url.pathname = at[2]!;
    return sub.fetch(new Request(url, c.req.raw), c.env);
  });
}

export function mountBrowser(app: Hono, deps: ApiDeps): void {
  const b = deps.browser;
  if (!b) return;
  const { host, audit } = b;
  if (b.agents) mountBrowserAgents(app, b.agents, deps.sseHeartbeatMs);
  const via = (c: Context): string => remoteCaller(c.env)?.deviceId ?? "local";
  const failed = (c: Context, err: unknown) => {
    if (err instanceof BrowserError) return c.json({ error: err.message }, STATUS[err.code]);
    throw err;
  };
  /** The URL a person's target stands for, then the tab's rules (host.ts); a refusal is audited with what was asked. */
  const resolveTarget = (target: OpenTarget): string => targetUrl(target, b.home);
  const refused = (c: Context, tab: string | null, target: OpenTarget, url: string | null, err: unknown) => {
    if (err instanceof BrowserError && err.code === "forbidden") audit.record({ tab, action: "refused", via: via(c), detail: { ...asked(target, url), reason: err.message } });
    return failed(c, err);
  };

  // `engine`: which browser the host starts now; `windows`: its tabs have windows of their own on this Mac (docs/browser-v0.md
  // §7.2), so a screen there shows the list and brings windows forward instead of drawing pictures.
  app.get("/browser/tabs", (c) => c.json({ running: host.running, groups: host.groups(), engine: b.engine(), windows: b.windows() }));

  // The tab's window before the browser's other windows (the Mac app then brings the browser forward). Local only.
  app.post("/browser/tabs/:id/show", async (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "not available from a paired device" }, 403);
    try {
      await host.show(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) { return failed(c, err); }
  });

  // A still picture of the tab for the Mac's list (JPEG). Local only: a phone has the stream.
  app.get("/browser/tabs/:id/preview", async (c) => {
    if (remoteCaller(c.env)) return c.json({ error: "not available from a paired device" }, 403);
    try {
      const picture = await host.picture(c.req.param("id"));
      return c.body(new Uint8Array(picture), 200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
    } catch (err) { return failed(c, err); }
  });

  // The phone's measure of its link (browser-v0 §5): bytes that do not compress, never cached.
  app.get("/browser/speed", (c) => {
    const body = speedBody(speedSize(c.req.query("bytes")));
    return c.body(new Uint8Array(body), 200, { "Content-Type": "application/octet-stream", "Content-Length": String(body.length), "Cache-Control": "no-store" });
  });

  app.post("/browser/tabs", async (c) => {
    const body = await parseBody(c, OpenBody);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const target = targetOf(body.data);
    let url: string | null = null;
    try {
      url = resolveTarget(target);
      const tab = await host.open(YOU, url);
      audit.record({ tab: tab.id, action: "open", via: via(c), detail: asked(target, url) });
      return c.json({ tab }, 201);
    } catch (err) { return refused(c, null, target, url, err); }
  });

  app.get("/browser/tabs/:id", (c) => {
    const tab = host.get(c.req.param("id"));
    return tab ? c.json({ tab }) : c.json({ error: "not found" }, 404);
  });

  // People may close any tab, an agent's too: it is their browser.
  app.delete("/browser/tabs/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await host.close(id);
      audit.record({ tab: id, action: "close", via: via(c) });
      return c.json({ ok: true });
    } catch (err) { return failed(c, err); }
  });

  // The tab now (`tab`), then frames and changes as they come; `closed` ends it. A comment every 10 s keeps a quiet
  // stream (a page that does not change) from looking dead to the phone.
  app.get("/browser/tabs/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!host.get(id)) return c.json({ error: "not found" }, 404);
    const opts = streamOptions((name) => c.req.query(name));
    return streamSSE(c, async (stream) => {
      const queue: BrowserEvent[] = [];
      let wake: (() => void) | null = null;
      let open = true;
      const push = (ev: BrowserEvent) => {
        // A frame still waiting is replaced by the newer one: a slow screen skips pictures, never falls behind.
        if (ev.type === "frame") {
          const waiting = queue.findIndex((e) => e.type === "frame");
          if (waiting >= 0) queue.splice(waiting, 1);
        }
        queue.push(ev);
        if (queue.length > MAX_QUEUED) open = false;
        wake?.();
      };
      let unsubscribe: () => void = () => undefined;
      try { unsubscribe = host.subscribe(id, opts, push); } catch { push({ type: "closed", reason: "closed" }); }
      stream.onAbort(() => { open = false; wake?.(); });
      const heartbeat = setInterval(() => { void stream.write(": ping\n\n").catch(() => undefined); }, deps.sseHeartbeatMs ?? SSE_HEARTBEAT_MS);
      try {
        while (open) {
          for (const ev of queue.splice(0)) {
            await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev), ...(ev.type === "frame" ? { id: String(ev.seq) } : {}) });
            if (ev.type === "closed") open = false;
          }
          if (!open) break;
          await new Promise<void>((resolve) => { wake = resolve; if (queue.length || !open) resolve(); });
          wake = null;
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });

  // Points are on the frame (`seq`, default the latest) and mapped to the page; text goes into the page as typed,
  // never to a model, and is not recorded.
  app.post("/browser/tabs/:id/input", async (c) => {
    const body = await parseBody(c, InputBody);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      await host.input(c.req.param("id"), body.data.screen ?? via(c), body.data.events as InputEvent[]);
      return c.json({ ok: true });
    } catch (err) { return failed(c, err); }
  });

  app.post("/browser/tabs/:id/navigate", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, NavigateBody);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const holder = body.data.screen ?? via(c);
    if (body.data.action) {
      try { return c.json({ tab: await host.history(id, holder, body.data.action) }); } catch (err) { return failed(c, err); }
    }
    const target = targetOf(body.data);
    let url: string | null = null;
    try {
      url = resolveTarget(target);
      const tab = host.navigate(id, holder, url);
      audit.record({ tab: id, action: "navigate", via: via(c), detail: asked(target, url) });
      return c.json({ tab });
    } catch (err) { return refused(c, id, target, url, err); }
  });

  app.post("/browser/tabs/:id/take", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, Hold);
    if (!body.ok) return c.json({ error: body.error }, 400);
    try {
      const before = host.get(id)?.heldBy ?? null;
      const tab = host.take(id, body.data.screen ?? via(c));
      audit.record({ tab: id, action: "take", via: via(c), detail: { screen: tab.heldBy, from: before, owner: tab.owner.kind } });
      return c.json({ tab });
    } catch (err) { return failed(c, err); }
  });

  app.post("/browser/tabs/:id/release", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, Hold);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const holder = body.data.screen ?? via(c);
    try {
      const held = host.get(id)?.heldBy ?? null;
      const tab = host.release(id, holder);
      if (held) audit.record({ tab: id, action: "release", via: via(c), detail: { screen: holder, reason: "hand-back" } });
      return c.json({ tab });
    } catch (err) { return failed(c, err); }
  });

  app.post("/browser/tabs/:id/viewport", async (c) => {
    const body = await parseBody(c, ViewportBody);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const { screen, ...viewport } = body.data;
    try {
      return c.json({ tab: await host.setViewport(c.req.param("id"), screen ?? via(c), viewport) });
    } catch (err) { return failed(c, err); }
  });

  // A person's Fill Ciphertext: the gate resolves the ciphertext for the focused field's page (and every frame above it),
  // and the value is typed into that field; neither the answer nor the audit nor a log holds it.
  app.post("/browser/tabs/:id/fill", async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, FillBody);
    if (!body.ok) return c.json({ error: "give a ciphertext (token)" }, 400);
    if (!b.fill) return c.json({ error: "凭据网关不可用，无法填入密文。" }, 503);
    try {
      const done = await host.fill(id, body.data.screen ?? via(c), body.data.token, b.fill);
      audit.record({ tab: id, action: "fill", via: via(c), detail: { label: done.label, host: done.host } });
      return c.json({ tab: host.get(id), filled: { label: done.label, host: done.host } });
    } catch (err) {
      if (err instanceof BrowserError && err.code === "forbidden") audit.record({ tab: id, action: "refused", via: via(c), detail: { kind: "fill", reason: err.message } });
      return failed(c, err);
    }
  });

  app.get("/browser/servers", async (c) => {
    try {
      return c.json({ servers: await b.servers() });
    } catch (err) {
      console.error(`browser: local servers could not be listed: ${(err as Error).message}`);
      return c.json({ error: "无法读取本地服务列表。" }, 503);
    }
  });
}
