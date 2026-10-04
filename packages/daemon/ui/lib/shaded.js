// The pixel look's icons as small shaded objects (docs/ui-v0.md §9, 2026-10-04; user: 所有的像素图标有能力画的更精致一些吗……
// 能不能弄成那种像素风格但是很精致的图标; shown a coloured set in the real window: 好出戏，能不能只用黑灰色强调层次感，就不上色了).
// Each is drawn on a board of at most 16 × 16 cells of 1.5 px — cells one can see — in six tones of the one ink, from
// highlight to ground, and nothing else: no hue. What is nearer or raised is lighter; a raised block has a light edge
// above and left and a dark one below and right; a screen or a pane is a dark ground inside an ink frame. The same
// pictures as the Mac's and the phone's `ShadedSprites.swift` (docs/design/concepts/pixel-icons.html); keep them in step.

/** The ink's six tones, from highlight to ground, as the page's colours (terminal.css, app.css): `--tw` … `--ts`. On a
 *  light ground they run the other way, from the darkest ink to the paper's shade. */
export const TONES = { W: "--tw", "#": "--th", m: "--tm", d: "--td", k: "--tk", s: "--ts" };
export const TONE_COLORS = {
  dark: { "--tw": "#ffffff", "--th": "#e9e6df", "--tm": "#a9a6a0", "--td": "#6f6c68", "--tk": "#3b3a37", "--ts": "#1e1d1b" },
  light: { "--tw": "#000000", "--th": "#16140f", "--tm": "#55524b", "--td": "#8a867d", "--tk": "#bdb8ac", "--ts": "#dcd7cb" },
};

/** One character a cell: `.` is clear, anything else a tone. */
export const SHADED = {
  /** One source switched onto three lanes: the nearest lane and its end the lightest, each further one a tone darker. */
  dispatch: [
    "............WWW#", ".........###W##m", ".......###..W##m", "......##....#mmd", ".....##.........",
    "....##..........", "WWW##.......mmmd", "W##mmmmmmmmmmddk", "W##mddddddddmddk", "#mmdd.......dkkk",
    "....dd..........", ".....dd.........", "......dd....dddk", ".......ddd..dkks", ".........ddddkks",
    "............ksss",
  ],
  /** A window: three dots on its title bar, a dark screen, a bright prompt, a cursor. */
  terminals: [
    ".##############.", "#mkmkmkmmmmmmmm#", "################", "#ssssssssssssss#", "#sWWsssssssssss#",
    "#sssWWsssssssss#", "#sssssWWsssssss#", "#sssWWsssssssss#", "#sWWssssmmmmsss#", "#ssssssssssssss#",
    "#ssssssssssssss#", ".##############.",
  ],
  /** A globe: light land on a dark sea, a highlight at its top left, darker at its bottom right. */
  browser: [
    ".....######.....", "...##mmmkkk##...", "..#mmmmmkkkkk#..", ".#Wmmmmkkkk#kk#.", ".#Wkmmkkkk#mmk#.",
    "#Wkkkmkkkmmmmmk#", "#Wkkkkkkkkmmmmk#", "#kkmmkkkkkkmmkk#", "#kmmmmkkkkkkmks#", "#kmmmmmkkkkkkss#",
    "#kkmmmmdkkkksss#", ".#kkmmmdkkksss#.", ".#kkkmdkkkssss#.", "..#kkkdkkssss#..", "...##kkksss##...",
    ".....######.....",
  ],
  /** Three sliders: the part each has travelled lighter, the rest dark, their knobs raised. */
  settings: [
    "...WWW#.........", "mmmW##mkkkkkkkkk", "dddW##msssssssss", "...#mmd.........", "................",
    ".........WWW#...", "mmmmmmmmmW##mkkk", "dddddddddW##msss", ".........#mmd...", "................",
    ".....WWW#.......", "mmmmmW##mkkkkkkk", "dddddW##msssssss", ".....#mmd.......",
  ],
  /** A window with its sidebar: the sidebar a lighter panel with three rows, the rest a dark ground. */
  list: [
    ".##############.", "#mmmmm#ssssssss#", "#mkkkm#ssssssss#", "#mmmmm#ssssssss#", "#mkkkm#ssssssss#",
    "#mmmmm#ssssssss#", "#mkkkm#ssssssss#", "#mmmmm#ssssssss#", "#ddddd#ssssssss#", "#ddddd#ssssssss#",
    ".##############.",
  ],
  /** Two panes side by side: the new one's head bright, its ground a tone lighter than the other's. */
  splitRight: [
    ".##############.", "#dddddd##WWWWWW#", "#ssssss##mmmmmm#", "#ssssss##kkkkkk#", "#ssssss##kkkkkk#",
    "#ssssss##kkkkkk#", "#ssssss##kkkkkk#", "#ssssss##kkkkkk#", "#ssssss##kkkkkk#", "#ssssss##kkkkkk#",
    ".##############.",
  ],
  /** Two panes one over the other: the same. */
  splitDown: [
    ".##############.", "#dddddddddddddd#", "#ssssssssssssss#", "#ssssssssssssss#", "#ssssssssssssss#",
    "################", "#WWWWWWWWWWWWWW#", "#mmmmmmmmmmmmmm#", "#kkkkkkkkkkkkkk#", "#kkkkkkkkkkkkkk#",
    ".##############.",
  ],
  /** A plus with some thickness. */
  new: [
    ".....WWW#.....", ".....W##m.....", ".....W##m.....", ".....W##m.....", ".....W##m.....", "WWWWWW###WWWW#",
    "W############m", "W############m", "#mmmm####mmmmd", ".....W##m.....", ".....W##m.....", ".....W##m.....",
    ".....W##m.....", ".....#mmd.....",
  ],
  /** A lock: a raised body under a darker shackle, its keyhole dark. */
  lock: [
    "...mmmmmm...", "..mm....md..", "..mm....md..", "..mm....md..", "..mm....md..", "WWWWWWWWWWW#", "W##########m",
    "W####kk####m", "W###kkkk###m", "W####kk####m", "W####kk####m", "W##########m", "#mmmmmmmmmmd",
  ],
  /** The lock where there is room for 10 px only. */
  lockSmall: [
    "..mmm..", ".m...d.", ".m...d.", "WWWWWW#", "W##k##m", "W##k##m", "W#####m", "#mmmmmd",
  ],
  /** Each agent's mark, 9 × 9 (its own logo's shape): Claude Code's spark, Codex's >_, OpenCode's brackets, pi's π. */
  "claude-code": [
    "....d....", ".d..#..d.", "..#.#.#..", "...###...", "d###W###d", "...###...", "..#.#.#..", ".d..#..d.",
    "....d....",
  ],
  codex: [
    ".........", "W#.......", ".W#......", "..W#.....", "...W#....", "..W#.....", ".W#..mmmm", "W#...dddd",
    ".........",
  ],
  opencode: [
    "W###.###m", "W#.....#m", "W#.....#m", "W#.....#m", "W#.....#m", "W#.....#m", "W#.....#m", "W#.....#m",
    "#mmm.mmmd",
  ],
  pi: [
    "WWWWWWWW#", "#mmmmmmmd", "..W#..W#.", "..W#..W#.", "..W#..W#.", "..W#..W#.", "..W#..W#.", "..W#..W##",
    "..#m..#mm",
  ],
  /** The app's mark (docs/ui-v0.md §10): three windows one behind another, each further one a tone darker; the front
   *  one has a raised title bar — where a state shows — a dark screen, a bright prompt and a cursor. */
  stack: [
    ".....dddddddddd.", "....dkkkkkkkkkkk", "....kssssssssssk", "...mmmmmmmmmmssk", "..mddddddddddksk", "..dssssssssssdsk",
    ".WWWWWWWWWWssdsk", "W##########msdk.", "#ssssssssssmsd..", "#sWWsssssssmsd..", "#sssWWsssssmd...", "#sWWssmmmssm....",
    "#ssssssssssm....", ".mmmmmmmmmm.....",
  ],
};

/** A number that changes when any picture does (FNV-1a over the names and rows, in this order): the three copies' tests
 *  hold the same one, so a picture changed in one place fails there until the others follow. */
export function digest() {
  let hash = 2166136261;
  for (const [name, rows] of Object.entries(SHADED)) {
    for (const byte of new TextEncoder().encode(`${name}=${rows.join("/")};`)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  }
  return hash;
}

/** A cell of `points` CSS px on this screen: a whole number of device pixels, never more than asked and at least one,
 *  so its edges are never blurred (1.5 px is 3 pixels on a 2× screen, 1 on a 1× one). */
export function cellPx(points = 1.5, ratio = globalThis.devicePixelRatio || 1) {
  const scale = Math.max(1, ratio);
  return Math.max(1, Math.floor(points * scale + 1e-6)) / scale;
}

const size = (cells, cell) => Number((cells * cell).toFixed(3));
const rect = (x, y, fill, opacity = 1) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"${opacity < 1 ? ` opacity="${opacity}"` : ""}/>`;
const cellsOf = (rows) => rows.flatMap((row, y) => [...row].flatMap((tone, x) => (tone === "." ? [] : [[x, y, tone]])));
const frame = (w, h, cell, cls, body, strength = 1) => `<svg class="px shaded${cls ? ` ${cls}` : ""}" width="${size(w, cell)}" height="${size(h, cell)}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges"${strength < 1 ? ` opacity="${strength}"` : ""} aria-hidden="true">${body}</svg>`;

/** A shaded picture as crisp squares, each in its tone; nothing for a name it does not have. `cell` in CSS px (drawn
 *  as a whole number of pixels), `shadow` a hard one a cell down and right, `strength` under 1 for one not in use. */
export function shaded(name, { cell = 1.5, shadow = false, strength = 1, cls = "", ratio } = {}) {
  if (!Object.hasOwn(SHADED, name)) return "";
  const rows = SHADED[name], cells = cellsOf(rows), pad = shadow ? 1 : 0;
  const under = shadow ? cells.map(([x, y]) => rect(x + 1, y + 1, "var(--px-shadow)")).join("") : "";
  const top = cells.map(([x, y, tone]) => rect(x, y, `var(${TONES[tone]})`)).join("");
  return frame(rows[0].length + pad, rows.length + pad, cellPx(cell, ratio), cls, under + top, strength);
}

// ---------- the app's mark with a state on it ----------
/** The front window's title bar from left to right, a block of two by two cells a step: the way the busy block runs. */
export const MARK_LANE = [1, 3, 5, 7, 9].map((x) => [[x, 6], [x + 1, 6], [x, 7], [x + 1, 7]]);
/** The front window's title bar: the raised strip a state colours. */
export const isEnd = (x, y) => (y === 6 && x >= 1 && x <= 10) || (y === 7 && x <= 11);
let uid = 0;

/** The mark in a state (`SHADED.stack`): idle (the picture), busy (the front window's title bar cyan, a light block
 *  running along it), waiting (the title bar amber, blinking), error (red), off (every other cell gone). `t` counts
 *  140 ms steps. `depth` for an identity mark: the hard shadow, the block's fading trail and a little glow. */
export function shadedMark({ state = "idle", t = 0, cell = 1.5, depth = false, ratio } = {}) {
  const rows = SHADED.stack, pad = depth ? 1 : 0;
  const cells = cellsOf(rows).filter(([x, y]) => !(state === "off" && (x + y) % 2));
  const head = t % MARK_LANE.length;
  const steps = state !== "busy" ? [] : (depth ? [[0, 1], [1, 0.55], [2, 0.25]] : [[0, 1]]).map(([back, alpha]) => [MARK_LANE[(head - back + MARK_LANE.length * 4) % MARK_LANE.length], alpha]);
  let glow = "";
  if (depth && state === "busy") {
    const id = `shg${uid++}`;
    glow = `<defs><filter id="${id}" x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation="1.6"/></filter></defs><g filter="url(#${id})" opacity=".7">${MARK_LANE[head].map(([x, y]) => rect(x, y, "var(--cyan)")).join("")}</g>`;
  }
  const under = depth ? cells.map(([x, y]) => rect(x + 1, y + 1, "var(--px-shadow)")).join("") : "";
  // The waiting bar changes every 4 steps (0.56 s): under three flashes a second (WCAG 2.3.1).
  const end = state === "waiting" ? "var(--amber)" : state === "error" ? "var(--red)" : state === "busy" ? "var(--cyan)" : null;
  const lit = state === "waiting" && Math.floor(t / 4) % 2 ? 0.25 : 1;
  const top = cells.map(([x, y, tone]) => {
    if (!end || !isEnd(x, y)) return rect(x, y, `var(${TONES[tone]})`);
    const edge = tone === "W" ? rect(x, y, "#fff", 0.45 * lit) : tone === "#" ? "" : rect(x, y, "#000", 0.35 * lit);
    return rect(x, y, end, lit) + edge;
  }).join("");
  const block = steps.map(([at, alpha]) => at.map(([x, y]) => rect(x, y, "#fff", alpha)).join("")).join("");
  return frame(rows[0].length + pad, rows.length + pad, cellPx(cell, ratio), "mark", glow + under + top + block);
}

/** A status square as a small key: the text's colour, a light edge above and left, a dark one below and right; hollow,
 *  the key's empty seat — a ring, dark above and left and light below and right. `side` in CSS px. */
export function key({ side = 8, hollow = false, cls = "" } = {}) {
  const edge = (d, fill, opacity) => `<path d="${d}" fill="${fill}" opacity="${opacity}"/>`;
  const above = `M0 0h${side - 1}v1h-${side - 2}v${side - 2}h-1z`, below = `M${side} ${side}h-${side - 1}v-1h${side - 2}v-${side - 2}h1z`;
  const body = hollow
    ? `<path fill-rule="evenodd" d="M0 0h${side}v${side}h-${side}zM2 2v${side - 4}h${side - 4}v-${side - 4}z" fill="currentColor"/>${edge(above, "#000", 0.35)}${edge(below, "#fff", 0.3)}`
    : `<rect width="${side}" height="${side}" fill="currentColor"/>${edge(above, "#fff", 0.45)}${edge(below, "#000", 0.35)}`;
  return `<svg class="px key${cls ? ` ${cls}` : ""}" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" aria-hidden="true">${body}</svg>`;
}
