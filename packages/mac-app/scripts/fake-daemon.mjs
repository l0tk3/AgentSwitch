#!/usr/bin/env node
// Stand-in for the daemon's loopback management routes (docs/app-v0.md §2), for UI work and the Swift
// integration test while the real ones are not available. No dependencies; state lives in memory.
//
//   node scripts/fake-daemon.mjs [--port 4711] [--remote-port 4713]
//   POST /__fake/pair {"name":"iPhone","platform":"ios"}   simulates a phone completing the pairing
//
// Prints {"port": N} on stdout once listening (--port 0 picks a free port).

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { networkInterfaces, hostname } from "node:os";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const PORT = arg("--port", 4711);
const REMOTE_PORT = arg("--remote-port", 4713);
const PAIRING_TTL_MS = 5 * 60_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const FINGERPRINT = "3f".repeat(8) + "a1b2c3d4".repeat(6);
const NAME = hostname().replace(/\.local$/, "");

let devices = [];
let pairing = null;
let models = { router: "deepseek/deepseek-flash", harness: "claude-code", model: "claude-sonnet-5" };
const catalog = {
  "claude-code": { models: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"], default_model: "claude-sonnet-5" },
  codex: { models: ["gpt-6-astra", "gpt-5.5"], default_model: "gpt-6-astra" },
  opencode: { models: ["deepseek/deepseek-flash"], default_model: "deepseek/deepseek-flash" },
};

const lan = () => Object.values(networkInterfaces()).flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
  .map((a) => a.address);

const newCode = () => [...randomBytes(8)].map((b) => CROCKFORD[b % 32]).join("").replace(/^(.{4})/, "$1-");

function newPairing() {
  const code = newCode();
  const payload = {
    v: 1, name: NAME, port: REMOTE_PORT, fp: FINGERPRINT, code, lan: lan(), tailnet: [],
    bonjour: `AgentSwitch on ${NAME}`, gate: { publicKey: randomBytes(32).toString("base64url"), keypair: "default" },
  };
  const link = `agentswitch://pair?p=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  pairing = { code, expiresAt: Date.now() + PAIRING_TTL_MS, used: false };
  return { code, expiresAt: pairing.expiresAt, link, payload };
}

const body = (req) => new Promise((resolve) => {
  let text = "";
  req.on("data", (c) => { text += c; });
  req.on("end", () => { try { resolve(text ? JSON.parse(text) : {}); } catch { resolve(null); } });
});

const send = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /healthz") return send(res, 200, { ok: true, version: "fake" });
  if (route === "POST /pairing") return send(res, 200, newPairing());
  if (route === "GET /devices") return send(res, 200, devices.map((d) => ({ ...d, online: !d.revokedAt })));
  if (req.method === "DELETE" && url.pathname.startsWith("/devices/")) {
    const id = decodeURIComponent(url.pathname.slice("/devices/".length));
    const found = devices.find((d) => d.id === id);
    if (!found) return send(res, 404, { error: "not found" });
    devices = devices.map((d) => (d.id === id ? { ...d, revokedAt: d.revokedAt ?? Date.now() } : d));
    return send(res, 200, { ok: true });
  }
  if (route === "GET /remote/info") {
    return send(res, 200, { enabled: true, port: REMOTE_PORT, fingerprint: FINGERPRINT, lan: lan(), tailnet: [],
      bonjour: `AgentSwitch on ${NAME}`, onlineDevices: devices.filter((d) => !d.revokedAt).length });
  }
  if (route === "GET /settings/models") {
    return send(res, 200, { router: { model: models.router, options: ["deepseek/deepseek-flash", "claude-haiku-4-5-20251001"] },
      default: { harness: models.harness, model: models.model }, harnesses: catalog });
  }
  if (route === "PUT /settings/models") {
    const b = await body(req);
    if (!b) return send(res, 400, { error: "invalid JSON" });
    if (b.default && !catalog[b.default.harness]?.models.includes(b.default.model)) return send(res, 400, { error: "unknown harness/model" });
    models = { router: b.router?.model ?? models.router, harness: b.default?.harness ?? models.harness, model: b.default?.model ?? models.model };
    return send(res, 200, { restartRequired: true });
  }
  if (route === "POST /__fake/pair") {
    const b = (await body(req)) ?? {};
    if (!pairing || pairing.used || pairing.expiresAt < Date.now()) return send(res, 401, { error: "pairing failed" });
    pairing = { ...pairing, used: true };
    const device = { id: randomUUID(), name: b.name ?? "iPhone", platform: b.platform ?? "ios", createdAt: Date.now(), lastSeenAt: Date.now(), revokedAt: null };
    devices = [...devices, device];
    return send(res, 200, { deviceId: device.id, token: randomBytes(32).toString("base64url") });
  }
  return send(res, 404, { error: "not found" });
}).listen(PORT, "127.0.0.1", function onListen() {
  process.stdout.write(JSON.stringify({ port: this.address().port }) + "\n");
});
