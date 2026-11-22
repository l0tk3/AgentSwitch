/** A seat's face (docs/chatroom-v0.md §1 头像): a pattern on a 5 × 5 grid, mirrored left to right, and one of ten
 *  colours, both made from the seat's name — nothing is chosen and nothing is drawn by hand. Fifteen cells decide a
 *  pattern (three columns of five); the ones kept are neither nearly empty nor nearly full and never the same row or
 *  column throughout, so each reads as a shape. In one room two faces differ in six cells at least: a name whose
 *  pattern is too near one already seated takes its next. It is made once, here, when the seat is taken, and kept with
 *  the seat: every screen draws the same one. */

export type Face = {
  /** Five rows of five, `#` lit and `.` not. */
  readonly rows: readonly string[];
  /** Which of the ten face colours (0…9); the screens have the colours. */
  readonly color: number;
};

const FALLBACK = ["#.#.#", ".###.", "##.##", ".###.", "#.#.#"];
const TRIES = 60, MIN_LIT = 9, MAX_LIT = 17;
/** Two faces in one room differ in this many cells at least. */
export const MIN_APART = 6;

/** The patterns a name has, in order: the first is its own, the next ones are for a room where that is taken. */
function* patterns(name: string): Generator<string[]> {
  let h = 2166136261;
  const next = (): number => {
    for (const ch of name) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    h ^= h >>> 13; h = Math.imul(h, 2654435761) >>> 0;
    return h;
  };
  for (let tries = 0; tries < TRIES; tries++) {
    const bits = next() & 0x7fff;
    const cells = Array.from({ length: 5 }, (_, y) => [0, 1, 2, 1, 0].map((x) => (bits >> (y * 3 + x)) & 1));
    const count = cells.flat().reduce((a: number, b) => a + b, 0);
    const rowsSame = cells.every((r) => r.join("") === cells[0]!.join(""));
    const colsSame = [0, 1, 2].every((x) => cells.every((r) => r[x] === cells[0]![x]));
    if (count < MIN_LIT || count > MAX_LIT || rowsSame || colsSame) continue;
    yield cells.map((r) => r.map((c) => (c ? "#" : ".")).join(""));
  }
}

export function faceColor(name: string): number {
  let h = 0;
  for (const ch of name) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return ((h ^ (h >>> 7)) >>> 0) % 10;
}

/** How many cells two patterns differ in. */
export function apart(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if (a[y]?.[x] !== b[y]?.[x]) n++;
  return n;
}

/** The face of `name` in a room where `seated` are taken. */
export function faceOf(name: string, seated: readonly Face[] = []): Face {
  const color = faceColor(name);
  let first: string[] | null = null;
  for (const rows of patterns(name)) {
    first ??= rows;
    if (seated.every((s) => apart(s.rows, rows) >= MIN_APART)) return { rows, color };
  }
  return { rows: first ?? FALLBACK, color };
}
