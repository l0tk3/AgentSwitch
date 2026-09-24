/** Routing evaluation against tests/fixtures/routing/*.jsonl with the REAL router (costs DeepSeek tokens).
 *
 *   npm run eval -- [--limit N] [--concurrency 3] [--cwd <repo>]
 *
 * Each line: {id, input, expect: {harness?: string|string[], cost?: string[], needs_browser?: boolean}, tags}.
 * Reports per-sample verdicts and a hit rate; a sample "hits" when every asserted field matches.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { route, type RouteResult } from "../src/router/route.js";
import { opencodeRouter } from "../src/router/routers/opencode.js";
import { loadTargets, modelSpec, type Targets } from "../src/router/targets.js";

type Sample = { id: string; input: string; expect: { harness?: string | string[]; cost?: string[]; needs_browser?: boolean }; tags: string[] };

const HERE = new URL(".", import.meta.url).pathname;

export function judge(sample: Sample, result: RouteResult, targets: Targets): { hit: boolean; why: string[] } {
  const why: string[] = [];
  const v = result.verdict;
  if (!v.ok) return { hit: false, why: ["no verdict"] };
  const e = sample.expect;
  if (e.harness !== undefined) {
    const allowed = Array.isArray(e.harness) ? e.harness : [e.harness];
    if (!allowed.includes(v.harness)) why.push(`harness ${v.harness} not in ${allowed.join("|")}`);
  }
  if (e.cost !== undefined) {
    const cost = modelSpec(targets.harnesses[v.harness]!, v.model)?.cost;
    if (!cost || !e.cost.includes(cost)) why.push(`cost ${cost} not in ${e.cost.join("|")}`);
  }
  if (e.needs_browser !== undefined && result.decision && result.decision.needs_browser !== e.needs_browser) {
    why.push(`needs_browser ${result.decision.needs_browser}`);
  }
  if (result.source !== "router") why.push(`source ${result.source} (${result.routerError ?? v.notes.join("; ")})`);
  return { hit: why.length === 0, why };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      limit: { type: "string" },
      concurrency: { type: "string", default: "3" },
      cwd: { type: "string", default: resolve(HERE, "..", "..", "..") },
      fixture: { type: "string", default: resolve(HERE, "..", "tests", "fixtures", "routing", "v0.jsonl") },
    },
  });
  const targets = loadTargets(resolve(HERE, "..", "config", "targets.yaml"));
  const router = opencodeRouter({ model: targets.router.model });
  const samples = readFileSync(values.fixture, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Sample);
  const chosen = values.limit ? samples.slice(0, Number(values.limit)) : samples;
  const conc = Number(values.concurrency);
  const results: { sample: Sample; result: RouteResult; hit: boolean; why: string[] }[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (next < chosen.length) {
        const sample = chosen[next++]!;
        const result = await route({ task: sample.input, cwd: values.cwd }, { targets, router, quota: {} });
        const { hit, why } = judge(sample, result, targets);
        results.push({ sample, result, hit, why });
        const v = result.verdict;
        const target = v.ok ? `${v.harness}/${v.model}` : "-";
        console.log(`${hit ? "HIT " : "MISS"} ${sample.id} -> ${target} (${result.routerMs} ms, conf ${result.decision?.confidence ?? "-"})${why.length ? "  " + why.join("; ") : ""}`);
      }
    }),
  );
  const hits = results.filter((r) => r.hit).length;
  console.log(`\n${hits}/${results.length} hit (${Math.round((100 * hits) / results.length)}%)`);
  const byTag = new Map<string, [number, number]>();
  for (const r of results) for (const t of r.sample.tags) {
    const cur = byTag.get(t) ?? [0, 0];
    byTag.set(t, [cur[0] + (r.hit ? 1 : 0), cur[1] + 1]);
  }
  for (const [tag, [h, n]] of [...byTag].sort()) console.log(`  ${tag.padEnd(12)} ${h}/${n}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) await main();
