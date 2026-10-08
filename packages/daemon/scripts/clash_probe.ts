/** Clash Integration tried for real on this Mac without touching the user's Clash (docs/clash-v0.md §7):
 *
 *  1. looks, read only, at the Clash Verge here and what its core runs;
 *  2. in a folder of its own, takes Clash Verge's current subscription in as the one to work from — which fetches the
 *     links it names from the subscription service, once, as Clash would;
 *  3. serves what AgentSwitch would serve on a loopback port, behind the local listener's own gate;
 *  4. has the core's own program check the subscription made (`-t`), then starts a second, private core on it (no
 *     TUN, no DNS, no ports; its own folder and control socket) and, through the same code the service uses, changes
 *     the nodes' order, picks a node, asks for delays, turns the rule templates on and off — reading back from the
 *     private core what its groups and rule sets became;
 *  5. takes the subscription service's own link in as well (the one the user's file names for its nodes) and has the
 *     core's program check what is made of it with its default group called Manual, the rule templates and the DNS
 *     template on;
 *  6. runs the routing check on the user's own running core: a few ordinary connections through its proxy port.
 *
 *  Nothing of Clash Verge's is written and its core is only read. Real nodes are tried (step 8), as Clash Verge's own
 *  delay test does.   npx tsx scripts/clash_probe.ts [path to mihomo]   (CLASH_PROBE_TMP: a short folder for the socket) */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { ClashSource, linkedProviders } from "../src/clash/source.js";
import { ClashStore } from "../src/clash/store.js";
import { vergeDir, vergeProfiles, vergeSocket } from "../src/clash/verge.js";
import { listenLocal } from "../src/daemon.js";

const MIHOMO = process.argv[2] ?? "/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line: string) => console.log(line);

async function main(): Promise<void> {
  const profiles = vergeProfiles(), real = vergeSocket();
  // The user's own subscription: the first of Clash Verge's that is not AgentSwitch's (served from this Mac).
  const own = profiles?.profiles.find((p) => !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(p.from ?? ""));
  if (!profiles || !own || !real) { say("Clash Verge not found or not running, or it has no subscription of its own"); return; }
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

    const taken = await clash.setSource({ verge: own.uid });
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
    const log = openSync(join(work, "core.log"), "w");
    core = spawn(MIHOMO, ["-d", homeDir, "-f", join(homeDir, "config.yaml"), "-ext-ctl-unix", socket], { stdio: ["ignore", log, log] });
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
    // The rule templates: on, the user's own lines, off — each a change of a rule set's content alone.
    const counts = async () => { const r = (await mine.status()).ruleSets; return `as-domestic ${r["as-domestic"]}, as-domestic-ip ${r["as-domestic-ip"]}, as-block ${r["as-block"]}`; };
    const base = { claude: { nodes: turned }, openai: { nodes: openai }, direct: ["203.0.113.7"], autoUpdateHours: 24, renameDefault: false };
    say(`10) templates off: ${await counts()}`);
    const on = await clash.saveSettings({ ...base, templates: { domestic: { on: true, rules: null }, block: { on: true, rules: null } } });
    say(`    both on: ${await counts()} (the page: ${JSON.stringify(on.templates)}, up to date ${on.upToDate})`);
    await clash.saveSettings({ ...base, templates: { domestic: { on: true, rules: ["DOMAIN-SUFFIX,cn", "PROCESS-NAME-WILDCARD,*DingTalk*", "IP-CIDR,192.168.0.0/16", "GEOIP,CN"] }, block: { on: false, rules: null } } });
    say(`    the user's own four lines, blocking off: ${await counts()}`);
    const complaints = readFileSync(join(work, "core.log"), "utf8").split("\n").filter((l) => /level=(error|warning)/.test(l) && /rule|provider|as-/i.test(l));
    say(`    the private core's complaints about rules or sets: ${complaints.length ? complaints.slice(0, 4).map((l) => l.replace(/^.*msg=/, "")).join(" / ") : "none"}`);

    // The subscription service's own link as the thing to work from (the link the user's file names for its nodes):
    // its default group called Manual.
    const link = Object.values(linkedProviders(parse(readFileSync(join(work, "clash", "source", "main.yaml"), "utf8")) as Record<string, unknown>))[0];
    if (link) {
      const second = mkdtempSync(join(tmpdir(), "as-clash-probe2-"));
      try {
        const raw = new ClashIntegration({ store: new ClashStore(second), source: new ClashSource(second, undefined, undefined, () => `clash.meta/${before.version}`), base: () => `http://127.0.0.1:${port}`, socket: () => null });
        const got2 = await raw.setSource({ link });
        say(`11) the service's own link taken in: ${got2.nodes.length} nodes, default group ${JSON.stringify(got2.defaultGroup)}`);
        const theirs = (parse(raw.subscription()!.text) as Record<string, any>).dns;
        const all = await raw.saveSettings({ claude: { nodes: claude }, openai: { nodes: openai }, direct: [], autoUpdateHours: 24, renameDefault: true, templates: { domestic: { on: true, rules: null }, block: { on: true, rules: null } }, dns: { on: true, text: null } });
        const text2 = raw.subscription()!.text;
        const made2 = parse(text2) as Record<string, any>;
        say(`    dns: the service's own had ${theirs ? `${Object.keys(theirs).length} keys (${theirs["enhanced-mode"] ?? "no mode"}, ${Object.keys(theirs["nameserver-policy"] ?? {}).length} policies)` : "none"}; with the template ${Object.keys(made2.dns).length} keys (${made2.dns["enhanced-mode"]}, ${Object.keys(made2.dns["nameserver-policy"]).length} policies, ${made2.dns["fake-ip-filter"].length} names kept real); Clash Verge's own DNS settings on: ${all.dns.overridden}`);
        say(`    groups: ${made2["proxy-groups"].map((g: { name: string; type: string }) => `${g.name}(${g.type})`).join(" | ")}`);
        say(`    rules: ${made2.rules.length}; first ${made2.rules.slice(0, 5).join(" | ")}; last ${made2.rules.slice(-5).join(" | ")}`);
        say(`    rules that still name the old group: ${made2.rules.filter((r: string) => got2.defaultGroup && r.split(",").includes(got2.defaultGroup)).length}`);
        writeFileSync(join(homeDir, "as-made-2.yaml"), text2);
        const check2 = spawnSync(MIHOMO, ["-t", "-d", homeDir, "-f", join(homeDir, "as-made-2.yaml")], { encoding: "utf8", timeout: 30_000 });
        say(`    the core's own check of it: ${/test is successful/.test(check2.stdout + check2.stderr) ? "passes" : `FAILS: ${(check2.stdout + check2.stderr).split("\n").filter((l) => /error|fatal/i.test(l)).slice(0, 3).join(" / ")}`}`);
      } finally { rmSync(second, { recursive: true, force: true }); }
    }
    // The routing check on the user's own running core: a connection of each kind through its proxy port, and what it
    // made of each. Whatever subscription it runs, the same kinds are tried; what should happen is what these settings ask.
    const live = new ClashIntegration({ store: new ClashStore(work), source: new ClashSource(work), base: () => `http://127.0.0.1:${port}`, socket: () => real });
    await live.saveSettings({ claude: { nodes: claude }, openai: { nodes: openai }, direct: [], autoUpdateHours: 24, renameDefault: false, templates: { domestic: { on: true, rules: null }, block: { on: true, rules: null } }, dns: { on: false, text: null } });
    const t0 = Date.now();
    const checked = await live.check();
    say(`12) the routing check on the user's own core (${Date.now() - t0} ms):`);
    for (const r of checked.rows) say(`    ${r.ok === null ? "·" : r.ok ? "✓" : "✗"} ${r.title} (${r.host}): ${r.observed.outcome}${r.observed.rule ? ` by ${r.observed.rule}` : ""}${r.observed.path.length ? ` → ${r.observed.path.join(" → ")}` : ""}${r.observed.exit ? ` · seen from ${r.observed.exit.loc} ${r.observed.exit.ip.replace(/\d+\.\d+$/, "x.x")} · ${r.observed.ms} ms` : ""}${r.expect ? `   [should: ${r.expect.kind === "group" ? r.expect.group : r.expect.kind}]` : ""}`);
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
