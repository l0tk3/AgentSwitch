/** User-managed extensions handed to every executor: MCP servers and skills.
 *  Both are stored under $AGENTSWITCH_HOME and injected per run, so nothing touches the user's
 *  own ~/.claude, ~/.codex or OpenCode config. */

import { z } from "zod";

export const HARNESSES = ["claude-code", "codex", "opencode"] as const;
export type Harness = (typeof HARNESSES)[number];

/** Names the gate wiring already uses; a user entry must not shadow them. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(["secret-gate", "playwright"]);

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const Name = z.string().regex(NAME_RE, "name: lowercase letters, digits, - and _ only").refine((n) => !RESERVED_NAMES.has(n), "name is reserved by the gate");
const StringMap = z.record(z.string().min(1), z.string());

export const McpServer = z
  .object({
    name: Name,
    kind: z.enum(["stdio", "http"]),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    /** Extra env for stdio servers. Put `enc:v1:` ciphertext here, never plaintext secrets. */
    env: StringMap.default({}),
    url: z.url().optional(),
    headers: StringMap.default({}),
    enabled: z.boolean().default(true),
    harnesses: z.array(z.enum(HARNESSES)).default([...HARNESSES]),
    /** Claude Code only: whether calls to this server's tools need a human (ask) or not (allow). */
    approval: z.enum(["ask", "allow"]).default("ask"),
    note: z.string().max(500).default(""),
  })
  .refine((s) => (s.kind === "stdio" ? Boolean(s.command) : Boolean(s.url)), { message: "stdio servers need command; http servers need url" })
  .refine((s) => (s.kind === "http" ? /^https?:\/\//.test(s.url ?? "") : true), { message: "url must be http(s)" });
export type McpServer = z.infer<typeof McpServer>;

export const SkillMeta = z.object({
  enabled: z.boolean().default(true),
  harnesses: z.array(z.enum(HARNESSES)).default([...HARNESSES]),
});
export type SkillMeta = z.infer<typeof SkillMeta>;

export type Skill = SkillMeta & {
  readonly name: string;
  readonly description: string;
  readonly path: string;      // directory holding SKILL.md
  readonly files: number;     // files in the skill directory besides SKILL.md
};

export type DiscoveredSkill = {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: string;    // e.g. ~/.claude/skills
  readonly installed: boolean;
};

export const SkillName = z.string().regex(NAME_RE, "name: lowercase letters, digits, - and _ only");

/** `name:` / `description:` from SKILL.md frontmatter; tolerant of missing frontmatter. */
export function parseFrontmatter(text: string): { name: string | null; description: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { name: null, description: "" };
  const get = (key: string): string | null => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(m[1]!);
    return line ? line[1]!.trim().replace(/^["']|["']$/g, "") : null;
  };
  return { name: get("name"), description: get("description") ?? "" };
}
