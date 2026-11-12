/** The web console's Files column (docs/files-v0.md §14, 2026-11-12; user: 能不能直接扩展现有的文件栏功能 支持到linux的
 *  网页控制台): what the Mac's column is, drawn by the terminal page for a node with no window of its own — a tree of
 *  the folder a terminal works in, a preview of the file selected, the keys. Read only: it lists, previews and
 *  downloads through the service's `/files…` routes and runs nothing. The rules are lib/filesTree.js; this file draws.
 *
 *  `filesColumn({ el, h, tip, onLayout, onLeave })`: `el` the column's element, `h` the page's element maker, `tip` a
 *  tooltip as the look writes it, `onLayout` called when the column's width changes (the terminal refits), `onLeave`
 *  when the keys go back to the terminal (esc). */

import { crumbs, isFolder, joinPath, leftOf, moved, parentOf, previewKind, refusalWords, rowsOf, sizeWord, SORTS, within } from "/ui/lib/filesTree.js";

const KEEP = "terminal.files";
const WIDTH = { fallback: 340, min: 240, max: 720 };
/** An open column asks again this often (an unchanged folder answers 304). */
const POLL_MS = 4000;
const SORT_WORDS = { name: "Name", modified: "Date Modified" };
const TYPE_WORDS = { pdf: "PDF", audio: "Audio", video: "Video", archive: "Archive", binary: "Binary", image: "Image", text: "Text" };

const remember = (v) => { try { localStorage.setItem(KEEP, JSON.stringify(v)); } catch { /* private window */ } };
const recall = () => { try { return JSON.parse(localStorage.getItem(KEEP) || "{}") || {}; } catch { return {}; } };

/** Age as a unit, as the list's rows have it: Now, 5m, 3h, 2d, then the date. */
function age(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "Now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d`;
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const query = (path, more = "") => `?path=${encodeURIComponent(path)}${more}`;

export function filesColumn({ el, h, tip = (t) => t, onLayout = () => {}, onLeave = () => {} }) {
  const kept = recall();
  const s = {
    open: false,
    width: Number.isFinite(kept.width) ? kept.width : WIDTH.fallback,
    order: SORTS.includes(kept.order) ? kept.order : "name",
    hidden: kept.hidden === true,
    root: null, home: "", levels: {}, etags: {}, expanded: new Set(), selected: null,
    problem: null, details: null, preview: null, typed: "", typedAt: 0, asked: 0, timer: null,
  };
  const keep = () => remember({ width: s.width, order: s.order, hidden: s.hidden });
  const rows = () => (s.root ? rowsOf(s.root, s.levels, s.expanded, { order: s.order, hidden: s.hidden }) : []);
  const widthNow = () => Math.round(Math.max(WIDTH.min, Math.min(s.width, WIDTH.max, innerWidth - 420)));

  // ---------- the service ----------
  /** One folder's level, or `{ same: true }` when it has not changed since it was read; throws what the service said. */
  async function level(path) {
    const res = await fetch(`/files${query(path, "&hidden=1")}`, { headers: s.etags[path] && s.levels[path] ? { "if-none-match": s.etags[path] } : {} });
    if (res.status === 304) return { same: true };
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { refusal: json.error, status: res.status });
    const tag = res.headers.get("etag");
    if (tag) s.etags[path] = tag;
    return json;
  }

  /** Reads `path` into the tree; true when what is shown changed. A folder that is gone leaves the tree. */
  async function read(path) {
    try {
      const got = await level(path);
      if (got.same) return false;
      // The folder as the service names it (`~/x` asked, `/Users/u/x` answered) is the one the tree keeps.
      s.levels[got.path] = got;
      if (got.path !== path) s.etags[got.path] = s.etags[path];
      if (got.home) s.home = got.home;
      return true;
    } catch (err) {
      if (path === s.root) { s.problem = refusalWords(err.refusal); return true; }
      const had = s.expanded.delete(path);
      delete s.levels[path];
      return had;
    }
  }

  /** The tree goes to `folder` (the home folder when none is named). */
  async function go(folder) {
    const asked = ++s.asked;
    let got;
    try { got = await level(folder ?? ""); } catch (err) {
      if (asked !== s.asked) return;
      // A folder that cannot be shown leaves the tree where it was, with the reason; nothing shown yet: the reason alone.
      s.problem = refusalWords(err.refusal);
      if (!s.root && folder) s.root = folder;
      draw();
      return;
    }
    if (asked !== s.asked || got.same) return;
    s.root = got.path;
    s.home = got.home || s.home;
    s.levels = { [got.path]: got };
    s.etags = {};
    s.expanded = new Set([...s.expanded].filter((p) => within(p, got.path) && p !== got.path));
    s.problem = null;
    if (s.selected && !within(s.selected, got.path)) select(null);
    draw();
    await Promise.all([...s.expanded].map(read));
    if (asked === s.asked) draw();
  }

  async function refresh() {
    if (!s.open || !s.root || document.hidden) return;
    const changed = await Promise.all([s.root, ...s.expanded].map(read));
    if (changed.some(Boolean)) draw();
  }

  async function twist(path) {
    if (s.expanded.has(path)) { s.expanded.delete(path); draw(); return; }
    s.expanded.add(path);
    draw();
    await read(path);
    draw();
  }

  // ---------- the selection and its preview ----------
  function select(path) {
    if (s.selected === path) return;
    s.selected = path;
    s.details = null;
    s.preview = null;
    if (path) describe(path);
  }

  async function describe(path) {
    try {
      const res = await fetch(`/files/stat${query(path)}`);
      const details = await res.json().catch(() => ({}));
      if (s.selected !== path) return;
      if (!res.ok) { s.details = { path, refused: refusalWords(details.error) }; drawPreview(); return; }
      s.details = details;
      drawPreview();
      if (previewKind(details) !== "text") return;
      const text = await fetch(`/files/preview${query(path)}`);
      const preview = await text.json().catch(() => ({}));
      if (s.selected !== path) return;
      s.preview = text.ok ? preview : { text: "", refused: refusalWords(preview.error) };
      drawPreview();
    } catch {
      if (s.selected !== path) return;
      s.details = { path, refused: "无法连接到服务。" };
      drawPreview();
    }
  }

  // ---------- drawing ----------
  const list = h("div", { class: "files-list", tabindex: "0", role: "tree", "aria-label": "Files" });
  const pathLine = h("div", { class: "files-path" });
  const note = h("div", { class: "files-note", hidden: true });
  const preview = h("div", { class: "files-preview", hidden: true });
  const sortBtn = h("button", { class: "files-btn", type: "button", onclick: () => { s.order = SORTS[(SORTS.indexOf(s.order) + 1) % SORTS.length]; keep(); draw(); } });
  const hiddenBtn = h("button", { class: "files-btn", type: "button", onclick: () => { s.hidden = !s.hidden; keep(); draw(); } }, ".*");
  const closeBtn = h("button", { class: "files-btn", type: "button", "aria-label": "Hide Files", onclick: () => close() }, "×");
  const grip = h("div", { class: "files-grip" });
  el.replaceChildren(
    grip,
    h("div", { class: "files-head" }, h("span", { class: "files-title", "data-label": "Files" }, "// Files"), h("span", { class: "grow" }), sortBtn, hiddenBtn, closeBtn),
    pathLine, list, note, preview);

  function drawHead() {
    sortBtn.textContent = SORT_WORDS[s.order];
    sortBtn.title = tip("Sort By");
    hiddenBtn.classList.toggle("on", s.hidden);
    hiddenBtn.title = tip(s.hidden ? "Hide Hidden Files" : "Show Hidden Files");
    closeBtn.title = tip("Hide Files ⌘⇧F");
    const parts = s.root ? crumbs(s.root, s.home) : [];
    pathLine.replaceChildren(...parts.flatMap((part, i) => [
      i > 0 && !(i === 1 && parts[0].name === "/") ? h("span", { class: "sep" }, "/") : null,
      h("button", { type: "button", class: i === parts.length - 1 ? "here" : "", title: part.path, onclick: () => go(part.path) }, part.name),
    ]).filter(Boolean));
  }

  function rowOf(row) {
    if (row.more) return h("div", { class: "frow more", style: `--depth:${row.depth}` }, h("span", { class: "tw" }), h("span", { class: "nm" }, `还有 ${row.more} 项未列出`));
    const e = row.entry;
    const meta = row.folder ? "" : s.order === "modified" ? age(e.mtime) : sizeWord(e.size);
    const cls = ["frow", row.folder ? "dir" : "file", e.dim ? "dim" : "", e.hidden ? "hid" : "", e.locked ? "locked" : "", row.path === s.selected ? "sel" : ""].filter(Boolean).join(" ");
    return h("div", {
      class: cls, style: `--depth:${row.depth}`, role: "treeitem", "data-path": row.path, title: row.path,
      "aria-selected": String(row.path === s.selected), ...(row.folder ? { "aria-expanded": String(row.open) } : {}),
      onclick: () => { list.focus(); select(row.path); if (row.folder) twist(row.path); else draw(); },
      ondblclick: () => { if (row.folder) go(row.path); },
    },
    h("span", { class: "tw" }, row.folder ? (row.open ? "▾" : "▸") : ""),
    h("span", { class: "nm" }, e.name + (e.kind === "link" ? " →" : "")),
    h("span", { class: "mt" }, e.locked ? "Locked" : meta));
  }

  function draw() {
    el.hidden = !s.open;
    if (!s.open) return;
    drawHead();
    const all = rows();
    list.replaceChildren(...all.map(rowOf));
    const empty = !s.problem && s.root && s.levels[s.root] && all.length === 0;
    note.hidden = !(s.problem || empty);
    note.textContent = s.problem ?? (empty ? (s.levels[s.root].hiddenCount > 0 && !s.hidden ? "只有隐藏文件。" : "空文件夹。") : "");
    list.querySelector(".frow.sel")?.scrollIntoView({ block: "nearest" });
    drawPreview();
  }

  function drawPreview() {
    const d = s.details;
    preview.hidden = !s.selected || !d;
    if (preview.hidden) { preview.replaceChildren(); return; }
    const name = d.name ?? d.path.split("/").pop();
    const kind = previewKind(d);
    const facts = d.refused ? [] : kind === "folder"
      ? [`${d.items} ${d.items === 1 ? "Item" : "Items"}`]
      : [TYPE_WORDS[d.type] ?? "", sizeWord(d.size), d.lines !== undefined ? `${d.lines} ${d.lines === 1 ? "Line" : "Lines"}` : "", d.mtime ? age(d.mtime) : ""].filter(Boolean);
    const download = !d.refused && kind !== "folder" && kind !== "none"
      ? h("a", { class: "files-btn", href: `/files/content${query(d.path)}`, download: name, title: tip("Download") }, "[ Download ]") : null;
    let body = null;
    if (d.refused) body = h("div", { class: "files-say" }, d.refused);
    else if (d.locked) body = h("div", { class: "files-say" }, refusalWords("locked"));
    else if (kind === "image") {
      const img = h("img", { alt: name, src: `/files/thumbnail${query(d.path)}` });
      img.addEventListener("error", () => img.replaceWith(h("div", { class: "files-say" }, "这张图片无法预览。")), { once: true });
      body = h("div", { class: "files-picture" }, img);
    } else if (kind === "text") {
      body = !s.preview ? h("div", { class: "files-say" }, "…")
        : s.preview.refused ? h("div", { class: "files-say" }, s.preview.refused)
          : h("div", { class: "files-text" }, h("pre", {}, s.preview.text), s.preview.truncated ? h("div", { class: "files-say" }, "只显示了开头的部分。") : null);
    } else if (kind === "other") body = h("div", { class: "files-say" }, "这种文件不在这里预览。");
    preview.replaceChildren(
      h("div", { class: "files-about" }, h("span", { class: "nm", title: d.path }, name), h("span", { class: "grow" }), download),
      facts.length ? h("div", { class: "files-facts" }, facts.join(" · ")) : null,
      body);
  }

  // ---------- the keys (the Mac column's: FilesPreviewViews.swift `FilesKeyView`) ----------
  list.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    const all = rows();
    const row = all.find((r) => r.path === s.selected);
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "ArrowDown" && e.metaKey) { done(); if (row?.folder) go(row.path); return; }
    if (e.key === "ArrowUp" && e.metaKey) { done(); up(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { done(); select(moved(all, s.selected, e.key === "ArrowDown" ? 1 : -1)); draw(); return; }
    if (e.key === "Home" || e.key === "End") { done(); select(moved(all, null, e.key === "Home" ? 1 : -1)); draw(); return; }
    if (e.key === "ArrowRight") {
      done();
      if (!row?.folder) return;
      if (row.open) { select(moved(all, s.selected, 1)); draw(); } else twist(row.path);
      return;
    }
    if (e.key === "ArrowLeft") {
      done();
      const what = leftOf(all, s.selected, s.root);
      if (what.close) twist(what.close); else if (what.select) { select(what.select); draw(); } else up();
      return;
    }
    if (e.key === "Enter") { done(); if (row?.folder) go(row.path); return; }
    if (e.key === "Escape") { done(); onLeave(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || e.key === " ") return;
    // A name typed: the first row that starts with it (a second within a moment adds to the first).
    done();
    const now = Date.now();
    s.typed = now - s.typedAt > 1000 ? e.key : s.typed + e.key;
    s.typedAt = now;
    const want = s.typed.toLowerCase();
    const hit = all.find((r) => r.entry && r.entry.name.toLowerCase().startsWith(want));
    if (hit) { select(hit.path); draw(); }
  });

  function up() {
    const above = s.root ? (s.levels[s.root]?.parent ?? parentOf(s.root)) : null;
    if (!above) return;
    const was = s.root;
    go(above).then(() => { select(was); draw(); });
  }

  // ---------- its width ----------
  function applyWidth() {
    document.documentElement.style.setProperty("--files-w", s.open ? `${widthNow()}px` : "0px");
    document.body.classList.toggle("files-open", s.open);
    onLayout();
  }
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = e.clientX, was = widthNow();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("files-dragging");
    const move = (ev) => { s.width = was + (from - ev.clientX); applyWidth(); };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      document.body.classList.remove("files-dragging");
      s.width = widthNow();
      keep();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end, { once: true });
    grip.addEventListener("pointercancel", end, { once: true });
  });
  grip.addEventListener("dblclick", () => { s.width = WIDTH.fallback; keep(); applyWidth(); });
  addEventListener("resize", () => { if (s.open) applyWidth(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  // ---------- what the page asks of it ----------
  function show(folder) {
    const was = s.open;
    s.open = true;
    if (!was) {
      applyWidth();
      s.timer = setInterval(refresh, POLL_MS);
    }
    draw();
    if (folder && folder !== s.root) go(folder); else if (!s.root) go(null); else refresh();
    list.focus();
  }

  function close() {
    if (!s.open) return;
    s.open = false;
    clearInterval(s.timer);
    s.timer = null;
    draw();
    applyWidth();
    onLeave();
  }

  return {
    get open() { return s.open; },
    get root() { return s.root; },
    show,
    close,
    /** The band's button, a row's `Open Files Beside`, ⌘⇧F: open at `folder` (or where it was); open there already, closed. */
    toggle(folder) { if (s.open && (!folder || folder === s.root)) close(); else show(folder); },
    /** The look changed: the words that depend on it are written again. */
    redraw: draw,
  };
}
