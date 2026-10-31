/** Agents: every agent's profiles (docs/profiles-v0.md), what the Mac's Settings › Agents does. A profile opens to its
 *  own rows — for one that pays by a key, its vendor, address, model (chosen from what the address lists), key and a
 *  connection test (docs/tui-v0.md §3); its proxy and where it lets traffic out; Claude Code's session key and
 *  telemetry; its colour; deleting it. Whatever is typed that is secret — a key, a proxy's password, a session key — is
 *  sealed by this node's gate before it leaves this process; the service gets the ciphertext. */

import { useState } from "react";
import type { Messages } from "../../i18n/index.js";
import { sealHost } from "../../keeper/profiles.js";
import type { ModelProbe } from "../../profiles/apiKeys.js";
import { API_HOME, apiAddress, PROFILE_AGENTS, PROFILE_COLORS, type Profile, type ProfileAgent } from "../../profiles/store.js";
import { VENDORS, vendorOf } from "../../profiles/vendors.js";
import type { PageProps } from "../app.js";
import type { Agents } from "../deps.js";
import { agentName } from "../names.js";
import { cleanSessionKey, proxySite, SESSION_KEY_SITE, splitProxy, validSessionKey } from "../text.js";
import { Form, useLoaded, useUi, useWords, type Row, type Tone, type Ui } from "../ui.js";

/** The longest name a profile has (profiles/store.ts). */
const NAME_MAX = 40;
const CUSTOM = "custom";

export function describeProbe(t: Messages, probe: ModelProbe): { text: string; tone: Tone } {
  if ("models" in probe) return { text: t.agents.probeModels(probe.models.length), tone: "ok" };
  if ("refused" in probe) return { text: t.agents.probeRefused(probe.refused), tone: "error" };
  if ("unlisted" in probe) return { text: t.agents.probeUnlisted, tone: "warn" };
  if ("status" in probe) return { text: t.agents.probeStatus(probe.status), tone: "error" };
  return { text: t.agents.probeUnreachable(probe.unreachable), tone: "error" };
}

/** How a profile signs in, in a few words. */
function how(t: Messages, agent: ProfileAgent, p: Profile): string {
  if (p.kind === "api") return t.agents.apiKeyAt(new URL(p.api?.baseUrl ?? API_HOME[agent] ?? "https://invalid.invalid").host) + (p.api?.model ? ` · ${p.api.model}` : "");
  if (p.id === "default") return t.agents.thisMachine;
  return p.account ? t.agents.signedInAs(p.account) : t.agents.notSignedIn;
}

export function AgentsPage({ deps, active, leave, height }: PageProps) {
  const { t } = useWords();
  const ui = useUi();
  const { data, error, reload } = useLoaded(async () => (await deps.client.profiles()).agents);
  const [open, setOpen] = useState<{ agent: ProfileAgent; id: string } | null>(null);
  const ro = deps.remote !== null;

  if (error && !data) return <Form rows={[{ kind: "note", text: error, tone: "error" }, { kind: "item", id: "retry", label: t.common.retry, press: () => void reload() }]} active={active} leave={leave} height={height} />;
  if (!data) return <Form rows={[{ kind: "note", text: `${t.common.loading}…` }]} active={false} height={height} />;

  const profile = open ? data[open.agent]?.profiles.find((p) => p.id === open.id) : undefined;
  if (open && profile) {
    return <Form rows={profileRows(t, ui, deps, open.agent, profile, ro, reload, () => setOpen(null))} active={active} leave={() => setOpen(null)} height={height} />;
  }

  const rows: Row[] = [];
  for (const agent of PROFILE_AGENTS) {
    const a = data[agent];
    if (!a) continue;
    rows.push({ kind: "heading", label: agentName(agent) });
    for (const p of a.profiles) {
      const proxy = p.proxy ? `  ${t.agents.viaProxy(p.exit ? t.agents.exitAt(p.exit.ip, p.exit.place) : new URL(p.proxy.server).host)}` : "";
      rows.push({ kind: "item", id: `${agent}/${p.id}`, label: p.name, value: `${how(t, agent, p)}${proxy}`, press: () => setOpen({ agent, id: p.id }) });
    }
    if (!a.kinds.length) rows.push({ kind: "note", text: t.agents.defaultOnly });
    else if (!ro && a.creatable) rows.push({ kind: "item", id: `${agent}/+`, label: t.agents.newProfile, press: () => void newProfile(t, ui, deps, agent, data, reload, setOpen) });
  }
  return <Form rows={rows} active={active} leave={leave} height={height} />;
}

function profileRows(t: Messages, ui: Ui, deps: PageProps["deps"], agent: ProfileAgent, p: Profile, ro: boolean, reload: () => Promise<void>, close: () => void): Row[] {
  const c = deps.client;
  const done = async (said: string, tone: Tone = "ok") => { await reload(); ui.say(said, tone); };
  const rows: Row[] = [{ kind: "heading", label: `${agentName(agent)} › ${p.name}` }];
  rows.push({ kind: "item", id: "kind", label: t.agents.signIn, value: p.kind === "api" ? t.agents.apiKey : p.id === "default" ? t.agents.thisMachine : p.account ?? t.agents.notSignedIn, disabled: true });
  if (p.kind === "api") {
    const vendor = vendorOf(agent, p.api?.baseUrl);
    rows.push({ kind: "item", id: "vendor", label: t.agents.vendor, value: vendor?.name ?? t.agents.custom, disabled: ro, press: async () => {
      const baseUrl = await askVendor(t, ui, agent, p.api?.baseUrl);
      if (baseUrl === null) return;
      await saveApi(t, ui, deps, agent, p, { baseUrl }, done);
    } });
    rows.push({ kind: "item", id: "base", label: t.agents.baseUrl, value: p.api?.baseUrl ?? API_HOME[agent] ?? "", tone: p.api?.baseUrl ? undefined : "dim", disabled: ro, press: async () => {
      const baseUrl = await askBaseUrl(t, ui, agent, p.api?.baseUrl);
      if (baseUrl === null) return;
      await saveApi(t, ui, deps, agent, p, { baseUrl }, done);
    } });
    rows.push({ kind: "item", id: "model", label: t.agents.model, value: p.api?.model ?? t.agents.agentsOwnModel, tone: p.api?.model ? undefined : "dim", disabled: ro, press: async () => {
      const chosen = await chooseModel(t, ui, deps, agent, { profile: p.id, ...(p.api?.baseUrl ? { baseUrl: p.api.baseUrl } : {}) }, p.api?.model);
      if (!chosen) return;
      await saveApi(t, ui, deps, agent, p, { model: chosen.model, force: chosen.force }, done);
    } });
    rows.push({ kind: "item", id: "key", label: t.agents.apiKey, value: t.agents.kept, disabled: ro, press: async () => {
      await saveApi(t, ui, deps, agent, p, { newKey: true }, done);
    } });
    rows.push({ kind: "item", id: "test", label: t.agents.testConnection, disabled: ro, press: async () => {
      const probe = await ui.run(t.agents.listing, () => c.profileModels(agent, { profile: p.id, ...(p.api?.baseUrl ? { baseUrl: p.api.baseUrl } : {}) }));
      if (probe) { const d = describeProbe(t, probe); ui.say(d.text, d.tone); }
    } });
  }
  if (agent === "claude-code" && p.kind === "subscription") {
    rows.push({ kind: "item", id: "session", label: t.agents.sessionKey, value: p.sessionKey ? t.agents.kept : t.agents.notSet, tone: p.sessionKey ? undefined : "dim", disabled: ro, press: async () => {
      const typed = await ui.ask({ title: t.agents.sessionKeyTitle, hint: t.agents.sessionKeyHint, secret: true, check: (v) => (!v.trim() || validSessionKey(v) ? null : t.agents.sessionKeyBad) });
      if (typed === null || (!typed.trim() && !p.sessionKey)) return;
      const ok = await ui.run(t.common.saving, async () => {
        const sealed = typed.trim() ? await deps.seal("profile/session-key", SESSION_KEY_SITE, cleanSessionKey(typed)) : null;
        await c.setProfileSessionKey(agent, p.id, sealed);
        return true;
      });
      if (ok) await done(t.agents.saved);
    } });
  }
  rows.push({ kind: "item", id: "proxy", label: t.agents.proxy, value: p.proxy ? `${p.proxy.server}${p.proxy.username ? ` · ${p.proxy.username}` : ""}` : t.agents.direct, tone: p.proxy ? undefined : "dim", disabled: ro, press: async () => {
    await setProxy(t, ui, deps, agent, p, done);
  } });
  if (p.proxy) {
    rows.push({ kind: "item", id: "exit", label: t.agents.exit, value: p.exit ? t.agents.exitAt(p.exit.ip, p.exit.place) : t.agents.notChecked, tone: p.exit ? undefined : "dim", disabled: ro, press: async () => {
      const r = await ui.run(t.agents.checking, () => c.checkProfile(agent, p.id));
      if (r) await done(r.problem ?? t.agents.exitAt(...exitOf(r.agents, agent, p.id)), r.problem ? "warn" : "ok");
    } });
  }
  if (agent === "claude-code") {
    rows.push({ kind: "item", id: "telemetry", label: t.agents.telemetry, value: p.telemetry === false ? t.common.off : t.common.on, disabled: ro, press: async () => {
      const ok = await ui.run(t.common.saving, async () => { await c.setProfileTelemetry(agent, p.id, p.telemetry === false); return true; });
      if (ok) await done(t.agents.saved);
    } });
  }
  if (p.id !== "default") {
    rows.push({ kind: "item", id: "color", label: t.agents.color, value: p.color ? t.agents.colors[p.color] ?? p.color : "", disabled: ro, press: async () => {
      const color = await ui.pick({ title: t.agents.colorTitle, options: PROFILE_COLORS.map((k) => ({ value: k, label: t.agents.colors[k] ?? k })), initial: p.color });
      if (!color || color === p.color) return;
      const ok = await ui.run(t.common.saving, async () => { await c.setProfileColor(agent, p.id, color); return true; });
      if (ok) await done(`${p.name}: ${t.agents.colors[color] ?? color}`);
    } });
    rows.push({ kind: "item", id: "delete", label: t.agents.delete, tone: "error", disabled: ro, press: async () => {
      if (!(await ui.confirm({ text: t.agents.deleteConfirm(p.name), yes: t.agents.deleteYes, danger: true }))) return;
      const ok = await ui.run(t.common.working, async () => { await c.removeProfile(agent, p.id); return true; });
      if (ok) { close(); await done(t.agents.deleted(p.name)); }
    } });
  }
  return rows;
}

function exitOf(agents: Agents, agent: ProfileAgent, id: string): [string, string | null] {
  const exit = agents[agent]?.profiles.find((p) => p.id === id)?.exit;
  return [exit?.ip ?? "", exit?.place ?? null];
}

/** The vendor's address, or one typed (Custom); undefined: the agent's own vendor; null: not chosen. */
async function askVendor(t: Messages, ui: Ui, agent: ProfileAgent, kept: string | undefined): Promise<string | undefined | null> {
  const list = VENDORS[agent] ?? [];
  const now = vendorOf(agent, kept);
  const chosen = await ui.pick({ title: t.agents.vendorTitle, hint: t.agents.vendorHint, initial: now?.id ?? CUSTOM,
    options: [...list.map((v) => ({ value: v.id, label: v.name, hint: v.baseUrl })), { value: CUSTOM, label: t.agents.custom }] });
  if (!chosen) return null;
  if (chosen === CUSTOM) return askBaseUrl(t, ui, agent, kept);
  const v = list.find((x) => x.id === chosen)!;
  return v.baseUrl === API_HOME[agent] ? undefined : v.baseUrl;
}

/** An address typed: undefined for none (the vendor's own), null when not typed. */
async function askBaseUrl(t: Messages, ui: Ui, agent: ProfileAgent, kept: string | undefined): Promise<string | undefined | null> {
  const typed = await ui.ask({ title: t.agents.baseUrlTitle, hint: t.agents.baseUrlHint(API_HOME[agent] ?? ""), initial: kept ?? "",
    check: (v) => (!v.trim() || apiAddress(v) ? null : t.agents.baseUrlBad) });
  if (typed === null) return null;
  if (!typed.trim()) return undefined;
  const kept2 = apiAddress(typed)!;
  return kept2 === API_HOME[agent] ? undefined : kept2;
}

/** A model chosen from what the address lists, or typed when it lists none; `force` when one it does not list is kept
 *  anyway. Empty: the agent's own. Null: not chosen. */
async function chooseModel(t: Messages, ui: Ui, deps: PageProps["deps"], agent: ProfileAgent, ask: { profile?: string; key?: string; baseUrl?: string }, kept: string | undefined): Promise<{ model: string; force: boolean } | null> {
  const probe = await ui.run(t.agents.listing, () => deps.client.profileModels(agent, ask));
  if (probe && "models" in probe) {
    const chosen = await ui.pick({ title: t.agents.modelTitle, hint: t.agents.modelHint, filter: true, custom: t.agents.modelTyped, initial: kept ?? "",
      options: [{ value: "", label: t.agents.agentsOwnModel }, ...probe.models.map((m) => ({ value: m, label: m }))] });
    if (chosen === null) return null;
    if (!chosen || probe.models.includes(chosen)) return { model: chosen, force: false };
    return (await ui.confirm({ text: t.agents.modelUnlisted(chosen), yes: t.agents.keepAnyway })) ? { model: chosen, force: true } : null;
  }
  if (probe) { const d = describeProbe(t, probe); ui.say(d.text, d.tone); }
  const typed = await ui.ask({ title: t.agents.modelTitle, hint: probe ? describeProbe(t, probe).text : undefined, initial: kept ?? "" });
  return typed === null ? null : { model: typed.trim(), force: false };
}

/** A key typed for `host` and sealed for it; null when none was typed. */
async function sealedKey(t: Messages, ui: Ui, deps: PageProps["deps"], title: string, host: string): Promise<string | null> {
  const typed = await ui.ask({ title, hint: t.agents.keyHint, secret: true, check: (v) => (v.trim() ? null : t.agents.keyEmpty) });
  if (!typed) return null;
  return (await ui.run(t.common.saving, () => deps.seal("profile/api-key", host, typed.trim()))) ?? null;
}

/** A key-paying profile's address, model or key changed: what is not said stays. An address on another site takes a new
 *  key, asked for here (the one kept was sealed for the old site). */
async function saveApi(t: Messages, ui: Ui, deps: PageProps["deps"], agent: ProfileAgent, p: Profile,
                       change: { baseUrl?: string | undefined; model?: string; force?: boolean; newKey?: boolean }, done: (said: string) => Promise<void>): Promise<void> {
  const baseUrl = "baseUrl" in change ? change.baseUrl : p.api?.baseUrl;
  const model = change.model !== undefined ? change.model || undefined : p.api?.model;
  const host = sealHost(agent, baseUrl);
  const moved = sealHost(agent, p.api?.baseUrl) !== host;
  let key: string | null = null;
  if (change.newKey || moved) {
    key = await sealedKey(t, ui, deps, moved && !change.newKey ? t.agents.siteMoved(host) : t.agents.keyTitle(host), host);
    if (!key) return;
  }
  const ok = await ui.run(t.common.saving, async () => {
    await deps.client.setProfileApi(agent, p.id, { key, baseUrl: baseUrl ?? null, model: model ?? null, ...(change.force ? { force: true } : {}) });
    return true;
  });
  if (ok) await done(t.agents.saved);
}

/** A proxy typed (empty: none), its password asked for when the line has a user but no password and the one kept was
 *  for another user; the password sealed for the proxy's host:port. */
async function setProxy(t: Messages, ui: Ui, deps: PageProps["deps"], agent: ProfileAgent, p: Profile, done: (said: string, tone?: Tone) => Promise<void>): Promise<void> {
  const typed = await ui.ask({ title: t.agents.proxyTitle, hint: t.agents.proxyHint, initial: p.proxy ? (p.proxy.username ? p.proxy.server.replace("://", `://${encodeURIComponent(p.proxy.username)}@`) : p.proxy.server) : "",
    check: (v) => (!v.trim() || proxySite(splitProxy(v).server) ? null : t.agents.proxyBad) });
  if (typed === null) return;
  if (!typed.trim()) {
    if (!p.proxy) return;
    const r = await ui.run(t.common.saving, () => deps.client.setProfileProxy(agent, p.id, { server: null }));
    if (r) await done(t.agents.saved);
    return;
  }
  const draft = splitProxy(typed);
  const site = proxySite(draft.server)!;
  const keeps = !draft.password && !!draft.username && p.proxy?.sealed === true && p.proxy.username === draft.username;
  let password = draft.password;
  if (!password && draft.username && !keeps) {
    const asked = await ui.ask({ title: t.agents.passwordTitle(draft.username), hint: t.agents.passwordHint, secret: true });
    if (asked === null) return;
    password = asked;
  }
  const r = await ui.run(t.agents.checking, async () => {
    const sealed = password ? await deps.seal("profile/proxy", site, password) : undefined;
    return deps.client.setProfileProxy(agent, p.id, { server: draft.server, ...(draft.username ? { username: draft.username } : {}), ...(sealed ? { password: sealed } : {}), ...(keeps ? { keepPassword: true } : {}) });
  });
  if (r) await done(r.problem ?? t.agents.exitAt(...exitOf(r.agents, agent, p.id)), r.problem ? "warn" : "ok");
}

/** A new profile, asked step by step: its name, how it signs in, and for one that pays by a key its vendor or address,
 *  its key and its model. Opened once made. */
async function newProfile(t: Messages, ui: Ui, deps: PageProps["deps"], agent: ProfileAgent, agents: Agents, reload: () => Promise<void>, open: (o: { agent: ProfileAgent; id: string }) => void): Promise<void> {
  const taken = new Set((agents[agent]?.profiles ?? []).map((p) => p.name.toLowerCase()));
  const name = await ui.ask({ title: t.agents.nameTitle, hint: t.agents.nameHint,
    check: (v) => (!v.trim() || v.trim().length > NAME_MAX ? t.agents.nameLength : taken.has(v.trim().toLowerCase()) ? t.agents.nameTaken : null) });
  if (!name) return;
  const kinds = agents[agent]?.kinds ?? [];
  const kind = kinds.length > 1
    ? await ui.pick({ title: t.agents.kindTitle, options: kinds.map((k) => (k === "api" ? { value: k, label: t.agents.kindKey, hint: t.agents.kindKeyHint } : { value: k, label: t.agents.kindAccount, hint: t.agents.kindAccountHint })) })
    : kinds[0] ?? null;
  if (!kind) return;
  if (kind === "subscription") {
    const made = await ui.run(t.common.saving, () => deps.client.createProfile(agent, name.trim(), "subscription"));
    if (!made) return;
    await reload();
    open({ agent, id: made.profile.id });
    ui.say(t.agents.madeSignIn(made.profile.name));
    return;
  }
  const baseUrl = await askVendor(t, ui, agent, undefined);
  if (baseUrl === null) return;
  const host = sealHost(agent, baseUrl);
  const key = await sealedKey(t, ui, deps, t.agents.keyTitle(host), host);
  if (!key) return;
  const model = await chooseModel(t, ui, deps, agent, { key, ...(baseUrl ? { baseUrl } : {}) }, undefined);
  if (!model) return;
  const made = await ui.run(t.common.saving, () => deps.client.createProfile(agent, name.trim(), "api", { key, ...(baseUrl ? { baseUrl } : {}), ...(model.model ? { model: model.model } : {}), ...(model.force ? { force: true } : {}) }));
  if (!made) return;
  await reload();
  open({ agent, id: made.profile.id });
  ui.say(t.agents.made(made.profile.name));
}
