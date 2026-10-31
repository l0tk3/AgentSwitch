/** Environment: what this node has and lacks, the lines of `agentswitch doctor` (the Mac's Settings › Environment
 *  checklist); asked again on request. Nothing is changed. Another node is asked on that node. */

import type { PageProps } from "../app.js";
import { Form, useLoaded, useWords, type Row, type Tone } from "../ui.js";

const TONE: Readonly<Record<string, Tone>> = { "✓": "ok", "✗": "error", "!": "warn" };

export function EnvironmentPage({ deps, active, leave, height }: PageProps) {
  const { t } = useWords();
  const report = useLoaded(() => (deps.remote ? Promise.resolve(null) : deps.doctor()));
  if (deps.remote) return <Form rows={[{ kind: "note", text: t.environment.remote }]} active={false} height={height} />;
  const rows: Row[] = [{ kind: "note", text: t.environment.about }];
  if (report.data) {
    for (const line of report.data) {
      if (!line.trim()) continue;
      if (line.startsWith("\n// ") || line.startsWith("// ")) { rows.push({ kind: "heading", label: line.trim().slice(3) }); continue; }
      rows.push({ kind: "note", text: line, tone: TONE[line[0] ?? ""] ?? "dim" });
    }
  } else rows.push({ kind: "note", text: report.error ?? `${t.environment.checking}…`, tone: report.error ? "error" : "dim" });
  rows.push({ kind: "item", id: "again", label: t.environment.checkAgain, press: () => void report.reload() });
  return <Form rows={rows} active={active} leave={leave} height={height} />;
}
