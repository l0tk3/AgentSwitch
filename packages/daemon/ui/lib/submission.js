/** The server acknowledges intake before credential processing finishes; only accepted is a task receipt. */
export async function postTask(body, { onProgress = () => {}, timeoutMs = 120_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetch("/tasks", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
      // Older servers and non-streaming validation errors keep the ordinary JSON API.
      const data = await response.json().catch(() => { throw new Error("未收到有效的任务回执"); });
      if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
      if (!data || typeof data.id !== "string") throw new Error("未收到有效的任务回执");
      return data;
    }
    if (!response.body) throw new Error("接收进度流已中断，任务结果待确认");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const parse = (line) => {
      if (!line.trim()) return null;
      let event;
      try { event = JSON.parse(line); } catch { throw new Error("接收进度格式异常，任务结果待确认"); }
      if (event?.type === "accepted" && event.task && typeof event.task.id === "string") return event.task;
      if (event?.type === "error") throw Object.assign(new Error("未收到任务回执，请检查任务状态"), { status: Number.isInteger(event.status) && event.status >= 400 && event.status <= 599 ? event.status : 500 });
      if (event?.type === "progress" && ["sealing", "creating"].includes(event.stage)) {
        onProgress({ stage: event.stage, elapsedMs: Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 ? event.elapsedMs : 0 });
      }
      return null;
    };
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        const task = parse(line);
        if (task) return task; // A receipt stays accepted even if the connection later breaks.
      }
      if (done) {
        const task = parse(pending);
        if (task) return task;
        throw new Error("接收连接已结束，未收到任务回执，结果待确认");
      }
    }
  } finally {
    clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => undefined);
  }
}
