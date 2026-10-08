/** Clash Integration tried for real on this Mac without touching the user's Clash (docs/clash-v0.md §7):
 *
 *  1. looks, read only, at the Clash Verge here and what its core runs;
 *  2. in a folder of its own, takes Clash Verge's current subscription in as the one to work from — which fetches the
 *     links it names from the subscription service, once, as Clash would;
 *  3. serves what AgentSwitch would serve on a loopback port, behind the local listener's own gate;
 *  4. has the core's own program check the subscription made (`-t`), then starts a second, private core on it (no
 *     TUN, no DNS, no ports; its own folder and control socket) and, through the same code the service uses, changes
 *     the nodes' order, picks a node, asks for delays — reading back from the private core what its groups became.
 *
 *  Nothing of Clash Verge's is written and its core is only read. Real nodes are tried (step 8), as Clash Verge's own
 *  delay test does.   npx tsx scripts/clash_probe.ts [path to mihomo]   (CLASH_PROBE_TMP: a short folder for the socket) */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { parse, stringify } from "yaml";
import { mountClash } from "../src/api/clash.js";
import { LocalAuth } from "../src/api/localAuth.js";
import type { ApiDeps } from "../src/api/shared.js";
import { ClashController } from "../src/clash/controller.js";
import { ClashIntegration } from "../src/clash/integration.js";
import { ClashSource } from "../src/clash/source.js";
import { ClashStore } from "../src/clash/store.js";
import { vergeDir, vergeProfiles, vergeSocket } from "../src/clash/verge.js";
import { listenLocal } from "../src/daemon.js";

const MIHOMO = process.argv[2] ?? "/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line: string) => console.log(line);

async function main(): Promise<void> {
  const profiles = vergeProfiles(), real = vergeSocket();
  if (!profiles?.current || !real) { say("Clash Verge not found or not running"); return; }
  const before = await new ClashController(real).status();
  say(`1) Clash Verge: ${profiles.profiles.length} subscription(s); core ${before.version}, tun ${before.tun}, ${before.nodes.length} nodes, ${before.groups.length} groups`);
  const used = (group: string): readonly string[] => before.groups.find((g) => g.name === group)?.members ?? [];
  say(`   its Claude自动选择 has ${JSON.stringify(used("Claude自动选择"))}; its OpenAI自动选择 has ${used("OpenAI自动选择").length} nodes`);

  const work = mkdtempSync(join(tmpdir(), "as-clash-probe-"));
  // A socket's path has to be short (104 bytes), so not under the work folder.
  const socket = join(mkdtempSync(join(process.env.CLASH_PROBE_TMP ?? "/tmp", "asp-")), "c.sock");
  let core: ReturnType<typeof spawn> | null = null;
  let server: ReturnType<typeof listenLocal> | null = null;
  try {
    let port = 0;
    const clash = new ClashIntegration({ store: new ClashStore(work), source: new ClashSource(work, undefined, undefined, () => `clash.meta/${before.version}`),
      base: () => `http://127.0.0.1:${port}`, socket: () => socket });
    const app = new Hono();
    mountClash(app, { clash } as unknown as ApiDeps);
    await new Promise<void>((ok) => { server = listenLocal({ app }, 0, (info: AddressInfo) => { port = info.port; ok(); }, new LocalAuth("probe-token-0123456789abcdefghijklmnopqrstuvwxyz")); });

    const taken = await clash.setSource({ verge: profiles.current });
    say(`2) taken in: ${taken.source?.kind} "${taken.source?.name}", ${taken.nodes.length} nodes; node sets ${JSON.stringify(taken.source?.providers.map((p) => `${p.name}: ${p.nodes} nodes${p.error ? ` (${p.error})` : ""}`))}; traffic ${taken.source?.traffic ? "known" : "not said"}`);
    if (!taken.nodes.length) { say("   no nodes: stopping"); return; }

    // The nodes the user's own groups use today, in their order; else the first few.
    const pick = (group: string, n: number): string[] => { const have = [...used(group)].filter((m) => taken.nodes.includes(m)); return (have.length ? have : [...taken.nodes]).slice(0, n); };
    const claude = pick("Claude自动选择", 3), openai = pick("OpenAI自动选择", 3);
    await clash.saveSettings({ claude: { nodes: claude }, openai: { nodes: openai }, direct: ["203.0.113.7"], autoUpdateHours: 24 });

    // What Clash Verge would fetch, through the listener's gate and by the token alone.
    const url = `http://127.0.0.1:${port}/clash/sub.yaml?k=${clash.token()}`;
    const got = await fetch(url);
    const text = await got.text();
    const made = parse(text) as Record<string, any>;
    say(`3) served: http ${got.status}, ${text.length} bytes, update interval ${got.headers.get("profile-update-interval")} h, traffic header ${got.headers.get("subscription-userinfo") ? "passed on" : "none"}; without the token: http ${(await fetch(url.replace(/k=.*/, "k=x"))).status}`);
    say(`   groups: ${made["proxy-groups"].map((g: { name: string }) => g.name).join(" | ")}`);
    for (const name of ["Claude", "Claude自动选择", "OpenAI", "OpenAI自动选择"]) say(`   ${name}: ${JSON.stringify(made["proxy-groups"].find((g: { name: string }) => g.name === name))}`);
    say(`   first rules: ${made.rules.slice(0, 4).join(" | ")}`);
    say(`   node sets: ${Object.entries(made["proxy-providers"]).map(([n, p]) => `${n} ← ${String((p as { url: string }).url).replace(/^https?:\/\/([^/]+)\/.*$/, "$1")}`).join(", ")}`);
    say(`   the subscription service's own link in it: ${/\btoken=|subscribe\?/.test(text.replace(/k=[\w-]+/g, "")) ? "YES (wrong)" : "no"}`);

    const homeDir = join(work, "core");
    mkdirSync(homeDir);
    for (const f of readdirSync(vergeDir())) if (/\.(mmdb|dat)$/.test(f)) cpSync(join(vergeDir(), f), join(homeDir, f));
    writeFileSync(join(homeDir, "as-made.yaml"), text);
    const check = spawnSync(MIHOMO, ["-t", "-d", homeDir, "-f", join(homeDir, "as-made.yaml")], { encoding: "utf8", timeout: 30_000 });
    say(`4) the core's own check of it: ${/test is successful/.test(check.stdout + check.stderr) ? "passes" : `FAILS: ${(check.stdout + check.stderr).split("\n").filter((l) => /error|fatal/i.test(l)).slice(0, 3).join(" / ")}`}`);

    // The same for a private core: nothing that reaches into the system.
    for (const key of ["tun", "dns", "port", "socks-port", "redir-port", "tproxy-port", "external-controller", "external-controller-unix", "external-controller-tls", "secret", "external-ui", "hosts", "sniffer"]) delete made[key];
    Object.assign(made, { "mixed-port": 0, "allow-lan": false, "log-level": "warning", "geo-auto-update": false });
    writeFileSync(join(homeDir, "config.yaml"), stringify(made, { lineWidth: 0 }));
    core = spawn(MIHOMO, ["-d", homeDir, "-f", join(homeDir, "config.yaml"), "-ext-ctl-unix", socket], { stdio: "ignore" });
    for (let i = 0; i < 50 && !existsSync(socket); i += 1) await sleep(200);
    const mine = new ClashController(socket);
    let status = await mine.status();
    for (let i = 0; i < 40 && !("as-claude" in status.nodeSets && "as-openai" in status.nodeSets); i += 1) { await sleep(250); status = await mine.status(); }
    const members = async (group: string) => { const g = (await mine.status()).groups.find((x) => x.name === group); return g ? `now ${g.now} of ${JSON.stringify(g.members)}` : "MISSING"; };
    say(`5) a private core on it: node sets ${Object.entries(status.nodeSets).map(([n, m]) => `${n}(${m.length})`).join(" ")}; rule sets ${JSON.stringify(status.ruleSets)}`);
    say(`   Claude: ${await members("Claude")}`);
    say(`   Claude自动选择: ${await members("Claude自动选择")}`);
    say(`   OpenAI自动选择: ${await members("OpenAI自动选择")}`);
    const seen = await clash.view();
    say(`   as the page sees it: active ${seen.active}, up to date ${seen.upToDate}, Claude live ${seen.services.claude.live} now ${seen.services.claude.now} (auto: ${seen.services.claude.autoNow})`);

    // The order turned round and a node taken out, through the service's own code: no reload, the groups follow.
    const turned = [...claude].reverse().slice(0, Math.max(1, claude.length - 1));
    await clash.saveSettings({ claude: { nodes: turned }, openai: { nodes: openai }, direct: ["203.0.113.7", "example.org"], autoUpdateHours: 24 });
    say(`6) order changed to ${JSON.stringify(turned)} → Claude自动选择: ${await members("Claude自动选择")}`);
    say(`   direct rules in the core now: ${(await mine.status()).ruleSets["as-direct"]}`);
    const last = turned[turned.length - 1]!;
    say(`7) pick ${last}: Claude now ${(await clash.select("claude", last)).services.claude.now}; back to automatic: ${(await clash.select("claude", null)).services.claude.now}`);
    say(`8) delays to Claude through the private core: ${JSON.stringify(await clash.delays("claude", "chosen"))}`);
    say(`   delays to OpenAI: ${JSON.stringify(await clash.delays("openai", "chosen"))}`);
    const all = await clash.delays("claude", "all");
    say(`   every node tried for Claude: ${Object.values(all).filter((d) => d !== null).length} of ${Object.keys(all).length} answered`);
    const after = await new ClashController(real).status();
    say(`9) the user's own core afterwards: ${after.groups.length} groups, rule sets ${JSON.stringify(Object.keys(after.ruleSets))}, tun ${after.tun} — ${JSON.stringify(after.groups.map((g) => [g.name, g.now])) === JSON.stringify(before.groups.map((g) => [g.name, g.now])) ? "as it was" : "CHANGED"}`);
  } finally {
    core?.kill();
    (server as { close?: () => void } | null)?.close?.();
    await sleep(300);
    rmSync(work, { recursive: true, force: true });
    rmSync(join(socket, ".."), { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
