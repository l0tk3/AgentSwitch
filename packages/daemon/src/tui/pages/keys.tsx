/** Keys: this node's gate key pair (keeper/gateKeys.ts; the Mac's Settings › Keys). The gate has one key pair
 *  (gate-simple-v0 §1): its public key is shown, and when there is none yet it can be made here. Each node's own: with
 *  `--on` there is nothing to show.
 *
 *  Where the gate runs is said plainly (gate-simple-v0 §5, keeper/gateService.ts): as the login user it only keeps
 *  values from being seen by mistake, and the page shows the `sudo` command that gives it its own account; as the
 *  system service the key pair is the service's (nothing to create here) and replacing it is an administrator's
 *  command, shown too. Nothing here runs sudo. */

import type { PageProps } from "../app.js";
import { reportLines } from "../../keeper/gateService.js";
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
  const gate = useLoaded(async () => (deps.gate ? deps.gate() : null));

  if (keys.error && !keys.data) return <Form rows={[{ kind: "note", text: keys.error, tone: "error" }, { kind: "item", id: "retry", label: t.common.retry, press: () => void keys.reload() }]} active={active} leave={leave} height={height} />;
  if (!keys.data) return <Form rows={[{ kind: "note", text: `${t.common.loading}…` }]} active={false} height={height} />;

  const service = gate.data?.mode.kind === "service";
  const rows: Row[] = [{ kind: "note", text: t.gateKeys.about }];
  const key = keys.data[0];
  if (key) rows.push({ kind: "item", id: "public", label: t.gateKeys.publicKey, value: key.public, disabled: true });
  else if (!service) {
    rows.push({ kind: "note", text: t.gateKeys.none });
    rows.push({ kind: "item", id: "create", label: t.gateKeys.create, press: async () => {
      const next = await ui.run(t.common.saving, () => deps.keys.create());
      if (next) { keys.set(next); ui.say(t.gateKeys.created); }
    } });
  } else rows.push({ kind: "note", text: t.gateKeys.none });
  if (gate.data) {
    const [first, ...rest] = reportLines(gate.data, t.gateMode);
    if (first) rows.push({ kind: "note", text: first, tone: service ? "ok" : "warn" });
    for (const line of rest) rows.push({ kind: "note", text: line, tone: line.startsWith("  ") ? "accent" : "dim" });
  }
  return <Form rows={rows} active={active} leave={leave} height={height} />;
}
