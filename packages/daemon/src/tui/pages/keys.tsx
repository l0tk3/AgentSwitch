/** Keys: this node's gate's key pairs (keeper/gateKeys.ts; the Mac's Settings › Keys). A pair opens to its public key,
 *  making it current, and deleting it — final, asked twice in so many words. Each node's own: with `--on` there is
 *  nothing to show. */

import { useState } from "react";
import { KEY_NAME } from "../../keeper/gateKeys.js";
import type { PageProps } from "../app.js";
import { Form, useLoaded, useUi, useWords, type Row } from "../ui.js";

export function KeysPage(props: PageProps) {
  const { t } = useWords();
  if (props.deps.remote) return <Form rows={[{ kind: "note", text: t.gateKeys.remote }]} active={false} height={props.height} />;
  return <LocalKeys {...props} />;
}

function LocalKeys({ deps, active, leave, height }: PageProps) {
  const { t } = useWords();
  const ui = useUi();
  const keys = useLoaded(() => deps.keys.list());
  const [open, setOpen] = useState<string | null>(null);

  if (keys.error && !keys.data) return <Form rows={[{ kind: "note", text: keys.error, tone: "error" }, { kind: "item", id: "retry", label: t.common.retry, press: () => void keys.reload() }]} active={active} leave={leave} height={height} />;
  if (!keys.data) return <Form rows={[{ kind: "note", text: `${t.common.loading}…` }]} active={false} height={height} />;
  const list = keys.data;

  const key = open ? list.find((k) => k.name === open) : undefined;
  if (key) {
    const rows: Row[] = [
      { kind: "heading", label: `${t.pages.keys} › ${key.name}` },
      { kind: "item", id: "public", label: t.gateKeys.publicKey, value: key.public, disabled: true },
    ];
    if (key.current) rows.push({ kind: "note", text: t.gateKeys.current, tone: "ok" });
    else {
      rows.push({ kind: "item", id: "use", label: t.gateKeys.makeCurrent, press: async () => {
        const next = await ui.run(t.common.saving, () => deps.keys.use(key.name));
        if (next) { keys.set(next); ui.say(t.gateKeys.nowCurrent(key.name)); }
      } });
      rows.push({ kind: "item", id: "delete", label: t.gateKeys.delete, tone: "error", press: async () => {
        if (!(await ui.confirm({ text: t.gateKeys.deleteConfirm(key.name), yes: t.gateKeys.deleteYes, danger: true }))) return;
        const next = await ui.run(t.common.working, () => deps.keys.retire(key.name));
        if (next) { setOpen(null); keys.set(next); ui.say(t.gateKeys.deleted(key.name)); }
      } });
    }
    return <Form rows={rows} active={active} leave={() => setOpen(null)} height={height} />;
  }

  const rows: Row[] = [{ kind: "note", text: t.gateKeys.about }];
  for (const k of list) {
    const marks = [k.current ? t.gateKeys.current : null, k.legacy ? t.gateKeys.legacy : null].filter(Boolean).join(" · ");
    rows.push({ kind: "item", id: k.name, label: k.name, value: `${marks ? `${marks} · ` : ""}${k.public.slice(0, 16)}…`, tone: k.current ? "ok" : undefined, press: () => setOpen(k.name) });
  }
  rows.push({ kind: "item", id: "+", label: t.gateKeys.newKey, press: async () => {
    const name = await ui.ask({ title: t.gateKeys.nameTitle, hint: t.gateKeys.nameHint, check: (v) => (KEY_NAME.test(v.trim()) && !list.some((k) => k.name === v.trim()) ? null : t.gateKeys.nameBad) });
    if (!name) return;
    const use = await ui.confirm({ text: t.gateKeys.makeCurrentTitle, yes: t.gateKeys.makeCurrent });
    const next = await ui.run(t.common.saving, () => deps.keys.create(name.trim(), use));
    if (next) { keys.set(next); ui.say(use ? t.gateKeys.nowCurrent(name.trim()) : t.gateKeys.made(name.trim())); }
  } });
  return <Form rows={rows} active={active} leave={leave} height={height} />;
}
