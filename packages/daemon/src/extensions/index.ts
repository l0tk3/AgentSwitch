/** What executors ask at run start: which MCP servers and skills this harness gets right now. */

import { join } from "node:path";
import { McpRegistry } from "./mcpRegistry.js";
import { SkillRegistry } from "./skillRegistry.js";
import type { Harness, McpServer } from "./types.js";

export type Extensions = {
  readonly mcp: McpRegistry;
  readonly skills: SkillRegistry;
  mcpFor(harness: Harness): McpServer[];
  /** Copy the harness's enabled skills into `dest`; returns the copied names (empty = nothing to attach). */
  skillsInto(harness: Harness, dest: string): string[];
};

export function extensionsAt(home: string): Extensions {
  const mcp = new McpRegistry(join(home, "mcp.json"));
  const skills = new SkillRegistry(join(home, "skills"));
  return { mcp, skills, mcpFor: (h) => mcp.enabledFor(h), skillsInto: (h, dest) => skills.materialize(h, dest) };
}

/** Executors without a registry (tests, echo mode). */
export const NO_EXTENSIONS: Pick<Extensions, "mcpFor" | "skillsInto"> = { mcpFor: () => [], skillsInto: () => [] };
