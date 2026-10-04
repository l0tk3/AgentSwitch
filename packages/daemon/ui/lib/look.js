// The web pages' look (docs/ui-v0.md §8, 2026-10-04; user: 设置里应该加入一版“经典设计”的图标和ui，就是那种像经典app一样的
// 平滑ui、设计和提示): `pixel`, the visual language of §7 and the default, or `classic` — the system font, round
// corners, line icons, standard buttons, dots for status. Only how things are drawn changes. The Mac window tells its
// page the look (`window.agentswitchLook`, then `window.agentswitch.look()`); a browser keeps its own (`appearance`).
// The words and tooltips are the Mac app's ClassicWords, said here for what the page draws itself.

/** `classic` only when it is that word: anything else is the pixel look. */
export const lookOf = (v) => (v === "classic" ? "classic" : "pixel");

/** The accent the Mac window hands over (the system's, the user: 蓝色): a six-digit colour or nothing. */
export const accentOf = (v) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : null);

const WORDS = {
  Busy: "Working", Waiting: "Needs You", Idle: "Ready", Exited: "Ended",
  "[!] Approval": "Approval Needed", "[?] Question": "Question", "On Mac": "On This Mac", Opening: "Opening…",
};

/** `text` as `look` writes it. A count of things waiting (`2 Waiting`) is `2 Need You`, one `1 Needs You`. */
export function word(text, look) {
  if (look !== "classic") return text;
  if (Object.hasOwn(WORDS, text)) return WORDS[text];
  const m = /^(\d+) Waiting$/.exec(text);
  if (m) return Number(m[1]) === 1 ? "1 Needs You" : `${m[1]} Need You`;
  return text;
}

/** A line of short words joined by ` · `, each as `look` writes it. */
export const phrase = (text, look) => (look === "classic" ? text.split(" · ").map((w) => word(w, look)).join(" · ") : text);

/** An age (`3h`) as `look` says it: `3h ago`; `Now` and a date stay. */
export const age = (text, look) => (look === "classic" && /^\d+[mhd]$/.test(text) ? `${text} ago` : text);

const SENTENCES = { "List ⌘B": "Show or hide the list (⌘B)" };

/** A control's tooltip: the pixel look says a name and its key (`Close ⌘W`), the classic one puts the key in brackets
 *  (`Close (⌘W)`). A sentence stays as it is. */
export function help(text, look) {
  if (look !== "classic") return text;
  if (Object.hasOwn(SENTENCES, text)) return SENTENCES[text];
  if (/[。：]/.test(text)) return text;
  const at = text.lastIndexOf(" ");
  if (at < 0) return text;
  const key = text.slice(at + 1);
  return /^[⌘⌃⌥⇧↩⌫]/.test(key) || key === "esc" ? `${text.slice(0, at)} (${key})` : text;
}

/** A group's label: `// Model` in the pixel look, `Model` in the classic one. */
export const label = (text, look) => (look === "classic" ? text.replace(/^\/\/\s*/, "") : text);

/** A button's word: `[ Take Over ]` in the pixel look, the word alone in the classic one (its `+` is an icon's job). */
export const bracket = (text, look) => (look === "classic" ? text.replace(/^\+\s*/, "") : `[ ${text} ]`);

// ---------- a page built from strings (the web console): its labels and status words as the look writes them ----------
/** `// ` at the start of a label: an element of class `lbl`, a `<label>`, a `<summary>`, a box's head. Nothing else: text
 *  a model or you wrote may start with the same two slashes (a comment in code). */
const LABEL = /(<(?:div|span)\s+class="(?:[^"]*\s)?lbl(?:\s[^"]*)?"[^>]*>(?:<span>)?|<label(?:\s[^>]*)?>(?:<span>)?|<summary>|<div class="hd"><span>)\/\/ /g;
const WORD = /(<span class="(?:word|badge)[^"]*">)([^<]+)(<\/span>)/g;
const COUNT = /(<\/span>)(\d+ Waiting)(<\/span>)/g;

/** A view's markup as the look has it: in the classic look the labels lose their slashes and the status words in
 *  `word` and `badge` spans (and the band's `2 Waiting`) are the classic ones. The pixel look's markup is untouched. */
export function dress(html, look) {
  if (look !== "classic") return html;
  return html.replace(LABEL, "$1")
    .replace(WORD, (_, open, text, close) => open + word(text, look) + close)
    .replace(COUNT, (_, before, text, close) => before + word(text, look) + close);
}

/** The look this page is drawn in (the root's class; a page without a document — a test — is the pixel look). */
export const pageLook = () => (globalThis.document?.documentElement.classList.contains("classic") ? "classic" : "pixel");

// ---------- line icons: an 18 pt board, 1.5 pt strokes on half pixels (docs/design/concepts/classic.html) ----------
const BOX = '<rect x="1.75" y="3.25" width="14.5" height="11.5" rx="2.75"/>';
export const ICONS = {
  dispatch: '<g fill="currentColor" stroke="none"><rect x="1.5" y="7" width="4" height="4" rx="1.2"/><rect x="12.5" y="1.75" width="4" height="4" rx="1.2"/><rect x="12.5" y="7" width="4" height="4" rx="1.2"/><rect x="12.5" y="12.25" width="4" height="4" rx="1.2"/></g><path d="M5.5 9h7M5.5 8.25C9.6 8.25 8.4 3.75 12.5 3.75M5.5 9.75C9.6 9.75 8.4 14.25 12.5 14.25"/>',
  terminal: BOX + '<path d="M5 6.75 7.25 9 5 11.25M9.5 11.25h3.5"/>',
  sidebar: BOX + '<path d="M6.75 3.25v11.5M3.75 6.25h1.25M3.75 8.5h1.25"/>',
  plus: '<path d="M9 3.75v10.5M3.75 9h10.5"/>',
  x: '<path d="M4.75 4.75l8.5 8.5M13.25 4.75l-8.5 8.5"/>',
  lock: '<rect x="3.75" y="8.25" width="10.5" height="7" rx="2"/><path d="M6 8.25V6a3 3 0 0 1 6 0v2.25"/>',
  search: '<circle cx="7.75" cy="7.75" r="4.75"/><path d="M11.25 11.25l3.5 3.5"/>',
  folder: '<path d="M2.25 5.5a1.75 1.75 0 0 1 1.75-1.75h2.6l1.65 1.75h5.75a1.75 1.75 0 0 1 1.75 1.75v5.5a1.75 1.75 0 0 1-1.75 1.75H4a1.75 1.75 0 0 1-1.75-1.75z"/>',
  chevdown: '<path d="M3.75 6.5 9 11.75l5.25-5.25"/>',
  chevright: '<path d="M6.75 3.75 12 9l-5.25 5.25"/>',
  chevup: '<path d="M3.75 11.5 9 6.25l5.25 5.25"/>',
  clock: '<circle cx="9" cy="9" r="6.75"/><path d="M9 5.25V9l2.5 1.5"/>',
  warn: '<path d="M9 2.75 15.75 14.5H2.25z"/><path d="M9 7.5v3M9 12.5v.05"/>',
  question: '<circle cx="9" cy="9" r="6.75"/><path d="M6.9 7.1a2.15 2.15 0 1 1 3.2 1.9c-.7.4-1.1.8-1.1 1.6M9 12.9v.05"/>',
  check: '<path d="M4 9.5l3.25 3.25L14 5.75"/>',
  phone: '<rect x="5.25" y="1.75" width="7.5" height="14.5" rx="2.25"/><path d="M8 13.75h2"/>',
  claude: '<path d="M9 2.75v12.5M2.75 9h12.5M4.6 4.6l8.8 8.8M13.4 4.6l-8.8 8.8"/>',
  codex: '<path d="M3.75 5.5 7.5 9l-3.75 3.5M9.75 12.75h4.5"/>',
  opencode: '<path d="M6.75 3.75h-3v10.5h3M11.25 3.75h3v10.5h-3"/>',
  pi: '<path d="M3.75 5.25h10.5M6.5 5.25v8M11.5 5.25v6.25a1.75 1.75 0 0 0 1.75 1.75"/>',
};
/** Each agent's mark as a line drawing (its own logo's shape, one colour). */
export const AGENT_ICON = { "claude-code": "claude", codex: "codex", opencode: "opencode", pi: "pi" };

/** A line icon in the text's colour; nothing for a name it does not have. */
export function icon(name, size = 16) {
  if (!Object.hasOwn(ICONS, name)) return "";
  return `<svg class="ci" width="${size}" height="${size}" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** In progress: the system's spinner, eight fading spokes turning in steps (still with Reduce Motion, in the CSS). */
export function spinner(size = 14) {
  const spokes = [...Array(8)].map((_, i) => `<rect x="7.2" y="1.1" width="1.6" height="4.1" rx=".8" transform="rotate(${i * 45} 8 8)" opacity="${(0.16 + 0.84 * i / 7).toFixed(2)}"/>`).join("");
  return `<svg class="cspin" width="${size}" height="${size}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${spokes}</svg>`;
}

/** Status as a dot: green idle, amber waiting (its ring breathes), red failed, a grey ring once ended. */
export const dot = (state) => `<span class="dot ${state}" aria-hidden="true"></span>`;
