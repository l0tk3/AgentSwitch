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
