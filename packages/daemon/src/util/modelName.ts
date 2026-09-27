/** Model ids as people say them (docs/ui-v0.md §1.5; the phone's AgentSwitchKit ModelName does the same):
 *  `claude-opus-5-5` → Opus 5.5, `deepseek/deepseek-flash` → DeepSeek Flash, `gpt-6-luna` → GPT-6 Luna. */

const BRANDS: Readonly<Record<string, string>> = { deepseek: "DeepSeek", gpt: "GPT", qwen: "Qwen", glm: "GLM", kimi: "Kimi", gemini: "Gemini", llama: "Llama", mistral: "Mistral", grok: "Grok" };
const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

export function modelName(id: string): string {
  let name = id.split("/").pop() ?? id;
  let suffix = "";
  if (name.endsWith("[1m]")) { name = name.slice(0, -4); suffix = " 1M"; }
  const parts = name.split("-");
  if (parts[0] === "claude" && parts.length >= 3) {
    const numbers = parts.slice(2).filter((p) => p.length <= 2 && /^\d+$/.test(p));
    return [cap(parts[1]!), numbers.join(".")].filter(Boolean).join(" ") + suffix;
  }
  if (parts[0] === "gpt" && parts.length >= 2) return [`GPT-${parts[1]}`, ...parts.slice(2).map(cap)].join(" ") + suffix;
  return parts.map((p) => BRANDS[p.toLowerCase()] ?? cap(p)).join(" ") + suffix;
}
