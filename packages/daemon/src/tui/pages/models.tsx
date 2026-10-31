/** Models: the dispatch model and the default executor and model (app-v0 §2, the Mac's Settings › Models). The service
 *  keeps the catalog it started with, so a change is saved to models.json and the service restarted. */

import { useState } from "react";
import type { PageProps } from "../app.js";
import { agentName } from "../names.js";
import { Form, useLoaded, useUi, useWords, type Row } from "../ui.js";

export function ModelsPage({ deps, active, leave, height }: PageProps) {
  const { t } = useWords();
  const ui = useUi();
  const { data, error, reload } = useLoaded(() => deps.client.modelSettings());
  const [draft, setDraft] = useState<{ router: string; harness: string; model: string } | null>(null);
  const ro = deps.remote !== null;

  if (error && !data) return <Form rows={[{ kind: "note", text: error, tone: "error" }, { kind: "item", id: "retry", label: t.common.retry, press: () => void reload() }]} active={active} leave={leave} height={height} />;
  if (!data) return <Form rows={[{ kind: "note", text: `${t.common.loading}…` }]} active={false} height={height} />;

  const now = draft ?? { router: data.router.model, harness: data.default.harness, model: data.default.model };
  const changed = now.router !== data.router.model || now.harness !== data.default.harness || now.model !== data.default.model;
  const harnesses = Object.keys(data.harnesses);
  const restart = () => { const ok = deps.node.restart(); ui.say(ok ? t.common.restarting : t.common.noKeeper, ok ? "ok" : "warn"); };

  const rows: Row[] = [
    { kind: "note", text: t.models.note },
    { kind: "item", id: "router", label: t.models.dispatchModel, value: now.router, disabled: ro, press: async () => {
      const chosen = await ui.pick({ title: t.models.dispatchModel, filter: true, initial: now.router, options: data.router.options.map((m) => ({ value: m, label: m })) });
      if (chosen) setDraft({ ...now, router: chosen });
    } },
    { kind: "item", id: "harness", label: t.models.executor, value: agentName(now.harness), disabled: ro, press: async () => {
      const chosen = await ui.pick({ title: t.models.executor, initial: now.harness, options: harnesses.map((h) => ({ value: h, label: agentName(h) })) });
      if (chosen && chosen !== now.harness) setDraft({ ...now, harness: chosen, model: data.harnesses[chosen]?.default_model ?? "" });
    } },
    { kind: "item", id: "model", label: t.models.model, value: now.model, disabled: ro, press: async () => {
      const chosen = await ui.pick({ title: t.models.model, filter: true, initial: now.model, options: (data.harnesses[now.harness]?.models ?? []).map((m) => ({ value: m, label: m })) });
      if (chosen) setDraft({ ...now, model: chosen });
    } },
  ];
  if (changed) {
    rows.push({ kind: "item", id: "save", label: t.models.saveRestart, tone: "accent", press: async () => {
      const ok = await ui.run(t.common.saving, async () => {
        await deps.client.saveModelSettings({ ...(now.router !== data.router.model ? { router: { model: now.router } } : {}), default: { harness: now.harness, model: now.model } });
        return true;
      });
      if (!ok) return;
      setDraft(null);
      await reload();
      restart();
    } });
  } else if (data.restartRequired) {
    rows.push({ kind: "note", text: t.models.pending, tone: "warn" });
    if (!ro) rows.push({ kind: "item", id: "restart", label: t.common.restartService, press: restart });
  }
  return <Form rows={rows} active={active} leave={leave} height={height} />;
}
