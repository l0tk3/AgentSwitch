import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UI = resolve(import.meta.dirname, "..", "ui");
const state = await import(join(UI, "lib/state.js"));
const actions = await import(join(UI, "lib/actions.js"));
const ctx = await import(join(UI, "views/ctx.js"));
const initial = structuredClone(state.get());
const record = { id: "a".repeat(24), origin: "https://fixture.example:8443", key: "form.layout", text: "设置表单在管理页", kind: "operation", status: "observed", source: { taskId: "source-task", eventSeq: 7, quote: "找到设置表单" }, createdAt: 1, updatedAt: 2, expiresAt: 3 };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function click() { return ctx.bindings.find((b: { sel: string }) => b.sel === "[data-delete-memory]").run({ dataset: { deleteMemory: record.id } }); }

beforeEach(() => state.set({ ...structuredClone(initial), view: "ctx", platformMem: { ...structuredClone(initial.platformMem), records: [record], loaded: true } }));
afterEach(() => vi.unstubAllGlobals());

describe("platform observations UI", () => {
  it("shows exact origin, kind, verification, expiry and linked source, escaping model text", () => {
    state.set({ platformMem: { ...state.get().platformMem, records: [{ ...record, text: "<script>bad</script>" }] } });
    const page = ctx.render(state.get());
    for (const text of [record.origin, "操作经验", "待验证", "已过期", "source-task", "事件 #7", record.source.quote, "更新", "过期"]) expect(page).toContain(text);
    expect(page).toContain('data-memory-task="source-task"');
    expect(page).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(page).not.toContain("<script>");
  });

  it("deletion is immediately busy, survives rendering and suppresses duplicate requests", async () => {
    const pending = deferred<Response>(); const fetcher = vi.fn((_path: string) => pending.promise); vi.stubGlobal("fetch", fetcher);
    const deletion = click();
    expect(ctx.render(state.get())).toMatch(/data-delete-memory="[a-f0-9]+" disabled>删除中…/);
    state.set({ hint: "unrelated render" });
    expect(ctx.render(state.get())).toContain("正在删除…");
    await click(); expect(fetcher).toHaveBeenCalledOnce();
    pending.resolve(reply({ ok: true })); await deletion;
    expect(state.get().platformMem.records).toEqual([]);
    expect(ctx.render(state.get())).toContain("暂无平台经验");
    expect(fetcher.mock.calls[0]![0]).toBe(`/platform-memory/${record.id}`);
  });

  it("deletion failure preserves the record, shows a Chinese error and allows an explicit retry", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ error: "disk error" }, 500)).mockResolvedValueOnce(reply({ error: "missing" }, 404));
    vi.stubGlobal("fetch", fetcher);
    await click();
    expect(state.get().platformMem.records).toHaveLength(1);
    expect(ctx.render(state.get())).toContain("删除暂未确认，请重试。");
    expect(ctx.render(state.get())).toContain("重试删除");
    await click(); expect(state.get().platformMem.records).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("an older GET cannot restore a deleted observation", async () => {
    const oldList = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((_path: string, options: RequestInit) => options.method === "DELETE" ? Promise.resolve(reply({ ok: true })) : oldList.promise));
    const loading = actions.loadPlatformMemory();
    await click();
    oldList.resolve(reply({ records: [record] })); await loading;
    expect(state.get().platformMem.records).toEqual([]);
    expect(state.get().platformMem.loading).toBe(false);
  });

  it("refresh failures remain visible and the same platform key can be learned again later", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply({ error: "offline" }, 503)).mockResolvedValueOnce(reply({ records: [{ ...record, updatedAt: Date.now(), expiresAt: Date.now() + 10000 }] })));
    await actions.loadPlatformMemory();
    expect(ctx.render(state.get())).toContain("平台经验暂未加载，请重试。");
    state.set({ platformMem: { ...state.get().platformMem, records: [], deletions: { [record.id]: { status: "deleted" } } } });
    await actions.loadPlatformMemory();
    expect(state.get().platformMem.records).toHaveLength(1);
    expect(state.get().platformMem.deletions[record.id]).toBeUndefined();
    expect(state.get().platformMem.hint).toBe("");
  });
});
