/** The names seats go by and who a message is for (docs/chatroom-v0.md §1, §4). A seat's handle is made once from what
 *  its session was called then, and stays: others keep writing the same `@name` whatever the session is renamed to. */

/** The user's seat, in every room. */
export const YOU = "you";
/** Everyone in the room; only the user may write it. */
export const ALL = "all";
const RESERVED = new Set([YOU, ALL, "everyone", "here", "room"]);
const MAX_HANDLE = 24;

/** A handle from a name: letters and digits of any script kept, lower case, everything else a dash. */
export function handleFrom(name: string, fallback = "session"): string {
  const slug = name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const cut = [...slug].slice(0, MAX_HANDLE).join("").replace(/-+$/, "");
  return cut || fallback;
}

/** `wanted`, or `wanted-2`, `wanted-3` … : the first nobody in the room has (had, too: a seat that left keeps its name
 *  in what it said). */
export function freeHandle(wanted: string, taken: ReadonlySet<string>): string {
  const base = RESERVED.has(wanted) ? `${wanted}-1` : wanted;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const MENTION = /(^|[^\p{L}\p{N}_@.-])@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;

/** The `@names` written in a text, in order, each once. An address in an e-mail or a package's `@scope` is not one:
 *  the `@` stands at the start or after something that is not part of a word. */
export function mentions(text: string): string[] {
  const found: string[] = [];
  // A name written inside code or a quotation is spoken of, not called: "`@all` wakes everyone", “@bob 说过…”.
  const said = text.replace(/`[^`\n]*`/g, " ").replace(/“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"/g, " ");
  for (const m of said.matchAll(MENTION)) {
    const name = m[2]!.toLowerCase();
    if (!found.includes(name)) found.push(name);
  }
  return found;
}
