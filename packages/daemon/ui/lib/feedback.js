/** The three-stage feedback a task gives back (received → handed to X → outcome), derived from the task row and
 *  its events. Shown as a strip on the task page; the one-sentence outcome doubles as the push/voice text later. */

import { ACTIVE, esc, target, taskStatusLabel } from "./api.js";

const WAIT_LABEL = (p) => p.for === "parent" ? "等父任务结束" : p.for === "thread" ? "等同线程的任务" : p.for === "cwd" ? "等同目录的任务" : p.for === "global" ? "等并发槽位" : String(p.for).startsWith("harness:") ? "等 " + String(p.for).slice(8) + " 空闲" : "等待";

/** @returns {{stage: 1|2|3, label: string, detail: string, tone: "ok"|"bad"|"warn"|""}} */
export function feedback(t, events) {
  const last = (type) => [...events].reverse().find((e) => e.type === type);
  const who = target(t);
  if (t.status === "done") return { stage: 3, tone: "ok", label: t.spoken || firstLine(t.result) || "完成", detail: who ? `${who} 完成` : "完成" };
  if (t.status === "partial" || t.status === "blocked") return { stage: 3, tone: "warn", label: taskStatusLabel(t), detail: firstLine(t.error) || "执行已停止，请查看已保存的进展和未完成原因。" };
  if (t.status === "failed") return { stage: 3, tone: "bad", label: t.spoken || firstLine(t.error) || "失败", detail: who ? `${who} 失败` : "失败" };
  if (t.status === "cancelled") return { stage: 3, tone: "", label: "已取消", detail: who };
  if (t.status === "waiting_approval") {
    const a = last("approval_request");
    const question = a && a.payload.kind === "question";
    return { stage: 2, tone: "warn", label: question ? (a.payload.source === "executor" ? "执行者在问你" : "路由器在问你") : "等你审批", detail: a ? String(a.payload.action || "").slice(0, 80) : "" };
  }
  if (t.status === "running") {
    const agent = last("agent");
    const running = events.filter((e) => e.type === "agent" && e.payload.status === "started").length - events.filter((e) => e.type === "agent" && (e.payload.status === "completed" || e.payload.status === "failed" || e.payload.status === "stopped")).length;
    return { stage: 2, tone: "", label: `${who} 执行中`, detail: running > 0 ? `${running} 个子 agent 在跑${agent && agent.payload.description ? "：" + agent.payload.description : ""}` : "" };
  }
  const routed = last("routed");
  const waiting = last("waiting");
  const dispatched = last("dispatched");
  const planning = [...events].reverse().find((e) => e.type === "step" && e.payload.action === "plan" && !["error", "none"].includes(e.payload.source));
  if (waiting && waiting.seq > Math.max(dispatched?.seq || 0, routed?.seq || 0, planning?.seq || 0)) return { stage: 2, tone: "", label: WAIT_LABEL(waiting.payload), detail: routed && routed.payload.verdict && routed.payload.verdict.ok ? `将交给 ${routed.payload.verdict.harness}/${routed.payload.verdict.model}` : "" };
  if (t.status === "routing" && (planning || dispatched)) return { stage: 2, tone: "", label: dispatched ? "正在规划下一步…" : "规划中…", detail: `${planning?.payload.model || "路由器"} 正在决定${dispatched ? "后续动作，已完成的步骤已保留" : "执行步骤，尚未派发业务执行"}` };
  if (routed && routed.payload.verdict && routed.payload.verdict.ok) return { stage: 2, tone: "", label: `交给 ${routed.payload.verdict.harness}/${routed.payload.verdict.model}`, detail: routed.payload.routerMs ? `分诊 ${(routed.payload.routerMs / 1000).toFixed(1)} s` : "" };
  if (t.status === "routing") return { stage: 1, tone: "", label: "分诊中…", detail: "消息已接收，路由器正在分析任务并选择执行模型" };
  return { stage: 1, tone: "", label: "已收到", detail: "排队中" };
}

export function firstLine(text) {
  return (text || "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("|") && !l.startsWith("#")) || "";
}

export function feedbackStrip(t, events) {
  const f = feedback(t, events);
  const dots = [1, 2, 3].map((n) => `<span class="fb-dot ${n < f.stage ? "past" : n === f.stage ? "now " + f.tone : ""}"></span>`).join("");
  const spin = ACTIVE.has(t.status) ? '<span class="fb-spin"></span>' : "";
  return `<div class="card fb ${f.tone}"><div class="fb-dots">${dots}</div><div class="grow"><div class="fb-label">${spin}${esc(f.label)}</div>${f.detail ? `<div class="dim">${esc(f.detail)}</div>` : ""}</div></div>`;
}
