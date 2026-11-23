/** Keys: this node's gate key pair (keeper/gateKeys.ts; the Mac's Settings › Keys). The gate has one key pair
 *  (gate-simple-v0 §1): its public key is shown, and when there is none yet it can be made here. Each node's own: with
 *  `--on` there is nothing to show. */

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

  if (keys.error && !keys.data) return <Form rows={[{ kind: "note", text: keys.error, tone: "error" }, { kind: "item", id: "retry", label: t.common.retry, press: () => void keys.reload() }]} active={active} leave={leave} height={height} />;
  if (!keys.data) return <Form rows={[{ kind: "note", text: `${t.common.loading}…` }]} active={false} height={height} />;

  const rows: Row[] = [{ kind: "note", text: t.gateKeys.about }];
  const key = keys.data[0];
  if (key) rows.push({ kind: "item", id: "public", label: t.gateKeys.publicKey, value: key.public, disabled: true });
  else {
    rows.push({ kind: "note", text: t.gateKeys.none });
    rows.push({ kind: "item", id: "create", label: t.gateKeys.create, press: async () => {
      const next = await ui.run(t.common.saving, () => deps.keys.create());
      if (next) { keys.set(next); ui.say(t.gateKeys.created); }
    } });
  }
  return <Form rows={rows} active={active} leave={leave} height={height} />;
}
