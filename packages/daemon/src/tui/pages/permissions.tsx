/** Permissions: who answers an executor's approvals (docs/supervisor-v0.md §1b, docs/control-v0.md §1; the Mac's
 *  Settings › Permissions) — you, the dispatch model, the dispatch model but for the kinds you keep, or nobody (Bypass,
 *  asked twice). Saved at once. The kinds are named in this screen's language by their ids; the service's own title is
 *  the fallback for a kind this screen does not know yet. */

import type { PageProps } from "../app.js";
import type { PolicyMode } from "../deps.js";
import { Form, useLoaded, useUi, useWords, type Row } from "../ui.js";

const MODES: readonly PolicyMode[] = ["manual", "auto", "scoped", "skip"];

export function PermissionsPage({ deps, active, leave, height }: PageProps) {
  const { t } = useWords();
  const ui = useUi();
  const { data, error, reload } = useLoaded(() => deps.client.policy());
  const ro = deps.remote !== null;

  if (error && !data) return <Form rows={[{ kind: "note", text: error, tone: "error" }, { kind: "item", id: "retry", label: t.common.retry, press: () => void reload() }]} active={active} leave={leave} height={height} />;
  if (!data) return <Form rows={[{ kind: "note", text: `${t.common.loading}…` }]} active={false} height={height} />;

  const mode = data.policy.mode as PolicyMode;
  const save = async (next: { mode: PolicyMode; human: string[] }) => {
    const ok = await ui.run(t.common.saving, async () => { await deps.client.setPolicy(next); return true; });
    if (ok) { await reload(); ui.say(`${t.permissions.mode}: ${t.permissions.modes[next.mode] ?? next.mode}`); }
  };
  const rows: Row[] = [
    { kind: "item", id: "mode", label: t.permissions.mode, value: t.permissions.modes[mode] ?? mode, tone: mode === "skip" ? "error" : undefined, disabled: ro, press: async () => {
      const chosen = await ui.pick({ title: t.permissions.mode, initial: mode, options: MODES.map((m) => ({ value: m, label: t.permissions.modes[m] ?? m, hint: t.permissions.modeHints[m] })) }) as PolicyMode | null;
      if (!chosen || chosen === mode) return;
      if (chosen === "skip" && !(await ui.confirm({ text: t.permissions.skipConfirm, yes: t.permissions.skipYes, danger: true }))) return;
      await save({ mode: chosen, human: data.policy.human });
    } },
    { kind: "note", text: t.permissions.modeHints[mode] ?? "" },
  ];
  if (mode === "scoped") {
    rows.push({ kind: "heading", label: t.permissions.youAnswer });
    for (const c of data.categories) {
      const kept = data.policy.human.includes(c.id);
      rows.push({ kind: "item", id: c.id, label: t.permissions.categories[c.id] ?? c.title, value: kept ? t.common.on : t.common.off, tone: kept ? "ok" : "dim", disabled: ro, press: () => {
        void save({ mode, human: kept ? data.policy.human.filter((h) => h !== c.id) : [...data.policy.human, c.id] });
      } });
    }
  }
  return <Form rows={rows} active={active} leave={leave} height={height} />;
}
