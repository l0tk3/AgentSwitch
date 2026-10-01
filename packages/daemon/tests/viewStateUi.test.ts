/** The sidebar, the context save buttons and the extension harness chips are rendered from state through the
 *  morph patcher; drag-over highlighting is the one transient class kept outside it. Real DOM, no daemon or model. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UI = resolve(import.meta.dirname, "..", "ui");
const HARNESSES = ["claude-code", "codex", "opencode"];
const existing = { name: "gh", kind: "stdio", command: "npx", args: [], env: {}, harnesses: ["codex"], enabled: false, approval: "ask", note: "" };
const found = { name: "deploy", source: "~/.claude/skills", description: "发布清单", path: "/skills/deploy", installed: false };
let dom: JSDOM;
let state: { get: () => any; set: (next: any) => any; subscribe: (fn: (next: any) => void) => () => void };
let fetcher: ReturnType<typeof vi.fn>;
const $ = <T extends Element = HTMLElement>(sel: string) => dom.window.document.querySelector(sel) as T | null;
const chipsOn = (sel: string) => [...dom.window.document.querySelectorAll(`${sel} .chip.on`)].map((c) => (c as HTMLElement).dataset.h);
const flush = async () => { for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0); };
const bodyOf = (method: string, path: string) => JSON.parse(fetcher.mock.calls.find(([url, init]) => url === path && init?.method === method)![1].body);

function type(id: string, value: string) {
  const el = $<HTMLTextAreaElement>("#" + id)!;
  el.focus();
  el.value = value;
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  return el;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  dom = new JSDOM(readFileSync(join(UI, "index.html"), "utf8"), { url: "http://localhost/", pretendToBeVisual: true });
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  vi.stubGlobal("alert", vi.fn());
  fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(
    url === "/healthz" ? { version: "test" }
      : url === "/approvals/policy" ? { policy: { mode: "manual", human: [] }, categories: [] }
      : url === "/platform-memory" ? { records: [] }
      : url === "/context" || url === "/memory" ? { path: "/tmp/" + url.slice(1), text: "", warnings: [] }
      : url.startsWith("/mcp/") || url.startsWith("/skills/") && !url.endsWith("/discover") ? {}
      : [])));
  vi.stubGlobal("fetch", fetcher);
  state = await import(join(UI, "lib/state.js"));
  await import(join(UI, "app.js"));
  await flush();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  dom.window.close();
  vi.unstubAllGlobals();
});

describe("sidebar", () => {
  it("is a function of state: health, escaped version, approval count and the active tab", async () => {
    const { band, sidebar } = await import(join(UI, "lib/sidebar.js"));
    const base = { health: false, version: "", approvals: [], tasks: [], threads: [], quota: [], view: "home" };
    expect(band(base)).toContain('<span class="dot" id="dot">');
    expect(band({ ...base, health: true })).toContain('<span class="dot on" id="dot">');
    expect(band({ ...base, version: "1<2" })).toContain('id="version">v1&lt;2</span>');
    expect(sidebar(base)).toContain('id="apCount"></span>');   // nothing waiting: nothing said
    expect(sidebar({ ...base, approvals: [{}, {}] })).toContain('id="apCount">▪2</span>');
    expect(sidebar({ ...base, view: "task" })).toContain('data-nav="home" class="on">');   // a task opens beside the tasks
    expect(sidebar({ ...base, view: "ctx" })).toMatch(/data-nav="home">.*Tasks.*data-nav="ctx" class="on">.*Context/s);
  });

  it("says its short words in title case (docs/ui-v0.md §7.2 第 7 条), the name as AgentSwitch writes it", async () => {
    const { band, sidebar } = await import(join(UI, "lib/sidebar.js"));
    const base = { health: true, version: "", approvals: [{}, {}], tasks: [], threads: [], quota: [], view: "home" };
    const top = band(base);
    for (const word of ["<b>AgentSwitch</b>", "Service</span>", "2 Waiting</span>", "Terminals ↗</a>"]) expect(top).toContain(word);
    const side = sidebar(base);
    for (const word of ["// Console", "// Topics", "// Usage", ">Tasks<", ">Log<", ">Extensions<", ">Context<", ">Refresh<", ">Reload<"]) expect(side).toContain(word);
    expect(`${top}${side}`).not.toMatch(/agentswitch<|>(tasks|log|extensions|context|service|refresh|reload)<|\/\/ (console|topics|usage)/);
  });

  it("is patched in place as state changes: dot, version, count, tabs and the refresh button keep their elements", () => {
    const dot = $("#dot")!, ext = $('nav a[data-nav="ext"]')!, refresh = $("#refresh")!;
    expect(dot.className).toBe("dot on");
    expect($("#version")!.textContent).toBe("vtest");
    state.set({ health: false, version: "2.0", view: "ext", approvals: [{ id: "a", taskId: "t", kind: "question", action: "问", evidence: "", createdAt: 1 }] });
    expect($("#dot")).toBe(dot);
    expect(dot.className).toBe("dot");
    expect($("#version")!.textContent).toBe("v2.0");
    expect($("#apCount")!.textContent).toBe("▪1");
    expect($('nav a[data-nav="ext"]')).toBe(ext);
    expect(ext.classList.contains("on")).toBe(true);
    expect($('nav a[data-nav="home"]')!.classList.contains("on")).toBe(false);
    expect($("#refresh")).toBe(refresh);
    state.set({ approvals: [] });
    expect($("#apCount")!.textContent).toBe("");
  });

  it("marks the clicked tab active through navigation state", async () => {
    $<HTMLElement>('nav a[data-nav="log"]')!.click();
    await flush();
    expect(state.get().view).toBe("log");
    expect([...dom.window.document.querySelectorAll("nav a.on")].map((a) => (a as HTMLElement).dataset.nav)).toEqual(["log"]);
  });
});

describe("context save buttons", () => {
  it.each([["ctx-text", "ctx-save", "ctx"], ["mem-text", "mem-save", "mem"]])("%s: the first edit re-renders %s, later keystrokes stay silent", (field, button, key) => {
    state.set({ view: "ctx", [key]: { ...state.get()[key], text: "已有内容", saved: true } });
    const save = $<HTMLButtonElement>("#" + button)!;
    expect([save.disabled, save.textContent]).toEqual([true, "已保存"]);
    const updates = vi.fn();
    const off = state.subscribe(updates);
    const el = type(field, "已有内容，改一下");
    expect(updates).toHaveBeenCalledTimes(1);
    expect($("#" + button)).toBe(save);
    expect([save.disabled, save.textContent]).toEqual([false, "保存"]);
    expect(state.get()[key]).toMatchObject({ draft: "已有内容，改一下", saved: false });
    updates.mockClear();
    type(field, "已有内容，改两下");
    expect(updates).not.toHaveBeenCalled();
    expect(state.get()[key].draft).toBe("已有内容，改两下");
    expect($("#" + field)).toBe(el);
    expect(dom.window.document.activeElement).toBe(el);
    off();
  });

  it("shows the example button only while the context is empty", () => {
    state.set({ view: "ctx" });
    expect($("#ctx-example")).toBeTruthy();
    type("ctx-text", "站点");
    expect($("#ctx-example")).toBeNull();
    type("ctx-text", "站点 A");
    type("ctx-text", "  ");
    expect($("#ctx-example")).toBeTruthy();
    expect($<HTMLTextAreaElement>("#ctx-text")!.value).toBe("  ");
  });
});

describe("extension harness chips", () => {
  beforeEach(() => { state.set({ view: "ext", discovered: [found] }); });

  it("toggles from state without losing typed form fields or an open import list, and saves the picks", async () => {
    $<HTMLElement>("#mcp-new")!.click();
    expect(chipsOn("#m-harness")).toEqual(HARNESSES);
    const name = type("m-name", "github");
    const kind = $<HTMLSelectElement>("#m-kind")!;
    kind.value = "http";
    const details = $<HTMLDetailsElement>("details")!;
    details.open = true;
    $<HTMLElement>('#m-harness [data-h="codex"]')!.click();
    expect(state.get().edit.harnesses.mcp).toEqual(["claude-code", "opencode"]);
    expect(chipsOn("#m-harness")).toEqual(["claude-code", "opencode"]);
    expect([$("#m-name"), name.value, kind.value, details.open]).toEqual([name, "github", "http", true]);
    $<HTMLElement>('#m-harness [data-h="codex"]')!.click();
    expect(chipsOn("#m-harness")).toEqual(HARNESSES);
    $<HTMLElement>('#m-harness [data-h="opencode"]')!.click();
    $<HTMLElement>("#m-save")!.click();
    expect(bodyOf("PUT", "/mcp/github")).toMatchObject({ kind: "http", harnesses: ["claude-code", "codex"], enabled: true });
    await flush();
    expect(state.get().edit).toEqual({ mcp: null, skill: null, harnesses: { mcp: null, skill: null } });
    expect($("#mcp-form")).toBeNull();
  });

  it("starts from the entry's own harnesses and forgets toggles when the form closes", () => {
    state.set({ mcp: [existing] });
    $<HTMLElement>('[data-mcp-edit="gh"]')!.click();
    expect(chipsOn("#m-harness")).toEqual(["codex"]);
    $<HTMLElement>('#m-harness [data-h="opencode"]')!.click();
    expect(chipsOn("#m-harness")).toEqual(["codex", "opencode"]);
    // The row names whom the server is given to in words; only the form's chips toggle.
    expect($('[data-mcp-edit="gh"]')!.closest(".xrow")!.textContent).toContain("codex");
    expect(state.get().edit.harnesses.mcp).toEqual(["codex", "opencode"]);
    $<HTMLElement>("#m-cancel")!.click();
    expect(state.get().edit.harnesses.mcp).toBeNull();
    $<HTMLElement>('[data-mcp-edit="gh"]')!.click();
    expect(chipsOn("#m-harness")).toEqual(["codex"]);
  });

  it("keeps skill and MCP picks apart and sends the skill's own", async () => {
    $<HTMLElement>("#mcp-new")!.click();
    $<HTMLElement>("#skill-new")!.click();
    $<HTMLElement>('#s-harness [data-h="claude-code"]')!.click();
    expect(chipsOn("#s-harness")).toEqual(["codex", "opencode"]);
    expect(chipsOn("#m-harness")).toEqual(HARNESSES);
    type("s-name", "deploy");
    type("s-content", "# 发布");
    $<HTMLElement>("#s-save")!.click();
    expect(bodyOf("PUT", "/skills/deploy")).toEqual({ content: "# 发布", harnesses: ["codex", "opencode"] });
    await flush();
    expect(state.get().edit.harnesses).toEqual({ mcp: null, skill: null });
    expect(chipsOn("#m-harness")).toEqual(HARNESSES);
  });
});

describe("drag-over highlight (transient CSS class, not state)", () => {
  const drag = (type: string, target: Element, files?: File[]) => {
    const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
    if (files) Object.defineProperty(e, "dataTransfer", { value: { files } });
    target.dispatchEvent(e);
    return e;
  };

  it("highlights the drop zone while dragging and attaches dropped files", () => {
    const zone = $("[data-dropzone]")!, inner = $("#c-task")!;
    const updates = vi.fn();
    const off = state.subscribe(updates);
    expect(drag("dragover", inner).defaultPrevented).toBe(true);
    drag("dragover", inner);
    expect(zone.classList.contains("drop")).toBe(true);
    expect(updates).not.toHaveBeenCalled();
    drag("dragleave", zone);
    expect(zone.classList.contains("drop")).toBe(false);
    drag("dragover", zone);
    expect(drag("drop", inner, [new dom.window.File(["x"], "notes.txt")]).defaultPrevented).toBe(true);
    expect(zone.classList.contains("drop")).toBe(false);
    expect(state.get().pending.map((p: { file: File }) => p.file.name)).toEqual(["notes.txt"]);
    off();
  });

  it("ignores drops on a busy composer and drags outside any zone", () => {
    state.set({ taskSubmissions: { home: { status: "sending", message: "发送中" } } });
    const zone = $("[data-dropzone]")!;
    drag("drop", zone, [new dom.window.File(["x"], "late.txt")]);
    expect(zone.classList.contains("drop")).toBe(false);
    expect(state.get().pending).toEqual([]);
    expect(drag("dragover", $("#refresh")!).defaultPrevented).toBe(false);
  });
});
