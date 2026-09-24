/** MCP server registry: one JSON file, re-read on every access so edits from the UI, the CLI and
 *  a running executor never race on stale state. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { zodIssues } from "../util/zod.js";
import { type Harness, McpServer } from "./types.js";

const File = z.object({ servers: z.array(McpServer).default([]) });

export function readServers(path: string): McpServer[] {
  if (!existsSync(path)) return [];
  const parsed = File.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path}: ${zodIssues(parsed.error)}`);
  return parsed.data.servers;
}

/** Pure: replace or append by name, keeping order. */
export function upsertServer(servers: readonly McpServer[], server: McpServer): McpServer[] {
  const i = servers.findIndex((s) => s.name === server.name);
  return i < 0 ? [...servers, server] : [...servers.slice(0, i), server, ...servers.slice(i + 1)];
}

export function removeServer(servers: readonly McpServer[], name: string): McpServer[] {
  return servers.filter((s) => s.name !== name);
}

export function serversFor(servers: readonly McpServer[], harness: Harness): McpServer[] {
  return servers.filter((s) => s.enabled && s.harnesses.includes(harness));
}

export class McpRegistry {
  constructor(private readonly path: string) {}

  list(): McpServer[] { return readServers(this.path); }
  get(name: string): McpServer | undefined { return this.list().find((s) => s.name === name); }
  enabledFor(harness: Harness): McpServer[] { return serversFor(this.list(), harness); }

  upsert(server: McpServer): McpServer {
    this.write(upsertServer(this.list(), server));
    return server;
  }

  remove(name: string): boolean {
    const before = this.list();
    const after = removeServer(before, name);
    if (after.length === before.length) return false;
    this.write(after);
    return true;
  }

  private write(servers: readonly McpServer[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ servers }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
