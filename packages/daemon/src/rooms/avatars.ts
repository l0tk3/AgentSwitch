/** A session's avatar (2026-11-24, user #200: 每个 session 都可以管理自己的头像，在各个房间里保持一致，就像保存自己
 *  的真名一样，可以自己更改，给他们一些公开头像库和系统默认头像库; #203: 像素风格的时候像素风头像，classic 风格的时候
 *  正常头像). Each session holds two: one for the pixel look, one for the classic. They go with the session — every
 *  room it sits in, and a resume of the same conversation — not with a seat. Unchosen, the pixel one is the seat's
 *  face (face.ts) and the classic one its initials on the face's colour.
 *
 *  The library: `f1`…`f40` faces (the 5 × 5 kind, by the system), `p1`…`p48` pixel characters (DiceBear's Pixel Art,
 *  CC0), `e1`…`e60` emoji for the classic look; any one emoji of the session's own too, and a 5 × 5 face it draws. */

import { faceColor, faceOf, type Face } from "./face.js";
import { PIXEL_ART } from "./avatarArt.js";

export type PixelAvatar =
  | { readonly kind: "face"; readonly id?: string; readonly rows: readonly string[]; readonly color: number }
  | { readonly kind: "grid"; readonly id: string; readonly palette: readonly string[]; readonly rows: readonly string[] };
export type ClassicAvatar = { readonly kind: "emoji"; readonly id?: string; readonly emoji: string; readonly bg: number };
export type Avatar = { readonly pixel: PixelAvatar | null; readonly classic: ClassicAvatar | null };

const FACE_SEEDS = ["ash", "birch", "cedar", "dune", "ember", "fern", "gale", "haze", "iris", "jade", "kelp", "lark", "moss", "nova", "opal", "pine", "quill", "reed", "sage", "tide",
  "umber", "vale", "wren", "yarrow", "zinc", "amber", "brook", "coral", "drift", "elm", "flint", "grove", "heath", "isle", "juniper", "knoll", "loch", "marsh", "nettle", "orchid"];

/** The system's faces, each its own pattern and colour. */
export const FACES: readonly (Face & { readonly id: string })[] = FACE_SEEDS.map((seed, i) => ({ id: `f${i + 1}`, ...faceOf(seed) }));

/** Emoji for the classic look: animals, robots, things — each reads at a small size. */
export const EMOJI: readonly string[] = [
  "🦊", "🐼", "🐨", "🐯", "🦁", "🐸", "🐙", "🦉", "🐧", "🐢", "🦄", "🐝", "🦋", "🐳", "🦀", "🐿️", "🦔", "🐺", "🐻", "🐰",
  "🤖", "👾", "👻", "🧠", "🦾", "🛸", "🚀", "🛰️", "🔭", "🧪", "⚙️", "🔧", "🧭", "📐", "🗺️", "💡", "🔮", "🎲", "🧩", "🎯",
  "🌵", "🌲", "🍀", "🌻", "🍄", "🌊", "🔥", "⚡", "❄️", "🌙", "⭐", "☀️", "🍋", "🍉", "🥑", "🍩", "☕", "🎧", "📚", "✏️",
];

/** The library as an agent reads it: short. */
export const LIBRARY_SAYS = `Pixel look: f1–f${FACES.length} (small faces), p1–p${PIXEL_ART.length} (pixel characters), or draw your own 5×5 face (rows: five strings of # and ., color 0–9). Classic look: e1–e${EMOJI.length} (${EMOJI.slice(0, 12).join("")}…), or any one emoji; bg 0–9 is its ground's colour.`;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** One emoji, one grapheme: a pictograph, with its variation and joiners. */
export function oneEmoji(s: string): boolean {
  const t = s.trim();
  const parts = [...segmenter.segment(t)];
  return parts.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(t);
}

/** A pixel avatar from a library id or a drawn face; null with what was wrong. */
export function pixelFrom(o: { readonly id?: string; readonly rows?: unknown; readonly color?: unknown }): PixelAvatar | string {
  const id = (o.id ?? "").trim().toLowerCase();
  if (id) {
    const face = FACES.find((f) => f.id === id);
    if (face) return { kind: "face", id, rows: face.rows, color: face.color };
    const art = PIXEL_ART.find((a) => a.id === id);
    if (art) return { kind: "grid", id, palette: art.palette, rows: art.rows };
    return `No pixel avatar "${o.id}". ${LIBRARY_SAYS}`;
  }
  const rows = o.rows;
  if (Array.isArray(rows) && rows.length === 5 && rows.every((r) => typeof r === "string" && /^[#.]{5}$/.test(r))) {
    const lit = rows.join("").split("").filter((c) => c === "#").length;
    if (lit < 5) return "A drawn face needs five lit cells (#) at least.";
    const color = typeof o.color === "number" && Number.isInteger(o.color) && o.color >= 0 && o.color <= 9 ? o.color : 0;
    return { kind: "face", rows: rows as string[], color };
  }
  return `Give \`pixel\` a library id or \`rows\` (five strings of five # and .). ${LIBRARY_SAYS}`;
}

/** A classic avatar from a library id or one emoji; null with what was wrong. */
export function classicFrom(o: { readonly id?: string; readonly emoji?: string; readonly bg?: unknown }, fallbackBg: number): ClassicAvatar | string {
  const bg = typeof o.bg === "number" && Number.isInteger(o.bg) && o.bg >= 0 && o.bg <= 9 ? o.bg : fallbackBg;
  const id = (o.id ?? "").trim().toLowerCase();
  if (id) {
    const n = /^e(\d+)$/.exec(id)?.[1];
    const emoji = n ? EMOJI[Number(n) - 1] : undefined;
    return emoji ? { kind: "emoji", id, emoji, bg } : `No classic avatar "${o.id}". ${LIBRARY_SAYS}`;
  }
  const e = (o.emoji ?? "").trim();
  if (oneEmoji(e)) return { kind: "emoji", emoji: e, bg };
  return `Give \`classic\` a library id (e1–e${EMOJI.length}) or \`emoji\`: one emoji. ${LIBRARY_SAYS}`;
}

/** Where a session's avatar is kept: its conversation once the agent has said it, its terminal before. */
export function avatarKeys(o: { readonly session?: string | null; readonly terminal?: string | null }): string[] {
  return [...(o.session ? [`s:${o.session}`] : []), ...(o.terminal ? [`t:${o.terminal}`] : [])];
}

/** The colour a classic avatar's ground takes when none was chosen: the face's. */
export function defaultBg(handle: string): number { return faceColor(handle); }
