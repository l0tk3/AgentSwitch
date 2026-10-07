/** Runs the engine's own check (src/browser/engine/selfCheck.ts) on an unpacked Camoufox, with the bundled Playwright or
 *  one unpacked beside it. Starts a real browser: not a test.
 *
 *    tsx scripts/browser_engine_check.ts <folder holding Camoufox.app> [<folder holding node_modules/playwright-core>]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineSelfCheck } from "../src/browser/engine/selfCheck.js";
import { EngineStore } from "../src/browser/engine/store.js";

const [camoufox, playwright] = process.argv.slice(2);
if (!camoufox) { console.error("usage: browser_engine_check.ts <folder holding Camoufox.app> [<folder holding node_modules/playwright-core>]"); process.exit(2); }
const root = mkdtempSync(join(tmpdir(), "agentswitch-engine-check-store-"));
const started = Date.now();
const result = await engineSelfCheck(new EngineStore(root))({ camoufox, playwright: playwright ?? null }, new AbortController().signal);
rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ ...result, ms: Date.now() - started }));
process.exit(result.ok ? 0 : 1);
