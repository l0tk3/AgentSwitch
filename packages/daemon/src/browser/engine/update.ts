/** Updating the browser engine (docs/browser-v0.md §7.2 第 6 条): for each part asked for — download, check the digest
 *  the release published, unpack — then the pair checks itself (the new copies, the copy in use for a part that is not
 *  changing), and only then are the new copies switched to and the old ones deleted. A digest that does not match, a
 *  pair that fails its check, a cancel: nothing switches and nothing is left on disk. One update at a time. */

import { createHash } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import { join } from "node:path";
import type { EnginePart, EngineStore } from "./store.js";

/** One thing to install: where its archive is and what it must hash to (`sha256:<hex>` as GitHub publishes a release
 *  asset's, or `sha512-<base64>` as the npm registry does). */
export type EngineSource = { readonly part: EnginePart; readonly version: string; readonly url: string; readonly bytes: number; readonly digest: string };

export type UpdatePhase = "download" | "verify" | "unpack" | "check" | "switch";

export type UpdateState = {
  readonly running: boolean;
  /** What the update is to install, by part. */
  readonly to?: Partial<Record<EnginePart, string>> | undefined;
  readonly part?: EnginePart | undefined;
  readonly phase?: UpdatePhase | undefined;
  readonly received?: number | undefined;
  readonly total?: number | undefined;
  /** Of the last update, once it is over. */
  readonly ok?: boolean | undefined;
  readonly cancelled?: boolean | undefined;
  /** Why it did not go through, for the person (the phase it stopped in stays in `phase`). */
  readonly error?: string | undefined;
  readonly finishedAt?: number | undefined;
};

/** The copies a check is given: folders of unpacked new copies, null for a part that is not changing. */
export type Candidate = { readonly camoufox: string | null; readonly playwright: string | null };
export type CheckResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type UpdateDeps = {
  readonly store: EngineStore;
  /** Writes the archive to `file`, telling how far it is. Rejects when it cannot, or when `signal` aborts. */
  download(source: EngineSource, file: string, progress: (received: number, total: number) => void, signal: AbortSignal): Promise<void>;
  /** Unpacks `archive` into the (existing, empty but for the archive) folder `into`. */
  unpack(part: EnginePart, archive: string, into: string, signal: AbortSignal): Promise<void>;
  selfCheck(candidate: Candidate, signal: AbortSignal): Promise<CheckResult>;
  /** The switch itself happens inside `apply`: whoever runs a browser on the copy in use stops it first and starts it
   *  again after (the old copy is deleted as the new one takes its place). Absent: `apply` at once. */
  switching?: ((apply: () => void) => Promise<void>) | undefined;
  now(): number;
};

const ARCHIVE = "archive";

export class EngineUpdater {
  private current: UpdateState = { running: false };
  private abort: AbortController | null = null;
  private finished: Promise<UpdateState> = Promise.resolve(this.current);

  constructor(private readonly deps: UpdateDeps) {}

  state(): UpdateState {
    return this.current;
  }

  /** The state once the update under way (or the last one) is over. */
  done(): Promise<UpdateState> {
    return this.finished;
  }

  start(sources: readonly EngineSource[]): { ok: true } | { ok: false; reason: "busy" | "nothing" } {
    if (this.current.running) return { ok: false, reason: "busy" };
    if (!sources.length) return { ok: false, reason: "nothing" };
    const to = Object.fromEntries(sources.map((s) => [s.part, s.version])) as Partial<Record<EnginePart, string>>;
    this.abort = new AbortController();
    this.current = { running: true, to };
    this.finished = this.run(sources, to, this.abort.signal);
    return { ok: true };
  }

  cancel(): void {
    this.abort?.abort();
  }

  private at(patch: Partial<UpdateState>): void {
    this.current = { ...this.current, ...patch };
  }

  private async run(sources: readonly EngineSource[], to: Partial<Record<EnginePart, string>>, signal: AbortSignal): Promise<UpdateState> {
    const { store } = this.deps;
    const folders = new Map<EnginePart, string>();
    const end = (patch: Partial<UpdateState>): UpdateState => {
      for (const dir of folders.values()) rmSync(dir, { recursive: true, force: true });
      this.abort = null;
      this.current = { running: false, to, part: this.current.part, phase: this.current.phase, ...patch, finishedAt: this.deps.now() };
      return this.current;
    };
    try {
      for (const source of sources) {
        const dir = store.incoming(source.part);
        folders.set(source.part, dir);
        const archive = join(dir, ARCHIVE);
        this.at({ part: source.part, phase: "download", received: 0, total: source.bytes });
        await this.deps.download(source, archive, (received, total) => this.at({ received, total }), signal);
        signal.throwIfAborted();
        this.at({ phase: "verify" });
        const digest = await digestOf(archive, source.digest);
        if (digest !== source.digest) return end({ ok: false, error: `下载的文件与发布的校验值不符（${source.part} ${source.version}），已丢弃。` });
        signal.throwIfAborted();
        this.at({ phase: "unpack" });
        await this.deps.unpack(source.part, archive, dir, signal);
        // The archive is not kept: not through the check, not after.
        rmSync(archive, { force: true });
        signal.throwIfAborted();
      }
      this.at({ part: undefined, phase: "check", received: undefined, total: undefined });
      const checked = await this.deps.selfCheck({ camoufox: folders.get("camoufox") ?? null, playwright: folders.get("playwright") ?? null }, signal);
      signal.throwIfAborted();
      if (!checked.ok) return end({ ok: false, error: checked.reason });
      this.at({ phase: "switch" });
      const apply = (): void => {
        for (const source of sources) {
          store.switchTo(source.part, folders.get(source.part)!, { version: source.version, digest: source.digest, bytes: source.bytes, installedAt: this.deps.now() });
          folders.delete(source.part);
        }
      };
      if (this.deps.switching) await this.deps.switching(apply); else apply();
      return end({ ok: true });
    } catch (err) {
      if (signal.aborted) return end({ ok: false, cancelled: true, error: "已取消。" });
      return end({ ok: false, error: (err as Error).message || String(err) });
    }
  }
}

/** The file's digest in the form `expected` is written in; anything else compares unequal. */
async function digestOf(file: string, expected: string): Promise<string> {
  const sha256 = expected.startsWith("sha256:");
  if (!sha256 && !expected.startsWith("sha512-")) return "";
  const hash = createHash(sha256 ? "sha256" : "sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return sha256 ? `sha256:${hash.digest("hex")}` : `sha512-${hash.digest("base64")}`;
}
