/** Context: what dispatch reads before every task (CONTEXT.md), the facts the summarizer added (MEMORY.md), and what it
 *  learned of the sites it worked on — the Mac's Dispatch › Context. The two files are edited in the user's own editor
 *  and saved whole; the service seals what looks like a credential in CONTEXT.md and says which lines it would not
 *  keep. Another node's (`--on`) can be read, not changed. */

import type { Messages } from "../../i18n/index.js";
import type { PageProps } from "../app.js";
import type { ConfigDeps } from "../deps.js";
import { Form, useLoaded, useUi, useWords, type Row, type Ui } from "../ui.js";

/** How much of a learned fact its row shows. */
const FACT_CHARS = 80;

const lineCount = (text: string): number => (text.trim() ? text.trimEnd().split("\n").length : 0);
const hostOf = (origin: string): string => { try { return new URL(origin).host; } catch { return origin; } };

/** `text` edited and saved by `save` when it changed; what the service said of it on the status line. */
async function editAndSave(t: Messages, ui: Ui, deps: ConfigDeps, text: string, name: string,
                           save: (next: string) => Promise<{ warnings: string[]; sealed?: { label: string }[] }>): Promise<boolean> {
  let next: string;
  try { next = await ui.external(() => deps.edit(text, name)); }
  catch (err) { ui.say(t.context.editorFailed((err as Error).message), "error"); return false; }
  if (next === text) { ui.say(t.context.unchanged, "dim"); return false; }
  const r = await ui.run(t.common.saving, () => save(next));
  if (!r) return false;
  const sealed = r.sealed?.length ?? 0;
  ui.say([sealed ? t.context.sealed(sealed) : t.context.saved, ...r.warnings].join(" "), r.warnings.length ? "warn" : "ok");
  return true;
}

export function ContextPage({ deps, active, leave, height }: PageProps) {
  const { t } = useWords();
  const ui = useUi();
  const ro = deps.remote !== null;
  const context = useLoaded(() => deps.client.context());
  const memory = useLoaded(() => deps.client.memory());
  const facts = useLoaded(() => deps.client.platformMemory());

  const rows: Row[] = [{ kind: "heading", label: "CONTEXT.md" }, { kind: "note", text: t.context.contextAbout }];
  if (context.data) {
    const c = context.data;
    rows.push({ kind: "item", id: "context", label: c.path, value: t.context.lines(lineCount(c.text)), disabled: ro, press: async () => {
      if (await editAndSave(t, ui, deps, c.text, "CONTEXT.md", (next) => deps.client.putContext(next))) await context.reload();
    } });
    for (const w of c.warnings) rows.push({ kind: "note", text: w, tone: "warn" });
  } else rows.push({ kind: "note", text: context.error ?? `${t.common.loading}…`, tone: context.error ? "error" : "dim" });

  rows.push({ kind: "heading", label: "MEMORY.md" }, { kind: "note", text: t.context.memoryAbout });
  if (memory.data) {
    const m = memory.data;
    rows.push({ kind: "item", id: "memory", label: m.path, value: t.context.lines(lineCount(m.text)), disabled: ro, press: async () => {
      if (await editAndSave(t, ui, deps, m.text, "MEMORY.md", (next) => deps.client.putMemory(next))) await memory.reload();
    } });
    for (const w of m.warnings) rows.push({ kind: "note", text: w, tone: "warn" });
  } else rows.push({ kind: "note", text: memory.error ?? `${t.common.loading}…`, tone: memory.error ? "error" : "dim" });

  rows.push({ kind: "heading", label: t.context.experience }, { kind: "note", text: t.context.experienceAbout });
  if (facts.data) {
    if (!facts.data.records.length) rows.push({ kind: "note", text: t.context.none });
    for (const f of facts.data.records) {
      const text = f.text.length > FACT_CHARS ? `${f.text.slice(0, FACT_CHARS - 1)}…` : f.text;
      rows.push({ kind: "item", id: `fact-${f.id}`, label: hostOf(f.origin), value: text, tone: f.status === "verified" ? undefined : "dim", disabled: ro, press: async () => {
        if (!(await ui.confirm({ text: t.context.forgetConfirm(f.text), yes: t.context.forgetYes, danger: true }))) return;
        const ok = await ui.run(t.common.working, async () => { await deps.client.forgetPlatformMemory(f.id); return true; });
        if (ok) { await facts.reload(); ui.say(t.context.forgotten); }
      } });
    }
  } else rows.push({ kind: "note", text: facts.error ?? `${t.common.loading}…`, tone: facts.error ? "error" : "dim" });
  return <Form rows={rows} active={active} leave={leave} height={height} />;
}
