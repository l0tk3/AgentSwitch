/** Node: this node's own settings — its name, whether paired devices can reach it, whether its terminals outlive a
 *  restart, its four ports (node.json, what the Mac keeps in its preferences; applied by restarting the service), the
 *  language of this screen (node.json, at once), and what the service keeps (whether paired nodes may type, the work
 *  folder; saved at once). Another node's (`--on`) is
 *  shown as it says it is. */

import { useState } from "react";
import { LOCALE_NAMES } from "../../i18n/index.js";
import { DEFAULT_PORTS, type NodeSettings, type Ports } from "../../keeper/plan.js";
import type { PageProps } from "../app.js";
import { portsFrom } from "../text.js";
import { Form, useLoaded, useUi, useWords, type Row } from "../ui.js";

type Draft = { readonly name: string; readonly remote: boolean; readonly holdTerminals: boolean; readonly ports: Readonly<Record<keyof Ports, string>> };

const PORT_KEYS: readonly (keyof Ports)[] = ["local", "remote", "gate", "opencode"];

function draftOf(s: NodeSettings): Draft {
  const ports = { ...DEFAULT_PORTS, ...s.ports };
  return { name: s.name ?? "", remote: s.remote !== false, holdTerminals: s.holdTerminals !== false,
    ports: { local: String(ports.local), remote: String(ports.remote), gate: String(ports.gate), opencode: String(ports.opencode) } };
}

/** node.json with the draft in it: what is the default is left out, everything else kept as it was. */
export function settingsWith(kept: NodeSettings, d: Draft, ports: Ports): NodeSettings {
  const next: Record<string, unknown> = { ...kept };
  if (d.name.trim()) next.name = d.name.trim(); else delete next.name;
  if (d.remote) delete next.remote; else next.remote = false;
  if (d.holdTerminals) delete next.holdTerminals; else next.holdTerminals = false;
  if (PORT_KEYS.every((k) => ports[k] === DEFAULT_PORTS[k])) delete next.ports; else next.ports = ports;
  return next as NodeSettings;
}

export function NodePage(props: PageProps) {
  return props.deps.remote ? <RemoteNode {...props} /> : <LocalNode {...props} />;
}

function RemoteNode({ deps, active, leave, height }: PageProps) {
  const { t } = useWords();
  const { data, error } = useLoaded(() => deps.client.node());
  const rows: Row[] = error ? [{ kind: "note", text: error, tone: "error" }]
    : !data ? [{ kind: "note", text: `${t.common.loading}…` }]
    : [{ kind: "item", id: "name", label: t.node.name, value: data.name, disabled: true },
       { kind: "item", id: "version", label: t.node.version, value: `${data.kind} ${data.version}`, disabled: true },
       { kind: "item", id: "has", label: t.node.has, value: data.has.join(" "), disabled: true }];
  return <Form rows={rows} active={active} leave={leave} height={height} />;
}

function LocalNode({ deps, active, leave, height, chooseLanguage }: PageProps) {
  const { t, locale } = useWords();
  const ui = useUi();
  const [first] = useState<{ settings: NodeSettings | null; error: string | null }>(() => { try { return { settings: deps.node.read(), error: null }; } catch (err) { return { settings: null, error: (err as Error).message }; } });
  const [kept, setKept] = useState<NodeSettings | null>(first.settings);
  const [draft, setDraft] = useState<Draft>(() => draftOf(kept ?? {}));
  const mesh = useLoaded(() => deps.client.mesh());
  const workdir = useLoaded(() => deps.client.workdir());

  const saved = draftOf(kept ?? {});
  const changed = JSON.stringify(saved) !== JSON.stringify(draft);
  const ports = portsFrom(draft.ports);
  const portProblem = ports === "number" ? t.node.portNumber : ports === "range" ? t.node.portRange : ports === "distinct" ? t.node.portDistinct : null;
  const onOff = (v: boolean) => (v ? t.common.on : t.common.off);

  const rows: Row[] = [
    ...(first.error ? [{ kind: "note", text: first.error, tone: "error" } as const] : []),
    { kind: "item", id: "name", label: t.node.name, value: draft.name || t.node.hostName, tone: draft.name ? undefined : "dim", press: async () => {
      const typed = await ui.ask({ title: t.node.name, hint: t.node.nameHint, initial: draft.name });
      if (typed !== null) setDraft({ ...draft, name: typed.trim() });
    } },
    { kind: "item", id: "remote", label: t.node.remote, value: onOff(draft.remote), press: () => setDraft({ ...draft, remote: !draft.remote }) },
    { kind: "item", id: "hold", label: t.node.holdTerminals, value: onOff(draft.holdTerminals), press: () => setDraft({ ...draft, holdTerminals: !draft.holdTerminals }) },
    { kind: "item", id: "language", label: t.app.language, value: LOCALE_NAMES[locale], press: chooseLanguage },
    { kind: "heading", label: t.node.ports },
    ...PORT_KEYS.map((k): Row => {
      const label = { local: t.node.portLocal, remote: t.node.portRemote, gate: t.node.portGate, opencode: t.node.portOpencode }[k];
      return { kind: "item", id: `port-${k}`, label, value: draft.ports[k], press: async () => {
        const typed = await ui.ask({ title: label, hint: t.node.portHint, initial: draft.ports[k], check: (v) => (/^\d+$/.test(v.trim()) ? null : t.node.portNumber) });
        if (typed !== null) setDraft({ ...draft, ports: { ...draft.ports, [k]: typed.trim() } });
      } };
    }),
  ];
  if (portProblem) rows.push({ kind: "note", text: portProblem, tone: "error" });
  if (changed && kept) {
    rows.push({ kind: "note", text: t.node.unsaved, tone: "warn" });
    if (!portProblem) rows.push({ kind: "item", id: "save", label: t.node.saveRestart, tone: "accent", press: () => {
      try {
        const next = settingsWith(deps.node.read(), draft, ports as Ports);
        deps.node.write(next);
        setKept(next);
        const ok = deps.node.restart();
        ui.say(ok ? t.common.restarting : t.common.noKeeper, ok ? "ok" : "warn");
      } catch (err) { ui.say((err as Error).message, "error"); }
    } });
  }
  rows.push({ kind: "heading", label: t.node.service });
  rows.push(mesh.data
    ? { kind: "item", id: "keyboard", label: t.node.keyboard, value: onOff(mesh.data.keyboard), press: async () => {
        const next = { keyboard: !mesh.data!.keyboard };
        const ok = await ui.run(t.common.saving, async () => { await deps.client.setMesh(next); return true; });
        if (ok) { await mesh.reload(); ui.say(`${t.node.keyboard}: ${onOff(next.keyboard)}`); }
      } }
    : { kind: "note", text: mesh.error ?? `${t.common.loading}…`, tone: mesh.error ? "error" : "dim" });
  // Tool terminals for paired nodes (docs/yazi-v0.md §3): asked before it goes on, yazi runs shell commands.
  if (mesh.data && mesh.data.tools !== undefined) {
    const tools = mesh.data.tools;
    rows.push({ kind: "item", id: "tools", label: t.node.tools, value: onOff(tools), tone: tools ? "warn" : undefined, press: async () => {
      if (!tools && !(await ui.confirm({ text: t.node.toolsConfirm, yes: t.node.toolsYes, danger: true }))) return;
      const next = { tools: !tools };
      const ok = await ui.run(t.common.saving, async () => { await deps.client.setMesh(next); return true; });
      if (ok) { await mesh.reload(); ui.say(`${t.node.tools}: ${onOff(next.tools)}`); }
    } });
  }
  rows.push(workdir.data
    ? { kind: "item", id: "workdir", label: t.node.workFolder, value: workdir.data.path, press: async () => {
        const typed = await ui.ask({ title: t.node.workFolder, hint: t.node.workFolderHint, initial: workdir.data!.path, check: (v) => (v.trim() ? null : t.node.workFolderHint) });
        if (typed === null || typed.trim() === workdir.data!.path) return;
        const ok = await ui.run(t.common.saving, async () => { await deps.client.setWorkdir(typed.trim()); return true; });
        if (ok) { await workdir.reload(); ui.say(`${t.node.workFolder}: ${typed.trim()}`); }
      } }
    : { kind: "note", text: workdir.error ?? `${t.common.loading}…`, tone: workdir.error ? "error" : "dim" });
  if (workdir.data?.problem) rows.push({ kind: "note", text: workdir.data.problem, tone: "warn" });
  return <Form rows={rows} active={active} leave={leave} height={height} />;
}
