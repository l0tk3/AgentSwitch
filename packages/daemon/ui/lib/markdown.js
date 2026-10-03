/** Markdown as the agents write it (results, replies, summaries), drawn on the console (docs/ui-v0.md §7.4, 2026-10-01,
 *  user: console 网页很多地方还不支持 markdown 显示). Everything is escaped first; only what Markdown says becomes
 *  markup: paragraphs, headings, lists (nested by indent), quotes, fenced code, tables, rules, and inline code, bold,
 *  italic, strike-through and links (http, https and mailto only). No raw HTML passes. */

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** One line's inline marks; code spans are kept whole first, so nothing inside them is read as a mark. */
export function mdInline(text) {
  const codes = [];
  let s = String(text ?? "").replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) => {
    codes.push(`<code>${esc(code.replace(/^ (.*) $/, "$1"))}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  // Links: [text](url) — a url of another kind stays text.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, label, url) => {
    const href = url.replace(/&(amp|lt|gt|quot);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"' }[e]));
    return /^(https?:|mailto:)/i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : all;
  });
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    // Italic only with single asterisks: underscores are everywhere in paths and names.
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** Markdown text → safe HTML. */
export function md(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${fence[2] ? ` data-lang="${esc(fence[2])}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { out.push(`<h${heading[1].length + 2 > 6 ? 6 : heading[1].length + 2} class="mdh">${mdInline(heading[2])}</h${heading[1].length + 2 > 6 ? 6 : heading[1].length + 2}>`); i++; continue; }
    if (RULE.test(line)) { out.push("<hr>"); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="mdt"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${mdInline(r[k] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
      out.push(`<blockquote>${md(body.join("\n"))}</blockquote>`);
      continue;
    }
    if (ITEM.test(line)) {
      const items = [];
      while (i < lines.length && (ITEM.test(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length))) {
        const m = ITEM.exec(lines[i]);
        if (m) items.push({ indent: m[1].replace(/\t/g, "  ").length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
        else items[items.length - 1].text += " " + lines[i].trim();
        i++;
      }
      out.push(list(items));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !RULE.test(lines[i]) && !QUOTE.test(lines[i]) && !ITEM.test(lines[i])
      && !(lines[i].includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]))) para.push(lines[i++]);
    out.push(`<p>${para.map(mdInline).join("<br>")}</p>`);
  }
  return out.join("");
}

/** Items into lists, a deeper indent a list inside the item before it. */
function list(items) {
  let html = "";
  const stack = [];
  for (const item of items) {
    while (stack.length && item.indent < stack.at(-1).indent) html += `</li></${stack.pop().tag}>`;
    const top = stack.at(-1);
    if (!top || item.indent > top.indent) {
      const tag = item.ordered ? "ol" : "ul";
      html += `<${tag}${item.ordered && item.start > 1 ? ` start="${item.start}"` : ""}>`;
      stack.push({ indent: item.indent, tag });
    } else {
      html += "</li>";
    }
    html += `<li>${mdInline(item.text)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

/** What a person typed, as typed (docs/ui-v0.md §7.4, 2026-10-03, user: dispatch里加上代码块支持吧，这样看着太难受了):
 *  fenced blocks and `code` spans drawn as code, nothing else read — a `*` or `#` they typed stays. The apps' rules
 *  (DispatchCode / MarkdownCode): a fence closes only on a bare fence of its mark at least as long, one left open runs
 *  to the end, ```ls``` on a line is a span; a span stays on one line. Escaped like the rest; the text between keeps
 *  its line breaks in the container (`pre-wrap`). */
export function mdTyped(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let words = [];
  const endWords = () => {
    while (words.length && !words[0].trim()) words.shift();
    while (words.length && !words.at(-1).trim()) words.pop();
    if (words.length) out.push(`<span class="typed">${words.map(codeSpans).join("\n")}</span>`);
    words = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN_FENCE.exec(lines[i]);
    if (!open || (open[2][0] === "`" && open[3].includes("`"))) { words.push(lines[i]); continue; }
    endWords();
    const [, lead, mark, info] = open;
    const close = new RegExp(`^[ \\t]*${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`);
    const indent = lead.replace(/\t/g, "").length;
    const body = [];
    for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ""));
    while (body.length && !body.at(-1).trim()) body.pop();
    const lang = info.trim().split(/\s+/)[0];
    out.push(`<pre><code${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
  }
  endWords();
  return out.join("");
}

const OPEN_FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

/** One line with its code spans as <code>, the rest escaped as typed: a run of backticks closes on the next run as
 *  long; one space comes off both ends (not from all spaces); a run with no partner stays. */
function codeSpans(line) {
  let out = "";
  let i = 0;
  const run = (at) => { let n = 0; while (line[at + n] === "`") n++; return n; };
  while (i < line.length) {
    if (line[i] !== "`") {
      const next = line.indexOf("`", i);
      const end = next < 0 ? line.length : next;
      out += esc(line.slice(i, end));
      i = end;
      continue;
    }
    const n = run(i);
    let close = -1;
    for (let j = i + n; j < line.length;) {
      if (line[j] !== "`") { j++; continue; }
      const m = run(j);
      if (m === n) { close = j; break; }
      j += m;
    }
    if (close < 0) { out += esc(line.slice(i, i + n)); i += n; continue; }
    let code = line.slice(i + n, close);
    if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
    out += `<code>${esc(code)}</code>`;
    i = close + n;
  }
  return out;
}
