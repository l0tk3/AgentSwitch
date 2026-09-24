/** Text a voice reads (threads-v0 §3 `spoken` / `speech`): the model is asked to write for the ear, and this cleans
 *  what it may still leave in — ciphertexts, links, Markdown markers, @ before handles (not in e-mail addresses),
 *  long random-looking strings, the lint's own removal marker — so none of it is ever read aloud. Line breaks become
 *  sentence joins. */

import { lintContext } from "../core/contextDoc.js";

const TOKEN = /\benc:(?:v1|ref):[A-Za-z0-9_=-]{8,}/g;
const LINK = /\bhttps?:\/\/\S+/g;
const REMOVED = /\s*\[removed: not a secret-gate token\]/g;
/** 16+ characters of letters and digits mixed: keys, session ids, hashes; plain words and numbers stay. */
const RANDOM = /(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=-]*[A-Za-z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]{16,}(?![A-Za-z0-9_+/=-])/g;
const LINE_MARKER = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d{1,3}[.)]\s+|>\s*)/gm;
const EMPHASIS = /\*\*|__|~~|`+/g;
const HANDLE = /(?<![A-Za-z0-9._%+-])@([A-Za-z0-9_]{1,30})/g;
/** CJK punctuation never needs a space on its closing / opening side. */
const SPACE_BEFORE = /\s+([，。！？、；：,.!?;:）」』】])/g;
const SPACE_AFTER = /([，。！？、；：（「『【])\s+/g;
const SENTENCE_END = /[。！？!?；;]/g;

export function speakable(text: string): string {
  return text
    .replace(TOKEN, " ")
    .replace(LINK, " ")
    .replace(REMOVED, "")
    .replace(RANDOM, " ")
    .replace(LINE_MARKER, "")
    .replace(EMPHASIS, "")
    .replace(/\|/g, " ")
    .replace(HANDLE, "$1")
    .replace(/\s+/g, " ")
    .replace(SPACE_BEFORE, "$1")
    .replace(SPACE_AFTER, "$1")
    .trim();
}

/** A summary's `spoken` / `speech`: every line linted on its own (a credential label on the third line is found as
 *  surely as on the first), then cleaned, then cut at the last sentence end within `max`. */
export function spokenLine(text: string, max: number): string {
  const linted = text.split("\n").map((line) => lintContext(`- ${line}`).text.replace(/^- /, "")).join("\n");
  return atSentence(speakable(linted), max);
}

function atSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const ends = [...head.matchAll(SENTENCE_END)];
  const last = ends.at(-1);
  return last?.index ? head.slice(0, last.index + 1) : head;
}
