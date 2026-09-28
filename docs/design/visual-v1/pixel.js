// Shared by the two demo pages: 1-bit sprites, the pixel switch mark, the glitch.
(() => {
/** A 1-bit sprite as crisp SVG squares; `off` also draws the dark cells (an LED matrix). */
function sprite(rows, { px = 2, gap = 0, off = null, cls = "" } = {}) {
  const w = rows[0].length, h = rows.length, step = px + gap, W = w * step - gap, H = h * step - gap;
  let r = "";
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === "#") r += `<rect x="${x * step}" y="${y * step}" width="${px}" height="${px}"/>`;
    else if (off) r += `<rect class="off" x="${x * step}" y="${y * step}" width="${px}" height="${px}" fill="${off}"/>`;
  }));
  return `<svg class="px ${cls}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="currentColor" shape-rendering="crispEdges">${r}</svg>`;
}

const AGENT_PX = {
  cc:    ["#.#.#", ".###.", "#####", ".###.", "#.#.#"],
  codex: ["#....", ".#...", "..#..", ".#...", "#.###"],
  oc:    ["##.##", "#...#", "#...#", "#...#", "##.##"],
  pi:    ["#####", ".#.#.", ".#.#.", ".#.#.", ".#..#"],
};
const AGENT_NAME = { cc: "Claude Code", codex: "Codex", oc: "OpenCode", pi: "pi" };
const SQUARE = ["####", "####", "####", "####"];
const HOLLOW = ["####", "#..#", "#..#", "####"];

/** The app's mark — one source switched onto three lanes, as the icon — on a pixel grid. S = source, a/b/c = lanes,
 *  A/B/C = their ends. The top lane is the lit one, as in the icon. */
const MARK = [
  "...........AAA",
  "......aaaaaAAA",
  ".....a.....AAA",
  "....a.........",
  "SSSa.......BBB",
  "SSSbbbbbbbbBBB",
  "SSSc.......BBB",
  "....c.........",
  ".....c.....CCC",
  "......cccccCCC",
  "...........CCC",
];
const LANE_A = [[3, 4], [4, 3], [5, 2], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1]];

const lit = (rows, x, y) => y >= 0 && y < rows.length && x >= 0 && x < rows[0].length && rows[y][x] !== ".";
/** Empty cells in an inside corner of a diagonal step: they get a half-lit pixel (sub-pixel anti-aliasing). Returns
 *  [x, y, the neighbouring cell's char] for each. */
function aaCells(rows) {
  const out = [];
  rows.forEach((r, y) => [...r].forEach((c, x) => {
    if (c !== ".") return;
    const n = lit(rows, x, y - 1), s = lit(rows, x, y + 1), w = lit(rows, x - 1, y), e = lit(rows, x + 1, y);
    const corner = (n && e && !lit(rows, x + 1, y - 1)) || (n && w && !lit(rows, x - 1, y - 1)) || (s && e && !lit(rows, x + 1, y + 1)) || (s && w && !lit(rows, x - 1, y + 1));
    if (corner && [n, s, w, e].filter(Boolean).length === 2) out.push([x, y, n ? rows[y - 1][x] : rows[y + 1][x]]);
  }));
  return out;
}
let uid = 0;

/** state: idle | busy | waiting | error | off. `t` is the animation frame. `mono` draws it as a menu bar template
 *  (one color; state by shape alone; always flat). `depth` (identity marks ≥ 24pt, ui-v0 §7.2.10): a 1-pixel hard
 *  shadow, half-lit pixels in the diagonal steps, and the busy block with a sub-pixel trail and a little glow. */
function mark({ px = 2, state = "idle", t = 0, mono = false, depth = false, colors = {} } = {}) {
  depth = depth && !mono;
  const c = { ink: "currentColor", dim: mono ? "currentColor" : "var(--ink3)", busy: mono ? "currentColor" : "var(--cyan)", wait: mono ? "currentColor" : "var(--amber)", error: mono ? "currentColor" : "var(--red)", shadow: "var(--px-shadow, #2c2a28)", ...colors };
  const off = depth ? 1 : 0;
  const W = (MARK[0].length + off) * px, H = (MARK.length + off) * px;
  const n = LANE_A.length, k = t % n;
  // the busy block: two cells together (flat), or a head with a fading trail (depth)
  const packet = new Map();
  if (state === "busy") {
    if (depth) [[0, 1], [1, 0.55], [2, 0.25]].forEach(([back, a]) => { const [x, y] = LANE_A[(k - back + n * 4) % n]; packet.set(`${x},${y}`, a); });
    else LANE_A.slice(k, k + 2).forEach(([x, y]) => packet.set(`${x},${y}`, 1));
  }
  const tone = (ch) => ("aAS".includes(ch) ? c.ink : c.dim);
  const rect = (x, y, fill, op = 1) => `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${fill}"${op < 1 ? ` opacity="${op}"` : ""}/>`;
  const cells = [];
  MARK.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== "." && !(state === "off" && (x + y) % 2)) cells.push([x, y, ch]); }));
  let under = "", glow = "";
  if (depth) {
    under = cells.map(([x, y]) => rect(x + 1, y + 1, c.shadow)).join("");
    if (state !== "off") under += aaCells(MARK).map(([x, y, ch]) => rect(x, y, tone(ch), 0.42)).join("");
    if (state === "busy") {
      const id = `pxg${uid++}`;
      const [hx, hy] = LANE_A[k];
      glow = `<defs><filter id="${id}" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="${px * 1.2}"/></filter></defs><g filter="url(#${id})" opacity=".7">${rect(hx, hy, c.busy)}</g>`;
    }
  }
  const top = cells.map(([x, y, ch]) => {
    let fill = tone(ch);
    let op = mono && !"aAS".includes(ch) ? 0.4 : 1;
    const p = packet.get(`${x},${y}`);
    // t counts 140 ms steps; the waiting end changes every 4 (0.56 s): under three flashes a second (WCAG 2.3.1).
    if (ch === "A" && state === "waiting") { fill = c.wait; op = Math.floor(t / 4) % 2 ? 0.25 : 1; }
    if (ch === "A" && state === "error") { fill = c.error; op = 1; }
    if (state === "busy" && mono && ch === "a" && p === undefined) op = 0.45;
    let r = rect(x, y, fill, op);
    if (p !== undefined) r += rect(x, y, c.busy, p);          // the trail lies over the lane
    return r;
  }).join("");
  return `<svg class="px mark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${glow}${under}${top}</svg>`;
}

// the wordmark's letters, 5×7
const FONT = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
};
const wordRows = (w) => { const rows = []; for (let y = 0; y < 7; y++) rows.push([...w].map((ch) => FONT[ch][y]).join(".")); return rows; };

/** The wordmark: ink letters over a 1-pixel signal-pink offset, half-lit pixels rounding G, S, C (ui-v0 §7.2.10).
 *  `lcd`: each pixel as R/G/B stripes with a glow — the last frame of the reveal only. */
function wordmark(word = "AGENTSWITCH", { px = 6, lcd = false, ink = "var(--ink)", signal = "var(--signal)" } = {}) {
  // Letters drawn with 2-cell strokes on a grid of half-size cells (`px` must be even): the pink offset is one fine
  // cell, half a stroke — an edge under the ink, not a second letter.
  const coarse = wordRows(word);
  const rows = lcd ? coarse : coarse.flatMap((r) => { const w = [...r].map((c) => c + c).join(""); return [w, w]; });
  if (!lcd) px /= 2;
  const W = (rows[0].length + 1) * px, H = (rows.length + 1) * px;
  const cells = [];
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== ".") cells.push([x, y]); }));
  const rect = (x, y, fill, op = 1) => `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${fill}"${op < 1 ? ` opacity="${op}"` : ""}/>`;
  if (lcd) {
    const id = `pxw${uid++}`, sw = px / 3, RGB = ["#ff3b3b", "#3bff7a", "#3b7bff"];
    const stripes = cells.map(([x, y]) => RGB.map((col, i) => `<rect x="${x * px + i * sw + sw * 0.12}" y="${y * px + px * 0.06}" width="${sw * 0.76}" height="${px * 0.88}" fill="${col}"/>`).join("")).join("");
    return `<svg class="px word" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges"><defs><filter id="${id}"><feGaussianBlur stdDeviation="${px * 0.6}"/></filter></defs><g filter="url(#${id})" opacity=".5">${cells.map(([x, y]) => rect(x, y, "#fff")).join("")}</g>${stripes}</svg>`;
  }
  const shadow = cells.map(([x, y]) => rect(x + 1, y + 1, signal)).join("");
  const aa = aaCells(rows).map(([x, y]) => rect(x, y, ink, 0.42)).join("");
  return `<svg class="px word" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${shadow}${aa}${cells.map(([x, y]) => rect(x, y, ink)).join("")}</svg>`;
}

/** One burst when something changes state (needs you, failed). Never on a loop; nothing with Reduce Motion. */
function glitch(el) {
  if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.classList.remove("glitch");
  void el.offsetWidth;
  el.classList.add("glitch");
  el.addEventListener("animationend", () => el.classList.remove("glitch"), { once: true });
}

const GLITCH_CSS = `
.glitch { animation: glitch .45s steps(1) 1; }
@keyframes glitch {
  0%   { transform: translate(0); }
  8%   { transform: translate(-4px, 0); clip-path: inset(12% 0 52% 0); text-shadow: 3px 0 var(--cyan), -3px 0 var(--signal); }
  16%  { transform: translate(5px, 0); clip-path: inset(58% 0 8% 0); }
  24%  { transform: translate(-2px, 1px); clip-path: inset(30% 0 36% 0); text-shadow: -4px 0 var(--cyan), 4px 0 var(--signal); }
  32%  { transform: translate(0); clip-path: none; filter: invert(1); }
  40%  { filter: none; text-shadow: 1px 0 var(--cyan), -1px 0 var(--signal); }
  56%  { transform: translate(2px, 0); clip-path: inset(70% 0 0 0); }
  64%, 100% { transform: translate(0); clip-path: none; text-shadow: none; filter: none; }
}`;

// A classic script (the pages open from file://, where modules are blocked).
window.Pixel = { sprite, AGENT_PX, AGENT_NAME, SQUARE, HOLLOW, mark, wordmark, glitch, GLITCH_CSS };
})();
