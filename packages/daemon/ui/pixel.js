// Pixel marks for the terminal window (docs/ui-v0.md §7): 1-bit sprites on whole-point cells, the app's mark (the
// icon's switch: one source, three lanes) with its states, the wordmark, and the glitch that marks a change of state.

export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** A 1-bit sprite ("#" lit) as crisp SVG squares; `px` is a whole number of points. */
export function sprite(rows, { px = 2, cls = "" } = {}) {
  const W = rows[0].length * px, H = rows.length * px;
  let r = "";
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") r += `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}"/>`; }));
  return `<svg class="px ${cls}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true">${r}</svg>`;
}

/** Each agent's mark, 5×5 (its own logo's shape): Claude Code's spark, Codex's >_, OpenCode's brackets, pi's π. */
export const AGENT_PX = {
  "claude-code": ["#.#.#", ".###.", "#####", ".###.", "#.#.#"],
  codex: ["#....", ".#...", "..#..", ".#...", "#.###"],
  opencode: ["##.##", "#...#", "#...#", "#...#", "##.##"],
  pi: ["#####", ".#.#.", ".#.#.", ".#.#.", ".#..#"],
};
export const LOCK = [".###.", "#...#", "#####", "##.##", "#####"];
/** Status: a square (idle, waiting), hollow when ended; busy is the spinner. */
export const SQUARE = ["####", "####", "####", "####"];
export const HOLLOW = ["####", "#..#", "#..#", "####"];
/** In progress, everywhere the same: a braille spinner (a still first frame with Reduce Motion). */
export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ---------- the app's mark ----------
// S = source, a/b/c = lanes, A/B/C = their ends; the top lane is the lit one, as in the icon.
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
/** Empty cells in an inside corner of a diagonal step: a half-lit pixel smooths the step (sub-pixel anti-aliasing). */
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

/** The mark in a state: idle (the lit lane), busy (a block runs along it), waiting (its end blinks amber), error (its
 *  end red), off (dithered to half). `depth` for identity marks ≥ 20pt: a 1-pixel hard shadow, half-lit steps, and
 *  the busy block with a sub-pixel trail and a little glow. */
export function mark({ px = 2, state = "idle", t = 0, depth = false } = {}) {
  const c = { ink: "var(--ink)", dim: "var(--ink3)", busy: "var(--cyan)", wait: "var(--amber)", error: "var(--red)", shadow: "var(--px-shadow)" };
  const off = depth ? 1 : 0;
  const W = (MARK[0].length + off) * px, H = (MARK.length + off) * px;
  const n = LANE_A.length, k = t % n;
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
    let fill = tone(ch), op = 1;
    // t counts 140 ms steps; the waiting end changes every 4 (0.56 s): under three flashes a second (WCAG 2.3.1).
    if (ch === "A" && state === "waiting") { fill = c.wait; op = Math.floor(t / 4) % 2 ? 0.25 : 1; }
    if (ch === "A" && state === "error") fill = c.error;
    const p = packet.get(`${x},${y}`);
    return rect(x, y, fill, op) + (p !== undefined ? rect(x, y, c.busy, p) : "");
  }).join("");
  return `<svg class="px mark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" aria-hidden="true">${glow}${under}${top}</svg>`;
}

// ---------- the wordmark ----------
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
export const wordRows = (w) => { const rows = []; for (let y = 0; y < 7; y++) rows.push([...w].map((ch) => FONT[ch][y]).join(".")); return rows; };

/** The wordmark settled: letters with 2-cell strokes on a half-size grid (`px` even), over a signal-pink offset of one
 *  fine cell (half a stroke), half-lit pixels rounding G, S, C. `lcd`: each pixel as R/G/B stripes with a glow — the
 *  reveal's last frame only. */
export function wordmark(word = "AGENTSWITCH", { px = 6, lcd = false } = {}) {
  const coarse = wordRows(word);
  const rows = lcd ? coarse : coarse.flatMap((r) => { const w = [...r].map((ch) => ch + ch).join(""); return [w, w]; });
  if (!lcd) px /= 2;
  const W = (rows[0].length + 1) * px, H = (rows.length + 1) * px;
  const cells = [];
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== ".") cells.push([x, y]); }));
  const rect = (x, y, fill, op = 1) => `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${fill}"${op < 1 ? ` opacity="${op}"` : ""}/>`;
  if (lcd) {
    const id = `pxw${uid++}`, sw = px / 3, RGB = ["#ff3b3b", "#3bff7a", "#3b7bff"];
    const stripes = cells.map(([x, y]) => RGB.map((col, i) => `<rect x="${x * px + i * sw + sw * 0.12}" y="${y * px + px * 0.06}" width="${sw * 0.76}" height="${px * 0.88}" fill="${col}"/>`).join("")).join("");
    return `<svg class="px word" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" aria-label="AgentSwitch"><defs><filter id="${id}"><feGaussianBlur stdDeviation="${px * 0.6}"/></filter></defs><g filter="url(#${id})" opacity=".5">${cells.map(([x, y]) => rect(x, y, "#fff")).join("")}</g>${stripes}</svg>`;
  }
  return `<svg class="px word" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" aria-label="AgentSwitch">${cells.map(([x, y]) => rect(x + 1, y + 1, "var(--signal)")).join("")}${aaCells(rows).map(([x, y]) => rect(x, y, "var(--ink)", 0.42)).join("")}${cells.map(([x, y]) => rect(x, y, "var(--ink)")).join("")}</svg>`;
}

/** The wordmark resolving out of glyph noise (the first time a screen shows it), then still. */
export function revealWordmark(el, word = "AGENTSWITCH", { px = 6 } = {}) {
  if (reducedMotion.matches) { el.innerHTML = wordmark(word, { px }); return () => undefined; }
  const grid = wordRows(word).map((r) => r + ".");
  const RAMP = " .:-=+*#%@";
  const start = performance.now();
  const at = grid.map((row) => [...row].map(() => 120 + Math.random() * 700));
  const size = `font-size:${px * 1.4}px;line-height:${px}px`;
  let settle = null;
  const timer = setInterval(() => {
    const t = performance.now() - start;
    if (t > 1000) {
      clearInterval(timer);
      el.innerHTML = wordmark(word, { px, lcd: true });
      settle = setTimeout(() => { el.innerHTML = wordmark(word, { px }); }, 260);
      return;
    }
    let html = "";
    grid.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        const on = ch === "#";
        if (t >= at[y][x]) html += on ? `<b class="on">█</b>` : " ";
        else { const g = RAMP[Math.floor(Math.random() * (on ? RAMP.length : 4))]; html += `<b class="${on ? "on" : "off"}">${g}</b>`; }
      });
      html += "\n";
    });
    el.innerHTML = `<pre class="noise" style="${size}">${html}</pre>`;
  }, 45);
  return () => { clearInterval(timer); clearTimeout(settle); };
}

/** One burst when something changes state (a permission request, a failure, an unexpected exit). Never on a loop;
 *  nothing with Reduce Motion. */
export function glitch(el) {
  if (!el || reducedMotion.matches) return;
  el.classList.remove("glitch");
  void el.offsetWidth;
  el.classList.add("glitch");
  el.addEventListener("animationend", () => el.classList.remove("glitch"), { once: true });
}
