/** Where a task goes when the router is unavailable or not trusted. Coarse, deterministic. */

import type { TargetRef, Targets } from "./targets.js";
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

export function defaultTarget(task: string, targets: Targets, quota: Quota): TargetRef {
  const cap = classify(task);
  if (cap === "browser") {
    const capable = Object.entries(targets.harnesses).filter(([, spec]) => spec.browser);
    const ranked = [...capable].sort(([a], [b]) => (quota[b] ?? 1) - (quota[a] ?? 1));
    const h = ranked[0];
    if (h) return { harness: h[0], model: h[1].default_model };
  }
  if (cap === "code" || cap === "browser" || (quota[targets.router.default.harness] ?? 1) <= 0) {
    const h = bestCodeHarness(targets, quota);
    const spec = targets.harnesses[h];
    if (spec) return { harness: h, model: spec.default_model };
  }
  return targets.router.default;
}
