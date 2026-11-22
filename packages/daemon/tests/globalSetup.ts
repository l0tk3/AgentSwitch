/** Once per test run (vitest.config.ts globalSetup): every temporary folder the tests make goes under one folder of
 *  this run, removed when the run ends. The tests make hundreds each run (`mkdtempSync(join(tmpdir(), …))`) and most
 *  never removed theirs: 23,848 were found in one Mac's temporary folder. A run that was killed leaves its one folder;
 *  the next run removes those older than a day. The name is short: unix socket paths under it must stay under 104. */

import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "asv-";
const STALE_MS = 24 * 3600_000;

export default function setup(): () => void {
  const base = realpathSync(tmpdir());
  for (const name of readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue;
    try { if (Date.now() - statSync(join(base, name)).mtimeMs > STALE_MS) rmSync(join(base, name), { recursive: true, force: true }); } catch { /* another run's */ }
  }
  const run = mkdtempSync(join(base, PREFIX));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = run;
  return () => {
    if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
    rmSync(run, { recursive: true, force: true, maxRetries: 3 });
  };
}
