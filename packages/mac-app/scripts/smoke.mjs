#!/usr/bin/env node
// Smoke test of the bundled runtime, playing the phone (docs/app-v0.md §7 Mac 应用). No dependencies.
//
//   node scripts/smoke.mjs --app build/AgentSwitch.app --work <scratch dir> [--attach]
//       [--local 4811 --remote 4813 --gate 8180 --opencode 4814]
//
// Default: starts the bundled gate and daemon itself (echo executors and router, throw-away homes under
// --work), exactly as the app would, then stops them. --attach: the app already runs them; only the phone part.
// Phone part: gate probe, /healthz, /remote/info, POST /pairing, TLS pinned by the certificate's SHA-256,
// POST /pair (wrong code, right code, reused code), /me, /gate/pubkey, an echo task and its SSE events,
// remote route allowlist, device revoke → 401.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, existsSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { Agent, request as httpsRequest } from "node:https";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const APP = resolve(opt("app", "build/AgentSwitch.app"));
const WORK = resolve(opt("work", "/tmp/agentswitch-smoke"));
const ATTACH = args.includes("--attach");
const PORTS = { local: +opt("local", 4811), remote: +opt("remote", 4813), gate: +opt("gate", 8180), opencode: +opt("opencode", 4814) };
const RUNTIME = join(APP, "Contents/Resources/runtime");
const HOME_AS = join(WORK, "agentswitch-home");
const HOME_SG = join(WORK, "secret-gate-home");
const LOGS = join(WORK, "logs");
const GATE_BIN = join(RUNTIME, "python/bin/secret-gate");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- the gate probe of `secret-gate bootstrap` (proxy_probe.py), raw TCP
function gateProbe(port) {
  return new Promise((resolveProbe) => {
    const sock = tcpConnect({ host: "127.0.0.1", port }, () => {
      sock.write("GET http://127.0.0.1:9/secret-gate-probe HTTP/1.1\r\nHost: 127.0.0.1:9\r\n"
        + `X-Secret-Gate-Probe: enc:v1:${"A".repeat(24)}\r\nConnection: close\r\n\r\n`);
    });
    let head = "";
    sock.setTimeout(3000, () => { sock.destroy(); resolveProbe(null); });
    sock.on("data", (d) => { head += d.toString("latin1"); });
    sock.on("error", () => resolveProbe(null));
    sock.on("close", () => resolveProbe(head.split("\r\n\r\n")[0]));
  });
}

// ---- local HTTP (loopback, plain)
async function local(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORTS.local}${path}`, {
    method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

// ---- remote HTTPS, trusting only the pinned certificate fingerprint (SHA-256 of the DER). A full handshake per
// request: a resumed TLS session carries no certificate to check.
const FRESH_TLS = new Agent({ keepAlive: false, maxCachedSessions: 0 });
function remote(method, path, { body, token, fingerprint, host = "127.0.0.1", sse = false } = {}) {
  return new Promise((resolveReq, reject) => {
    const req = httpsRequest({
      host, port: PORTS.remote, method, path, rejectUnauthorized: false, agent: FRESH_TLS,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(sse ? { accept: "text/event-stream" } : {}) },
    }, (res) => {
      const cert = res.socket.getPeerCertificate();
      if (!cert?.raw) { req.destroy(); reject(new Error("no peer certificate to pin")); return; }
      const seen = createHash("sha256").update(cert.raw).digest("hex");
      if (fingerprint && seen !== fingerprint) { req.destroy(); reject(new Error(`certificate fingerprint ${seen} != pinned ${fingerprint}`)); return; }
      let text = "";
      res.on("data", (d) => { text += d; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* SSE or empty */ }
        resolveReq({ status: res.statusCode, json, text, fingerprint: seen });
      });
    });
    req.setTimeout(60_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function childEnv(extra) {
  return {
    HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME, TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "en_US.UTF-8", ...extra,
  };
}

function startChildren() {
  mkdirSync(HOME_AS, { recursive: true, mode: 0o700 });
  mkdirSync(HOME_SG, { recursive: true, mode: 0o700 });
  mkdirSync(LOGS, { recursive: true, mode: 0o700 });
  const gateEnv = childEnv({ PATH: `${join(RUNTIME, "python/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, SECRET_GATE_HOME: HOME_SG, PYTHONDONTWRITEBYTECODE: "1" });
  const keys = JSON.parse(execFileSync(GATE_BIN, ["keys", "--json"], { env: gateEnv }).toString());
  if (!keys.length) execFileSync(GATE_BIN, ["keys", "--json", "new", "default", "--use"], { env: gateEnv });
  const gate = spawn(GATE_BIN, ["proxy", "--port", String(PORTS.gate)], { env: gateEnv, stdio: ["ignore", openSync(join(LOGS, "gate.log"), "a"), openSync(join(LOGS, "gate.log"), "a")] });
  const daemonEnv = childEnv({
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    AGENTSWITCH_HOME: HOME_AS, AGENTSWITCH_PORT: String(PORTS.local), AGENTSWITCH_REMOTE: "1", AGENTSWITCH_REMOTE_PORT: String(PORTS.remote),
    AGENTSWITCH_OPENCODE_PORT: String(PORTS.opencode), AGENTSWITCH_EXECUTORS: "echo", AGENTSWITCH_ROUTER: "echo",
    AGENTSWITCH_REMOTE_NAME: "Smoke Mac", SECRET_GATE_HOME: HOME_SG, SECRET_GATE_BIN: GATE_BIN, SECRET_GATE_PROXY: `http://127.0.0.1:${PORTS.gate}`,
    PYTHONDONTWRITEBYTECODE: "1", TAILSCALE_BE_CLI: "1",
  });
  const daemon = spawn(join(RUNTIME, "node/bin/node"), ["--no-warnings=ExperimentalWarning", join(RUNTIME, "daemon/dist/cli.js"), "serve"],
    { env: daemonEnv, cwd: join(RUNTIME, "daemon"), stdio: ["ignore", openSync(join(LOGS, "daemon.log"), "a"), openSync(join(LOGS, "daemon.log"), "a")] });
  return { gate, daemon };
}

function stopChild(child, signal) {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolveStop({ code: child.exitCode, signal: child.signalCode }); return; }
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", (code, sig) => { clearTimeout(timer); resolveStop({ code, signal: sig }); });
    child.kill(signal);
  });
}

async function phone() {
  const head = await waitFor("gate probe", async () => { const h = await gateProbe(PORTS.gate); return h && h.startsWith("HTTP/") ? h : null; });
  check("gate answers the bootstrap probe with 403 X-Secret-Gate: denied", /^HTTP\/1\.\d 403/.test(head) && /x-secret-gate:\s*denied/i.test(head), head.split("\r\n")[0]);

  const health = await waitFor("daemon /healthz", async () => { const r = await local("GET", "/healthz"); return r.status === 200 ? r : null; });
  check("daemon /healthz on the loopback listener", health.json?.ok === true, `version ${health.json?.version}`);

  const info = (await local("GET", "/remote/info")).json;
  check("GET /remote/info: remote enabled with a fingerprint", info?.enabled && /^[0-9a-f]{64}$/.test(info.fingerprint ?? ""), `port ${info?.port}, bonjour "${info?.bonjour}", lan ${JSON.stringify(info?.lan)}, tailnet ${JSON.stringify(info?.tailnet)}`);
  check("remote port is the configured one", info.port === PORTS.remote);

  const pairing = await local("POST", "/pairing");
  check("POST /pairing returns code, expiresAt, link, payload", pairing.status === 200 && pairing.json?.code && pairing.json?.link?.startsWith("agentswitch://pair?p="), `code ${pairing.json?.code}`);
  const payload = JSON.parse(Buffer.from(new URL(pairing.json.link).searchParams.get("p"), "base64url").toString());
  check("link payload carries fp, port, code and the gate public key", payload.fp === info.fingerprint && payload.port === PORTS.remote && payload.code === pairing.json.code && payload.gate?.publicKey,
    `keypair ${payload.gate?.keypair}`);
  const gateKeys = JSON.parse(execFileSync(GATE_BIN, ["keys", "--json"], { env: childEnv({ SECRET_GATE_HOME: ATTACH ? opt("gate-home", HOME_SG) : HOME_SG, PATH: "/usr/bin:/bin" }) }).toString());
  check("payload public key is the gate's current keypair", gateKeys.some((k) => k.current && k.public === payload.gate.publicKey));
  check("expiry about five minutes out", Math.abs(pairing.json.expiresAt - Date.now() - 300_000) < 15_000);

  const pinnedHealth = await remote("GET", "/healthz", { fingerprint: payload.fp });
  check("remote /healthz over TLS pinned to the payload fingerprint", pinnedHealth.status === 200 && pinnedHealth.json?.ok === true, pinnedHealth.fingerprint.slice(0, 16));
  let mismatch = null;
  try { await remote("GET", "/healthz", { fingerprint: "0".repeat(64) }); } catch (err) { mismatch = err.message; }
  check("a different pinned fingerprint is refused by the client", mismatch?.includes("!= pinned"));

  const wrong = await remote("POST", "/pair", { fingerprint: payload.fp, body: { code: "ZZZZ-ZZZZ", name: "Smoke iPhone", platform: "ios" } });
  check("wrong pairing code → 401", wrong.status === 401);
  const paired = await remote("POST", "/pair", { fingerprint: payload.fp, body: { code: payload.code, name: "Smoke iPhone", platform: "ios" } });
  check("POST /pair with the code → deviceId + token", paired.status === 200 && paired.json?.deviceId && paired.json?.token, paired.json?.deviceId);
  const token = paired.json.token;
  const reused = await remote("POST", "/pair", { fingerprint: payload.fp, body: { code: payload.code, name: "Second", platform: "ios" } });
  check("the same code again → 401 (one use)", reused.status === 401);

  const noToken = await remote("GET", "/me", { fingerprint: payload.fp });
  check("GET /me without a token → 401", noToken.status === 401);
  const me = await remote("GET", "/me", { fingerprint: payload.fp, token });
  check("GET /me with the token", me.status === 200 && me.json?.deviceId === paired.json.deviceId, me.json?.name);
  const pub = await remote("GET", "/gate/pubkey", { fingerprint: payload.fp, token });
  check("GET /gate/pubkey matches the payload", pub.status === 200 && pub.json?.publicKey === payload.gate.publicKey);
  const mcp = await remote("GET", "/mcp", { fingerprint: payload.fp, token });
  check("GET /mcp is not served remotely → 404", mcp.status === 404);
  const pairingRemote = await remote("POST", "/pairing", { fingerprint: payload.fp, token });
  check("POST /pairing is not served remotely → 404", pairingRemote.status === 404);

  const task = await remote("POST", "/tasks", { fingerprint: payload.fp, token, body: { task: "smoke test from the phone @echo {\"result\":\"smoke ok\",\"delayMs\":50}" } });
  check("POST /tasks with the device token", (task.status === 200 || task.status === 201) && task.json?.id, `task ${task.json?.id} ${task.json?.status}`);
  const events = await remote("GET", `/tasks/${task.json.id}/events`, { fingerprint: payload.fp, token, sse: true });
  const types = [...events.text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  check("SSE events over the remote listener end in done", types.includes("done"), types.join(","));
  const detail = await remote("GET", `/tasks/${task.json.id}`, { fingerprint: payload.fp, token });
  check("GET /tasks/:id reports done", detail.json?.status === "done" || detail.json?.task?.status === "done", detail.json?.status ?? detail.json?.task?.status);

  const devices = (await local("GET", "/devices")).json;
  const mine = devices.find((d) => d.id === paired.json.deviceId);
  check("GET /devices lists the phone", mine && mine.name === "Smoke iPhone" && mine.revokedAt === null, `online ${mine?.online}`);
  const revoke = await local("DELETE", `/devices/${paired.json.deviceId}`);
  check("DELETE /devices/:id", revoke.status === 200);
  const after = await remote("GET", "/me", { fingerprint: payload.fp, token });
  check("revoked token → 401 at once", after.status === 401);
  return { fingerprint: info.fingerprint, bonjour: info.bonjour, deviceId: paired.json.deviceId };
}

async function main() {
  if (!existsSync(RUNTIME)) throw new Error(`no runtime at ${RUNTIME}`);
  let children = null;
  if (!ATTACH) {
    for (const [name, port] of Object.entries(PORTS)) {
      const busy = await new Promise((r) => { const s = tcpConnect({ host: "127.0.0.1", port }, () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
      if (busy) throw new Error(`port ${port} (${name}) is in use; refusing to touch it`);
    }
    children = startChildren();
    const killAll = () => { children.daemon.kill("SIGKILL"); children.gate.kill("SIGKILL"); };
    process.on("uncaughtException", (err) => { console.error(`SMOKE CRASHED: ${err.stack}`); killAll(); process.exit(1); });
  }
  let summary;
  try {
    summary = await phone();
  } finally {
    if (children) {
      const d = await stopChild(children.daemon, "SIGTERM");
      const g = await stopChild(children.gate, "SIGTERM");
      console.log(`daemon exit ${JSON.stringify(d)}, gate exit ${JSON.stringify(g)}`);
      if (summary) {
        check("daemon exits 0 on SIGTERM", d.code === 0);
        check("gate stops on SIGTERM", d && (g.code !== null || g.signal !== null));
      }
    }
  }
  console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, ...summary }));
}

main().catch((err) => { console.error(`SMOKE FAILED: ${err.message}`); process.exit(1); });
