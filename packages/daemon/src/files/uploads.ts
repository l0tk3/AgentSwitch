/** Upload staging: each upload gets its own directory under $AGENTSWITCH_HOME/uploads/<id>/<name>,
 *  then `moveInto` relocates the chosen ones into a task's <cwd>/in/. Stale staging dirs are swept. */

import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { ATTACH_DIR, contentType, safeName } from "./names.js";

export type Attachment = {
  readonly name: string;
  /** Relative to the task's working directory, e.g. "in/shot.png". */
  readonly path: string;
  readonly size: number;
  readonly type: string;
};

export type StagedUpload = { readonly id: string; readonly name: string; readonly size: number; readonly type: string };

/** "shot.png" → "shot-2.png" until the name is free in `dir`. */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

export class Uploads {
  constructor(readonly dir: string) {}

  stage(rawName: string, bytes: Buffer, type: string): StagedUpload {
    const id = randomUUID().slice(0, 12);
    const name = safeName(rawName);
    mkdirSync(join(this.dir, id), { recursive: true });
    writeFileSync(join(this.dir, id, name), bytes, { mode: 0o600 });
    return { id, name, size: bytes.length, type: type || "application/octet-stream" };
  }

  private staged(id: string): { name: string; size: number } {
    const dir = join(this.dir, id);
    if (!/^[0-9a-f-]{12}$/.test(id) || !existsSync(dir)) throw new Error(`unknown upload ${id}`);
    const name = readdirSync(dir).find((n) => statSync(join(dir, n)).isFile());
    if (!name) throw new Error(`unknown upload ${id}`);
    return { name, size: statSync(join(dir, name)).size };
  }

  /** Move staged uploads into `dir` under names without spaces (a path typed into a terminal stays one word); every
   *  id must exist (checked before anything moves). The paths returned are absolute. */
  moveToDir(ids: readonly string[], dir: string): Attachment[] {
    const found = ids.map((id) => ({ id, ...this.staged(id) }));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return found.map(({ id, name, size }) => {
      const target = freeName(dir, name.replace(/\s+/g, "-"));
      moveFile(join(this.dir, id, name), join(dir, target));
      rmSync(join(this.dir, id), { recursive: true, force: true });
      return { name: target, path: join(dir, target), size, type: contentType(target) };
    });
  }

  /** Move staged uploads into <cwd>/in/; every id must exist (checked before anything moves). */
  moveInto(ids: readonly string[], cwd: string): Attachment[] {
    const found = ids.map((id) => ({ id, ...this.staged(id) }));
    const dest = join(cwd, ATTACH_DIR);
    mkdirSync(dest, { recursive: true });
    return found.map(({ id, name, size }) => {
      const target = freeName(dest, name);
      moveFile(join(this.dir, id, name), join(dest, target));
      rmSync(join(this.dir, id), { recursive: true, force: true });
      return { name: target, path: `${ATTACH_DIR}/${target}`, size, type: contentType(target) };
    });
  }
}

/** A file moved, also to another file system: a terminal's attachments go to the system's temporary folder, which on
 *  Linux is often its own (tmpfs), where a rename from the uploads folder fails with EXDEV (2026-10-15, user: 文件未能
 *  粘贴：EXDEV: cross-device link not permitted). There it is copied (never over a file already there) and the staged one
 *  removed. */
export function moveFile(from: string, to: string, rename: (a: string, b: string) => void = renameSync): void {
  try {
    rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    rmSync(from, { force: true });
  }
}
