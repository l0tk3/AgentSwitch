/** A new pair checks itself before it is switched to (docs/browser-v0.md §7.2 第 6 条): the Camoufox and the Playwright
 *  that would be in use are started on a profile of their own, headless, against a page served from this process, and
 *  asked for what the service needs of them — a page, another size, pictures one after another, a request refused,
 *  the agents' tools. A build that is not of the Playwright's Firefox fails here (measured 2026-10-05: 152 under a
 *  Playwright for 156 fails at the resize and sends one picture). Starts a real browser: not for unit tests. */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { camoufoxExecutable } from "./files.js";
import { activePlaywright, playwrightIn, type PlaywrightCopy } from "./loader.js";
import type { EngineStore } from "./store.js";
import type { Candidate, CheckResult } from "./update.js";

const LAUNCH_MS = 60_000;
const FRAMES_MS = 3_000;
/** Pictures of a page that moves, in `FRAMES_MS`: a build that does not go with the Playwright sends one. */
const FRAMES_ENOUGH = 5;

const PAGE = `<!doctype html><meta charset=utf-8><title>engine check</title><div id=box style="position:absolute;top:40px;width:60px;height:60px;background:#f0c"></div>
<script>let x=0;setInterval(()=>{x=(x+7)%500;document.getElementById('box').style.left=x+'px'},16)</script>`;

type Page = {
  goto(url: string): Promise<unknown>;
  title(): Promise<string>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  evaluate(code: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screencast: { start(opts: { quality: number; onFrame: (frame: unknown) => void }): Promise<unknown>; stop(): Promise<void> };
};
type Context = {
  pages(): Page[];
  newPage(): Promise<Page>;
  route(match: (url: URL) => boolean, handler: (route: { abort(code: string): Promise<void> }) => unknown): Promise<void>;
  close(): Promise<void>;
};
type Core = { firefox: { launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<Context> } };
type Tools = { tools?: { createConnection?: (config: object, context: () => Promise<unknown>) => Promise<{ close(): Promise<void> }> } };

export function engineSelfCheck(store: EngineStore, platform: string = process.platform): (candidate: Candidate, signal: AbortSignal) => Promise<CheckResult> {
  return async (candidate, signal) => {
    let step = "Playwright";
    const fail = (why: string): CheckResult => ({ ok: false, reason: `自检未通过：${step}：${why}` });
    const copy: PlaywrightCopy | null = candidate.playwright ? playwrightIn(candidate.playwright) : activePlaywright(store);
    if (!copy) return fail("新的 playwright-core 无法加载。");
    const dir = candidate.camoufox ?? (store.installed("camoufox") ? store.dir("camoufox") : null);
    let core: Core, bundle: Tools;
    try {
      core = copy.require("playwright-core") as Core;
      bundle = copy.require("playwright-core/lib/coreBundle") as Tools;
    } catch (err) {
      return fail(firstLine(err));
    }
    if (typeof bundle.tools?.createConnection !== "function") return fail("这一版没有 agent 的浏览器工具所需的接口。");
    // A Playwright alone, with no Camoufox to drive yet: it loads and has the tools.
    if (!dir) return { ok: true };
    step = "启动";
    const executable = camoufoxExecutable(dir, platform);
    if (!executable) return fail("未找到 Camoufox 的程序。");
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(req.url?.startsWith("/refused") ? "should not load" : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const profile = mkdtempSync(join(tmpdir(), "agentswitch-engine-check-"));
    let context: Context | null = null;
    const stop = () => { void context?.close().catch(() => undefined); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      context = await core.firefox.launchPersistentContext(profile, {
        executablePath: executable, headless: true, viewport: null, acceptDownloads: false, timeout: LAUNCH_MS,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      });
      signal.throwIfAborted();
      step = "开页";
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(base);
      if (await page.title() !== "engine check") return fail("页面没有打开。");
      step = "改尺寸";
      await page.setViewportSize({ width: 900, height: 600 });
      if (await page.evaluate("innerWidth") !== 900) return fail("页面没有跟着改变大小。");
      step = "连续出帧";
      let frames = 0;
      await page.screencast.start({ quality: 60, onFrame: () => { frames++; } });
      await page.waitForTimeout(FRAMES_MS);
      await page.screencast.stop();
      if (frames < FRAMES_ENOUGH) return fail(`${FRAMES_MS / 1000} 秒内只有 ${frames} 帧。`);
      signal.throwIfAborted();
      step = "拦截";
      await context.route((url) => url.pathname.startsWith("/refused"), (route) => route.abort("blockedbyclient"));
      if (await page.evaluate(`fetch(${JSON.stringify(`${base}/refused`)}).then(() => "loaded", () => "refused")`) !== "refused") return fail("被拒绝的请求仍然发了出去。");
      step = "agent 工具";
      const held = context;
      const connection = await bundle.tools.createConnection({ outputDir: join(profile, "out") }, async () => held);
      await connection.close();
      return { ok: true };
    } catch (err) {
      return signal.aborted ? fail("已取消。") : fail(firstLine(err));
    } finally {
      signal.removeEventListener("abort", stop);
      await context?.close().catch(() => undefined);
      server.close();
      rmSync(profile, { recursive: true, force: true });
    }
  };
}

function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split("\n")[0]!.slice(0, 300);
}
