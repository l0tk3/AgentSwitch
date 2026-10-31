/** Extensions: the MCP servers and skills handed to every executor (src/extensions; the Mac's Dispatch › Extensions).
 *  A server opens to its switch, the agents it goes to, Claude Code's approval for its tools, and the rest of it as
 *  JSON in the user's editor (what the Mac's sheet has field by field); a skill to its switch, its agents and its
 *  SKILL.md in the editor. New ones are named first and written in the editor; skills found in the agents' own folders
 *  can be imported. */

import { useState } from "react";
import type { McpServer, Skill } from "../../extensions/types.js";
import { HARNESSES, NAME_RE, RESERVED_NAMES } from "../../extensions/types.js";
import type { Messages } from "../../i18n/index.js";
import type { PageProps } from "../app.js";
import type { ConfigDeps, McpServerInput } from "../deps.js";
import { agentName } from "../names.js";
import { Form, useLoaded, useUi, useWords, type Row, type Ui } from "../ui.js";

/** A new server as first shown in the editor. */
const SERVER_TEMPLATE = { kind: "stdio", command: "npx", args: ["-y", "some-mcp-server"], env: {}, note: "" };
const SKILL_TEMPLATE = (name: string) => `---\nname: ${name}\ndescription: \n---\n\n`;

/** A server as edited: all but its name, its switch and its agents (rows of their own). */
function editable(s: McpServer): Record<string, unknown> {
  const { name: _name, enabled: _enabled, harnesses: _harnesses, ...rest } = s;
  return rest;
}

/** A server's JSON edited and sent; null when unchanged, not JSON, or not sent. */
async function editServer(t: Messages, ui: Ui, deps: ConfigDeps, name: string, start: Record<string, unknown>, keep: Partial<McpServer>): Promise<boolean> {
  const before = `${JSON.stringify(start, null, 2)}\n`;
  let text: string;
  try { text = await ui.external(() => deps.edit(before, `${name}.json`)); }
  catch (err) { ui.say(t.context.editorFailed((err as Error).message), "error"); return false; }
  if (text === before && Object.keys(keep).length) { ui.say(t.context.unchanged, "dim"); return false; }
  let body: Record<string, unknown>;
  try { body = JSON.parse(text) as Record<string, unknown>; }
  catch (err) { ui.say(t.extensions.jsonBad((err as Error).message), "error"); return false; }
  const ok = await ui.run(t.common.saving, async () => { await deps.client.putMcp({ ...body, ...keep, name } as McpServerInput); return true; });
  if (ok) ui.say(t.extensions.saved);
  return ok === true;
}

function nameCheck(t: Messages, taken: readonly string[]) {
  return (v: string): string | null => (!NAME_RE.test(v.trim()) ? t.extensions.nameBad : taken.includes(v.trim()) || RESERVED_NAMES.has(v.trim()) ? t.extensions.nameTaken : null);
}

/** The agents something goes to, one row each, switched on and off. */
function agentRows(t: Messages, on: readonly string[], ro: boolean, set: (next: string[]) => void): Row[] {
  return [{ kind: "heading", label: t.extensions.agents }, ...HARNESSES.map((h): Row => ({
    kind: "item", id: `agent-${h}`, label: agentName(h), value: on.includes(h) ? t.common.on : t.common.off, tone: on.includes(h) ? "ok" : "dim", disabled: ro,
    press: () => set(on.includes(h) ? on.filter((x) => x !== h) : [...on, h]),
  }))];
}

export function ExtensionsPage({ deps, active, leave, height }: PageProps) {
  const { t } = useWords();
  const ui = useUi();
  const ro = deps.remote !== null;
  const servers = useLoaded(() => deps.client.mcp());
  const skills = useLoaded(() => deps.client.skills());
  const [open, setOpen] = useState<{ kind: "server" | "skill"; name: string } | null>(null);

  const server = open?.kind === "server" ? servers.data?.find((s) => s.name === open.name) : undefined;
  if (server) return <Form rows={serverRows(t, ui, deps, server, ro, servers.reload, () => setOpen(null))} active={active} leave={() => setOpen(null)} height={height} />;
  const skill = open?.kind === "skill" ? skills.data?.find((s) => s.name === open.name) : undefined;
  if (skill) return <Form rows={skillRows(t, ui, deps, skill, ro, skills.reload, () => setOpen(null))} active={active} leave={() => setOpen(null)} height={height} />;

  const rows: Row[] = [{ kind: "note", text: t.extensions.about }, { kind: "heading", label: t.extensions.servers }];
  if (servers.data) {
    for (const s of servers.data) {
      const what = s.kind === "stdio" ? [s.command, ...s.args].join(" ") : s.url ?? "";
      rows.push({ kind: "item", id: `server-${s.name}`, label: s.name, value: `${s.enabled ? t.common.on : t.common.off} · ${what}`, tone: s.enabled ? undefined : "dim", press: () => setOpen({ kind: "server", name: s.name }) });
    }
    if (!ro) rows.push({ kind: "item", id: "server+", label: t.extensions.addServer, press: async () => {
      const name = await ui.ask({ title: t.extensions.serverName, hint: t.extensions.nameHint, check: nameCheck(t, servers.data!.map((s) => s.name)) });
      if (!name) return;
      ui.say(t.extensions.secretsHint, "dim");
      if (await editServer(t, ui, deps, name.trim(), SERVER_TEMPLATE, {})) { await servers.reload(); setOpen({ kind: "server", name: name.trim() }); }
    } });
  } else rows.push({ kind: "note", text: servers.error ?? `${t.common.loading}…`, tone: servers.error ? "error" : "dim" });

  rows.push({ kind: "heading", label: t.extensions.skills });
  if (skills.data) {
    for (const s of skills.data) {
      rows.push({ kind: "item", id: `skill-${s.name}`, label: s.name, value: `${s.enabled ? t.common.on : t.common.off} · ${s.description || t.extensions.noDescription}`, tone: s.enabled ? undefined : "dim", press: () => setOpen({ kind: "skill", name: s.name }) });
    }
    if (!ro) {
      rows.push({ kind: "item", id: "skill+", label: t.extensions.newSkill, press: async () => {
        const name = await ui.ask({ title: t.extensions.skillName, hint: t.extensions.nameHint, check: nameCheck(t, skills.data!.map((s) => s.name)) });
        if (!name) return;
        let content: string;
        try { content = await ui.external(() => deps.edit(SKILL_TEMPLATE(name.trim()), "SKILL.md")); }
        catch (err) { ui.say(t.context.editorFailed((err as Error).message), "error"); return; }
        const ok = await ui.run(t.common.saving, async () => { await deps.client.putSkill(name.trim(), { content }); return true; });
        if (ok) { await skills.reload(); setOpen({ kind: "skill", name: name.trim() }); ui.say(t.extensions.saved); }
      } });
      rows.push({ kind: "item", id: "skill-import", label: t.extensions.importSkill, press: async () => {
        const found = await ui.run(t.common.loading, () => deps.client.discoverSkills());
        if (!found) return;
        const choices = found.filter((s) => !s.installed);
        if (!choices.length) { ui.say(t.extensions.nothingToImport, "dim"); return; }
        const path = await ui.pick({ title: t.extensions.importTitle, hint: t.extensions.importHint, filter: true,
          options: choices.map((s) => ({ value: s.path, label: s.name, hint: `${s.source} · ${s.description || t.extensions.noDescription}` })) });
        if (!path) return;
        const ok = await ui.run(t.common.saving, async () => { await deps.client.importSkill(path); return true; });
        if (ok) { await skills.reload(); ui.say(t.extensions.imported(choices.find((s) => s.path === path)!.name)); }
      } });
    }
  } else rows.push({ kind: "note", text: skills.error ?? `${t.common.loading}…`, tone: skills.error ? "error" : "dim" });
  return <Form rows={rows} active={active} leave={leave} height={height} />;
}

function serverRows(t: Messages, ui: Ui, deps: ConfigDeps, s: McpServer, ro: boolean, reload: () => Promise<void>, close: () => void): Row[] {
  const put = async (change: Partial<McpServer>) => {
    const ok = await ui.run(t.common.saving, async () => { await deps.client.putMcp({ ...s, ...change }); return true; });
    if (ok) { await reload(); ui.say(t.extensions.saved); }
  };
  return [
    { kind: "heading", label: `${t.extensions.servers} › ${s.name}` },
    { kind: "item", id: "enabled", label: t.extensions.enabled, value: s.enabled ? t.common.on : t.common.off, disabled: ro, press: () => void put({ enabled: !s.enabled }) },
    { kind: "item", id: "approval", label: t.extensions.approval, value: s.approval === "allow" ? t.extensions.approvalAllow : t.extensions.approvalAsk, disabled: ro,
      press: () => void put({ approval: s.approval === "allow" ? "ask" : "allow" }) },
    { kind: "item", id: "edit", label: t.extensions.edit, value: s.kind === "stdio" ? [s.command, ...s.args].join(" ") : s.url ?? "", disabled: ro, press: async () => {
      ui.say(t.extensions.secretsHint, "dim");
      if (await editServer(t, ui, deps, s.name, editable(s), { enabled: s.enabled, harnesses: s.harnesses })) await reload();
    } },
    ...(s.note ? [{ kind: "note", text: s.note } as const] : []),
    ...agentRows(t, s.harnesses, ro, (next) => void put({ harnesses: next as McpServer["harnesses"] })),
    { kind: "item", id: "delete", label: t.extensions.delete, tone: "error", disabled: ro, press: async () => {
      if (!(await ui.confirm({ text: t.extensions.deleteConfirm(s.name), yes: t.extensions.deleteYes, danger: true }))) return;
      const ok = await ui.run(t.common.working, async () => { await deps.client.removeMcp(s.name); return true; });
      if (ok) { close(); await reload(); ui.say(t.extensions.deleted(s.name)); }
    } },
  ];
}

function skillRows(t: Messages, ui: Ui, deps: ConfigDeps, s: Skill, ro: boolean, reload: () => Promise<void>, close: () => void): Row[] {
  const put = async (change: { enabled?: boolean; harnesses?: string[]; content?: string }) => {
    const ok = await ui.run(t.common.saving, async () => { await deps.client.putSkill(s.name, change); return true; });
    if (ok) { await reload(); ui.say(t.extensions.saved); }
  };
  return [
    { kind: "heading", label: `${t.extensions.skills} › ${s.name}` },
    { kind: "note", text: s.description || t.extensions.noDescription },
    { kind: "item", id: "enabled", label: t.extensions.enabled, value: s.enabled ? t.common.on : t.common.off, disabled: ro, press: () => void put({ enabled: !s.enabled }) },
    { kind: "item", id: "edit", label: t.extensions.editSkill, value: s.path, disabled: ro, press: async () => {
      const full = await ui.run(t.common.loading, () => deps.client.skill(s.name));
      if (!full) return;
      let content: string;
      try { content = await ui.external(() => deps.edit(full.content, "SKILL.md")); }
      catch (err) { ui.say(t.context.editorFailed((err as Error).message), "error"); return; }
      if (content === full.content) { ui.say(t.context.unchanged, "dim"); return; }
      await put({ content });
    } },
    ...agentRows(t, s.harnesses, ro, (next) => void put({ harnesses: next })),
    { kind: "item", id: "delete", label: t.extensions.delete, tone: "error", disabled: ro, press: async () => {
      if (!(await ui.confirm({ text: t.extensions.deleteConfirm(s.name), yes: t.extensions.deleteYes, danger: true }))) return;
      const ok = await ui.run(t.common.working, async () => { await deps.client.removeSkill(s.name); return true; });
      if (ok) { close(); await reload(); ui.say(t.extensions.deleted(s.name)); }
    } },
  ];
}
