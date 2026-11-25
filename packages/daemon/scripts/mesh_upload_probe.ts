/** docs/mesh-v0.md by hand (2026-10-11, user: 我在远程使用mac session的时候粘贴图片有的时候卡半天): how long a picture takes
 *  on the service's own part of the way — from one node's 127.0.0.1 listener (where the Mac app posts it, as
 *  `/nodes/<id>/uploads`), forwarded over the pinned HTTPS connection to the other node's remote listener, staged there.
 *
 *  Two services in this process, each with its own certificate and real listeners on 127.0.0.1, on throw-away homes
 *  under the temporary folder; no terminal, no agent, no model. Not part of the tests.
 *
 *    env -i PATH=… HOME=$HOME TMPDIR=$TMPDIR node --import tsx scripts/mesh_upload_probe.ts [--frozen | --only-frozen]
 *
 *  `--frozen` adds the slow part (minutes): the link between the two stops carrying anything without being closed —
 *  a Mac asleep, a Wi-Fi left — and a request and an upload are sent into it. `--only-frozen` runs that part alone. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildDaemon, listenLocal, startRemote, type Daemon, type DaemonConfig } from "../src/daemon.js";
import { NODES_KEY_HEADER } from "../src/nodes/book.js";
import { remoteRuntime, type RemoteRuntime } from "../src/remote/runtime.js";
import type { RemoteListener } from "../src/remote/server.js";
import { ensureTls } from "../src/remote/tls.js";

const HERE = new URL(".", import.meta.url).pathname;
const TARGETS = join(HERE, "..", "config", "targets.yaml");
const KEY = Buffer.alloc(32, 9).toString("base64url");
const MB = 1024 * 1024;
const homes: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
});

type Node = { name: string; d: Daemon; runtime: RemoteRuntime; listener: RemoteListener; local: string; key: string; listensOn: number };

/** A service. `advertised`: the port its pairing link names, when something stands between it and the other node. */
async function node(name: string, advertised?: number): Promise<Node> {
  const home = mkdtempSync(join(tmpdir(), "agentswitch-upload-probe-"));
  homes.push(home);
  const cfg: DaemonConfig = { home, targetsPath: TARGETS, port: 0, opencodeBinary: "" };
  const listensOn = await freePort();
  const runtime = remoteRuntime({
    home, port: advertised ?? listensOn, name, gate: () => null, tls: ensureTls(join(home, "remote")),
    addresses: async () => ({ lan: ["127.0.0.1"], tailnet: [] }), gateKey: async () => ({ publicKey: KEY, keypair: "default" }),
  });
  const d = buildDaemon(cfg, { remote: runtime });
  const listener = await startRemote(d, { ...runtime, port: listensOn }, "127.0.0.1");
  const port = await new Promise<number>((done) => { const server = listenLocal(d, 0, (info) => done(info.port)); closers.push(() => { server.close(); }); });
  d.setLocalPort(port);
  const made: Node = { name, d, runtime, listener, local: `http://127.0.0.1:${port}`, key: readFileSync(join(home, "nodes", "key"), "utf8").trim(), listensOn };
  closers.push(async () => { await made.listener.close(); d.close(); });
  return made;
}

/** `from` uses `to`: `to` shows a link, `from` takes it. Returns what `from` calls `to`. */
async function pair(from: Node, to: Node): Promise<string> {
  const shown = (await (await fetch(`${to.local}/pairing`, { method: "POST", headers: { "content-type": "application/json", [NODES_KEY_HEADER]: to.key }, body: JSON.stringify({ back: false }) })).json()) as { link: string };
  const added = await fetch(`${from.local}/nodes`, { method: "POST", headers: { "content-type": "application/json", [NODES_KEY_HEADER]: from.key }, body: JSON.stringify({ link: shown.link, back: false }) });
  const body = (await added.json()) as { node?: { id: string }; error?: string };
  if (!body.node) throw new Error(`pairing: HTTP ${added.status} ${body.error ?? ""}`);
  return body.node.id;
}

type Timed = { ms: number; status: number; said: string };

async function post(url: string, key: string, bytes: number, timeoutMs = 200_000): Promise<Timed> {
  const form = new FormData();
  form.append("file", new Blob([randomBytes(bytes)], { type: "image/png" }), "pasted.png");
  const began = performance.now();
  try {
    const res = await fetch(url, { method: "POST", headers: { [NODES_KEY_HEADER]: key }, body: form, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { ms: performance.now() - began, status: res.status, said: res.status === 200 ? "" : text.slice(0, 120) };
  } catch (err) {
    return { ms: performance.now() - began, status: 0, said: (err as Error).message };
  }
}

async function get(url: string, key: string, timeoutMs = 200_000): Promise<Timed> {
  const began = performance.now();
  try {
    const res = await fetch(url, { headers: { [NODES_KEY_HEADER]: key }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { ms: performance.now() - began, status: res.status, said: res.status === 200 ? "" : text.slice(0, 120) };
  } catch (err) {
    return { ms: performance.now() - began, status: 0, said: (err as Error).message };
  }
}

const shown = (t: Timed): string => `${t.ms.toFixed(0)} ms${t.status === 200 ? "" : ` (HTTP ${t.status}${t.said ? `: ${t.said}` : ""})`}`;
const row = (what: string, times: Timed[]): void => console.log(`  ${what.padEnd(46)} ${times.map(shown).join(", ")}`);

/** Something between two nodes that can stop carrying anything without closing anything: while frozen, what arrives
 *  from either side is dropped, a connection one side closes stays open for the other, and a new connection is taken
 *  and left unanswered. Thawed, the connections that sat through it are closed (their bytes are lost) and new ones
 *  are carried again. */
async function relay(to: () => number): Promise<{ port: number; freeze(): void; thaw(): void; close(): void }> {
  const pairs: [Socket, Socket | null][] = [];
  let frozen = false;
  const server = createServer((near) => {
    near.on("error", () => undefined);
    if (frozen) { pairs.push([near, null]); near.on("data", () => undefined); return; }
    const far = connect(to(), "127.0.0.1");
    pairs.push([near, far]);
    const carry = (a: Socket, b: Socket) => {
      a.on("data", (chunk) => { if (!frozen) b.write(chunk); });
      a.on("error", () => { if (!frozen) b.destroy(); });
      a.on("close", () => { if (!frozen) b.destroy(); });
    };
    carry(near, far);
    carry(far, near);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const drop = () => { for (const [a, b] of pairs.splice(0)) { a.destroy(); b?.destroy(); } };
  return {
    port: (server.address() as AddressInfo).port,
    freeze: () => { frozen = true; },
    thaw: () => { frozen = false; drop(); },
    close: () => { server.close(); drop(); },
  };
}

async function main(): Promise<void> {
  const frozen = process.argv.includes("--frozen") || process.argv.includes("--only-frozen");
  const laptop = await node("Laptop");
  if (!process.argv.includes("--only-frozen")) await usual(laptop);
  if (frozen) await quiet(laptop);
}

async function usual(laptop: Node): Promise<void> {
  const studio = await node("Studio");
  const id = await pair(laptop, studio);
  const through = `${laptop.local}/nodes/${id}/uploads`;
  console.log(`Laptop uses Studio (${id}); a picture posted to Laptop's own listener, staged on Studio`);

  console.log("\n== five in a row of each size: through the other node, and to a node's own listener for comparison");
  for (const mb of [1, 8, 20]) {
    const forwarded: Timed[] = [], own: Timed[] = [];
    for (let i = 0; i < 5; i++) { forwarded.push(await post(through, laptop.key, mb * MB)); own.push(await post(`${studio.local}/uploads`, studio.key, mb * MB)); }
    row(`${mb} MB through Laptop to Studio`, forwarded);
    row(`${mb} MB to Studio's own listener`, own);
  }

  console.log("\n== the first after the connection sat idle (the other side closes an idle one after 5 s)");
  for (const idle of [4_800, 5_000, 5_200, 6_500, 12_000]) {
    await post(through, laptop.key, MB);
    await sleep(idle);
    row(`8 MB after ${(idle / 1000).toFixed(1)} s of nothing`, [await post(through, laptop.key, 8 * MB)]);
  }

  console.log("\n== while keys are typed elsewhere on the same connection (a request every 40 ms), ten pictures");
  let typing = true;
  const keys = (async () => { let n = 0; while (typing) { await get(`${laptop.local}/nodes/${id}/healthz`, laptop.key); n += 1; await sleep(40); } return n; })();
  const busy: Timed[] = [];
  for (let i = 0; i < 10; i++) { busy.push(await post(through, laptop.key, 8 * MB)); await sleep(300); }
  typing = false;
  row(`8 MB (${await keys} small requests beside them)`, busy);

  console.log("\n== the other node's service started again");
  await post(through, laptop.key, MB);
  await studio.listener.close();
  studio.listener = await startRemote(studio.d, { ...studio.runtime, port: studio.listensOn }, "127.0.0.1");
  row("8 MB right after", [await post(through, laptop.key, 8 * MB), await post(through, laptop.key, 8 * MB)]);
  await post(through, laptop.key, MB);
  await studio.listener.close();
  row("8 MB while it is down", [await post(through, laptop.key, 8 * MB)]);
  studio.listener = await startRemote(studio.d, { ...studio.runtime, port: studio.listensOn }, "127.0.0.1");
  row("8 MB once it is back", [await post(through, laptop.key, 8 * MB), await post(through, laptop.key, 8 * MB)]);
}

/** The link stops carrying anything and nothing is closed: a Mac asleep, a Wi-Fi left. */
async function quiet(laptop: Node): Promise<void> {
  console.log("\n== the link stops carrying anything, nothing is closed (a Mac asleep, a Wi-Fi left)");
  let target = 0;
  const between = await relay(() => target);
  closers.push(() => between.close());
  const far = await node("Far", between.port);
  target = far.listensOn;
  const id = await pair(laptop, far);
  const uploads = `${laptop.local}/nodes/${id}/uploads`, list = `${laptop.local}/nodes/${id}/tasks`;
  const both = async (bytes: number) => Promise.all([get(list, laptop.key), post(uploads, laptop.key, bytes)]);
  row("8 MB while the link is good", [await post(uploads, laptop.key, 8 * MB), await post(uploads, laptop.key, 8 * MB)]);
  // Frozen right after a request went through: the service still takes the address for good.
  between.freeze();
  const [asked, sent] = await both(8 * MB);
  row("a list asked for right after it froze", [asked]);
  row("8 MB sent right after it froze", [sent]);
  const [again, small] = await both(200 * 1024);
  row("the next list, still frozen", [again]);
  row("200 KB sent, still frozen", [small]);
  between.thaw();
  row("8 MB once it carries again", [await post(uploads, laptop.key, 8 * MB), await post(uploads, laptop.key, 8 * MB)]);
  // Frozen after the link sat quiet for a while: what the Mac app would send first after a pause.
  await sleep(8_000);
  between.freeze();
  const [later, picture] = await both(8 * MB);
  row("a list asked for, frozen while it sat quiet 8 s", [later]);
  row("8 MB sent, frozen while it sat quiet 8 s", [picture]);
  between.thaw();
  row("8 MB once it carries again", [await post(uploads, laptop.key, 8 * MB)]);
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(async () => {
  for (const close of closers.reverse()) { try { await close(); } catch { /* the rest still close */ } }
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  // Whatever a daemon still holds (a timer, a kept socket) does not keep the probe alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});
