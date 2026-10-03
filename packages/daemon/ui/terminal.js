// The terminal window (docs/terminal-v0.md §1) in the visual language of docs/ui-v0.md §7. AgentSwitch's own
// terminals, one live at a time, drawn with the user's terminal font and colors. The sidebar is a directory tree:
// project folders (each in the nearest folder above it that the list shows), their running terminals, then earlier
// sessions to continue. Keys go straight in; a reply that may hold a password goes through the sealed composer under
// the terminal; a permission request floats over the screen until someone answers it here or in the terminal. No
// native dialogs (the Mac window has none). Short words are English, sentences formal Chinese.
import { Terminal } from "/ui/vendor/xterm.mjs";
import { FitAddon } from "/ui/vendor/addon-fit.mjs";
import { Unicode11Addon } from "/ui/vendor/addon-unicode11.mjs";
import { WebLinksAddon } from "/ui/vendor/addon-web-links.mjs";
import { AGENT_PX, flicker, glitch, HOLLOW, LOCK, mark, reducedMotion, revealWordmark, SPIN, sprite, SQUARE } from "/ui/pixel.js";
import { everyFolder, everySession, everyTerminal, folderOf, folderTree as buildTree, foldersAbove, slashed, tilde } from "/ui/lib/tree.js";

const $ = (id) => document.getElementById(id);
const IN_MAC_APP = /AgentSwitchMac/.test(navigator.userAgent);
const native = IN_MAC_APP ? window.webkit?.messageHandlers?.agentswitch : null;
/** The Mac window's toolbar (native) shows what the page tells it: each kind of report sent only when it changes. */
const tellWindow = (() => {
  const last = {};
  return (type, msg) => {
    if (!native) return;
    const s = JSON.stringify(msg);
    if (last[type] === s) return;
    last[type] = s;
    native.postMessage({ type, ...msg });
  };
})();
if (IN_MAC_APP) document.documentElement.classList.add("mac-app");
// The Mac window draws the terminal itself (a native SwiftTerm view under this page, docs/terminal-v0.md §1 Mac): the
// page leaves the screen's area clear, says where it is and what floats over it, and draws no terminal of its own.
const NATIVE = IN_MAC_APP && window.agentswitchNativeScreen === true;
if (NATIVE) document.documentElement.classList.add("native-screen");
/** The grid the native screen fits (it tells us), for a terminal started or continued here. */
let nativeGrid = { cols: 100, rows: 30 };
const narrow = matchMedia("(max-width: 760px), (pointer: coarse)");

const AGENTS = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "opencode", name: "OpenCode" },
  { id: "pi", name: "pi" },
];
const AGENT = Object.fromEntries(AGENTS.map((a) => [a.id, a.name]));
const RESUMABLE = new Set(["claude-code", "codex", "opencode"]);
/** Sessions whose record can be deleted here (OpenCode keeps them in its database). */
// Every agent's sessions can be deleted (docs/terminal-v0.md §5; OpenCode and pi since 2026-10-01).
const DELETABLE = new Set(["claude-code", "codex", "opencode", "pi"]);
/** "Continue" goes on in the same session, one program at a time; the service sees where Claude Code and Codex
 *  sessions are open (terminal-v0 §5), not OpenCode's. */
const CHECKED = new Set(["claude-code", "codex"]);
/** How the agent asks before acting (terminal-v0 §3); the protected paths stay closed in all three. */
const MODES = [
  { id: "manual", name: "Ask Each" },
  { id: "auto", name: "Auto" },
  { id: "bypass", name: "Bypass" },
];
/** The first time, the Mac's approval policy (control-v0 §1) picks the mode; after that, the last one chosen. */
const MODE_FROM_POLICY = { manual: "manual", scoped: "auto", auto: "auto", skip: "bypass" };
const TOOL_WORDS = { Write: "Write File", Edit: "Edit File", MultiEdit: "Edit File", NotebookEdit: "Edit Notebook", Bash: "Run Command", WebFetch: "Fetch Page", WebSearch: "Search Web" };
/** A terminal's status as it is shown (docs/ui-v0.md §7.2 第 7 条); the value from the service stays as it is. */
const STATUS_WORDS = { working: "Busy", waiting: "Waiting", idle: "Idle", exited: "Exited" };
const SESSIONS_SHOWN = 3;

// ---------- helpers ----------
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) signedOut();
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status, body: json });
  return json;
}

/** The sign-in cookie lasts as long as the service: after a restart the Mac app signs in again, a browser says so. */
let signOutShown = false;
function signedOut() {
  if (signOutShown) return;
  signOutShown = true;
  if (native) native.postMessage({ type: "signIn" });
  else notify("登录已失效。请从 AgentSwitch 重新打开此页面。");
}

function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style") n.setAttribute("style", v);
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}
/** A span holding markup this page made (a sprite). */
const raw = (html, cls = "") => { const s = h("span", { class: cls }); s.innerHTML = html; return s; };

/** Age as a unit: Now, 5m, 3h, 2d, then the date. */
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "Now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

// ---------- colors: one surface, the screen's own ----------
function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const LIGHT = { "--ink": "#151413", "--ink2": "#5f5b54", "--ink3": "#a29d93", "--ink4": "#d3cec3", "--hover": "rgba(0,0,0,.04)", "--sel": "rgba(0,0,0,.06)",
  "--signal": "#e0106e", "--cyan": "#0086a8", "--amber": "#c27400", "--green": "#3f8f00", "--red": "#d7261b", "--px-shadow": "#cfc9bc", "--dither": "#bdb7ab" };
function applyChrome(style) {
  const c = rgb(style?.theme?.background) ?? [0, 0, 0];
  const root = document.documentElement.style;
  root.setProperty("--term", `rgb(${c.join(",")})`);
  if (style?.fontFamily) root.setProperty("--mono", style.fontFamily);
  const dark = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 < 0.5;
  if (!dark) {
    for (const [k, v] of Object.entries(LIGHT)) root.setProperty(k, v);
    document.documentElement.style.colorScheme = "light";
  }
}

// ---------- state ----------
let terminals = [];
let agents = AGENTS.map((a) => a.id);
/** Each agent's models ({id, name, older?}) from GET /terminals — what the agent offers today, in its order; none
 *  chosen = the agent's own default, which `defaults` names when the agent says what it is. */
let models = {};
let modelDefaults = {};
let sessions = [];
let current = null;
let source = null;
let lastSeq = 0;
let creating = false;
let renaming = false;
let opening = null;          // the session being continued, until its terminal shows
let wipeNext = false;        // the next snapshot is another terminal's screen: draw it in top to bottom
let pickedAgent = recall("terminal.agent") || "claude-code";
let pickedMode = recall("terminal.mode");
/** The model chosen last, per agent ("" = default). */
const pickedModels = (() => { try { return JSON.parse(recall("terminal.models") || "{}"); } catch { return {}; } })();
const collapsed = new Set(JSON.parse(recall("terminal.collapsed") || "[]"));
const expanded = new Set();  // folders showing all their sessions

// ---------- the sidebar: its width by dragging its edge; closed past the left edge, by the top bar's button or ⌘B ----------
const SIDE = { width: 290, min: 220, closeBelow: 120 };
let side = (() => {
  try { return { width: SIDE.width, closed: false, ...JSON.parse(recall("terminal.side") || "{}") }; } catch { return { width: SIDE.width, closed: false }; }
})();
/** Room for the screen stays (the Mac window is at least 800 wide). */
const sideWidth = (x) => Math.round(Math.max(SIDE.min, Math.min(x, 560, innerWidth - 420)));
/** The top bar's list button (a browser's; the Mac window has it in its toolbar): the fine pixel icon, 1 pt cells. */
const LIST_ICON = [".################.", "#.....#..........#", "#.....#..........#", "#.###.#..........#", "#.....#..........#", "#.###.#..........#",
  "#.....#..........#", "#.###.#..........#", "#.....#..........#", "#.....#..........#", "#.....#..........#", "#.....#..........#",
  "#.....#..........#", ".################."];
const NEW_ICON = ["......#......", "......#......", "......#......", "......#......", "......#......", "......#......", "#############",
  "......#......", "......#......", "......#......", "......#......", "......#......", "......#......"];
$("newBtn").innerHTML = sprite(NEW_ICON, { px: 1 });
function renderSideBtn() {
  const shown = narrow.matches ? document.body.classList.contains("list-open") : !side.closed;
  if (!$("sideBtn").firstChild) $("sideBtn").innerHTML = sprite(LIST_ICON, { px: 1 });
  $("sideBtn").setAttribute("aria-expanded", String(shown));
}
function applySide() {
  document.documentElement.style.setProperty("--side-w", `${sideWidth(side.width)}px`);
  document.body.classList.toggle("side-closed", side.closed);
  renderSideBtn();
}
/** The list: a drawer over the screen on a narrow one, else the column beside it. */
function toggleList() {
  if (narrow.matches) { document.body.classList.toggle("list-open"); renderSideBtn(); } else toggleSide();
}
function setSide(next) {
  side = { ...side, ...next };
  remember("terminal.side", JSON.stringify(side));
  applySide();
}
const toggleSide = () => setSide({ closed: !side.closed });
applySide();
addEventListener("resize", applySide);
// A drag follows the pointer (the screen refits as it goes); let go left of `closeBelow` and the list closes.
$("sideGrip").addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || narrow.matches) return;
  e.preventDefault();
  const grip = e.currentTarget, from = e.clientX;
  let moved = false;
  grip.setPointerCapture(e.pointerId);
  document.body.classList.add("side-dragging");
  const move = (ev) => {
    moved ||= Math.abs(ev.clientX - from) > 3;
    if (!moved) return;
    const closing = ev.clientX < SIDE.closeBelow;
    document.body.classList.toggle("side-closed", closing);
    if (!closing) document.documentElement.style.setProperty("--side-w", `${sideWidth(ev.clientX)}px`);
  };
  const end = (ev) => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", end);
    grip.removeEventListener("pointercancel", end);
    document.body.classList.remove("side-dragging");
    if (ev.type === "pointercancel") { applySide(); return; }
    if (!moved) return;
    setSide(ev.clientX < SIDE.closeBelow ? { closed: true } : { closed: false, width: sideWidth(ev.clientX) });
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
});
$("sideGrip").addEventListener("dblclick", () => { if (!side.closed) setSide({ width: SIDE.width }); });

// ---------- the screen ----------
const style = await api("GET", "/terminals/style").catch(() => null);
applyChrome(style);
const firstFont = /^"([^"]+)"/.exec(style?.fontFamily ?? "")?.[1];
if (firstFont) await document.fonts.load(`${style.fontSize}px "${firstFont}"`).catch(() => undefined);
/** A link in the terminal, opened as iTerm does: ⌘-click (a plain click selects text). The Mac app opens web links
 *  in the browser and shows file links in Finder, never running them; a browser opens web links only. */
function openLink(event, uri) {
  if (!event.metaKey && !narrow.matches) return;
  if (native) native.postMessage({ type: "openURL", url: uri });
  else if (/^https?:\/\//i.test(uri)) window.open(uri, "_blank", "noopener");
}

/** A link's real target while the pointer is on it: an agent's link text can name one place and point at another. */
function showLinkTarget(uri) {
  let shown = uri;
  if (/^file:\/\//i.test(uri)) { try { shown = tilde(decodeURIComponent(new URL(uri).pathname)); } catch { /* as it is */ } }
  $("linkHint").textContent = narrow.matches ? shown : `⌘ Click · ${shown}`;
  $("linkHint").hidden = false;
}
const hideLinkTarget = () => { $("linkHint").hidden = true; };

const term = new Terminal({
  // OSC 8 links (the agents' status lines)
  linkHandler: { activate: openLink, hover: (_e, uri) => showLinkTarget(uri), leave: hideLinkTarget, allowNonHttpProtocols: true },
  fontFamily: style?.fontFamily ?? 'ui-monospace, "SF Mono", Menlo, "PingFang SC", monospace',
  fontSize: style?.fontSize ?? 13,
  lineHeight: style?.lineHeight ?? 1.2,
  letterSpacing: style?.letterSpacing ?? 0,
  theme: style?.theme,
  cursorBlink: true,
  scrollback: 10000,
  allowProposedApi: true,
  macOptionIsMeta: true,
  drawBoldTextInBrightColors: true,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new Unicode11Addon());
term.loadAddon(new WebLinksAddon(openLink, { hover: (_e, uri) => showLinkTarget(uri), leave: hideLinkTarget }));   // plain URLs in the text
term.unicode.activeVersion = "11";
// The DOM renderer on purpose: macOS draws the glyphs with its own text rendering, as in iTerm (WebGL drew them at
// twice the size on a Retina screen in testing).
if (!NATIVE) term.open($("screen"));
/** This screen's grid, for a terminal started or continued here. */
function gridHere() {
  if (NATIVE) return nativeGrid;
  fit.fit();
  return { cols: term.cols, rows: term.rows };
}
/** The keyboard to the terminal on screen. */
function focusScreen() {
  if (NATIVE) tellWindow("focus", { at: Date.now() });
  else term.focus();
}
/** A line of our own under the program's output (not the program's: a note such as "1 secret sealed"). */
function screenNote(text) {
  if (NATIVE) native.postMessage({ type: "note", text });
  else term.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
}

// Keystrokes go straight in, a few at a time, one request after another: typed text and named keys (Shift+Enter)
// reach the program in the order they were pressed.
let pendingKeys = "";
let keyTimer = null;
let sending = Promise.resolve();
const inOrder = (send) => { sending = sending.then(send).catch((e) => notify(e.message)); };
function flushKeys() {
  clearTimeout(keyTimer);
  keyTimer = null;
  if (!pendingKeys || !current) return;
  const data = pendingKeys, id = current.id;
  pendingKeys = "";
  inOrder(() => api("POST", `/terminals/${id}/write`, { data }));
}
function typed(data) {
  if (!current || current.status === "exited") return;
  pendingKeys += data;
  clearTimeout(keyTimer);
  keyTimer = setTimeout(flushKeys, 6);
}
term.onData(typed);
/** A key the service encodes as the program asked (keys.ts), after what was typed before it. */
function namedKey(name) {
  if (!current || current.status === "exited") return;
  flushKeys();
  const id = current.id;
  inOrder(() => api("POST", `/terminals/${id}/keys`, { keys: [name] }));
}
// The wheel over a program that scrolls itself (every agent's full screen: it tracks the mouse, or sits on the
// alternate screen). xterm turns wheel movement into notches at 30 % below 50 px an event, and WebKit (the Mac window)
// reports a slow wheel click as about 4 px, so clicks and gentle swipes sent nothing. As iTerm: a new movement is one
// notch at once, a continuing one a notch per two lines of travel; the service encodes them as the program asked
// (`/keys` wheel-up/down, as the phone). A plain screen keeps xterm's own scrolling through its history.
const WHEEL_GESTURE_GAP_MS = 120;
let wheelTravel = 0, wheelDir = 0, wheelLast = 0, wheelQueued = 0, wheelSending = false;
term.attachCustomWheelEventHandler((ev) => {
  if (ev.shiftKey || !current || current.status === "exited") return true;
  if (term.modes.mouseTrackingMode === "none" && term.buffer.active.type !== "alternate") return true;
  ev.preventDefault();
  if (ev.deltaY === 0) return false;
  const cell = $("screen").querySelector(".xterm-rows > div")?.getBoundingClientRect().height || 16;
  const px = ev.deltaMode === 1 ? ev.deltaY * cell : ev.deltaMode === 2 ? ev.deltaY * cell * term.rows : ev.deltaY;
  const now = performance.now();
  let notches = 0;
  if (now - wheelLast > WHEEL_GESTURE_GAP_MS || Math.sign(px) !== wheelDir) { wheelDir = Math.sign(px); wheelTravel = 0; notches = wheelDir; }
  else {
    wheelTravel += px;
    notches = Math.trunc(wheelTravel / (2 * cell));
    wheelTravel -= notches * 2 * cell;
  }
  wheelLast = now;
  if (notches) queueWheel(notches);
  return false;
});
/** Notches from the Mac window (up positive): to a program that scrolls itself, else through this screen's history. */
function wheelNotches(n) {
  const took = !n || !current || current.status === "exited" || creating ? "none"
    : term.modes.mouseTrackingMode === "none" && term.buffer.active.type !== "alternate" ? "history" : "program";
  if (took === "history") term.scrollLines(-3 * n);
  else if (took === "program") queueWheel(-n);
}
/** Notches (up negative, as deltaY) sent together, 20 at most a request. */
function queueWheel(n) {
  wheelQueued += n;
  if (wheelSending) return;
  wheelSending = true;
  const id = current.id;
  (async () => {
    while (wheelQueued !== 0 && current?.id === id) {
      const count = Math.min(20, Math.abs(wheelQueued));
      const key = wheelQueued < 0 ? "wheel-up" : "wheel-down";
      wheelQueued -= Math.sign(wheelQueued) * count;
      await api("POST", `/terminals/${id}/keys`, { keys: Array(count).fill(key) }).catch((e) => { native?.postMessage({ type: "log", text: `wheel keys failed: ${e.message}` }); notify(e.message); });
    }
    wheelQueued = 0;
    wheelSending = false;
  })();
}
// A page shortcut is not the terminal's: xterm leaves it, and the document's listener runs it (once). Shift+Enter is a
// new line in the agent's prompt: xterm would send it as a plain Enter, and the prompt would go.
const shiftEnter = (e) => e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing;
term.attachCustomKeyEventHandler((e) => {
  if (shiftEnter(e)) {
    if (e.type === "keydown") { e.preventDefault(); namedKey("shift-enter"); }
    return false;
  }
  return !(e.type === "keydown" && shortcut(e));
});

/** This window's size for terminal `id`: fit the screen and tell the service when it differs. True when it did (the
 *  size change makes the agent draw again). */
function fitTo(id) {
  if (NATIVE || current?.id !== id || creating || !mine()) return false;
  const before = [term.cols, term.rows];
  fit.fit();
  if (term.cols !== before[0] || term.rows !== before[1] || term.cols !== current.cols || term.rows !== current.rows) {
    api("POST", `/terminals/${id}/resize`, { cols: term.cols, rows: term.rows, screen: SCREEN }).catch(() => undefined);
    current.cols = term.cols;
    current.rows = term.rows;
    return true;
  }
  return false;
}

function fitAndTell() {
  if (NATIVE || !current || creating || !mine()) return;
  fit.fit();
  if (term.cols !== current.cols || term.rows !== current.rows) {
    api("POST", `/terminals/${current.id}/resize`, { cols: term.cols, rows: term.rows, screen: SCREEN }).catch(() => undefined);
    current.cols = term.cols;
    current.rows = term.rows;
  }
}
new ResizeObserver(() => { clearTimeout(fitAndTell.t); fitAndTell.t = setTimeout(fitAndTell, 80); }).observe($("stage"));
// One size for one terminal (terminal-v0 §1 "尺寸有主"): the service keeps whose it is. Typing, clicking, the
// placeholder's [ take over ] take it here; opening the terminal or coming back to the tab only when nobody has it (in use
// elsewhere, the placeholder says where). Only the owner sends its size as its layout changes. In the Mac window the
// native screen is the one that draws and owns: it tells the page where the terminal is in use, and the page draws the
// placeholder over it.
const SCREEN = `web-${Math.random().toString(36).slice(2, 10)}`;
let sizeOwner = null;      // who has the current terminal's size (its stream says)
let claimOnConnect = false;   // just opened here in use: taken once the stream says nobody has it
const mine = () => sizeOwner === SCREEN;
let nativeActive = null;   // the Mac window says when it is the key window (window.agentswitch.active)
function inUse() { return (nativeActive ?? document.hasFocus()) && !document.hidden; }
/** `active`: the user acts here (a key, a click) and takes it; else only a size nobody has. */
const reclaim = (active) => () => { if (NATIVE || !inUse()) return; if (mine()) fitAndTell(); else if (active || !sizeOwner) claim(); };
function claim() {
  if (!current || creating || current.status === "exited") return;
  if (NATIVE) { native.postMessage({ type: "claim" }); return; }
  fit.fit();
  sizeOwner = SCREEN;
  showAway(null);
  current.cols = term.cols;
  current.rows = term.rows;
  api("POST", `/terminals/${current.id}/resize`, { cols: term.cols, rows: term.rows, screen: SCREEN }).catch(() => undefined);
}
const WHERE = { mac: ["On Mac", "这个终端正在 Mac 上使用。"], iphone: ["On iPhone", "这个终端正在 iPhone 上使用。"], web: ["On Web", "这个终端正在浏览器中使用。"] };
const placeOf = (by) => (by.startsWith("phone") ? "iphone" : by.startsWith("mac") ? "mac" : "web");
/** The placeholder: glitches in; going (this screen took the size back), glitches once more and the screen is drawn in.
 *  Said again while going (the service confirming the claim), it goes on going. */
function showAway(place) {
  const el = $("away");
  if (!place) {
    if (el.hidden || !el.dataset.place) return;
    delete el.dataset.place;
    // Not seen (a window behind the others, whose timers WebKit slows): gone at once.
    if (reducedMotion.matches || document.hidden) { el.hidden = true; return; }
    glitch(el.querySelector(".away-box"));
    clearTimeout(showAway.leaving);
    showAway.leaving = setTimeout(() => { if (!el.dataset.place) { el.hidden = true; refreshWipe(); } }, 450);
    return;
  }
  clearTimeout(showAway.leaving);
  const [head, line] = WHERE[place] ?? WHERE.web;
  const same = !el.hidden && el.dataset.place === place;
  el.dataset.place = place;
  $("awayHead").textContent = head;
  $("awayLine").textContent = line;
  el.hidden = false;
  if (!same) glitch(el.querySelector(".away-box"));
}
$("away").addEventListener("mousedown", (e) => { e.preventDefault(); claim(); focusScreen(); });
addEventListener("focus", reclaim(false));
document.addEventListener("visibilitychange", () => { if (!document.hidden) reclaim(false)(); });
term.textarea?.addEventListener("keydown", reclaim(true), true);
$("screen").addEventListener("mousedown", reclaim(true), true);

// ---------- feedback: loading, notices, confirmations ----------
let loadingTimer = null;
function showLoading(text) {
  $("loadingText").textContent = text;
  $("loading").hidden = false;
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(hideLoading, 20000);
}
function hideLoading() {
  clearTimeout(loadingTimer);
  $("loading").hidden = true;
}

let noticeTimer = null;
function notify(message) {
  $("notice").textContent = message;
  $("notice").hidden = false;
  glitch($("notice"));
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 6000);
}

let sheetDone = null;
/** An in-page confirmation (the Mac window shows no alert or confirm): a sentence, and the action as a word. `folder`
 *  adds a folder line (`{value, options}`: full paths, the Mac's Choose… beside it; the action waits for a folder); its
 *  text comes back as `value`. */
function ask({ title, body, confirm, destructive = false, check = null, folder = null }) {
  $("sheetTitle").textContent = title;
  $("sheetBody").textContent = body;
  $("sheetConfirm").textContent = confirm;
  $("sheetConfirm").className = `btn pri ${destructive ? "danger" : ""}`;
  $("sheetCheck").hidden = !check;
  $("sheetCheckText").textContent = check ?? "";
  $("sheetCheckbox").checked = false;
  $("sheetField").hidden = !folder;
  $("sheetInput").value = folder?.value ?? "";
  // The folders offered, a line each under the field (shown with ~, put in it whole): a click puts one in it.
  const offers = [...new Set(folder?.options ?? [])];
  const markOffer = () => {
    for (const b of $("sheetOffers").children) b.classList.toggle("on", b.dataset.path === $("sheetInput").value.trim());
    $("sheetConfirm").disabled = Boolean(folder) && !$("sheetInput").value.trim();
  };
  $("sheetOffers").hidden = !offers.length;
  $("sheetOffers").replaceChildren(...offers.map((f) => h("button", { class: "offer", type: "button", title: f, "data-path": f,
    onclick: () => { $("sheetInput").value = f; markOffer(); $("sheetInput").focus(); } }, tilde(f))));
  $("sheetInput").oninput = markOffer;
  markOffer();
  $("sheet").hidden = false;
  if (folder) {
    // The field takes the keys (in the Mac window the terminal screen may hold them).
    native?.postMessage({ type: "focusPage" });
    $("sheetInput").focus();
    $("sheetInput").select();
  } else $("sheetConfirm").focus();
  return new Promise((resolve) => {
    const done = (ok) => {
      $("sheet").hidden = true;
      $("sheetConfirm").onclick = $("sheetCancel").onclick = null;
      sheetDone = null;
      resolve({ ok, checked: $("sheetCheckbox").checked, value: $("sheetInput").value.trim() });
      if (current && !creating) focusScreen();
    };
    sheetDone = done;
    $("sheetConfirm").onclick = () => done(true);
    $("sheetCancel").onclick = () => done(false);
  });
}

// ---------- selecting and following one terminal ----------
function select(id, { loading = null } = {}) {
  const t = terminals.find((x) => x.id === id);
  if (!t) return;
  closeStream();
  const moved = current?.id !== t.id;
  wipeNext ||= moved;
  // The composer belongs to the terminal it was opened for: what was typed there (it may be a secret) never goes on
  // to another one.
  if (moved) { $("composerText").value = ""; if (!narrow.matches) $("composer").hidden = true; }
  $("composerTo").textContent = `→ ${folderOf(t.workdir || t.cwd)}`;
  current = t;
  leaveCreate();
  lastSeq = 0;
  $("toasts").replaceChildren();
  document.body.classList.remove("list-open");
  renderSideBtn();
  if (loading) showLoading(loading); else hideLoading();
  sizeOwner = null;
  clearTimeout(showAway.leaving);
  $("away").hidden = true;
  delete $("away").dataset.place;
  if (NATIVE) {
    // The native screen follows this terminal and sizes it; the page only takes its events.
    follow(id);
  } else {
    term.reset();
    fit.fit();
    // Opened here while in use: the size is this page's once the stream says nobody else has it; else it follows and
    // the placeholder says where it is in use.
    claimOnConnect = inUse();
    follow(id);
  }
  render();
  focusScreen();
  remember("terminal.last", id);
}

function closeStream() {
  if (source) source.close();
  source = null;
}

/** Output that paints something (not just mode switches and cursor moves): the agent has drawn its screen. */
const paints = (data) => data.replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[\x20-\x2f]*[\x30-\x7e]|\s/g, "").length > 0;

function follow(id) {
  if (current?.id !== id || creating) return;   // switched again before the resize came back
  closeStream();
  // A native screen reads the stream itself, with its own id; this page then only takes the events.
  source = new EventSource(NATIVE ? `/terminals/${id}/stream` : `/terminals/${id}/stream?screen=${SCREEN}`);
  const on = (type, fn) => source.addEventListener(type, (e) => { if (current?.id === id) fn(JSON.parse(e.data)); });
  on("snapshot", (ev) => {
    if (NATIVE) { if (paints(ev.data)) hideLoading(); return; }
    term.reset();
    if (ev.cols !== term.cols || ev.rows !== term.rows) term.resize(ev.cols, ev.rows);
    term.write(ev.data);
    lastSeq = ev.seq;
    if (wipeNext) { wipeNext = false; refreshWipe(); }
    if (paints(ev.data)) hideLoading();
    // Drawn at the size it had (another window, the phone); now fit this window and have the agent redraw to it —
    // also when the size is the same, since a snapshot drops what the agent drew as links (its status line).
    setTimeout(() => { if (!fitTo(id) && current?.id === id && current.status !== "exited") api("POST", `/terminals/${id}/redraw`).catch(() => undefined); }, 0);
  });
  on("output", (ev) => {
    if (NATIVE) { if (!$("loading").hidden && paints(ev.data)) setTimeout(hideLoading, 120); return; }
    if (ev.seq <= lastSeq) return;
    term.write(ev.data);
    lastSeq = ev.seq;
    if (!$("loading").hidden && paints(ev.data)) setTimeout(hideLoading, 120);
  });
  on("resize", (ev) => {
    if (NATIVE) return;   // the native screen follows, and says where the terminal is in use
    if (claimOnConnect) {
      claimOnConnect = false;
      if (!ev.by || ev.by === SCREEN) { sizeOwner = ev.by ?? null; return claim(); }
    }
    sizeOwner = ev.by ?? null;
    if (mine()) return showAway(null);
    // Its owner left (or an older screen that says no name): the screen in use takes it back.
    if (!ev.by && inUse()) return claim();
    if (ev.cols !== term.cols || ev.rows !== term.rows) term.resize(ev.cols, ev.rows);
    showAway(ev.by ? placeOf(ev.by) : null);
  });
  on("status", (ev) => patch(id, { status: ev.status }));
  on("name", (ev) => patch(id, { name: ev.name }));
  on("exit", (ev) => { hideLoading(); patch(id, { status: "exited", exitCode: ev.code }); if (!NATIVE) term.write(`\r\n\x1b[2m[Exited · code ${ev.code ?? "?"}]\x1b[0m\r\n`); });
  on("permission", (ev) => addToast(id, ev.request, true));
  on("permission_resolved", (ev) => { document.getElementById(`perm-${ev.id}`)?.remove(); });
  // On each (re)connect, every request waiting: one answered elsewhere while this page was away goes.
  on("permissions", (ev) => {
    const waiting = new Set(ev.requests.map((r) => r.id));
    for (const el of $("toasts").querySelectorAll(`.toast[data-terminal="${id}"]`)) if (!waiting.has(el.dataset.id)) el.remove();
    for (const r of ev.requests) addToast(id, r);
  });
  on("removed", () => { closeStream(); current = null; refresh().then(afterRemoval); });
}

/** Another terminal's screen arrives: it is drawn in from the top, a scan line ahead of it (still under Reduce Motion). */
function refreshWipe() {
  if (reducedMotion.matches) return;
  for (const [el, cls] of [[$("screen"), "wipe"], [$("scan"), "run"]]) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
  }
}

/** A terminal's fields changed; one that starts waiting for the user, or ends with an error, flashes once. */
function patch(id, fields) {
  const t = terminals.find((x) => x.id === id);
  if (!t) return;
  const before = t.status;
  Object.assign(t, fields);
  render();
  const became = (s) => fields.status === s && before !== s;
  if (became("waiting") || (became("exited") && t.exitCode)) glitch(document.querySelector(`.row[data-id="${id}"]`));
}

function afterRemoval() {
  const next = terminalOrder[0] ?? terminals[0]?.id;
  if (next) select(next); else showCreate();
}

// ---------- permission requests ----------
function addToast(id, request, fresh = false) {
  if (document.getElementById(`perm-${request.id}`)) return;
  if (request.questions?.length) return addQuestion(id, request, fresh);
  const decide = (decision) => sendDecision(id, request.id, decision).finally(() => focusScreen());
  const raw_ = request.summary.startsWith(`${request.tool}: `) ? request.summary.slice(request.tool.length + 2) : request.summary;
  const cwd = terminals.find((t) => t.id === id)?.cwd;
  const detail = cwd && raw_.startsWith(cwd + "/") ? raw_.slice(cwd.length + 1) : tilde(raw_);
  const toast = h("div", { class: "toast box", id: `perm-${request.id}`, "data-id": request.id, "data-terminal": id },
    h("div", { class: "hd" }, h("span", {}, "[!] Approval"), h("span", { class: "grow" }), h("span", {}, TOOL_WORDS[request.tool] ?? request.tool)),
    h("code", {}, detail),
    cwd ? h("div", { class: "path" }, tilde(cwd)) : null,
    h("div", { class: "ft" },
      h("span", { class: "hint" }, terminals.find((t) => t.id === id)?.name ?? ""),
      h("button", { class: "btn", onclick: () => decide("deny") }, "[ Deny ", h("kbd", {}, "⌘⌫"), " ]"),
      h("button", { class: "btn pri", onclick: () => decide("allow") }, "[ Allow ", h("kbd", {}, "⌘↩"), " ]")));
  $("toasts").append(toast);
  if (fresh) glitch(toast);
}

// A question the agent asks (Claude Code's AskUserQuestion; terminal-v0 §3 "选择题", 2026-10-01, user: 能不能hook的更
// 精细，直接用这个框来选agent给的选项): each question with its options to pick — one (< > / <x>) or several ([ ] / [x]) —
// and Other to write in; [ Submit ] once each has an answer, which goes back to the agent as its own dialog would give
// it (that dialog closes). No allow / deny. Click into the card: numbers pick in the question in focus (its last number
// is Other), ↩ submits, esc gives the keyboard back to the screen. From the screen ⌘↩ submits, or hands the card the
// keyboard while an answer is missing.
function addQuestion(id, request, fresh) {
  const questions = request.questions;
  const picks = questions.map(() => ({ labels: [], other: "" }));
  const answered = (i) => picks[i].labels.length > 0 || picks[i].other.trim() !== "";
  const complete = () => questions.every((_, i) => answered(i));
  const markOf = (q, on) => (q.multiSelect ? (on ? "[x]" : "[ ]") : (on ? "<x>" : "< >"));
  const rows = questions.map(() => []);
  const fields = [];
  const submit = h("button", { class: "btn pri", disabled: true, onclick: () => submitAnswers() }, "[ Submit ", h("kbd", {}, "⌘↩"), " ]");
  const redraw = (i) => {
    for (const r of rows[i]) { const on = r.on(); r.el.classList.toggle("on", on); r.mk.textContent = markOf(questions[i], on); }
    submit.disabled = !complete();
  };
  const pick = (i, label) => {
    const p = picks[i];
    if (questions[i].multiSelect) p.labels = p.labels.includes(label) ? p.labels.filter((l) => l !== label) : [...p.labels, label];
    else { p.labels = [label]; p.other = ""; fields[i].value = ""; }
    redraw(i);
  };
  const blocks = questions.map((q, i) => {
    const options = q.options.map((o, n) => {
      const mk = h("span", { class: "mk" }, markOf(q, false));
      const el = h("button", { class: "opt", onclick: () => pick(i, o.label) },
        h("kbd", {}, String(n + 1)), mk, h("span", { class: "lb" }, o.label), o.description ? h("small", {}, o.description) : null);
      rows[i].push({ el, mk, on: () => picks[i].labels.includes(o.label) });
      return el;
    });
    // Writing in Other picks it: in place of the option picked (one), or beside them (several).
    const field = h("input", { placeholder: q.options.length ? "Other" : "Answer", spellcheck: "false", autocomplete: "off", oninput: () => {
      picks[i].other = field.value;
      if (!q.multiSelect && field.value.trim()) picks[i].labels = [];
      redraw(i);
    } });
    fields[i] = field;
    const mk = h("span", { class: "mk" }, markOf(q, false));
    const other = h("label", { class: "opt" }, h("kbd", {}, String(q.options.length + 1)), mk, field);
    rows[i].push({ el: other, mk, on: () => picks[i].other.trim() !== "" });
    return h("div", { class: "q", "data-q": String(i) }, q.header ? h("div", { class: "qh" }, `// ${q.header}`) : null, h("div", { class: "qt" }, q.question), options, other);
  });
  const toast = h("div", { class: "toast box ask", id: `perm-${request.id}`, "data-id": request.id, "data-terminal": id, tabindex: "-1" },
    h("div", { class: "hd" }, h("span", {}, "[?] Question")),
    h("div", { class: "qs" }, blocks),
    h("div", { class: "ft" }, h("span", { class: "hint" }, terminals.find((t) => t.id === id)?.name ?? ""), submit));
  let busy = false;
  async function submitAnswers() {
    if (busy || !complete()) return;
    busy = true;
    submit.disabled = true;
    const answers = Object.fromEntries(questions.map((q, i) => [q.question, { labels: picks[i].labels, ...(picks[i].other.trim() ? { other: picks[i].other.trim() } : {}) }]));
    try {
      const r = await api("POST", `/terminals/${id}/permissions/${request.id}`, { decision: "allow", answers });
      toast.remove();
      if (r.sealed) screenNote(`${r.sealed} ${r.sealed === 1 ? "secret" : "secrets"} sealed`);
      focusScreen();
    } catch (e) {
      // Answered already (in the terminal, on the phone) is no error: the card just goes.
      if (e.status === 404) { toast.remove(); focusScreen(); } else notify(e.message);
    }
    busy = false;
    submit.disabled = !complete();
  }
  // Where the keyboard goes in question i: its first option, else (words only) its field.
  const entry = (i) => (questions[i].options.length ? rows[i][0].el : fields[i]);
  const unanswered = () => Math.max(0, questions.findIndex((_, k) => !answered(k)));
  // ⌘↩ from the screen (shortcut()): submit, or the keyboard to the card while an answer is missing.
  toast.answer = () => (complete() ? submitAnswers() : entry(unanswered()).focus());
  toast.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const inField = e.target.tagName === "INPUT";
    if (e.key === "Enter") { e.preventDefault(); void submitAnswers(); return; }
    if (e.key === "Escape") {
      e.preventDefault();
      const i = Number(e.target.closest(".q")?.dataset.q);
      if (inField && questions[i]?.options.length) entry(i).focus(); else focusScreen();
      return;
    }
    if (inField || !/^[1-9]$/.test(e.key)) return;
    e.preventDefault();
    const at = e.target.closest?.(".q");
    const i = at ? Number(at.dataset.q) : unanswered();
    const n = Number(e.key);
    if (n <= questions[i].options.length) { pick(i, questions[i].options[n - 1].label); rows[i][n - 1].el.focus(); }
    else if (n === questions[i].options.length + 1) fields[i].focus();
  });
  $("toasts").append(toast);
  if (fresh) glitch(toast);
}

function decideFirst(decision) {
  const first = $("toasts").firstElementChild;
  if (!first || !current) return false;
  void sendDecision(current.id, first.dataset.id, decision);
  return true;
}

/** Answered already (on the phone, in the terminal itself) is no error: the card just goes. */
function sendDecision(id, requestId, decision) {
  return api("POST", `/terminals/${id}/permissions/${requestId}`, { decision }).catch((e) => {
    if (e.status === 404) document.getElementById(`perm-${requestId}`)?.remove();
    else notify(e.message);
  });
}

// ---------- the sidebar: a directory tree ----------
/** The folders with their terminals and sessions (lib/tree.js has the rules: a fixed order, each folder in the nearest
 *  folder above it that the list shows). */
const folderTree = () => buildTree(terminals, sessions);
/** A folder folded by its path; `parent:<path>` is how a folder that only gathered others was kept before 2026-10-03. */
const folded = (cwd) => collapsed.has(cwd) || collapsed.has(`parent:${cwd}`);

/** Terminals in the order they were opened: ⌘1–9 follow it, wherever the tree puts them (a new terminal in an earlier
 *  folder does not renumber the others). */
let terminalOrder = [];

/** A terminal's status mark: the spinner while busy, a square while idle or waiting, hollow once ended. */
function statusMark(t) {
  if (t.status === "working") return h("span", { class: "spin" }, SPIN[spinFrame]);
  if (t.status === "exited") return raw(sprite(HOLLOW, { px: 2 }), "sq-exited");
  return raw(sprite(SQUARE, { px: 2 }), t.status === "waiting" ? "sq-waiting blink" : "sq-idle");
}
const agentMark = (harness) => raw(sprite(AGENT_PX[harness] ?? AGENT_PX.pi, { px: 2 }), "agent-mark");

function terminalRow(t, tr, depth, name = t.name) {
  const index = terminalOrder.indexOf(t.id);
  const meta = t.status === "waiting" ? h("span", { class: "w" }, "Waiting")
    : t.status === "exited" ? (t.exitCode ? h("span", { class: "x" }, `Exit ${t.exitCode}`) : "Exited")
    : agentMark(t.harness);
  return h("div", { class: `row term ${t.status} ${current?.id === t.id && !creating ? "sel" : ""}`, "data-id": t.id, title: `${AGENT[t.harness]}${index < 9 ? ` · ⌘${index + 1}` : ""}`,
    onclick: () => select(t.id), ondblclick: () => startRename(t.id), oncontextmenu: (e) => { e.preventDefault(); showMenu(e, t); } },
    h("span", { class: "ix" }, index < 9 ? String(index + 1).padStart(2, "0") : ""),
    h("span", { class: "tr", style: `padding-left:${depth * 2}ch` }, tr),
    h("span", { class: "st" }, statusMark(t)),
    h("span", { class: `nm ${t.status === "exited" ? "dither" : ""}`, "data-rename": t.id }, name),
    h("span", { class: "mt" }, meta),
    h("span", { class: "ac" }, h("button", { title: "Close ⌘W", onclick: (e) => { e.stopPropagation(); closeTerminal(t); } }, "×")));
}

/** A terminal's sub-agents at work, one level under it (docs/terminal-v0.md §1): what each was sent to do, its kind and
 *  what it is doing now. A click opens the terminal. */
function subagentRows(t, tr, depth) {
  const subs = t.status === "exited" ? [] : t.subagents ?? [];
  const stem = tr === "└─" ? "\u00a0\u00a0" : "│\u00a0";
  return subs.map((a, k) => h("div", { class: "row sub", title: [a.type, a.doing].filter(Boolean).join(" · "), onclick: () => select(t.id) },
    h("span", { class: "ix" }),
    h("span", { class: "tr", style: `padding-left:${depth * 2}ch` }, `${stem}${k === subs.length - 1 ? "└─" : "├─"}`),
    h("span", { class: "st" }, h("span", { class: "spin" }, SPIN[spinFrame])),
    h("span", { class: "nm" }, a.name, a.doing ? h("i", {}, a.doing) : null),
    h("span", { class: "mt" }, a.type)));
}

function sessionRow(s, tr, depth, name = s.title || "(Untitled)") {
  const canResume = RESUMABLE.has(s.harness);
  const meta = opening === s.id ? "Opening" : s.active ? "Busy" : ago(s.updatedAt);
  return h("div", { class: `row session ${opening === s.id ? "opening" : ""}`, title: `${AGENT[s.harness] ?? s.harness} · ${tilde(s.cwd)}`, onclick: canResume ? () => resume(s) : null },
    h("span", { class: "ix" }),
    h("span", { class: "tr", style: `padding-left:${depth * 2}ch` }, tr),
    h("span", { class: "st" }),
    h("span", { class: "nm" }, name),
    h("span", { class: "mt" }, agentMark(s.harness), h("span", {}, meta)),
    h("span", { class: "ac" },
      canResume ? h("button", { class: "go", onclick: (e) => { e.stopPropagation(); resume(s); } }, "Resume") : null,
      // The service says whether a program still holds it (a session just written is not held by that alone).
      DELETABLE.has(s.harness) ? h("button", { class: "del", onclick: (e) => { e.stopPropagation(); deleteSession(s); } }, "Delete") : null));
}

/** Right-click on a terminal, with the shortcuts that do the same. */
function showMenu(e, t) {
  const item = (label, key, run, opts = {}) => h("button", { class: opts.danger ? "danger" : "", disabled: opts.disabled, onclick: () => { $("menu").hidden = true; run(); } },
    h("span", {}, label), key ? h("kbd", {}, key) : null);
  $("menu").replaceChildren(
    item("Rename", null, () => startRename(t.id)),
    item("Encrypt & Send…", "⌘⇧V", () => { select(t.id); openComposer(); }, { disabled: t.status === "exited" }),
    item("Close", "⌘W", () => closeTerminal(t), { danger: true }));
  $("menu").hidden = false;
  const r = $("menu").getBoundingClientRect();
  $("menu").style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  $("menu").style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
}

/** Deletes the agent's own record of a session (not one in use): it leaves the list and cannot be continued again. */
async function deleteSession(s) {
  const r = await ask({ title: `删除会话「${s.title || "无标题"}」？`, body: `将删除 ${AGENT[s.harness]} 保存的会话记录，此操作无法撤销。`, confirm: "Delete", destructive: true });
  if (!r.ok) return;
  try {
    await api("DELETE", `/sessions/${s.harness}/${encodeURIComponent(s.id)}`);
    sessions = sessions.filter((x) => !(x.harness === s.harness && x.id === s.id));
    renderSidebar();
  } catch (err) { notify(err.message); }
}

// ---------- search (docs/terminal-v0.md §1 搜索) ----------
/** What is typed in the list's search line; the sessions whose words matched (`harness:id` → the words around it),
 *  from the Mac, for the query `textFor`. */
let query = "";
let textHits = new Map();
let textFor = "";
let textTimer = null;
let textAsked = 0;

/** `text` with the first match of `q` marked. */
function marked(text, q) {
  const i = text.toLowerCase().indexOf(q);
  return i < 0 ? [text] : [text.slice(0, i), h("mark", {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

/** The words from a little before the match: the list is narrow, and the match must show. */
function near(text, q) {
  const i = text.toLowerCase().indexOf(q);
  return i > 10 ? `…${text.slice(i - 8).replace(/^…/, "")}` : text;
}

function searchFor(value) {
  query = value;
  renderSidebar();
  clearTimeout(textTimer);
  const q = value.trim();
  if (!q) { textHits = new Map(); textFor = ""; return; }
  // The words only the Mac has, once typing pauses; an answer to an older query is dropped.
  textTimer = setTimeout(async () => {
    const asked = ++textAsked;
    const r = await api("GET", `/sessions/search?q=${encodeURIComponent(q)}`).catch(() => null);
    if (asked !== textAsked || query.trim() !== q) return;
    textHits = new Map((r?.hits ?? []).map((x) => [`${x.harness}:${x.id}`, x.excerpt]));
    textFor = q.toLowerCase();
    renderSidebar();
  }, 250);
}

/** The tree with only what matches, in its own order and shape: a folder whose name matches with all it holds, else
 *  the terminals and sessions whose name or words match; a match in the words shows them under the row. */
function renderSearch(q) {
  const out = [];
  let folderHits = 0, titleHits = 0, textCount = 0;
  const words = (key) => (textFor === q ? textHits.get(key) : undefined);
  // Each folder with terminals or sessions of its own, named by the folders it sits in (Worktop/培训/靶场): a match on
  // a folder's name keeps every folder under it as well.
  for (const { folder: g, name: label } of everyFolder(folderTree())) {
    if (!g.own) continue;
    const nameHit = label.toLowerCase().includes(q) || tilde(g.cwd).toLowerCase().includes(q);
    const rows = [
      ...g.terminals.map((t) => ({ t, title: t.name.toLowerCase().includes(q), said: t.agentSessionId ? words(`${t.harness}:${t.agentSessionId}`) : undefined })),
      ...g.sessions.map((s) => ({ s, title: (s.title || "").toLowerCase().includes(q), said: words(`${s.harness}:${s.id}`) })),
    ].filter((r) => nameHit || r.title || r.said);
    if (!nameHit && !rows.length) continue;
    if (nameHit) folderHits++;
    out.push(h("div", { class: "dir", title: tilde(g.cwd) },
      h("span", { class: "chev" }, "▾"),
      h("span", { class: "name" }, ...marked(label, q), label.endsWith("/") ? "" : "/", gitMark(gits[g.cwd])),
      counts(g.terminals, g.sessions)));
    rows.forEach((r, i) => {
      const tr = i === rows.length - 1 ? "└─" : "├─";
      if (r.title) titleHits++;
      else if (r.said) textCount++;
      if (r.t) out.push(terminalRow(r.t, tr, 0, r.title ? marked(r.t.name, q) : r.t.name), ...subagentRows(r.t, tr, 0));
      else out.push(sessionRow(r.s, tr, 0, r.title ? marked(r.s.title, q) : r.s.title || "(Untitled)"));
      if (r.said && !r.title) {
        out.push(h("div", { class: "row hit", onclick: () => (r.t ? select(r.t.id) : RESUMABLE.has(r.s.harness) && resume(r.s)) },
          h("span", { class: "ix" }),
          h("span", { class: "tr" }, `${tr === "└─" ? "\u00a0\u00a0" : "│\u00a0"}└─`),
          h("span", { class: "st" }),
          h("span", { class: "nm" }, ...marked(near(r.said, q), q))));
      }
    });
  }
  if (!out.length) return [h("div", { class: "none" }, `没有找到与“${query.trim()}”相关的文件夹或会话。`)];
  const n = (k, one, many) => (k ? `${k} ${k === 1 ? one : many}` : "");
  const said = [n(folderHits, "folder", "folders"), n(titleHits, "title", "titles"), n(textCount, "in text", "in text")].filter(Boolean).join(" · ");
  return [h("div", { class: "found" }, said ? `// ${said}` : "//"), ...out];
}

function focusSearch() {
  if (narrow.matches) document.body.classList.add("list-open"); else if (side.closed) setSide({ closed: false });
  native?.postMessage({ type: "focusPage" });
  $("find").focus();
  $("find").select();
}

/** A terminal just started or continued shows in the list: its folder and every folder above it open. */
function unfold(cwd) {
  const keys = foldersAbove(cwd).flatMap((p) => [p, `parent:${p}`]).filter((k) => collapsed.has(k));
  if (!keys.length) return;
  for (const k of keys) collapsed.delete(k);
  remember("terminal.collapsed", JSON.stringify([...collapsed]));
}

/** After a folder's name: its branch, files changed, commits ahead and behind its upstream (docs/terminal-v0.md §1). */
let gits = {};
function gitMark(g) {
  if (!g) return null;
  const said = [g.branch, g.changed ? `±${g.changed}` : "", g.ahead ? `↑${g.ahead}` : "", g.behind ? `↓${g.behind}` : ""].filter(Boolean).join(" ");
  return h("i", { class: "git", title: `git: ${g.branch}${g.changed ? ` · ${g.changed} changed` : ""}${g.ahead ? ` · ${g.ahead} ahead` : ""}${g.behind ? ` · ${g.behind} behind` : ""}` }, said);
}

/** "▪2 5": running terminals (amber, blinking, while one waits for you — it may be folded away) · sessions, in the
 *  folder and the folders under it. */
function counts(ts, ss) {
  const live = ts.filter((t) => t.status !== "exited").length;
  const waiting = ts.some((t) => t.status === "waiting");
  return h("span", { class: "count" }, live ? h("b", { class: waiting ? "w blink" : "" }, `▪${live}`) : null, ss.length ? String(ss.length) : null);
}

function renderSidebar() {
  if (renaming) return;
  terminalOrder = [...terminals].sort((a, b) => a.createdAt - b.createdAt).map((t) => t.id);
  const q = query.trim().toLowerCase();
  if (q) { $("groups").replaceChildren(...renderSearch(q)); return; }
  const toggle = (cwd) => {
    if (folded(cwd)) { collapsed.delete(cwd); collapsed.delete(`parent:${cwd}`); } else collapsed.add(cwd);
    remember("terminal.collapsed", JSON.stringify([...collapsed]));
    renderSidebar();
  };
  // Any folder folds, the one with the terminal on screen too (its line is marked instead); folded terminals keep
  // their ⌘1–9.
  const holds = (ts) => (ts.some((t) => t.id === current?.id && !creating) ? "holds" : "");
  const out = [];
  // A folder's line, its own terminals and sessions, then the folders under it one step further in. A folder that
  // only gathers others has the quieter line.
  const renderFolder = (g, depth) => {
    const closed = folded(g.cwd);
    const ts = everyTerminal(g);
    out.push(h("div", { class: `dir ${g.own ? "" : "parent"} ${closed ? holds(ts) : ""}`, title: tilde(g.cwd), style: `padding-left:calc(10px + ${depth * 2}ch)`, onclick: () => toggle(g.cwd) },
      h("span", { class: "chev" }, closed ? "▸" : "▾"),
      h("span", { class: "name" }, slashed(g.label), gitMark(gits[g.cwd])),
      counts(ts, everySession(g)),
      h("button", { class: "add", title: "New Terminal Here", onclick: (e) => { e.stopPropagation(); showCreate(g.cwd); } }, "+")));
    if (closed) return;
    const all = expanded.has(g.cwd);
    const list = all ? g.sessions : g.sessions.slice(0, SESSIONS_SHOWN);
    const hidden = g.sessions.length - list.length;
    const more = g.sessions.length > SESSIONS_SHOWN;
    const n = g.terminals.length + list.length + (more ? 1 : 0);
    let i = 0;
    const tr = () => (++i === n ? "└─" : "├─");
    for (const t of g.terminals) {
      const twig = tr();
      out.push(terminalRow(t, twig, depth), ...subagentRows(t, twig, depth));
    }
    for (const s of list) out.push(sessionRow(s, tr(), depth));
    // ▸ opens the rest under it; ▴ folds them back up (2026-10-03, user: 这个图标也有问题吧，有点误导人 — ▾ under the
    // list read as a folder still to open).
    if (more) {
      out.push(h("div", { class: "row more", onclick: () => { if (all) expanded.delete(g.cwd); else expanded.add(g.cwd); renderSidebar(); } },
        h("span", { class: "ix" }), h("span", { class: "tr", style: `padding-left:${depth * 2}ch` }, tr()), h("span", { class: "st" }),
        h("span", { class: "nm" }, all ? "▴ Less" : `▸ ${hidden} More`)));
    }
    for (const c of g.children) renderFolder(c, depth + 1);
  };
  for (const g of folderTree()) renderFolder(g, 0);
  $("groups").replaceChildren(...(out.length ? out : [h("div", { class: "empty-note" }, "暂无会话。")]));
}

// ---------- the mark: how all the terminals are doing ----------
let markFrame = 0;
function markState() {
  const live = terminals.filter((t) => t.status !== "exited");
  const waiting = live.filter((t) => t.status === "waiting").length;
  if (waiting) return ["waiting", `${waiting} Waiting`];
  if (live.some((t) => t.status === "working")) return ["busy", "Busy"];
  return live.length ? ["idle", "Idle"] : ["off", ""];
}
function renderMark() {
  const [state, tag] = markState();
  // In the list's band, and in the top band while the list is closed.
  $("mark").innerHTML = mark({ px: 2, state, t: markFrame, depth: true });
  $("markTag").textContent = tag;
  tellWindow("mark", { state, tag });
  document.body.classList.toggle("any-waiting", state === "waiting");
}

/** The sealed reply's bar under the terminal: while one is on screen and running (the composer opens above it). */
function renderSeal() {
  $("sealBar").hidden = !current || creating || current.status === "exited";
  if ($("sealBar").hidden && !narrow.matches) { $("composer").hidden = true; $("composerText").value = ""; }
}

function renderHead() {
  const t = current;
  const create = !t || creating;
  // The title: the folder the agent works in now and its git (docs/terminal-v0.md §1, 2026-10-01), as its own status
  // line says it; the terminal's name stays on its row in the list and in the tooltip.
  const where = create ? "" : folderOf(t.workdir || t.cwd);
  const g = create ? null : gits[t.workdir || t.cwd];
  const git = g ? [g.branch, g.changed ? `±${g.changed}` : "", g.ahead ? `↑${g.ahead}` : "", g.behind ? `↓${g.behind}` : ""].filter(Boolean).join(" ") : "";
  $("bandName").replaceChildren(create ? "New Terminal" : where, git ? h("i", { class: "git" }, git) : "");
  $("bandName").title = create ? "" : `${t.name} · ${tilde(t.workdir || t.cwd)}`;
  const word = create ? "" : STATUS_WORDS[t.status] ?? t.status;
  $("bandStatus").className = `band-status ${create ? "" : t.status}`;
  $("bandStatus").textContent = word;
  document.title = create ? "New Terminal" : `${where} — ${t.name}`;
  // The Mac window's toolbar: the same title (none while one is being made), and where the screen is, so the window
  // can hand the wheel over it to the page.
  tellWindow("head", { name: where, git, path: create ? "" : tilde(t.workdir || t.cwd), terminal: create ? "" : t.name, status: create ? null : t.status });
  tellScreen();
}
function tellScreen() {
  const r = $("screen").getBoundingClientRect();
  const area = [r.x, r.y, r.width, r.height].map(Math.round);
  const cell = $("screen").querySelector(".xterm-rows > div")?.getBoundingClientRect().height || 16;
  // The native screen shows `id` in `rect` (none while a terminal is being made); `area` is where it would be.
  tellWindow("screen", !current || creating ? { rect: null, area, id: null } : { rect: area, area, id: current.id, cwd: current.workdir || current.cwd, cell: Math.round(cell * 10) / 10 });
}
/** What floats over the screen (permission requests, the composer, the loading line, a sheet): the native screen under
 *  the page leaves clicks there to the page. */
function tellOverlays() {
  if (!NATIVE) return;
  const shown = (el) => el && !el.hidden && el.getClientRects().length > 0;
  const els = [$("away"), ...document.querySelectorAll("#toasts .toast"), $("composer"), $("loading"), $("sheet")].filter(shown);
  tellWindow("overlays", { rects: els.map((el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); }) });
}

function render() {
  renderSidebar();
  renderHead();
  renderSeal();
  renderMark();
}

// ---------- new terminal, continuing a session ----------
let stopReveal = () => undefined;
let flashAgent = null;       // the agent just chosen: its tile flashes once
function leaveCreate() {
  creating = false;
  $("create").hidden = true;
  stopReveal();
}

function showCreate(folder = null) {
  closeStream();
  hideLoading();
  const first = $("create").hidden;
  creating = true;
  $("create").hidden = false;
  if (first) { stopReveal(); stopReveal = revealWordmark($("wordmark"), "AGENTSWITCH", { px: 6 }); }
  $("toasts").replaceChildren();
  document.body.classList.remove("list-open");
  renderSideBtn();
  if (!agents.includes(pickedAgent)) pickedAgent = agents[0] ?? "claude-code";
  $("agents").replaceChildren(...AGENTS.map((a) => {
    const installed = agents.includes(a.id);
    return h("button", { class: `agent ${pickedAgent === a.id ? "on" : ""}`, "data-agent": a.id, disabled: !installed,
      onclick: () => { if (pickedAgent !== a.id) flashAgent = a.id; pickedAgent = a.id; showCreate($("cwd").value); } },
      raw(sprite(AGENT_PX[a.id], { px: 4 })), h("span", {}, a.name), installed ? null : h("small", {}, "Not Installed"));
  }));
  if (flashAgent) { glitch($("agents").querySelector(`[data-agent="${flashAgent}"]`)); flashAgent = null; }
  const list = models[pickedAgent] ?? [];
  const chosen = list.some((m) => m.id === pickedModels[pickedAgent]) ? pickedModels[pickedAgent] : "";
  // The current models, then the ones a newer model superseded folded under `older` (as the agent's own picker).
  const option = (m) => h("option", { value: m.id, title: m.description ?? "" }, list.filter((x) => x.name === m.name).length > 1 ? `${m.name} · ${m.id}` : m.name);
  const older = list.filter((m) => m.older);
  $("model").replaceChildren(h("option", { value: "" }, modelDefaults[pickedAgent] ? `Default · ${modelDefaults[pickedAgent]}` : "Default"),
    ...list.filter((m) => !m.older).map(option), ...(older.length ? [h("optgroup", { label: "Older" }, ...older.map(option))] : []));
  $("model").value = chosen;
  $("model").disabled = list.length === 0;
  // one of three: angle-bracket marks (< > / <x>), not checkboxes ([ ] / [x] are for picking several)
  $("modes").replaceChildren(...MODES.map((m) => h("button", { class: pickedMode === m.id ? "on" : "", onclick: () => { pickedMode = m.id; remember("terminal.mode", m.id); showCreate($("cwd").value); } },
    `${pickedMode === m.id ? "<x>" : "< >"} ${m.name}`)));
  if (folder) $("cwd").value = tilde(folder);
  const folders = [...new Set([...terminals.map((t) => t.cwd), ...sessions.map((s) => s.cwd)].map(tilde))].slice(0, 30);
  $("folders").replaceChildren(...folders.map((f) => h("option", { value: f })));
  $("createCancel").hidden = !current;
  $("createError").textContent = "";
  render();
  $("createStart").focus();
}

async function start() {
  if ($("createStart").disabled) return;
  const cwd = $("cwd").value.trim();
  if (!cwd) { $("createError").textContent = "请填写文件夹。"; return; }
  $("createStart").disabled = true;
  try {
    const grid = gridHere();
    const model = $("model").value;
    const { terminal } = await api("POST", "/terminals", { harness: pickedAgent, cwd, mode: pickedMode, ...(model ? { model } : {}), ...grid });
    remember("terminal.agent", pickedAgent);
    remember("terminal.cwd", cwd);
    unfold(terminal.cwd);
    await refresh();
    select(terminal.id, { loading: `Starting ${AGENT[pickedAgent]}` });
  } catch (err) {
    $("createError").textContent = err.message;
    glitch($("createError"));
  } finally {
    $("createStart").disabled = false;
  }
}

async function resume(s) {
  if (!RESUMABLE.has(s.harness) || opening) return;
  // Already continued here: go to that terminal rather than making a second copy.
  const open = terminals.find((t) => t.status !== "exited" && (t.resumedFrom === s.id || t.agentSessionId === s.id));
  if (open) { select(open.id); return; }
  const name = s.title || "会话";
  if (!CHECKED.has(s.harness) && s.active) {
    const r = await ask({ title: `继续「${name}」？`, body: "此会话可能正在其他终端中运行。OpenCode 不支持分叉，继续将写入同一会话。", confirm: "Resume" });
    if (!r.ok) return;
  }
  opening = s.id;
  leaveCreate();
  closeStream();
  current = null;
  render();
  $("bandName").textContent = name;
  term.reset();
  showLoading(`Opening 「${name}」`);
  const cancelled = () => Object.assign(new Error(""), { cancelled: true });
  try {
    let body = { harness: s.harness, cwd: s.cwd, agentSessionId: s.id, ...(s.title ? { title: s.title } : {}), mode: s.mode ?? pickedMode, ...gridHere() };
    let r = null;
    let gone0 = null;   // the first answer that its folder is gone: the folder it ran in, and what the Mac offered
    while (!r) {
      try {
        r = await api("POST", "/terminals/resume", body);
      } catch (err) {
        const where = err.body?.elsewhere;
        const gone = err.body?.folderGone;
        if (where && !body.fork) {
          // Open in another program (iTerm, Codex's app): one writer at a time, else the two records part ways.
          hideLoading();
          const app = where.app ?? "其他程序";
          const answer = await ask({ title: `「${name}」正在 ${app} 中运行`,
            body: `同一会话同时只能由一个程序写入，否则记录会分叉。请先在 ${app} 中退出该会话后再继续，或创建分支：新会话包含全部历史，原会话保持不变。`,
            confirm: "Fork" });
          if (!answer.ok) throw cancelled();
          body = { ...body, fork: true, cols: term.cols, rows: term.rows };
        } else if (gone) {
          // Its folder was moved, renamed or deleted: it goes on in a folder picked here (docs/terminal-v0.md §5,
          // 2026-10-03, user: 如果会话没了选择新目录继续). Offered: folders of the same name the Mac knows (the first
          // put in the field), then the nearest folder above the old one still there (only offered: one Enter away it
          // would move the session into a folder too wide). A picked folder that is missing too is said, the field
          // keeping it to mend.
          hideLoading();
          gone0 ??= err.body;
          const again = gone !== gone0.folderGone;
          const offered = [...(gone0.alike ?? []), ...(gone0.near ? [gone0.near] : [])];
          const picked = await ask({ title: `「${name}」的文件夹已不存在`,
            body: `这段会话原来在 ${tilde(gone0.folderGone)}，该文件夹可能已被移动、改名或删除。${again ? `所选的 ${tilde(gone)} 也不存在。` : ""}请选择一个文件夹，会话将在那里继续。`,
            confirm: "Resume", folder: { value: again ? gone : (gone0.alike?.[0] ?? ""), options: offered } });
          if (!picked.ok || !picked.value) throw cancelled();
          body = { ...body, cwd: picked.value };
        } else throw err;
        showLoading(`Opening 「${name}」`);
      }
    }
    unfold(r.terminal.cwd);
    await refresh();
    opening = null;
    select(r.terminal.id, r.existing ? {} : { loading: `Opening 「${name}」` });
  } catch (err) {
    opening = null;
    hideLoading();
    if (!err.cancelled) notify(`无法继续「${name}」：${err.message}`);
    if (terminalOrder[0]) select(terminalOrder[0]); else showCreate();
  }
}

// ---------- rename, close, delete ----------
function startRename(id) {
  const t = terminals.find((x) => x.id === id);
  const cell = document.querySelector(`[data-rename="${id}"]`);
  if (!t || !cell) return;
  const input = h("input", { class: "rename", value: t.name, spellcheck: "false" });
  let done = false;
  renaming = true;
  const finish = async (save) => {
    if (done) return;
    done = true;
    renaming = false;
    if (save && input.value.trim() !== t.name) {
      const r = await api("PATCH", `/terminals/${id}`, { name: input.value }).catch((e) => notify(e.message));
      if (r?.terminal) patch(id, { name: r.terminal.name });
    }
    render();
    focusScreen();
  };
  input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  cell.replaceWith(input);
  input.focus();
  input.select();
}

/** Closing a terminal ends its program and takes it off the list; the agent's own record stays, so the session can be
 *  continued later. An ended one goes at once; a running one asks first. */
async function closeTerminal(t) {
  if (!t) return;
  let transcript = false;
  if (t.status !== "exited") {
    // Only a record this terminal started can go with it; one it went on writing is the user's original session.
    const own = t.agentSessionId && t.harness === "claude-code" && (!t.resumedFrom || t.forked);
    const r = await ask({ title: `关闭「${t.name}」？`, body: `将结束 ${AGENT[t.harness]} 进程。会话记录保留，可稍后继续。`, confirm: "Close", destructive: true,
      check: own ? "同时删除会话记录（无法恢复）" : null });
    if (!r.ok) return;
    transcript = r.checked;
  }
  await api("DELETE", `/terminals/${t.id}${transcript ? "?transcript=1" : ""}`).catch((e) => notify(e.message));
  if (current?.id !== t.id) refresh();
}

// ---------- sealed composer ----------
/** The composer opens as a box over the terminal's foot (flashing once: the user opened it) and closes on esc or send. */
function openComposer() {
  if (!current || current.status === "exited" || creating) return;
  $("composerTo").textContent = `→ ${folderOf(current.workdir || current.cwd)}`;
  if ($("composer").hidden) { $("composer").hidden = false; if (!narrow.matches) glitch($("composer")); }
  $("composerText").focus();
}
function closeComposer() {
  if (narrow.matches) return;
  $("composer").hidden = true;
  $("composerText").value = "";
  focusScreen();
}
async function sendComposer() {
  const text = $("composerText").value;
  if (!current || !text.trim()) return;
  $("composerSend").disabled = true;
  try {
    const r = await api("POST", `/terminals/${current.id}/input`, { text });
    $("composerText").value = "";
    if (r.sealed) screenNote(`${r.sealed} ${r.sealed === 1 ? "secret" : "secrets"} sealed`);
    closeComposer();
  } catch (err) { notify(err.message); }
  $("composerSend").disabled = false;
}

// ---------- keyboard ----------
/** The page's own shortcut for a key, to run, or null: only asks, so the terminal's key handler can too. */
function shortcut(e) {
  if (!e.metaKey) return null;
  const key = e.key.toLowerCase();
  const asking = $("toasts").childElementCount > 0 && current;
  // A question is answered, not allowed or denied (addQuestion): ⌘↩ submits it, ⌘⌫ does nothing to it.
  const first = $("toasts").firstElementChild;
  const question = asking && first?.classList.contains("ask");
  if (key === "t" && !e.shiftKey) return () => showCreate();
  if (key === "b" && !e.shiftKey) return toggleList;
  if (key === "f" && !e.shiftKey) return focusSearch;
  if (key === "w" && !e.shiftKey && current && !creating) return () => closeTerminal(current);
  if (key === "v" && e.shiftKey) return () => openComposer();
  if (e.key === "Enter" && asking) return question ? () => first.answer() : () => decideFirst("allow");
  if (e.key === "Backspace" && asking && !question) return () => decideFirst("deny");
  const n = /^[1-9]$/.test(e.key) ? terminalOrder[Number(e.key) - 1] : null;
  if (n) return () => select(n);
  return null;
}
document.addEventListener("keydown", (e) => {
  if (sheetDone) {
    // Enter that ends a word in an input method (Pinyin) is the input method's.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") { e.preventDefault(); sheetDone(false); }
    else if (e.key === "Enter") { e.preventDefault(); if (!$("sheetConfirm").disabled) sheetDone(true); }
    return;
  }
  if (e.target === $("find")) {
    if (e.key === "Escape") { e.preventDefault(); $("find").value = ""; searchFor(""); $("find").blur(); return; }
    if (!e.metaKey) return;
  }
  if (e.target === $("composerText")) {
    if (e.key === "Escape") { e.preventDefault(); closeComposer(); }
    else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendComposer(); }
    return;
  }
  if (creating && e.key === "Enter" && !e.isComposing && e.target.tagName !== "BUTTON") { e.preventDefault(); start(); return; }
  if (creating && e.key === "Escape" && current) { select(current.id); return; }
  const run = shortcut(e);
  if (run) { e.preventDefault(); run(); }
});

// ---------- wiring ----------
$("sealLock").innerHTML = sprite(LOCK, { px: 2 });
$("composerLock").innerHTML = sprite(LOCK, { px: 2 });
$("newBtn").addEventListener("click", () => showCreate());
$("sealBar").addEventListener("click", () => ($("composer").hidden ? openComposer() : closeComposer()));
$("sideBtn").addEventListener("click", toggleList);
$("find").addEventListener("input", () => searchFor($("find").value));
$("createStart").addEventListener("click", start);
$("model").addEventListener("change", () => { pickedModels[pickedAgent] = $("model").value; remember("terminal.models", JSON.stringify(pickedModels)); });
$("createCancel").addEventListener("click", () => current && select(current.id));
document.addEventListener("mousedown", (e) => { if (!$("menu").hidden && !$("menu").contains(e.target)) $("menu").hidden = true; });
window.addEventListener("blur", () => { $("menu").hidden = true; });
$("composerSend").addEventListener("click", sendComposer);
$("keys").addEventListener("click", (e) => {
  const key = e.target.closest("button")?.dataset.key;
  if (key && current) api("POST", `/terminals/${current.id}/keys`, { keys: [key] }).catch((err) => notify(err.message));
});
const dock = () => { $("composer").hidden = !narrow.matches; renderSeal(); };
narrow.addEventListener("change", () => { dock(); renderSideBtn(); });

// The Mac app picks folders with its own open panel.
if (native) {
  // The window's drag strip lies over the top bar: it leaves the bar's controls to the page.
  new ResizeObserver(tellScreen).observe($("screen"));
  $("chooseFolder").hidden = false;
  $("chooseFolder").addEventListener("click", () => native.postMessage({ type: "chooseFolder", path: $("cwd").value }));
  $("sheetChoose").hidden = false;
  $("sheetChoose").addEventListener("click", () => native.postMessage({ type: "chooseFolder", path: $("sheetInput").value }));
  if (NATIVE) {
    new MutationObserver(tellOverlays).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "style"] });
    addEventListener("resize", tellOverlays);
  }
  window.agentswitch = {
    folderChosen: (path) => {
      // For the folder line of the box open now (a session whose folder is gone), else for the new terminal.
      if (sheetDone && !$("sheetField").hidden) {
        $("sheetInput").value = path;
        $("sheetInput").dispatchEvent(new Event("input"));
        $("sheetConfirm").focus();
        return;
      }
      $("cwd").value = tilde(path);
      $("createStart").focus();
    },
    // ⌘W, ⌘T, ⌘B, ⌘1–9, ⌘⇧V, ⌘↩ / ⌘⌫ on a request, as the window hands them over (a menu would take them first).
    shortcut: (key, shift = false) => { const run = shortcut({ metaKey: true, shiftKey: shift, key }); run?.(); return !!run; },
    // The grid the native screen fits at its size.
    grid: (cols, rows) => { nativeGrid = { cols, rows }; },
    // ⌘A: the terminal's own selection when it has the keyboard, else the field in focus.
    selectAll: () => (document.activeElement === term.textarea ? term.selectAll() : document.execCommand("selectAll")),
    // The window became the key window, or stopped being it (the screen in use sets the size).
    active: (on) => { nativeActive = on; },
    // Where the terminal is in use when not here ("mac", "iphone", "web"), or null: the placeholder over the screen.
    away: (place) => showAway(place),
    // The toolbar's buttons.
    toggleList: () => toggleList(),
    newTerminal: () => showCreate(),
    // The wheel over the screen, as notches (up positive): the window takes it, WebKit gives the page none there.
    wheel: (n) => wheelNotches(n),
    // One terminal on screen (the menu bar's Live Activity card): the list read again first, it may be new.
    show: async (id) => { await refresh(); if (terminals.some((t) => t.id === id)) select(id); },
  };
}

// The busy spinner and the mark move in steps; with Reduce Motion they hold still, and nothing moves while the page is
// out of sight: another page of the Mac window, a closed or hidden window, a background tab (2026-10-03, user: 是不是
// 还得优化一下 cpu/gpu 占用).
const still = () => reducedMotion.matches || document.hidden;
let spinFrame = 0;
setInterval(() => {
  if (still()) return;
  spinFrame = (spinFrame + 1) % SPIN.length;
  for (const el of document.querySelectorAll(".spin")) el.textContent = SPIN[spinFrame];
}, 90);
// Busy rows flicker now and then, each on its own beat: every second one in five does, about every 3–7 s (ui-v0
// §7.2.9, 2026-10-01, user: 正在运行中的都改成这个效果).
setInterval(() => {
  if (document.hidden) return;
  for (const el of document.querySelectorAll(".row.term.working")) if (Math.random() < 0.2) flicker(el);
}, 1000);
setInterval(() => {
  if (still() || ["idle", "off"].includes(markState()[0])) return;
  markFrame++;
  renderMark();
}, 140);

async function refresh() {
  const r = await api("GET", "/terminals").catch(() => null);
  if (!r) return;
  const before = new Map(terminals.map((t) => [t.id, t.status]));
  terminals = r.terminals;
  agents = r.agents ?? agents;
  models = r.models ?? models;
  modelDefaults = r.defaults ?? modelDefaults;
  if (current) current = terminals.find((t) => t.id === current.id) ?? null;
  render();
  for (const t of terminals) {
    const was = before.get(t.id);
    if (was && was !== t.status && (t.status === "waiting" || (t.status === "exited" && t.exitCode))) glitch(document.querySelector(`.row[data-id="${t.id}"]`));
  }
  if (current) for (const p of current.permissions) addToast(current.id, p);
}

async function refreshGit() {
  const r = await api("GET", "/folders/git").catch(() => null);
  if (!r || JSON.stringify(r.folders) === JSON.stringify(gits)) return;
  gits = r.folders;
  renderSidebar();
  renderHead();
}

async function refreshSessions() {
  // Every session the Mac lists: each folder whole (docs/terminal-v0.md §4).
  const r = await api("GET", "/sessions").catch(() => null);
  sessions = r?.sessions ?? [];
  renderSidebar();
}

// ---------- start ----------
dock();
const workdir = await api("GET", "/settings/workdir").catch(() => null);
if (!MODES.some((m) => m.id === pickedMode)) {
  const policy = await api("GET", "/approvals/policy").catch(() => null);
  pickedMode = MODE_FROM_POLICY[policy?.policy?.mode] ?? "manual";
}
$("cwd").value = recall("terminal.cwd") || (workdir?.path ? tilde(workdir.path) : "~");
await refresh();
await refreshSessions();
void refreshGit();
const wanted = new URLSearchParams(location.search).get("id") || recall("terminal.last");
if (wanted && terminals.some((t) => t.id === wanted)) select(wanted);
else if (terminalOrder[0]) select(terminalOrder[0]);
else showCreate();
// Out of sight the list is not asked for; it is read again as the page comes back.
setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
setInterval(() => { if (!document.hidden) void refreshSessions(); }, 20000);
setInterval(() => { if (!document.hidden) void refreshGit(); }, 5000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  void refresh();
  void refreshSessions();
  void refreshGit();
});
