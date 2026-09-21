/** Skill registry: $AGENTSWITCH_HOME/skills/<name>/SKILL.md (+ any support files) with enable/scope
 *  metadata in skills.json. Skills can be typed in the UI or imported from the user's own
 *  ~/.claude/skills, ~/.codex/skills, ~/.agents/skills or OpenCode skill folders (copied, never linked). */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { type DiscoveredSkill, type Harness, NAME_RE, parseFrontmatter, type Skill, SkillMeta } from "./types.js";

const MetaFile = z.record(z.string(), SkillMeta);
export const SKILL_FILE = "SKILL.md";

export function defaultDiscoverRoots(home = process.env.HOME ?? ""): { source: string; dir: string }[] {
  return [
    { source: "~/.claude/skills", dir: join(home, ".claude", "skills") },
    { source: "~/.codex/skills", dir: join(home, ".codex", "skills") },
    { source: "~/.agents/skills", dir: join(home, ".agents", "skills") },
    { source: "~/.config/opencode/skill", dir: join(home, ".config", "opencode", "skill") },
    { source: "~/.config/opencode/skills", dir: join(home, ".config", "opencode", "skills") },
  ];
}

function skillDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(root, d.name, SKILL_FILE)))
    .map((d) => d.name)
    .sort();
}

function countFiles(dir: string): number {
  return readdirSync(dir, { withFileTypes: true, recursive: true }).filter((d) => d.isFile()).length - 1;
}

export class SkillRegistry {
  private readonly metaPath: string;

  constructor(private readonly dir: string) {
    this.metaPath = join(dirname(dir), "skills.json");
  }

  get directory(): string { return this.dir; }

  list(): Skill[] {
    const meta = this.readMeta();
    return skillDirs(this.dir).map((name) => this.describe(name, meta[name]));
  }

  get(name: string): Skill | undefined {
    if (!NAME_RE.test(name) || !existsSync(join(this.dir, name, SKILL_FILE))) return undefined;
    return this.describe(name, this.readMeta()[name]);
  }

  content(name: string): string | undefined {
    const s = this.get(name);
    return s ? readFileSync(join(s.path, SKILL_FILE), "utf8") : undefined;
  }

  enabledFor(harness: Harness): Skill[] {
    return this.list().filter((s) => s.enabled && s.harnesses.includes(harness));
  }

  /** Create or update: content replaces SKILL.md when given; meta fields merge over the current ones. */
  write(name: string, patch: { content?: string | undefined; enabled?: boolean | undefined; harnesses?: Harness[] | undefined }): Skill {
    if (!NAME_RE.test(name)) throw new Error("invalid skill name");
    const dir = join(this.dir, name);
    const exists = existsSync(join(dir, SKILL_FILE));
    if (!exists && patch.content === undefined) throw new Error("content required for a new skill");
    if (patch.content !== undefined) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, SKILL_FILE), ensureFrontmatter(name, patch.content));
    }
    const meta = this.readMeta();
    const current = meta[name] ?? SkillMeta.parse({});
    const next: SkillMeta = { enabled: patch.enabled ?? current.enabled, harnesses: patch.harnesses ?? current.harnesses };
    this.writeMeta({ ...meta, [name]: next });
    return this.describe(name, next);
  }

  remove(name: string): boolean {
    const s = this.get(name);
    if (!s) return false;
    rmSync(s.path, { recursive: true, force: true });
    const { [name]: _gone, ...rest } = this.readMeta();
    this.writeMeta(rest);
    return true;
  }

  discover(roots = defaultDiscoverRoots()): DiscoveredSkill[] {
    const installed = new Set(skillDirs(this.dir));
    return roots.flatMap(({ source, dir }) =>
      skillDirs(dir).map((name) => {
        const fm = parseFrontmatter(readFileSync(join(dir, name, SKILL_FILE), "utf8"));
        return { name, description: fm.description, path: join(dir, name), source, installed: installed.has(name) };
      }),
    );
  }

  /** Copy a skill directory in. The directory must contain SKILL.md and have a valid name. */
  importFrom(path: string): Skill {
    const src = resolve(path);
    const name = basename(src);
    if (!NAME_RE.test(name)) throw new Error(`skill directory name "${name}" is not a valid skill name`);
    if (!existsSync(src) || !statSync(src).isDirectory() || !existsSync(join(src, SKILL_FILE))) throw new Error(`${src} is not a skill directory (no ${SKILL_FILE})`);
    const dest = join(this.dir, name);
    if (resolve(dest) === src) throw new Error("already in the registry");
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    return this.write(name, {});
  }

  /** Copy every skill enabled for `harness` into `dest`; returns the names copied. */
  materialize(harness: Harness, dest: string): string[] {
    const chosen = this.enabledFor(harness);
    if (chosen.length) mkdirSync(dest, { recursive: true });
    for (const s of chosen) cpSync(s.path, join(dest, s.name), { recursive: true });
    return chosen.map((s) => s.name);
  }

  private describe(name: string, meta: SkillMeta | undefined): Skill {
    const path = join(this.dir, name);
    const fm = parseFrontmatter(readFileSync(join(path, SKILL_FILE), "utf8"));
    const m = meta ?? SkillMeta.parse({});
    return { name, description: fm.description, path, files: countFiles(path), enabled: m.enabled, harnesses: m.harnesses };
  }

  private readMeta(): Record<string, SkillMeta> {
    if (!existsSync(this.metaPath)) return {};
    const parsed = MetaFile.safeParse(JSON.parse(readFileSync(this.metaPath, "utf8")));
    if (!parsed.success) throw new Error(`${this.metaPath}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return parsed.data;
  }

  private writeMeta(meta: Record<string, SkillMeta>): void {
    mkdirSync(dirname(this.metaPath), { recursive: true });
    const tmp = `${this.metaPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n");
    renameSync(tmp, this.metaPath);
  }
}

/** Every harness keys skills by the frontmatter name; add a minimal header when the user left it out. */
export function ensureFrontmatter(name: string, content: string): string {
  const fm = parseFrontmatter(content);
  if (fm.name) return content;
  if (content.startsWith("---")) return content;
  return `---\nname: ${name}\ndescription: ${firstLine(content)}\n---\n\n${content}`;
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  return line.slice(0, 120);
}
