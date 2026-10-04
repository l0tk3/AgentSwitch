// Pixel marks for the terminal window (docs/ui-v0.md §7): 1-bit sprites on whole-point cells, the wordmark, and the
// glitch that marks a change of state. The icons — the app's mark with its states, each agent's mark, the lock, the
// status squares — are shaded pictures now (§9, lib/shaded.js).

// A page without matchMedia (a test's DOM) moves.
export const reducedMotion = globalThis.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false, addEventListener() {} };

/** A 1-bit sprite ("#" lit) as crisp SVG squares; `px` is a whole number of points. */
export function sprite(rows, { px = 2, cls = "" } = {}) {
  const W = rows[0].length * px, H = rows.length * px;
  let r = "";
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") r += `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}"/>`; }));
  return `<svg class="px ${cls}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true">${r}</svg>`;
}

/** In progress, everywhere the same: a braille spinner (a still first frame with Reduce Motion). */
export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ---------- half-lit steps ----------
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
/** While something runs, a light burst now and then (ui-v0 §7.2.9, 2026-10-01, user: 正在运行中的都改成这个效果):
 *  the bands and the split, no inversion, so the full glitch stays the sign that something happened. */
export function flicker(el) {
  if (!el || reducedMotion.matches || el.classList.contains("glitch")) return;
  el.classList.remove("flicker");
  void el.offsetWidth;
  el.classList.add("flicker");
  el.addEventListener("animationend", () => el.classList.remove("flicker"), { once: true });
}

export function glitch(el) {
  if (!el || reducedMotion.matches) return;
  el.classList.remove("glitch");
  void el.offsetWidth;
  el.classList.add("glitch");
  el.addEventListener("animationend", () => el.classList.remove("glitch"), { once: true });
}
