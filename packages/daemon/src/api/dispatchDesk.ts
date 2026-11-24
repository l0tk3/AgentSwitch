/** The new dispatch (2026-11-24, design-dispatch-admin.md; user #163: dispatch 应该设计成一个特殊的管理员，可以拉房间派
 *  任务，之前的 context.md、记忆文件啥的全都取消掉; #170: 只留一个 dispatch 专属房间). The dispatch is a session like any
 *  other, on the agent, profile and model the user picks, in a folder of its own (`<work folder>/Dispatch`) whose
 *  `AGENTS.md` is its working instructions (the user edits it; Claude Code reads it through `CLAUDE.md`). It sits as an
 *  admin in one room, 调度台, with the user; whatever the user says there is for it. It makes rooms, brings sessions
 *  in, writes the task lists and reports back; it remembers by its own conversation and the rooms' shared folders.
 *
 *  Kept here: the user's choice (`<home>/dispatch-desk.json`). Asked of this service's own API, as the screens ask
 *  it: starting, resuming and stopping its terminal. While it is on, an ended dispatch is resumed — the same
 *  conversation — within half a minute. */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import { loadWorkdir } from "../files/workdir.js";
import type { RoomStore, SeatWas } from "../rooms/store.js";
import { loadTrustedFolders, saveTrustedFolders, trustedRootOf } from "../terminals/trustedFolders.js";
import type { Ask } from "./roomOrg.js";
import type { ApiDeps } from "./shared.js";

export const DESK_FILE = "dispatch-desk.json";
export const DESK_NAME = "调度台";
const DESK_TOPIC = "你和调度说话的地方：说要做什么，它开房间、拉人、派任务、向你汇报。";
const DESK_HANDLE_NAME = "dispatch";
/** How many sessions the dispatch may have started that still sit in rooms (an ordinary admin: 4). */
export const DESK_MAX_STARTED = 8;
/** How long a replaced dispatch is given to write its handover. */
export const DESK_HANDOFF = { waitMs: 120_000, pollMs: 2000 };
const WATCH_MS = 30_000;

const Mode = z.enum(["manual", "auto", "bypass"]);
export const DeskSettings = z.object({
  /** Off: no dispatch runs (its conversation is kept for the next time). */
  on: z.boolean(),
  agent: z.string().regex(/^[a-z-]{2,20}$/),
  profile: z.string().regex(/^[a-z0-9]{1,16}$/).nullable(),
  model: z.string().min(1).max(200).nullable(),
  /** The permission mode of the dispatch and of the sessions it starts (bypass, as every session started for a room). */
  mode: Mode,
  maxStarted: z.number().int().min(1).max(16),
}).strict();
export type DeskSettings = z.infer<typeof DeskSettings>;

const DEFAULTS: DeskSettings = { on: false, agent: "claude-code", profile: null, model: null, mode: "bypass", maxStarted: DESK_MAX_STARTED };

/** The working instructions a new dispatch folder starts with; the user's to change. */
export const DEFAULT_INSTRUCTIONS = `# 调度的工作说明

你是 AgentSwitch 的调度（dispatch）。你不写代码、不改文件；你管人：开房间、拉会话或开新会话、把活分清楚写进任务表、盯进度、向用户汇报。

## 在哪说话

- 「${DESK_NAME}」是你和用户的房间。用户在这里说要做什么，你在这里回答、提问、汇报。
- 每件要多人做的事开一个房间（room_admin create），名字和一句话主题写清楚；现成的会话可以开房间时一起拉进来（\`terminals\`）。细节留在那个房间里，不搬到调度台。
- 你开的房间里你是管理员：能拉人（room_admin add）、恢复、禁言、踢人、结束会话。
- 事情做完、用户确认了，解散那个房间（room_admin dissolve）：房间和消息删掉，为它新开的会话一并结束（对话记录留着），原本就在跑的会话不受影响。

## 一件事怎么做

1. 先弄清楚。说不清的在调度台问用户；能自己查到的不问（room_admin sessions 看哪些会话在跑、在哪个目录）。
2. 一句话能答的，直接答。
3. 一个会话能做完的：交给一个现成的会话（在那个目录里跑着、做过相关事的），或者开一个新的。开一个只有你和它的房间，好留记录。
4. 要多人的：开房间，拉人或开新会话，任务写进任务表（room_tasks），指定负责人，@ 每个人说清要它交什么。
5. 开工之后不轮询。有人 @ 你（卡住、完成、要决定）你才会被叫醒。
6. 全部完成后，在调度台向用户汇报：结论、在哪个房间、花了多少（room_tasks show 有每个任务的花费）。你开的会话活干完了就结束掉（end，对话记录保留）。

## 必须先在调度台问用户的

- 一件事要开 2 个以上新会话。
- 用某个配置下最贵的模型。
- 动 main 分支、推送、发布、删文件、花钱的操作。
- 你判断不了用户要什么。

## 规矩

- 汇报只写结论和去哪看，几行以内；长的写进共享文件夹，消息里放路径。
- 用户随时可能进房间直接说话、改任务表、接手某个成员：照用户说的做。
- 你只有自己的对话历史和各房间的共享文件夹可以回头查。重要的决定写进房间的任务表或笔记，不能只记在你脑子里。
- 这个文件夹里若有 \`handoff.md\`，那是上一个调度留给你的交接，开始时先读它。
`;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? v as Obj : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export type DeskStatus = {
  readonly settings: DeskSettings;
  /** Where it works: its folder, its instructions, the room. */
  readonly folder: string;
  readonly instructions: string;
  readonly room: string | null;
  /** Its terminal now, if it has one. */
  readonly terminal: { readonly id: string; readonly status: string; readonly model: string | null } | null;
  /** What went wrong the last time it was started or resumed; null: nothing. */
  readonly problem: string | null;
  /** A replacement is waiting for the old dispatch's handover. */
  readonly replacing: boolean;
};

export class DispatchDesk {
  private problem: string | null = null;
  private replacing = false;
  private busy: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: { readonly home: string; readonly ask: Ask; readonly rooms: RoomStore; readonly changed?: (room: string) => void; readonly now?: () => number }) {}

  settings(): DeskSettings {
    try { return DeskSettings.parse({ ...DEFAULTS, ...obj(JSON.parse(readFileSync(join(this.o.home, DESK_FILE), "utf8"))) }); }
    catch { return DEFAULTS; }
  }

  private save(s: DeskSettings): void { writeFileSync(join(this.o.home, DESK_FILE), JSON.stringify(s, null, 2), { mode: 0o600 }); }

  folder(): string { return join(loadWorkdir(this.o.home), "Dispatch"); }
  instructionsPath(): string { return join(this.folder(), "AGENTS.md"); }

  /** The desk room, if there is one. */
  room(): string | null { return this.o.rooms.list().find((r) => r.desk)?.id ?? null; }

  /** The dispatch's seat at the desk (it may have left: a replaced one). */
  private seat(): { room: string; handle: string; terminal: string | null; session: string | null } | null {
    const id = this.room();
    if (!id) return null;
    const seat = this.o.rooms.get(id).seats.find((s) => s.kind === "session" && s.left === undefined);
    return seat ? { room: id, handle: seat.handle, terminal: seat.terminal ?? null, session: seat.session?.id ?? null } : null;
  }

  /** How many sessions a terminal may start: the dispatch its own number, any other the rooms' (null). */
  limitOf(terminal: string): number | null {
    const seat = this.seat();
    return seat?.terminal === terminal ? this.settings().maxStarted : null;
  }

  async status(): Promise<DeskStatus> {
    const seat = this.seat();
    let terminal: DeskStatus["terminal"] = null;
    if (seat?.terminal) {
      const res = await this.o.ask("GET", `/terminals/${encodeURIComponent(seat.terminal)}`).catch(() => null);
      const t = obj(obj(res?.body).terminal);
      if (res?.status === 200) terminal = { id: seat.terminal, status: str(t.status), model: str(t.modelNow) || str(t.model) || null };
    }
    return { settings: this.settings(), folder: this.folder(), instructions: this.instructionsPath(), room: this.room(), terminal, problem: this.problem, replacing: this.replacing };
  }

  readInstructions(): string {
    try { return readFileSync(this.instructionsPath(), "utf8"); } catch { return DEFAULT_INSTRUCTIONS; }
  }

  writeInstructions(text: string): void {
    this.prepare();
    writeFileSync(this.instructionsPath(), text, { mode: 0o644 });
  }

  /** The user's choice saved; on, a dispatch on it runs (started, or resumed, or left running when it already is). A
   *  change of agent, profile or model does not touch one running: `replace` does that, after its handover. */
  async apply(next: DeskSettings): Promise<DeskStatus> {
    this.save(next);
    if (next.on) await this.ensure();
    else await this.stop();
    return this.status();
  }

  /** Its folder, its instructions (written once), and the folder trusted in AgentSwitch (no "trust this folder?"). */
  private prepare(): void {
    const folder = this.folder();
    mkdirSync(folder, { recursive: true });
    if (!existsSync(this.instructionsPath())) writeFileSync(this.instructionsPath(), DEFAULT_INSTRUCTIONS, { mode: 0o644 });
    const claude = join(folder, "CLAUDE.md");
    if (!existsSync(claude)) writeFileSync(claude, "@AGENTS.md\n", { mode: 0o644 });
    const trusted = loadTrustedFolders(this.o.home);
    if (!trustedRootOf(folder, trusted)) {
      try { saveTrustedFolders(this.o.home, [...trusted, folder]); } catch { /* the agent asks once; the room says so */ }
    }
  }

  /** One at a time: a second call waits for the first. */
  ensure(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.ensureOnce().finally(() => { this.busy = null; });
    return this.busy;
  }

  private async ensureOnce(): Promise<void> {
    const s = this.settings();
    if (!s.on) return;
    this.prepare();
    let room = this.room();
    if (!room) {
      room = this.o.rooms.create({ name: DESK_NAME, topic: DESK_TOPIC, desk: true }).id;
      this.o.changed?.(room);
    }
    const seat = this.seat();
    if (seat?.terminal) {
      const res = await this.o.ask("GET", `/terminals/${encodeURIComponent(seat.terminal)}`).catch(() => null);
      if (res?.status === 200 && str(obj(obj(res.body).terminal).status) !== "exited") { this.problem = null; return; }
    }
    // Its conversation goes on when there is one (the seat follows it by itself, rooms/follow.ts); else a new one.
    const base = { harness: s.agent, cwd: this.folder(), mode: s.mode, ...(s.profile ? { profile: s.profile } : {}), ...(s.model ? { model: s.model } : {}) };
    let res = seat?.session ? await this.o.ask("POST", "/terminals/resume", { ...base, agentSessionId: seat.session }) : await this.o.ask("POST", "/terminals", base);
    if (seat?.session && res.status >= 300) res = await this.o.ask("POST", "/terminals/resume", { harness: s.agent, cwd: this.folder(), mode: s.mode, agentSessionId: seat.session, ...(s.profile ? { profile: s.profile } : {}) });
    const t = obj(obj(res.body).terminal);
    const id = str(t.id);
    if (res.status >= 300 || !id) {
      this.problem = `调度没能${seat?.session ? "恢复" : "启动"}：${str(obj(res.body).error) || `refused (${res.status})`}`;
      return;
    }
    this.problem = null;
    await this.o.ask("PATCH", `/terminals/${encodeURIComponent(id)}`, { name: DESK_HANDLE_NAME }).catch(() => null);
    const was: SeatWas = { agent: s.agent, name: DESK_HANDLE_NAME, cwd: this.folder(), model: str(t.model) || s.model, profile: str(obj(t.profile).name) || null };
    if (seat) {
      if (seat.terminal !== id) { try { this.o.rooms.rebind(seat.room, seat.handle, id, was); } catch { /* followed already */ } }
    } else {
      this.o.rooms.seat(room, { terminal: id, was, canAdd: true });
    }
    this.o.changed?.(room);
  }

  /** It stops: its terminal closed, its seat and conversation kept for the next time it is turned on. */
  async stop(): Promise<void> {
    const seat = this.seat();
    if (seat?.terminal) await this.o.ask("DELETE", `/terminals/${encodeURIComponent(seat.terminal)}`).catch(() => null);
  }

  /** A new dispatch in place of the one running (the agent, profile or model changed, or its conversation grew too
   *  long): the old writes its handover into `handoff.md` in the dispatch folder — asked at the desk, two minutes at
   *  most — and leaves; a new one, in a new conversation, starts and reads it. */
  async replace(): Promise<void> {
    const seat = this.seat();
    const s = this.settings();
    if (!s.on) throw new Error("调度没有打开");
    this.replacing = true;
    try {
      if (seat?.terminal) {
        const live = await this.o.ask("GET", `/terminals/${encodeURIComponent(seat.terminal)}`).catch(() => null);
        if (live?.status === 200 && str(obj(obj(live.body).terminal).status) !== "exited") {
          const file = join(this.folder(), "handoff.md");
          const asked = (this.o.now ?? Date.now)();
          this.o.rooms.post(seat.room, { from: "you", text: `@${seat.handle} 〔交接〕要换一个新的调度了。把交接写进 ${file}：你在管哪些房间、每个做到哪、卡在哪，我交代过的长期规矩。写完说一声，两分钟内。`, expects: "none" });
          this.o.changed?.(seat.room);
          for (let waited = 0; waited < DESK_HANDOFF.waitMs; waited += DESK_HANDOFF.pollMs) {
            try { if (statSync(file).mtimeMs >= asked) break; } catch { /* not yet */ }
            await new Promise((r) => setTimeout(r, DESK_HANDOFF.pollMs));
          }
          await this.o.ask("DELETE", `/terminals/${encodeURIComponent(seat.terminal)}`).catch(() => null);
        }
        this.o.rooms.unseat(seat.room, seat.handle);
      }
      await this.ensure();
    } finally { this.replacing = false; }
  }

  /** While on, an ended dispatch is brought back. */
  watch(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { if (this.settings().on && !this.replacing) void this.ensure().catch(() => { /* said in status */ }); }, WATCH_MS);
    this.timer.unref?.();
  }

  close(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

const Instructions = z.object({ text: z.string().max(100_000) }).strict();

/** `GET/PUT /dispatch/desk`, `GET/PUT /dispatch/desk/instructions`, `POST /dispatch/desk/replace`: on this Mac only
 *  (not in the remote list) — which agent runs as the dispatch, and with what say, is set where the user sits. */
export function mountDispatchDesk(app: Hono, deps: ApiDeps): void {
  const desk = deps.dispatchDesk;
  if (!desk) return;
  app.get("/dispatch/desk", async (c) => c.json(await desk.status()));
  app.put("/dispatch/desk", async (c) => {
    const body = DeskSettings.partial().strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    const given = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined));
    return c.json(await desk.apply(DeskSettings.parse({ ...desk.settings(), ...given })));
  });
  app.get("/dispatch/desk/instructions", (c) => c.json({ path: desk.instructionsPath(), text: desk.readInstructions() }));
  app.put("/dispatch/desk/instructions", async (c) => {
    const body = Instructions.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "text: a string" }, 400);
    desk.writeInstructions(body.data.text);
    return c.json({ path: desk.instructionsPath(), text: desk.readInstructions() });
  });
  app.post("/dispatch/desk/replace", async (c) => {
    if (!desk.settings().on) return c.json({ error: "调度没有打开" }, 409);
    void desk.replace().catch(() => { /* said in status */ });
    return c.json({ ok: true, replacing: true }, 202);
  });
}
