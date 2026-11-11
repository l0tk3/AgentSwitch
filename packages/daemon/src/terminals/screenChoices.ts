/** A list the agent draws on its own screen and waits on — Codex's `/model` (its models, then how hard each thinks),
 *  Claude Code's or Codex's question whether to trust a folder, any menu of theirs: rows, one of them marked as where
 *  the selection stands. A screen that shows the record offers the same rows; taking one moves the selection there with
 *  the arrow keys and enters it, as in the terminal (docs/simple-view-v0.md §5.11; 2026-10-08, user: /model直接在简略
 *  视图里出一个列表让我可以点就行了，逻辑和和在cli一致).
 *
 *  Two shapes are read. Numbered rows (`› 1. Trust and continue` / `  2. Quit`), as before. And rows without numbers
 *  (`❯ No, exit` / `  Yes, I trust this folder`), which is how Claude Code 2.1.299 asks about a folder: these are a
 *  list only with the line under them that says how to take one (`Enter to confirm · Esc to cancel`), since a mark and
 *  a few words is also what a prompt with something typed after it looks like (2026-11-10, user: 第一次进入某个文件夹
 *  的需要选是否信任文件夹，这个时候简略模式无法正常显示; seen with scripts/trust_prompt_probe.ts).
 *
 *  Grok draws two more (2026-11-11, seen with Grok 1.0.77 in a pty; read only off a Grok terminal's screen). What it
 *  asks before it uses a tool: rows with a number and a round mark, the filled one where the selection stands
 *  (`3 (●) Yes, proceed`), in a block with a bar down its left side; the arrow keys move it and Enter takes it, as in
 *  the other lists. And its question whether to trust a folder: two rows with the key that takes each at their end
 *  (`Yes, proceed    y` / `No, quit    n`), nothing marked — Enter takes the first. Such a row carries its `key`.
 *
 *  `title` is what is asked: the paragraph above the rows that asks something, else the nearest. `text` is everything
 *  the screen says above the rows, when that is more than the title — a folder's question is several paragraphs, and
 *  the last line of one of them (`decision will be saved.`) said nothing. */
export type ScreenChoices = {
  readonly title: string;
  /** `key`: the key that takes this row at once, in a list taken by keys instead of a selection (Grok's folder question). */
  readonly options: readonly { readonly label: string; readonly detail?: string; readonly key?: string }[];
  /** Where the selection stands: the row Enter takes. */
  readonly selected: number;
  /** All that stands above the rows, a paragraph a line; absent when the title is all of it. */
  readonly text?: string;
};

const CHOICE_ROW = /^\s*(?:[│|]\s*)?(?:([›❯>▶])\s+)?(\d{1,2})[.)]\s+(\S.*?)\s*(?:[│|]\s*)?$/u;
/** A row of a list without numbers: its mark, or the room of one, then its words. */
const PLAIN_ROW = /^(\s*(?:[│|]\s*)?)(?:([›❯>▶])(\s+)|(\s+))(\S.*?)\s*(?:[│|]\s*)?$/u;
/** The line under a list that says how to take a row of it. */
const TAKE_HINT = /\benter\b.*\b(select|confirm|continue|choose|submit)|\besc\b.*\b(back|cancel|quit|exit)/i;
/** A rule, or an edge of a box: nothing but line-drawing. */
const RULE_ROW = /^[\s─━═╭╮╰╯┌┐└┘├┤│|]*[─━═]{3,}[\s─━═╭╮╰╯┌┐└┘├┤│|]*$/u;
/** A row of the conversation, not of the question: an agent's bullet, a prompt mark, a spinner. */
const TALK_ROW = /^\s*(?:[│|]\s*)?[•⏺●›❯>⎿└·✢✳✶✻✽]\s/u;
const MAX_CHOICES = 40;
const MAX_TITLE = 300;
const MAX_TEXT = 1500;
/** How far above the rows the question is looked for: rows between the two, then rows of it. */
const MAX_GAP = 3;
const MAX_ABOVE = 16;
/** A line ends this near the screen's edge when the next word did not fit (agents leave a margin). */
const WRAP_SLACK = 6;

const edges = (l: string): string => l.replace(/^[\s│|╭╰─]+|[\s│|╮╯─]+$/gu, "").trim();

/** The list on the screen's last rows, if it shows one. `lines` are the screen's rows top to bottom, blank ones
 *  included or not; `cols` its width, for telling a wrapped line from one that ends (else the widest row's);
 *  `harness` the agent whose screen it is, for the shapes only one of them draws (Grok's). */
export function choicesOnScreen(lines: readonly string[], cols?: number, harness?: string): ScreenChoices | null {
  const width = cols ?? Math.max(0, ...lines.map((l) => l.trimEnd().length));
  const own = harness === "grok" ? radio(lines) ?? keyed(lines, width) : null;
  const found = own ?? numbered(lines) ?? plain(lines);
  if (!found) return null;
  const { title, text } = found.asked ?? asked(lines, found.first, width);
  return { title, options: found.options, selected: found.selected, ...(text && text !== title ? { text } : {}) };
}

/** `asked`: what stands above the rows, where the shape reads it itself. */
type Found = { readonly first: number; readonly options: ScreenChoices["options"]; readonly selected: number; readonly asked?: { readonly title: string; readonly text: string } };

/** A row of what Grok asks before a tool: the bar of its block, a number, a round mark, the words. */
const RADIO_ROW = /^\s*(?:[┃│|]\s*)?(\d{1,2})\s+\(([○●◯◉])\)\s+(\S.*?)\s*$/u;
/** A row of the block above them. */
const BLOCK_ROW = /^\s*┃/u;
/** How far up from the screen's end such a list is looked for: it is what the screen waits on, with the line that
 *  names its keys under it. */
const RADIO_FROM_END = 6;

/** Grok's question before a tool: rows numbered 1, 2, 3… each with a round mark, exactly one filled. Above them in the
 *  same block, what it is about to do and on what (and a line naming more keys, which says nothing of it). */
function radio(all: readonly string[]): Found | null {
  let end = all.length - 1, below = 0;
  while (end >= 0 && !RADIO_ROW.test(all[end]!)) { if (all[end]!.trim()) below += 1; end -= 1; }
  if (end < 0 || below > RADIO_FROM_END) return null;
  const rows: { n: number; on: boolean; text: string }[] = [];
  let first = end;
  for (let i = end; i >= 0 && rows.length <= MAX_CHOICES; i--) {
    const m = RADIO_ROW.exec(all[i]!);
    if (!m) break;
    rows.unshift({ n: Number(m[1]), on: m[2] === "●" || m[2] === "◉", text: m[3]! });
    first = i;
  }
  if (rows.length < 2 || rows.length > MAX_CHOICES || rows.some((r, i) => r.n !== i + 1) || rows.filter((r) => r.on).length !== 1) return null;
  const above: string[] = [];
  for (let i = first - 1; i >= 0 && first - i <= MAX_ABOVE && BLOCK_ROW.test(all[i]!); i--) {
    const said = all[i]!.replace(/^\s*┃\s*/u, "").replace(/^[›❯>│|]\s*/u, "").trim();
    if (said && !/^←/u.test(said)) above.unshift(said);
  }
  return {
    first, options: rows.map((r) => ({ label: r.text.trim().slice(0, 200) })), selected: rows.findIndex((r) => r.on),
    asked: { title: (above[0] ?? "").slice(0, MAX_TITLE), text: above.join("\n").slice(0, MAX_TEXT) },
  };
}

/** A row taken by a key: its words, room, then the key alone at its end. */
const KEYED_ROW = /^\s*(\S(?:.*?\S)?)\s{4,}([a-z])\s*$/u;
/** Rows that say something: a logo drawn in dots and blocks says nothing. */
const WORDS = /[\p{L}\p{N}]/u;
/** What may stand under such a list: the program's name in a corner. */
const KEYED_BELOW = 2;

/** Grok's question whether to trust a folder: two rows or more, one under the other, each ending in the key that takes
 *  it — the first letter of its own words (`Yes, proceed    y`, `No, quit    n`) — under a paragraph that asks. Nothing
 *  is marked; Enter takes the first. */
function keyed(all: readonly string[], width: number): Found | null {
  const lines = all.map((l) => (WORDS.test(l) ? l : ""));
  let end = lines.length - 1, below = 0;
  const row = (i: number) => {
    const m = KEYED_ROW.exec(lines[i] ?? "");
    return m && m[1]![0]!.toLowerCase() === m[2] ? { label: m[1]!, key: m[2]! } : null;
  };
  while (end >= 0 && !row(end)) { if (lines[end]!.trim()) below += 1; end -= 1; }
  if (end < 0 || below > KEYED_BELOW) return null;
  const rows: { label: string; key: string }[] = [];
  let first = end;
  for (let i = end; i >= 0 && rows.length <= MAX_CHOICES; i--) {
    const r = row(i);
    if (!r) break;
    rows.unshift(r);
    first = i;
  }
  if (rows.length < 2 || rows.length > MAX_CHOICES || new Set(rows.map((r) => r.key)).size !== rows.length) return null;
  const said = asked(lines, first, width);
  if (!/[?？]/u.test(said.title)) return null;
  return { first, options: rows.map((r) => ({ label: r.label.trim().slice(0, 200), key: r.key })), selected: 0, asked: said };
}

/** Rows numbered 1, 2, 3… in order (a row between two of them that has no number continues the one above), exactly
 *  one with the selection's mark before its number. Numbered lines in an answer have no such mark: not a list to
 *  choose from. Blank rows are not counted: a list may be drawn with room between its rows. */
function numbered(all: readonly string[]): Found | null {
  const at = all.map((_, i) => i).filter((i) => all[i]!.trim());
  const lines = at.map((i) => all[i]!);
  let end = -1;
  for (let i = lines.length - 1; i >= 0 && end < 0; i--) if (CHOICE_ROW.test(lines[i]!)) end = i;
  if (end < 0) return null;
  const rows: { at: number; n: number; marked: boolean; text: string }[] = [];
  for (let i = end; i >= 0 && end - i < 4 * MAX_CHOICES; i--) {
    const m = CHOICE_ROW.exec(lines[i]!);
    if (!m) continue;
    rows.unshift({ at: i, n: Number(m[2]), marked: !!m[1], text: m[3]! });
    if (Number(m[2]) === 1) break;
  }
  if (!rows.length || rows.length > MAX_CHOICES || rows.some((r, i) => r.n !== i + 1) || rows.filter((r) => r.marked).length !== 1) return null;
  // A single row is a list only where the screen says under it how to take it (Codex: `enter select · esc back`);
  // by itself it may be what you typed after your own prompt mark.
  if (rows.length === 1 && !lines.slice(end + 1, end + 5).some((l) => TAKE_HINT.test(l))) return null;
  const options = rows.map((r) => {
    const [label, ...rest] = r.text.split(/\s{2,}/);
    const detail = rest.join(" ").trim();
    return { label: label!.trim().slice(0, 200), ...(detail ? { detail: detail.slice(0, 300) } : {}) };
  });
  return { first: at[rows[0]!.at]!, options, selected: rows.findIndex((r) => r.marked) };
}

/** Rows without numbers: the last thing on the screen is the line that says how to take one, and right above it two
 *  rows or more, their words beginning in one column, exactly one with the mark before them. */
function plain(lines: readonly string[]): Found | null {
  let hint = lines.length - 1;
  while (hint >= 0 && !lines[hint]!.trim()) hint -= 1;
  if (hint < 1 || !TAKE_HINT.test(lines[hint]!)) return null;
  let end = hint - 1;
  while (end >= 0 && hint - end <= MAX_GAP && !lines[end]!.trim()) end -= 1;
  if (end < 0 || !lines[end]!.trim()) return null;
  const rows: { marked: boolean; column: number; text: string }[] = [];
  let first = end;
  for (let i = end; i >= 0 && rows.length <= MAX_CHOICES; i--) {
    const line = lines[i]!;
    if (!line.trim() || RULE_ROW.test(line)) break;
    const m = PLAIN_ROW.exec(line);
    if (!m) break;
    const marked = !!m[2];
    rows.unshift({ marked, column: m[1]!.length + (marked ? 1 + m[3]!.length : m[4]!.length), text: m[5]! });
    first = i;
  }
  const at = rows.findIndex((r) => r.marked);
  if (rows.length < 2 || rows.length > MAX_CHOICES || at < 0 || rows.filter((r) => r.marked).length !== 1) return null;
  if (rows.some((r) => r.column !== rows[at]!.column)) return null;
  return { first, options: rows.map((r) => ({ label: r.text.trim().slice(0, 200) })), selected: at };
}

/** What stands above the rows that begin at `first`: its paragraphs, down to the one nearest the rows. It ends at a
 *  rule or a box's edge, at a row of the conversation, at two blank rows, or `MAX_ABOVE` rows up. Lines of a paragraph
 *  that the screen's width broke are joined again; ones that end by themselves (a heading, a path) stay lines. */
function asked(lines: readonly string[], first: number, width: number): { title: string; text: string } {
  let i = first - 1, gap = 0;
  while (i >= 0 && gap < MAX_GAP && !edges(lines[i]!)) { i -= 1; gap += 1; }
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (let taken = 0; i >= 0 && taken < MAX_ABOVE; i--) {
    const raw = lines[i]!;
    if (RULE_ROW.test(raw)) break;
    // The conversation begins here: the rows taken since the last blank one were the rest of what it says.
    if (TALK_ROW.test(raw)) { current = []; break; }
    if (!edges(raw)) {
      if (!current.length) break;
      paragraphs.unshift(current);
      current = [];
      continue;
    }
    current.unshift(raw);
    taken += 1;
  }
  if (current.length) paragraphs.unshift(current);
  const said = paragraphs.map((p) => unwrapped(p, width));
  // What is asked: the paragraph that asks, whole; else the nearest one's first line (a heading over a line about it).
  const asks = [...said].reverse().find((p) => /[?？]/u.test(p))?.replace(/\s*\n\s*/g, " ") ?? said[said.length - 1]?.split("\n")[0] ?? "";
  return { title: asks.slice(0, MAX_TITLE), text: said.join("\n").slice(0, MAX_TEXT) };
}

/** A paragraph's rows as text: a row the next one's first word would not have fitted after runs on into it. */
function unwrapped(rows: readonly string[], width: number): string {
  let out = "";
  rows.forEach((raw, i) => {
    const text = edges(raw);
    if (i === 0) { out = text; return; }
    const before = rows[i - 1]!.replace(/[\s│|]+$/u, "");
    const word = /^\S+/.exec(text)?.[0] ?? "";
    out += (before.length + 1 + word.length > width - WRAP_SLACK ? " " : "\n") + text;
  });
  return out;
}
