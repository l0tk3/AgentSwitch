/** The few parts every page of `agentswitch config` is made of (docs/tui-v0.md §2): a list of rows to move through, and
 *  three questions that take the page's place while they are asked — choose one of these, type this, are you sure.
 *  Asking is a promise, so a page asks in sequence what a Mac sheet shows at once (a new profile: its name, how it signs
 *  in, its address, its key, its model). What is being done, and what came of it, is said on the status line. */

import { Box, Text, useApp, useInput, usePaste } from "ink";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Locale, Messages } from "../i18n/index.js";

export type Tone = "dim" | "ok" | "warn" | "error" | "accent";
export const COLOR: Readonly<Record<Tone, string>> = { dim: "gray", ok: "green", warn: "yellow", error: "red", accent: "cyan" };

export type Words = { readonly t: Messages; readonly locale: Locale };
export const WordsContext = createContext<Words | null>(null);
export function useWords(): Words {
  const w = useContext(WordsContext);
  if (!w) throw new Error("no words");
  return w;
}

export type Option = { readonly value: string; readonly label: string; readonly hint?: string | undefined };
export type PickRequest = { readonly title: string; readonly options: readonly Option[]; readonly initial?: string | undefined; readonly hint?: string | undefined;
  /** Typing narrows the list; with `custom`, what is typed can be chosen itself (its label: `custom(typed)`). */
  readonly filter?: boolean; readonly custom?: ((typed: string) => string) | undefined };
export type AskRequest = { readonly title: string; readonly initial?: string | undefined; readonly hint?: string | undefined;
  /** Not shown as typed (a key, a password). */ readonly secret?: boolean;
  /** Shown as this says instead of as typed (a proxy line with its password hidden): it must keep the length, since the
   *  cursor is placed by it. */ readonly mask?: ((typed: string) => string) | undefined;
  /** Why what is typed will not do; null: it will. */ readonly check?: ((typed: string) => string | null) | undefined };
export type ConfirmRequest = { readonly text: string; readonly yes: string; readonly danger?: boolean };

type Question =
  | { readonly kind: "pick"; readonly req: PickRequest; readonly done: (v: string | null) => void }
  | { readonly kind: "ask"; readonly req: AskRequest; readonly done: (v: string | null) => void }
  | { readonly kind: "confirm"; readonly req: ConfirmRequest; readonly done: (v: boolean) => void };

export type Ui = {
  pick(req: PickRequest): Promise<string | null>;
  ask(req: AskRequest): Promise<string | null>;
  confirm(req: ConfirmRequest): Promise<boolean>;
  /** `work` done while the status line says `label`; what it throws is said there, and undefined returned. */
  run<T>(label: string, work: () => Promise<T>): Promise<T | undefined>;
  say(text: string, tone?: Tone): void;
  /** `work` given the terminal (an editor): the screen steps aside and is drawn again after. */
  external<T>(work: () => Promise<T> | T): Promise<T>;
  /** A question takes the page's place: the page does not take keys meanwhile. */
  readonly asking: boolean;
  readonly busy: boolean;
};

const UiContext = createContext<Ui | null>(null);
export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("no ui");
  return ui;
}

type Status = { readonly text: string; readonly tone: Tone } | null;

/** The questions and the status line for whatever is inside: `children(question, status)` lays them out. */
export function UiProvider({ children }: { children: (question: ReactNode, status: ReactNode) => ReactNode }) {
  const [question, setQuestion] = useState<Question | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(0);
  const { suspendTerminal } = useApp();

  const pick = useCallback((req: PickRequest) => new Promise<string | null>((resolve) => setQuestion({ kind: "pick", req, done: (v) => { setQuestion(null); resolve(v); } })), []);
  const ask = useCallback((req: AskRequest) => new Promise<string | null>((resolve) => setQuestion({ kind: "ask", req, done: (v) => { setQuestion(null); resolve(v); } })), []);
  const confirm = useCallback((req: ConfirmRequest) => new Promise<boolean>((resolve) => setQuestion({ kind: "confirm", req, done: (v) => { setQuestion(null); resolve(v); } })), []);
  const say = useCallback((text: string, tone: Tone = "ok") => setStatus({ text, tone }), []);
  const run = useCallback(async <T,>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
    busyRef.current += 1;
    setBusy(label);
    setStatus(null);
    try { return await work(); }
    catch (err) { setStatus({ text: (err as Error).message, tone: "error" }); return undefined; }
    finally { busyRef.current -= 1; if (busyRef.current === 0) setBusy(null); }
  }, []);

  const external = useCallback(async <T,>(work: () => Promise<T> | T): Promise<T> => {
    let out: T | undefined;
    await suspendTerminal(async () => { out = await work(); });
    return out as T;
  }, [suspendTerminal]);

  const ui = useMemo<Ui>(() => ({ pick, ask, confirm, run, say, external, asking: question !== null, busy: busy !== null }), [pick, ask, confirm, run, say, external, question, busy]);
  const line = busy ? <Text color={COLOR.accent}>{busy}…</Text> : status ? <Text color={COLOR[status.tone]} wrap="wrap">{status.text}</Text> : null;
  return <UiContext.Provider value={ui}>{children(question ? <QuestionView q={question} /> : null, line)}</UiContext.Provider>;
}

function QuestionView({ q }: { q: Question }) {
  if (q.kind === "pick") return <Picker req={q.req} done={q.done} />;
  if (q.kind === "ask") return <Asker req={q.req} done={q.done} />;
  return <Confirmer req={q.req} done={q.done} />;
}

/** How many rows of a list fit: the window's rows less what is around the list. */
export const LIST_ROWS = 12;

/** The part of `count` rows around `at` that fits in `rows`. */
export function windowOf(count: number, at: number, rows: number): { from: number; to: number } {
  if (count <= rows) return { from: 0, to: count };
  const from = Math.min(Math.max(0, at - Math.floor(rows / 2)), count - rows);
  return { from, to: from + rows };
}

function Picker({ req, done }: { req: PickRequest; done: (v: string | null) => void }) {
  const { t } = useWords();
  const [typed, setTyped] = useState("");
  const shown = useMemo(() => {
    const q = typed.trim().toLowerCase();
    const list = q ? req.options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : req.options;
    return req.custom && typed.trim() && !req.options.some((o) => o.value === typed.trim()) ? [...list, { value: typed.trim(), label: req.custom(typed.trim()) }] : list;
  }, [typed, req]);
  const [at, setAt] = useState(() => Math.max(0, req.options.findIndex((o) => o.value === req.initial)));
  const here = Math.min(at, Math.max(0, shown.length - 1));
  useInput((input, key) => {
    if (key.escape) return done(null);
    if (key.return) { const o = shown[here]; if (o) done(o.value); return; }
    if (key.upArrow) return setAt((here - 1 + shown.length) % Math.max(1, shown.length));
    if (key.downArrow || key.tab) return setAt((here + 1) % Math.max(1, shown.length));
    if (!req.filter) return;
    if (key.backspace || key.delete) { setTyped((s) => s.slice(0, -1)); setAt(0); return; }
    if (input && !key.ctrl && !key.meta) { setTyped((s) => s + input); setAt(0); }
  });
  usePaste((text) => { if (req.filter) { setTyped((s) => s + text.replace(/[\r\n]+/g, "")); setAt(0); } });
  const { from, to } = windowOf(shown.length, here, LIST_ROWS);
  return (
    <Box flexDirection="column">
      <Text bold>{req.title}</Text>
      {req.hint ? <Text color={COLOR.dim} wrap="wrap">{req.hint}</Text> : null}
      {req.filter ? <Text>{"› "}{typed}<Text inverse> </Text></Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {from > 0 ? <Text color={COLOR.dim}>  ↑</Text> : null}
        {shown.slice(from, to).map((o, i) => (
          <Text key={`${o.value}-${from + i}`} {...(from + i === here ? { color: COLOR.accent } : {})} wrap="truncate-end">
            {from + i === here ? "▸ " : "  "}{o.label}{o.hint ? <Text color={COLOR.dim}>{"  "}{o.hint}</Text> : null}
          </Text>
        ))}
        {to < shown.length ? <Text color={COLOR.dim}>  ↓</Text> : null}
        {shown.length === 0 ? <Text color={COLOR.dim}>  {t.common.noMatch}</Text> : null}
      </Box>
      <Box marginTop={1}><Text color={COLOR.dim}>{[t.keys.move, t.keys.choose, req.filter ? t.keys.filter : null, t.keys.cancel].filter(Boolean).join("   ")}</Text></Box>
    </Box>
  );
}

/** One line of text being typed: the cursor moves with ← → Home End, Ctrl+U clears, a paste goes in whole (its line
 *  breaks taken out). */
export function useLine(initial: string, active: boolean, onEnter: (v: string) => void, onEscape: () => void): { value: string; cursor: number } {
  const [s, set] = useState({ value: initial, cursor: initial.length });
  useInput((input, key) => {
    if (key.escape) return onEscape();
    if (key.return) return onEnter(s.value);
    if (key.leftArrow) return set({ ...s, cursor: Math.max(0, s.cursor - 1) });
    if (key.rightArrow) return set({ ...s, cursor: Math.min(s.value.length, s.cursor + 1) });
    if (key.home || (key.ctrl && input === "a")) return set({ ...s, cursor: 0 });
    if (key.end || (key.ctrl && input === "e")) return set({ ...s, cursor: s.value.length });
    if (key.ctrl && input === "u") return set({ value: "", cursor: 0 });
    if (key.backspace || key.delete) {
      if (s.cursor === 0) return;
      return set({ value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 });
    }
    if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.tab) {
      const text = input.replace(/[\r\n]+/g, "");
      set({ value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor), cursor: s.cursor + text.length });
    }
  }, { isActive: active });
  usePaste((pasted) => {
    const text = pasted.replace(/[\r\n]+/g, "");
    set((was) => ({ value: was.value.slice(0, was.cursor) + text + was.value.slice(was.cursor), cursor: was.cursor + text.length }));
  }, { isActive: active });
  return s;
}

/** Secrets are shown as dots, no more than this many (how long a key is is not shown either). */
const SECRET_DOTS = 24;

function Asker({ req, done }: { req: AskRequest; done: (v: string | null) => void }) {
  const { t } = useWords();
  const [problem, setProblem] = useState<string | null>(null);
  const line = useLine(req.initial ?? "", true, (v) => {
    const why = req.check?.(v) ?? null;
    if (why) setProblem(why); else done(v);
  }, () => done(null));
  const shown = req.mask ? req.mask(line.value) : line.value;
  const before = req.secret ? "•".repeat(Math.min(line.cursor, SECRET_DOTS)) : shown.slice(0, line.cursor);
  const under = req.secret ? "" : shown.slice(line.cursor, line.cursor + 1);
  const after = req.secret ? "" : shown.slice(line.cursor + 1);
  return (
    <Box flexDirection="column">
      <Text bold>{req.title}</Text>
      {req.hint ? <Text color={COLOR.dim} wrap="wrap">{req.hint}</Text> : null}
      <Box marginTop={1} borderStyle="round" borderColor={COLOR.accent} paddingX={1}>
        <Text wrap="truncate-start">{before}<Text inverse>{under || " "}</Text>{after}</Text>
      </Box>
      {problem ? <Text color={COLOR.error} wrap="wrap">{problem}</Text> : null}
      <Box marginTop={1}><Text color={COLOR.dim}>{[t.keys.done, t.keys.clear, t.keys.cancel].join("   ")}</Text></Box>
    </Box>
  );
}

function Confirmer({ req, done }: { req: ConfirmRequest; done: (v: boolean) => void }) {
  const { t } = useWords();
  const [yes, setYes] = useState(false);
  useInput((input, key) => {
    if (key.escape) return done(false);
    if (key.return) return done(yes);
    if (key.leftArrow || key.rightArrow || key.tab) return setYes((y) => !y);
    if (input === "y" || input === "Y") return done(true);
    if (input === "n" || input === "N") return done(false);
  });
  return (
    <Box flexDirection="column">
      <Text wrap="wrap">{req.text}</Text>
      <Box marginTop={1} gap={2}>
        <Text {...(!yes ? { inverse: true } : {})}>{` ${t.common.cancel} `}</Text>
        <Text {...(yes ? { inverse: true, color: req.danger ? COLOR.error : COLOR.accent } : {})}>{` ${req.yes} `}</Text>
      </Box>
      <Box marginTop={1}><Text color={COLOR.dim}>{["← →", t.keys.choose, t.keys.cancel].join("   ")}</Text></Box>
    </Box>
  );
}

/** A row of a page: a heading, a line said, or something to move to and press (Enter). */
export type Row =
  | { readonly kind: "heading"; readonly label: string }
  | { readonly kind: "note"; readonly text: string; readonly tone?: Tone }
  | { readonly kind: "item"; readonly id: string; readonly label: string; readonly value?: string | undefined; readonly tone?: Tone | undefined;
      /** Shown, but nothing to press (another node's, read only). */ readonly disabled?: boolean; readonly press?: (() => void) | undefined };

/** Rows to move through with ↑ ↓ and press with Enter; Esc (or ←) leaves. The one under the cursor is kept by its id
 *  across a reload, so a list that changes under it does not move it. */
/** Columns a text takes in a terminal: the wide characters of Chinese, Japanese and Korean take two. */
export function cells(text: string): number {
  let n = 0;
  for (const ch of text) n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return n;
}

/** The label column: as wide as the widest label of a row with a value, within bounds. */
const LABEL_MIN = 16, LABEL_MAX = 56;

export function Form({ rows, active, leave, height }: { rows: readonly Row[]; active: boolean; leave?: (() => void) | undefined; height: number }) {
  const labelWidth = Math.min(LABEL_MAX, Math.max(LABEL_MIN, ...rows.map((r) => (r.kind === "item" && r.value !== undefined ? cells(r.label) + 2 : 0))));
  const items = rows.map((r, i) => (r.kind === "item" ? i : -1)).filter((i) => i >= 0);
  const [cursor, setCursor] = useState<string | null>(null);
  const atItem = Math.max(0, items.findIndex((i) => (rows[i] as { id: string }).id === cursor));
  const at = items[atItem] ?? -1;
  const move = (by: number) => {
    if (!items.length) return;
    const next = items[Math.min(items.length - 1, Math.max(0, atItem + by))]!;
    setCursor((rows[next] as { id: string }).id);
  };
  useInput((input, key) => {
    if (key.upArrow) return move(-1);
    if (key.downArrow) return move(1);
    if (key.pageUp) return move(-height);
    if (key.pageDown) return move(height);
    if (key.escape || key.leftArrow) return leave?.();
    if (key.return || input === " ") {
      const row = rows[at];
      if (row?.kind === "item" && !row.disabled) row.press?.();
    }
  }, { isActive: active });
  const { from, to } = windowOf(rows.length, at, Math.max(3, height));
  return (
    <Box flexDirection="column">
      {from > 0 ? <Text color={COLOR.dim}>  ↑</Text> : null}
      {rows.slice(from, to).map((r, i) => {
        const index = from + i;
        if (r.kind === "heading") return <Box key={`h${index}`} marginTop={index === 0 ? 0 : 1}><Text bold>{r.label}</Text></Box>;
        if (r.kind === "note") return <Box key={`n${index}`} paddingLeft={2}><Text color={COLOR[r.tone ?? "dim"]} wrap="wrap">{r.text}</Text></Box>;
        const here = active && index === at;
        return (
          <Box key={r.id}>
            <Box flexShrink={0}><Text {...(here ? { color: COLOR.accent } : r.disabled ? { color: COLOR.dim } : {})}>{here ? "▸ " : "  "}</Text></Box>
            <Box width={r.value === undefined ? undefined : labelWidth} flexShrink={0}>
              <Text {...(here ? { color: COLOR.accent } : r.disabled && r.value === undefined ? { color: COLOR.dim } : {})} wrap="truncate-end">{r.label}</Text>
            </Box>
            {r.value !== undefined ? <Text {...(r.tone ? { color: COLOR[r.tone] } : {})} wrap="truncate-end">{r.value}</Text> : null}
          </Box>
        );
      })}
      {to < rows.length ? <Text color={COLOR.dim}>  ↓</Text> : null}
    </Box>
  );
}

/** What `load` gives, loaded when the page opens and again on `reload`; its error said in its place. */
export function useLoaded<T>(load: () => Promise<T>): { data: T | null; error: string | null; reload: () => Promise<void>; set: (v: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    try { setData(await loadRef.current()); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload, set: setData };
}
