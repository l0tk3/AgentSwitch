/** Read-only look at the Clash Verge on this Mac with the service's own code (docs/clash-v0.md §6): its subscriptions,
 *  what its core runs, and a subscription made of the current one, written to the path given (to be checked with the
 *  core's `-t`). Changes nothing of Clash's.   npx tsx scripts/clash_probe.ts <out.yaml> */
import { writeFileSync } from "node:fs";
import { parse } from "yaml";
import { buildSubscription, EMPTY_SETTINGS, running } from "../src/clash/build.js";
import { ClashController } from "../src/clash/controller.js";
import { vergeProfiles, vergeProfileText, vergeSocket } from "../src/clash/verge.js";

async function main(): Promise<void> {
  const p = vergeProfiles();
  const socket = vergeSocket();
  if (!p || !socket) { console.log("Clash Verge not found or not running"); return; }
  console.log(`subscriptions ${p.profiles.length}, current ${p.current}`);
  const s = await new ClashController(socket).status();
  console.log(`core ${s.version}, mode ${s.mode}, tun ${s.tun}, groups ${s.groups.length}, nodes ${s.nodes.length}, rule sets ${Object.keys(s.ruleSets).length}`);
  const text = vergeProfileText(p.current ?? "");
  if (text === null) { console.log("current subscription not readable"); return; }
  const settings = { ...EMPTY_SETTINGS, source: p.current, claude: { nodes: s.nodes.slice(0, 3), mode: "auto" as const }, openai: { nodes: s.nodes.slice(2, 4), mode: "auto" as const }, direct: ["5.102.107.254"] };
  const out = buildSubscription(text, settings, "http://127.0.0.1:1/clash", "probe-token-0123456789");
  const made = parse(out) as { "proxy-groups": { name: string; type: string }[]; rules: string[]; proxies?: unknown[]; "proxy-providers"?: object };
  console.log(`made ${out.length} bytes: inline nodes ${made.proxies?.length ?? 0}, providers ${Object.keys(made["proxy-providers"] ?? {}).length}`);
  console.log("first groups:", made["proxy-groups"].slice(0, 8).map((g) => `${g.type}:${[...g.name].length}ch${g.name.startsWith("AgentSwitch") ? `(${g.name})` : g.name.startsWith("AS · ") ? "(AS · …)" : ""}`).join(" "));
  console.log("first rules:", made.rules.slice(0, 4).join(" | "));
  console.log("the core runs it now:", JSON.stringify(running(settings, s)));
  if (process.argv[2]) writeFileSync(process.argv[2], out);
}
void main();
