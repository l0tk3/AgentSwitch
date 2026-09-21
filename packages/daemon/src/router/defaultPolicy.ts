/** Where a task goes when the router is unavailable or not trusted. Coarse, deterministic. */

import { categoryOf, modelKey, type TargetRef, type Targets } from "./targets.js";
import type { Quota } from "./validate.js";

export type Capability = "browser" | "code" | "chat";

const BROWSER = /(浏览器|网页|打开\s*https?:|登录|登陆|填表|填写|点击|网站|browser|web ?page|log ?in|click|navigate|https?:\/\/)/i;
const CODE = /(代码|修复|修一下|实现|重构|测试|单测|编译|报错|函数|模块|接口|仓库|提交|分支|依赖|脚本|bug|refactor|implement|fix|test|compile|function|module|repo|commit|branch|\.py\b|\.ts\b|\.swift\b|\.go\b|\.rs\b)/i;

export function classify(task: string): Capability {
  if (BROWSER.test(task)) return "browser";
  if (CODE.test(task)) return "code";
  return "chat";
}

const CODE_HARNESSES = ["claude-code", "codex"] as const;

/** Among the code harnesses, the one with the most quota left (ties: catalog order). */
function bestCodeHarness(targets: Targets, quota: Quota): string {
  const known = CODE_HARNESSES.filter((h) => h in targets.harnesses);
  const ranked = [...known].sort((a, b) => (quota[b] ?? 1) - (quota[a] ?? 1));
  return ranked[0] ?? targets.router.default.harness;
}

/** Inside a restricted category the allow list is a preference order: the first entry whose harness still has quota. */
function categoryTarget(category: string, targets: Targets, quota: Quota): TargetRef {
  const allow = targets.categories[category]!.allow;
  return allow.find((r) => (quota[r.harness] ?? 1) >= targets.router.quota_threshold) ?? allow[0]!;
}

/** router-v0 §4 default table: browser → claude-code / claude-sonnet-5. Only when that has no quota does the
 *  cheapest other browser-capable harness step in; the low-confidence fallback must never land on a top-cost model. */
export const BROWSER_DEFAULT: TargetRef = { harness: "claude-code", model: "claude-sonnet-5" };

function browserTarget(targets: Targets, quota: Quota): TargetRef | undefined {
  const preferred = targets.harnesses[BROWSER_DEFAULT.harness];
  if (preferred?.browser && modelKey(preferred, BROWSER_DEFAULT.model) && (quota[BROWSER_DEFAULT.harness] ?? 1) >= targets.router.quota_threshold) return BROWSER_DEFAULT;
  const rank: Record<string, number> = { free: 0, low: 1, mid: 2, high: 3, top: 4 };
  const candidates = Object.entries(targets.harnesses)
    .filter(([h, spec]) => spec.browser && (quota[h] ?? 1) >= targets.router.quota_threshold)
    .flatMap(([h, spec]) => Object.entries(spec.models).filter(([, m]) => !m.unavailable).map(([model, m]) => ({ harness: h, model, cost: rank[m.cost] ?? 9 })))
    .sort((a, b) => a.cost - b.cost);
  const c = candidates[0];
  return c ? { harness: c.harness, model: c.model } : undefined;
}

export function defaultTarget(task: string, targets: Targets, quota: Quota): TargetRef {
  const category = categoryOf(task, targets);
  if (category) return categoryTarget(category, targets, quota);
  const cap = classify(task);
  if (cap === "browser") {
    const t = browserTarget(targets, quota);
    if (t) return t;
  }
  if (cap === "code" || cap === "browser" || (quota[targets.router.default.harness] ?? 1) <= 0) {
    const h = bestCodeHarness(targets, quota);
    const spec = targets.harnesses[h];
    if (spec) return { harness: h, model: spec.default_model };
  }
  return targets.router.default;
}
