import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Forwarder, isLocalDestination, type ForwarderAddress } from "../src/browser/forwarder.js";

const open: { close(): unknown }[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.close(); });

function listen(answer: string): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => { hits.push(req.url ?? ""); res.end(answer); });
  open.push({ close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r(undefined)); }) });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, hits })));
}

/** A server that sends every request on to another port of this Mac. */
function redirector(to: number): Promise<{ port: number }> {
  const server = createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${to}${req.url ?? "/"}` }); res.end(); });
  open.push({ close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r(undefined)); }) });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port })));
}

const auth = (a: ForwarderAddress, password = a.password) => ({ "Proxy-Authorization": `Basic ${Buffer.from(`${a.username}:${password}`).toString("base64")}` });
const proxyPort = (a: ForwarderAddress) => Number(new URL(a.server).port);

/** `GET url` through the forwarder, as a browser asks a proxy for a plain-HTTP page. */
function get(a: ForwarderAddress, url: string, headers: Record<string, string> = auth(a)): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort(a), path: url, headers: { Host: new URL(url).host, ...headers } }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** `CONNECT host:port` through the forwarder, as a browser asks for an HTTPS site or a WebSocket. */
function connect(a: ForwarderAddress, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort(a), method: "CONNECT", path: target, headers: auth(a) });
    req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
    req.on("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end();
  });
}

async function forwarder(opts: ConstructorParameters<typeof Forwarder>[0]) {
  const f = new Forwarder(opts);
  open.push({ close: () => f.stop() });
  return { f, at: await f.start() };
}

describe("the browser's traffic goes through the service's own forwarder (docs/browser-v0.md §7.3 转发层)", () => {
  it("passes a request for a server on this Mac that is not AgentSwitch's", async () => {
    const site = await listen("site");
    const { at } = await forwarder({ ownPorts: () => [] });
    expect(at.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await get(at, `http://127.0.0.1:${site.port}/page`)).toEqual({ status: 200, body: "site" });
    expect(site.hits).toEqual(["/page"]);
  });

  it("refuses AgentSwitch's own ports however this Mac is named, for a page and for a tunnel", async () => {
    const own = await listen("own");
    const { at } = await forwarder({ ownPorts: () => [own.port], resolve: async (host) => host === "points-home.test" ? ["127.0.0.1"] : ["203.0.113.9"] });
    for (const host of ["127.0.0.1", "localhost", "127.0.0.2", "app.localhost", "points-home.test"]) {
      expect((await get(at, `http://${host}:${own.port}/secret`)).status, host).toBe(403);
      expect(await connect(at, `${host}:${own.port}`), host).toBe(403);
    }
    expect(await connect(at, `[::1]:${own.port}`)).toBe(403);
    expect(own.hits).toEqual([]);
  });

  it("refuses the hop a redirect makes to one of them: the browser asks the forwarder for every hop", async () => {
    const own = await listen("own");
    const bounce = await redirector(own.port);
    const { at } = await forwarder({ ownPorts: () => [own.port] });
    const first = await get(at, `http://127.0.0.1:${bounce.port}/pixel.png`);
    expect(first.status).toBe(302);
    expect((await get(at, `http://127.0.0.1:${own.port}/pixel.png`)).status).toBe(403);
    expect(own.hits).toEqual([]);
  });

  it("follows the ports as they change", async () => {
    const own = await listen("own");
    let ports: number[] = [];
    const { at } = await forwarder({ ownPorts: () => ports });
    expect((await get(at, `http://127.0.0.1:${own.port}/a`)).status).toBe(200);
    ports = [own.port];
    expect((await get(at, `http://127.0.0.1:${own.port}/b`)).status).toBe(403);
  });

  it("serves only the browser it was started for: another program without its password is turned away", async () => {
    const site = await listen("site");
    const { at } = await forwarder({ ownPorts: () => [] });
    expect((await get(at, `http://127.0.0.1:${site.port}/`, {})).status).toBe(407);
    expect((await get(at, `http://127.0.0.1:${site.port}/`, auth(at, "guess"))).status).toBe(407);
    expect(site.hits).toEqual([]);
  });

  it("sends what leaves this Mac to the upstream proxy, and what stays on it or its network straight there", async () => {
    const site = await listen("site");
    const { f: outer, at: upstreamAt } = await forwarder({ ownPorts: () => [] });
    let upstream: string | null = `http://${upstreamAt.username}:${upstreamAt.password}@127.0.0.1:${proxyPort(upstreamAt)}`;
    const { f, at } = await forwarder({ ownPorts: () => [], upstream: () => upstream, resolve: async () => ["127.0.0.1"] });
    // A local server: not through the upstream.
    expect((await get(at, `http://127.0.0.1:${site.port}/local`)).status).toBe(200);
    expect(outer.stats().requests).toBe(0);
    // A name out on the network: the upstream is asked (which cannot find such a name; what it answers is its own).
    await get(at, `http://example.test:${site.port}/out`);
    expect(outer.stats().requests).toBe(1);
    expect(f.stats().requests).toBe(2);
    // Changed without a restart.
    upstream = null;
    await get(at, `http://example.test:${site.port}/again`).catch(() => undefined);
    expect(outer.stats().requests).toBe(1);
  });

  it("knows what is this Mac or its own network", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "10.0.0.5", "192.168.1.20", "172.16.3.4", "172.31.255.1", "169.254.10.1", "printer.local", "app.localhost"]) expect(isLocalDestination(host), host).toBe(true);
    for (const host of ["example.com", "172.32.0.1", "8.8.8.8", "11.0.0.1", "local.example.com"]) expect(isLocalDestination(host), host).toBe(false);
  });
});
