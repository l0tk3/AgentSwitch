/** What the phone downloads to measure its link to the Mac (browser-v0 §1 iPhone, §5; 2026-10-03, user: tailscale
 *  直接根据网速来行了，中转有的时候比直连快): over Tailscale the picture it asks for goes by the speed measured, not by
 *  whether the path is direct or relayed. The bytes do not compress (one random block, repeated) and carry no line
 *  feeds: the phone's reader cuts its chunks at them, and it times the chunks. */

import { randomBytes } from "node:crypto";

export const SPEED_DEFAULT_BYTES = 1024 * 1024;
export const SPEED_MAX_BYTES = 4 * 1024 * 1024;
const BLOCK_BYTES = 64 * 1024;
const LINE_FEED = 0x0a;

let block: Buffer | null = null;

/** The random block, made once: line feeds become the byte after them. */
function speedBlock(): Buffer {
  if (!block) {
    const made = randomBytes(BLOCK_BYTES);
    for (let i = 0; i < made.length; i++) if (made[i] === LINE_FEED) made[i] = LINE_FEED + 1;
    block = made;
  }
  return block;
}

/** `?bytes=`: missing or bad is the default, beyond the bounds is the bound (as the stream's options). */
export function speedSize(raw: string | undefined): number {
  const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), SPEED_MAX_BYTES) : SPEED_DEFAULT_BYTES;
}

/** `bytes` bytes of the block, repeated. */
export function speedBody(bytes: number): Buffer {
  return Buffer.alloc(bytes, speedBlock());
}
