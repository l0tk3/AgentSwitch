/** Text a voice reads (the Live Activity's result line, api/live.ts): what an agent's answer may still have in it —
 *  ciphertexts, links, Markdown markers, @ before handles (not in e-mail addresses), long random-looking strings, a
 *  removal marker — is cleaned out, so none of it is ever read aloud. Line breaks become sentence joins. */

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
