/** Shell commands that only look (2026-09-25). A read-only step (research, verify) refuses everything that asks for
 *  approval, and Claude asks for every shell command, so "summarise the repository's recent changes" could not even run
 *  `git log` in the repository. These run without asking in such a step: every command of the line is on the list
 *  below and used only to read, there is no redirection into a file, no command or process substitution, no job in
 *  the background, no variable set in front of a command, and no path in a protected folder. Anywhere else on the Mac
 *  is fine, like Claude Code on it (user decision the same day). Anything else still goes to the floor, which refuses
 *  it in a read-only step. */

import { commandTouchesProtected, NO_PROTECTED, type ProtectedPaths, shellWords } from "./protected.js";

/** Commands that read and print, with no option that writes or runs something else. */
const READERS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "pwd", "stat", "file", "du", "df", "which", "echo",
  "printf", "sort", "uniq", "cut", "tr", "nl", "tree", "basename", "dirname", "realpath", "readlink", "date", "whoami",
  "uname", "diff", "cmp", "shasum", "sha256sum", "md5", "jq", "column", "ps", "lsof", "sw_vers", "true", "test", "[",
]);
/** `git` subcommands that only read. `branch`, `tag`, `remote`, `config`, `stash` and `reflog` are checked further. */
const GIT_READ = new Set([
  "log", "status", "diff", "show", "rev-parse", "rev-list", "ls-files", "ls-tree", "blame", "shortlog", "describe",
  "cat-file", "grep", "count-objects", "for-each-ref", "name-rev", "merge-base", "whatchanged",
]);
const GIT_LISTING_FLAGS = new Set(["-a", "-r", "-v", "-vv", "-l", "--list", "--all", "--remotes", "--verbose", "--show-current", "--contains", "--merged", "--no-merged", "-n"]);
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
/** Options that make a reader write a file. */
const WRITING_OPTIONS = /^(-o|--output(=.*)?|-w|--write(=.*)?)$/;

/** The command of a `Bash: <command>` approval (Claude, OpenCode), or null for any other action. */
export function shellCommandOf(action: string): string | null {
  return action.startsWith("Bash: ") ? action.slice("Bash: ".length) : null;
}

/** True when `command` only reads and names no protected path (see the module comment). */
export function isReadOnlyCommand(command: string, cwd: string, prot: ProtectedPaths = NO_PROTECTED, env: NodeJS.ProcessEnv = process.env): boolean {
  const segments = splitLine(command);
  if (!segments) return false;
  if (commandTouchesProtected(command, cwd, prot, env) !== null) return false;
  return segments.every((segment) => {
    const words = shellWords(segment);
    return !words.length || readsOnly(words);
  });
}

function readsOnly(words: readonly string[]): boolean {
  const [name = "", ...args] = words;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return false;   // a variable in front can change what runs
  const base = name.split("/").pop() ?? name;
  if (base === "cd") return args.length <= 1;
  if (base === "git") return gitReads(args);
  if (base === "find") return !args.some((a) => FIND_ACTIONS.has(a));
  if (!READERS.has(base)) return false;
  return !args.some((a) => WRITING_OPTIONS.test(a));
}

function gitReads(args: readonly string[]): boolean {
  // Global options first (`-C <dir>`, `--no-pager`, `-c` is refused: it can set an alias or a pager).
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    const a = args[i]!;
    if (a === "-c") return false;
    i += a === "-C" || a === "--git-dir" || a === "--work-tree" ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return false;
  if (rest.some((a) => /^--(output|exec|upload-pack|ext-diff)/.test(a))) return false;
  if (GIT_READ.has(sub)) return true;
  if (sub === "branch" || sub === "tag") return rest.every((a) => GIT_LISTING_FLAGS.has(a));
  if (sub === "remote") return rest.every((a) => a === "-v" || a === "--verbose") || (rest[0] === "get-url" && rest.length === 2);
  if (sub === "config") return rest.length > 0 && ["--get", "--get-all", "--list", "-l", "--show-origin"].includes(rest[0]!);
  if (sub === "stash" || sub === "reflog") return rest.length === 0 ? sub === "reflog" : rest[0] === "list" || rest[0] === "show";
  return false;
}

/** The line split into its simple commands, or null when it runs or writes more than a reader would: a substitution,
 *  a background job, or a redirection into anything but /dev/null or another descriptor. */
function splitLine(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  const cut = () => { segments.push(current); current = ""; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote === "'") { if (ch === "'") quote = null; current += ch; continue; }
    if (ch === "`" || (ch === "$" && next === "(")) return null;   // runs something, in double quotes too
    if (quote === "\"") { if (ch === "\"" && command[i - 1] !== "\\") quote = null; current += ch; continue; }
    if (ch === "'" || ch === "\"") { quote = ch; current += ch; continue; }
    if (ch === "\\") { current += ch + (next ?? ""); i++; continue; }
    if (ch === ";" || ch === "\n") { cut(); continue; }
    if (ch === "|") { if (next === "|") i++; cut(); continue; }
    if (ch === "&") {
      if (next === "&") { i++; cut(); continue; }
      if (next === ">") { const skip = redirection(command, i + 2); if (skip === null) return null; i = skip - 1; continue; }   // &> target
      return null;   // a job in the background
    }
    if (ch === "<" && next === "(") return null;
    if (ch === ">") {
      if (next === "(") return null;
      const start = next === ">" ? i + 2 : i + 1;
      const skip = redirection(command, start);
      if (skip === null) return null;
      current = current.replace(/\d$/, "");   // the descriptor number before `>`
      i = skip - 1;
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  cut();
  return segments;
}

/** A redirection's target from `at`: /dev/null or `&<digit>` is fine (returns where it ends); anything else is a file. */
function redirection(command: string, at: number): number | null {
  let i = at;
  while (command[i] === " ") i++;
  if (command[i] === "&" && /\d/.test(command[i + 1] ?? "")) return i + 2;
  if (command.startsWith("/dev/null", i) && !/[^\s;&|)]/.test(command[i + "/dev/null".length] ?? " ")) return i + "/dev/null".length;
  return null;
}
