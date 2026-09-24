/** Dependency direction between the top-level directories of src/ (tech debt #20/#21). Every relative import in src/,
 *  static, type-only, re-export or `import("…")` type reference, must follow ALLOWED; a new top-level directory has to
 *  be placed in the matrix before it can be imported. Files directly under src/ (daemon.ts, cli.ts, client.ts) are the
 *  composition root and may import anything. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ROOT = "(root)";

const UPPER = ["util", "core", "harness", "files", "extensions", "secrets", "quota"] as const;

/** Which layers each layer may import (besides itself). Peers not listed may not import each other: router and
 *  executors, router and threads, threads and secrets. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  util: [],
  core: ["util"],
  harness: ["util", "core"],
  files: ["util", "core"],
  extensions: ["util", "core"],
  secrets: ["util", "core"],
  quota: ["util", "core", "harness"],
  threads: ["util", "core"],
  router: ["util", "core", "harness"],
  executors: [...UPPER],
  engine: [...UPPER, "threads", "router", "executors"],
  /** assistant-v0 §1.1: the router as the user's assistant; above the engine, below the API. */
  assistant: [...UPPER, "router", "engine"],
  api: [...UPPER, "threads", "router", "executors", "engine", "assistant"],
  /** app-v0 §2: the remote listener, device tokens and pairing; a peer of api, which it reaches only over fetch. */
  remote: [...UPPER, "threads", "router", "executors", "engine"],
  [ROOT]: [...UPPER, "threads", "router", "executors", "engine", "assistant", "api", "remote"],
};

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(["'])(\.{1,2}\/[^"']+)\1/gm;

/** Relative module specifiers in a source text, in order. */
function relativeImports(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => m[2]!);
}

function layerOf(file: string): string {
  const parts = relative(SRC, file).split(sep);
  return parts.length === 1 ? ROOT : parts[0]!;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

type Edge = { readonly file: string; readonly target: string; readonly from: string; readonly to: string };

function edges(): Edge[] {
  return sourceFiles(SRC).flatMap((file) => relativeImports(readFileSync(file, "utf8")).map((spec) => {
    const target = resolve(dirname(file), spec);
    return { file: relative(SRC, file), target: relative(SRC, target), from: layerOf(file), to: layerOf(target) };
  }));
}

describe("layer directions in src/", () => {
  it("the parser sees static, type-only, re-export and import() type references", () => {
    const text = [
      'import { a } from "./a.js";',
      'import type { B } from "../b/b.js";',
      'export { c } from "./c.js";',
      'import "./side.js";',
      'const t = null as unknown as import("../d/d.js").T;',
      'import { z } from "zod";',
    ].join("\n");
    expect(relativeImports(text)).toEqual(["./a.js", "../b/b.js", "./c.js", "./side.js", "../d/d.js"]);
  });

  it("every top-level directory of src/ is placed in the matrix", () => {
    const dirs = readdirSync(SRC).filter((name) => statSync(join(SRC, name)).isDirectory());
    expect(dirs.filter((d) => !(d in ALLOWED))).toEqual([]);
    for (const allowed of Object.values(ALLOWED)) expect(allowed.filter((d) => !(d in ALLOWED))).toEqual([]);
  });

  it("the matrix has no cycle", () => {
    const reaches = (from: string, to: string, seen = new Set<string>()): boolean =>
      (ALLOWED[from] ?? []).some((next) => next === to || (!seen.has(next) && (seen.add(next), reaches(next, to, seen))));
    expect(Object.keys(ALLOWED).filter((layer) => reaches(layer, layer))).toEqual([]);
  });

  it("every relative import follows the matrix", () => {
    const all = edges();
    expect(all.length).toBeGreaterThan(300);   // the parser really read the tree
    const violations = all.filter((e) => e.from !== e.to && !(ALLOWED[e.from] ?? []).includes(e.to))
      .map((e) => `${e.from} -> ${e.to}: ${e.file} imports ${e.target}`);
    expect(violations).toEqual([]);
  });

  it("threads never imports router, and router never imports threads, executors or engine", () => {
    const crossing = edges().filter((e) => (e.from === "threads" && e.to === "router") || (e.from === "router" && ["threads", "executors", "engine"].includes(e.to)));
    expect(crossing).toEqual([]);
  });
});
