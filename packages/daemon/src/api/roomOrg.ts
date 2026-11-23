/** What the Chatroom Kit's organizing tools read and do (docs/chatroom-v0.md §6 开了“拉会话”才有的): the profiles, the
 *  models, the sessions, a profile's check, and starting a session. Each is asked of this service's own API, in
 *  process — the same routes the screens use, with the same rules — and cut down to what an agent may know: no
 *  account, no key, no proxy. */

import type { RoomPolicy } from "../rooms/policy.js";
import type { KitOrg } from "../rooms/kit.js";
import { RoomError } from "../rooms/store.js";

/** One request to this service's own API. */
export type Ask = (method: string, path: string, body?: unknown) => Promise<{ readonly status: number; readonly body: unknown }>;

type Obj = Record<string, unknown>;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Obj => (v && typeof v === "object" ? v as Obj : {});
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const STATES: Readonly<Record<string, string>> = { working: "busy", waiting: "waiting", idle: "idle", exited: "exited" };

export function roomOrg(ask: Ask, policy?: RoomPolicy): KitOrg {
  const refuse = (res: { status: number; body: unknown }, what: string): never => {
    throw new RoomError(res.status === 404 ? 404 : res.status === 403 ? 403 : res.status === 409 ? 409 : 400, `${what}: ${str(obj(res.body).error) || `refused (${res.status})`}`);
  };
  return {
    async profiles() {
      const [all, health] = await Promise.all([ask("GET", "/profiles"), ask("GET", "/profiles/health")]);
      const checked = obj(obj(health.body).health);
      return Object.entries(obj(obj(all.body).agents)).flatMap(([agent, of]) => list(obj(of).profiles).map((p) => {
        const h = obj(checked[`${agent}.${str(p.id)}`]);
        return { agent, id: str(p.id), name: str(p.name), kind: str(p.kind), health: str(h.status) ? { status: str(h.status), checkedAt: num(h.checkedAt), message: str(h.message).slice(0, 200) } : null };
      }));
    },
    async models() {
      const [res, profiles] = await Promise.all([ask("GET", "/terminals"), ask("GET", "/profiles")]);
      const agents = obj(obj(profiles.body).agents);
      return Object.fromEntries(Object.entries(obj(obj(res.body).models)).map(([agent, models]) => [agent, list(models).filter((m) => m.older !== true).map((m) => {
        // Under which profiles the user has turned this model off for sessions a session starts.
        const off = policy ? list(obj(agents[agent]).profiles).filter((p) => !policy.allows(agent, str(p.id), str(m.id))).map((p) => str(p.name) || str(p.id)) : [];
        return { id: str(m.id), name: str(m.name), ...(str(m.description) || off.length ? { description: [str(m.description), off.length ? `NOT for you under profile ${off.join(", ")}` : ""].filter(Boolean).join(" · ") } : {}) };
      })]));
    },
    async sessions(limit) {
      const [terminals, sessions] = await Promise.all([ask("GET", "/terminals"), ask("GET", `/sessions?limit=${Math.min(Math.max(limit, 1), 500)}`)]);
      return {
        running: list(obj(terminals.body).terminals).filter((t) => str(t.status) !== "exited").map((t) => ({
          terminal: str(t.id), agent: str(t.harness), name: str(t.name), cwd: str(t.workdir) || str(t.cwd), state: STATES[str(t.status)] ?? str(t.status), profile: str(obj(t.profile).name) || null,
        })),
        resumable: list(obj(sessions.body).sessions).filter((s) => s.active !== true).map((s) => ({
          agent: str(s.harness), id: str(s.id), title: (str(s.title) || str(s.lastText)).slice(0, 120), cwd: str(s.cwd), updatedAt: num(s.updatedAt) || Date.parse(str(s.updatedAt)) || 0,
          profile: str(obj(s.profile).name) || (typeof s.profile === "string" ? s.profile : null),
        })),
      };
    },
    async check(agent, profile) {
      if (!/^[a-z-]{2,20}$/.test(agent) || !/^[a-z0-9]{1,16}$/.test(profile)) throw new RoomError(400, "profile_check: `agent` and `profile` are an agent's name and a profile's id, as `profiles` lists them.");
      const res = await ask("POST", `/profiles/${agent}/${profile}/health`, {});
      if (res.status !== 200) refuse(res, "The check was not run");
      const h = obj(res.body);
      return { status: str(h.status) || "unknown", checkedAt: num(h.checkedAt), message: str(h.message).slice(0, 300) };
    },
    async start(req) {
      // The user says which models a session may start a session on, per profile (rooms/policy.ts).
      if (policy && req.model) {
        const all = obj(obj((await ask("GET", "/profiles")).body).agents);
        const of = obj(all[req.agent]);
        const profile = req.profile ?? (str(of.current) || "default");
        if (!policy.allows(req.agent, profile, req.model)) {
          const models = list(obj(obj((await ask("GET", "/terminals")).body).models)[req.agent]).filter((m) => m.older !== true).map((m) => str(m.id)).filter((id) => policy.allows(req.agent, profile, id));
          const name = str(list(of.profiles).find((p) => str(p.id) === profile)?.name) || profile;
          throw new RoomError(403, `The user has turned the model ${req.model} off for sessions started by a session under profile "${name}". Allowed there: ${models.join(", ") || "none"}; or leave \`model\` out for the profile's own default.`);
        }
      }
      const body = { harness: req.agent, cwd: req.cwd, ...(req.profile ? { profile: req.profile } : {}), ...(req.model ? { model: req.model } : {}), ...(req.mode ? { mode: req.mode } : {}), ...(req.resume ? { agentSessionId: req.resume } : {}) };
      const res = await ask("POST", req.resume ? "/terminals/resume" : "/terminals", body);
      const id = str(obj(obj(res.body).terminal).id);
      if (res.status >= 300 || !id) refuse(res, "The session was not started");
      return id;
    },
    async resume(req) {
      // The same conversation in two terminals writes one record from both ends: never.
      const all = await ask("GET", "/terminals");
      const live = arr(obj(all.body).terminals).map(obj).find((t) => str(t.agentSessionId) === req.session && str(t.status) !== "exited");
      if (live) throw new RoomError(409, `That conversation is already running in another terminal ("${str(live.name) || str(live.id)}"); its seat goes there by itself in a moment.`);
      const mode = req.mode === "manual" || req.mode === "auto" || req.mode === "bypass" ? req.mode : undefined;
      const body = (model: boolean) => ({ harness: req.agent, cwd: req.cwd, agentSessionId: req.session, ...(req.profile ? { profile: req.profile } : {}), ...(model && req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}), ...(mode ? { mode } : {}) });
      let res = await ask("POST", "/terminals/resume", body(true));
      // The model it said it was on last may not be one the start takes by that name: then its own default.
      if (res.status === 400 && req.model) res = await ask("POST", "/terminals/resume", body(false));
      const id = str(obj(obj(res.body).terminal).id);
      if (res.status >= 300 || !id) refuse(res, "The session was not resumed");
      return { id };
    },
    async rename(terminal, name) {
      const res = await ask("PATCH", `/terminals/${encodeURIComponent(terminal)}`, { name });
      if (res.status >= 300) refuse(res, "The session was not renamed");
    },
    async stop(terminal, transcript = false) {
      const res = await ask("DELETE", `/terminals/${encodeURIComponent(terminal)}${transcript ? "?transcript=1" : ""}`).catch(() => null);
      return !!res && res.status < 300;
    },
  };
}
