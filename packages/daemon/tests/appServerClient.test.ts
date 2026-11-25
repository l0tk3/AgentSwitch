import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AppServerClient, type Json } from "../src/harness/appserver.js";

describe("AppServerClient", () => {
  it("requests, notifications and server requests over a fake transport", async () => {
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    const notes: string[] = [];
    const client = new AppServerClient(toServer, fromServer, async (method, params) => ({ echoed: method, ok: (params as { x?: number }).x }), (m) => notes.push(m));
    const serverSeen: Json[] = [];
    toServer.on("data", (d: Buffer) => { for (const line of d.toString().split("\n").filter(Boolean)) serverSeen.push(JSON.parse(line) as Json); });
    const p = client.request("initialize", { a: 1 });
    await vi.waitFor(() => expect(serverSeen[0]).toMatchObject({ id: 1, method: "initialize", params: { a: 1 } }), { timeout: 4_000, interval: 1 });
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hello: true } }) + "\n");
    expect(await p).toEqual({ hello: true });
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: {} }) + "\n");
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: 77, method: "execCommandApproval", params: { x: 5 } }) + "\n");
    fromServer.write("not json\n");
    await vi.waitFor(() => expect(serverSeen.at(-1)).toEqual({ jsonrpc: "2.0", id: 77, result: { echoed: "execCommandApproval", ok: 5 } }), { timeout: 4_000, interval: 1 });
    expect(notes).toEqual(["item/completed"]);
    const failing = client.request("x", {}, 20);
    await expect(failing).rejects.toThrow(/no response/);
    const p2 = client.request("y");
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: 1, message: "nope" } }) + "\n");
    await expect(p2).rejects.toThrow(/nope/);
    const p3 = client.request("z");
    client.fail(new Error("closed"));
    await expect(p3).rejects.toThrow(/closed/);
  });
});
