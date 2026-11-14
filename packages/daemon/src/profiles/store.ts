/** Profiles (docs/profiles-v0.md): several sign-ins per agent, each a home folder of its own that the agent is started
 *  with (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), so the Mac's own `~/.claude` and `~/.codex` are never rewritten and the
 *  agents' own apps and other terminals are untouched. Every agent has `Default` — the Mac's own, with no folder here —
 *  and a current profile that new terminals start under. Claude Code first (step 2); Codex has the ones that pay by a
 *  key (§3.6) and, since 2026-10-20, the ones that sign in with a ChatGPT account (§6.2); OpenCode and pi have
 *  `Default` alone for now.
 *
 *  A profile's folder holds what is the account's and the device's (Claude Code's `.claude.json` with identifiers it
 *  makes itself on first run; Codex's `auth.json`, `installation_id` and its own databases; the credentials); what is
 *  the user's — instructions, skills, commands, settings — and the sessions are the Mac's own, linked in, so any profile
 *  continues any session and nothing is set up twice. Of the Mac's `.claude.json` only what names no account is carried
 *  over once (trusted folders, MCP servers, the theme); Codex keeps all of that in `config.toml`, which is linked. */

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROFILE_AGENTS = ["claude-code", "codex", "opencode", "pi"] as const;
export type ProfileAgent = (typeof PROFILE_AGENTS)[number];
export type ProfileKind = "subscription" | "api";
export const DEFAULT_PROFILE = "default";
/** A profile's own proxy (§4): where what runs under it leaves this Mac. The password is a ciphertext of the gate's. */
export type ProfileProxy = { readonly server: string; readonly username?: string | undefined; readonly password?: string | undefined };
/** How a profile that pays by a key reaches its model (§3.6): the key, a ciphertext of the gate's sealed for the
 *  address it is sent to; that address when it is not the vendor's own; the model it starts on when none is chosen. */
export type ProfileApi = { readonly key: string; readonly baseUrl?: string | undefined; readonly model?: string | undefined };
/** The vendor's own address for each agent that can pay by a key: where a key goes when the profile names no other. */
export const API_HOME: Partial<Record<ProfileAgent, string>> = { "claude-code": "https://api.anthropic.com", codex: "https://api.openai.com/v1" };
/** The ways a profile of each agent can sign in (absent: `Default` alone). A Codex account profile has a home folder of
 *  its own (§6.2); one that pays by a key needs none. */
export const PROFILE_KINDS: Partial<Record<ProfileAgent, readonly ProfileKind[]>> = { "claude-code": ["subscription", "api"], codex: ["subscription", "api"] };
const API_MODEL = /^[\w.:/@[\]-]{1,120}$/;

/** An address a key is sent to, as kept: http(s), no account in it, no query, no trailing slash. Null: not one. */
export function apiAddress(said: string): string | null {
  let url: URL;
  try { url = new URL(said.trim()); } catch { return null; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash || said.length > 300) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The site a profile's key is sealed for: the origin of where it is sent. */
export function apiSite(agent: ProfileAgent, baseUrl: string | undefined): string {
  return `${new URL(baseUrl ?? API_HOME[agent] ?? "https://invalid.invalid").origin}/`;
}

/** Where a profile's proxy let traffic out when it was last checked. */
export type ProfileExit = { readonly ip: string; readonly place: string | null; readonly timezone: string | null; readonly checkedAt: number };
/** The colours a profile can have (§3.2), by name; the screens know what each looks like. None of them is a colour
 *  the screens use for a state (waiting, working, failed, done, the signal). */
export const PROFILE_COLORS = ["violet", "sand", "mint", "orchid", "olive", "slate"] as const;
export type ProfileColor = (typeof PROFILE_COLORS)[number];
export type Profile = { readonly id: string; readonly name: string; readonly kind: ProfileKind; readonly createdAt: number;
  /** Its colour: the dot its terminals are marked with. `Default` has none. */
  readonly color?: ProfileColor;
  /** Who is signed in, as the agent's own files say (absent: nobody yet, or the agent does not say). */
  readonly account?: string;
  /** Its proxy as the screens are told of it (`sealed`: it has a password, never shown); absent: this Mac's own way out. */
  readonly proxy?: { readonly server: string; readonly username?: string; readonly sealed: boolean };
  readonly exit?: ProfileExit;
  /** One that pays by a key (§3.6): where the key is sent when not the vendor's own, the model it starts on. The key
   *  itself is never told. */
  readonly api?: { readonly baseUrl?: string; readonly model?: string };
  /** It has a claude.ai session key kept for its own browser (§3.4); the key itself is never told. */
  readonly sessionKey?: true;
  /** The device Claude Code says it is under this profile (§3.5): the `userID` of its own file; absent till it has run. */
  readonly device?: string;
  /** Claude Code's telemetry is off under it (§3.7: `DISABLE_TELEMETRY`); absent: on, as Claude Code has it. */
  readonly telemetry?: false };
export type AgentProfiles = { readonly current: string; readonly profiles: readonly Profile[]; /** More than `Default` can be made for this agent. */ readonly creatable: boolean;
  /** The ways a new profile of this agent can sign in; empty where none can be made. */ readonly kinds: readonly ProfileKind[] };

type Stored = { current?: string; profiles?: { id: string; name: string; kind: ProfileKind; createdAt: number; color?: ProfileColor; proxy?: ProfileProxy; exit?: ProfileExit; api?: ProfileApi;
  /** A claude.ai session key, a ciphertext of the gate's (§3.4), and whether the browser has yet to be given it. */
  sessionKey?: string; sessionKeyDue?: boolean;
  /** `false`: Claude Code's telemetry is off under it (§3.7). */
  telemetry?: false }[] };
type File = { agents?: Partial<Record<ProfileAgent, Stored>> };

export class ProfileError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict", message: string) { super(message); }
}

/** What of the Mac's own Claude Code folder a profile shares by a link: the user's own set-up, and the sessions with
 *  what goes with them (docs/profiles-v0.md §2). The session folders are made in the Mac's own when missing. */
const CLAUDE_LINKED = ["CLAUDE.md", "skills", "commands", "agents", "plugins", "keybindings.json", "output-styles", "settings.json"] as const;
const CLAUDE_SESSIONS = ["projects", "file-history", "todos", "plans"] as const;
/** What of the Mac's `.claude.json` names no account or device: carried into a new profile once. */
const CLAUDE_CARRIED = ["theme", "editorMode", "hasCompletedOnboarding", "lastOnboardingVersion", "autoUpdates", "verbose", "preferredNotifChannel", "mcpServers"] as const;
const CLAUDE_PROJECT_CARRIED = ["hasTrustDialogAccepted", "hasCompletedProjectOnboarding", "allowedTools", "mcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers"] as const;
/** The same for Codex (docs/profiles-v0.md §6.1–6.2): the user's own set-up — `config.toml` too, which holds no account
 *  (Codex writes through the link: the hooks' trust, a trusted folder, a model chosen land in the Mac's own) — and the
 *  sessions, which Codex finds under a linked `sessions/` both ways. What stays the profile's own: `auth.json`,
 *  `installation_id`, the databases, the caches, the locks. */
const CODEX_LINKED = ["config.toml", "AGENTS.md", "AGENTS.override.md", "skills", "rules", "prompts", "plugins"] as const;
const CODEX_SESSIONS = ["sessions", "archived_sessions"] as const;
const MAX_PROFILES = 24;
const DEVICE = /^[0-9a-f]{16,128}$/;
/** How many conversations' profiles are remembered for one agent (§3.3); the oldest go first. */
const MAX_SESSIONS = 4000;
type SessionNotes = Record<string, Record<string, { p: string; at: number }>>;

export type ProfileStoreOptions = { /** `$AGENTSWITCH_HOME`. */ readonly home: string; readonly userHome?: string; readonly now?: () => number };

export class ProfileStore {
  private readonly dir: string;
  private readonly file: string;
  /** Which profile each conversation last ran under (§3.3): `profiles/sessions.json`, AgentSwitch's own note — nothing
   *  is written into the agent's own files (a conversation stays what its own CLI made). */
  private readonly sessionsFile: string;
  private sessions: SessionNotes | null = null;
  private readonly userHome: string;
  private readonly now: () => number;

  constructor(o: ProfileStoreOptions) {
    this.dir = join(o.home, "profiles");
    this.file = join(this.dir, "profiles.json");
    this.sessionsFile = join(this.dir, "sessions.json");
    this.userHome = o.userHome ?? homedir();
    this.now = o.now ?? Date.now;
  }

  /** Every agent's profiles, `Default` first. */
  all(): Record<ProfileAgent, AgentProfiles> {
    const file = this.read();
    return Object.fromEntries(PROFILE_AGENTS.map((agent) => [agent, this.of(agent, file)])) as Record<ProfileAgent, AgentProfiles>;
  }

  /** A conversation of `agent` runs under `profile` now (null or `Default`: the Mac's own). Only what is not the
   *  Mac's own is written down; one that went back to the Mac's own is forgotten. */
  noteSession(agent: ProfileAgent, sessionId: string, profile: string | null): void {
    if (!sessionId || sessionId.length > 200) return;
    const notes = this.sessionNotes(), mine = (notes[agent] ??= {});
    const id = profile && profile !== DEFAULT_PROFILE ? profile : null;
    if ((mine[sessionId]?.p ?? null) === id) return;
    if (id) mine[sessionId] = { p: id, at: this.now() }; else delete mine[sessionId];
    const kept = Object.entries(mine);
    if (kept.length > MAX_SESSIONS) notes[agent] = Object.fromEntries(kept.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SESSIONS));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.sessionsFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(notes), { mode: 0o600 });
    renameSync(tmp, this.sessionsFile);
  }

  /** The profile a conversation of `agent` last ran under, when it is one that is still there; null: the Mac's own
   *  (it ran there, was started outside AgentSwitch, or its profile has since been removed). */
  sessionProfile(agent: ProfileAgent, sessionId: string): string | null {
    return this.sessionProfiles(agent).get(sessionId) ?? null;
  }

  /** The same for every conversation of `agent` that has one (the conversations' list). */
  sessionProfiles(agent: ProfileAgent): ReadonlyMap<string, string> {
    const mine = this.sessionNotes()[agent];
    if (!mine) return new Map();
    const there = new Set((this.read().agents?.[agent]?.profiles ?? []).map((p) => p.id));
    return new Map(Object.entries(mine).flatMap(([id, note]) => (there.has(note.p) ? [[id, note.p] as const] : [])));
  }

  private sessionNotes(): SessionNotes {
    if (this.sessions) return this.sessions;
    try { const parsed = JSON.parse(readFileSync(this.sessionsFile, "utf8")) as SessionNotes; this.sessions = parsed && typeof parsed === "object" ? parsed : {}; } catch { this.sessions = {}; }
    return this.sessions;
  }

  /** The profile last chosen for a new terminal of `agent`: what the next new terminal is offered first (§3.3). */
  current(agent: ProfileAgent): string { return this.of(agent, this.read()).current; }

  /** `id` is a profile of `agent` other than `Default`. */
  has(agent: ProfileAgent, id: string): boolean {
    return id !== DEFAULT_PROFILE && (this.read().agents?.[agent]?.profiles?.some((p) => p.id === id) ?? false);
  }

  /** How `id` reaches its model, whole (the key a ciphertext); null: it signs in with an account, or is not there. */
  apiOf(agent: ProfileAgent, id: string): ProfileApi | null {
    return this.read().agents?.[agent]?.profiles?.find((p) => p.id === id)?.api ?? null;
  }

  /** `id`'s key, address and model from now on. Only a profile that pays by a key has them. */
  setApi(agent: ProfileAgent, id: string, api: ProfileApi): void {
    const checked = checkedApi(agent, api);
    this.change(agent, id, (p) => { if (p.kind !== "api") throw new ProfileError("invalid", "this profile signs in with an account"); return { ...p, api: checked }; });
  }

  /** The folder the agent is started with for `id`; null for `Default` (the Mac's own), for one that has none (Codex's
   *  that pay by a key, which run in the Mac's own) and for one that is not there. */
  homeOf(agent: ProfileAgent, id: string): string | null {
    if (id === DEFAULT_PROFILE || !/^[a-z0-9]{6,16}$/.test(id)) return null;
    const home = join(this.dir, agent, id, "home");
    return this.read().agents?.[agent]?.profiles?.some((p) => p.id === id) && existsSync(home) ? home : null;
  }

  /** Before an agent starts under `id`: what of the Mac's own has come since the profile was made (an `AGENTS.md`, a
   *  `config.toml`) is linked in too, unless the profile has one of its own by now. Codex's alone. */
  keepLinked(agent: ProfileAgent, id: string): void {
    const home = this.homeOf(agent, id);
    if (home && agent === "codex") this.codexHome(home);
  }

  /** The name the screens show for `id` (null: no such profile). */
  nameOf(agent: ProfileAgent, id: string): string | null {
    return this.of(agent, this.read()).profiles.find((p) => p.id === id)?.name ?? null;
  }

  /** How `id` signs in; null for `Default` and for one that is not there. */
  kindOf(agent: ProfileAgent, id: string): ProfileKind | null {
    return this.read().agents?.[agent]?.profiles?.find((p) => p.id === id)?.kind ?? null;
  }

  /** `id`'s colour; null for `Default` and for one that is not there. */
  colorOf(agent: ProfileAgent, id: string): ProfileColor | null {
    return this.read().agents?.[agent]?.profiles?.find((p) => p.id === id)?.color ?? null;
  }

  /** Claude Code's telemetry is off under `id` (§3.7); false for `Default` and for one that is not there. */
  telemetryOff(agent: ProfileAgent, id: string): boolean {
    return this.read().agents?.[agent]?.profiles?.find((p) => p.id === id)?.telemetry === false;
  }

  /** Claude Code's telemetry under `id` from the next terminal on: on (as Claude Code has it) or off. */
  setTelemetry(agent: ProfileAgent, id: string, on: boolean): void {
    if (id === DEFAULT_PROFILE) throw new ProfileError("not_found", "no such profile");
    if (agent !== "claude-code") throw new ProfileError("invalid", "only Claude Code's telemetry can be turned off");
    this.change(agent, id, ({ telemetry: _was, ...p }) => (on ? p : { ...p, telemetry: false }));
  }

  setColor(agent: ProfileAgent, id: string, color: ProfileColor): void {
    if (id === DEFAULT_PROFILE) throw new ProfileError("not_found", "no such profile");
    if (!PROFILE_COLORS.includes(color)) throw new ProfileError("invalid", "no such colour");
    this.change(agent, id, (p) => ({ ...p, color }));
  }

  /** The proxy `id` has of its own, whole (for the forwarder); null: none, or no such profile. */
  proxyOf(agent: ProfileAgent, id: string): ProfileProxy | null {
    return this.read().agents?.[agent]?.profiles?.find((p) => p.id === id)?.proxy ?? null;
  }

  /** `id`'s proxy from now on (null: none); what was known of the old one's exit goes with it. */
  setProxy(agent: ProfileAgent, id: string, proxy: ProfileProxy | null): void {
    this.ensureDefault(agent, id);
    this.change(agent, id, (p) => { const { proxy: _old, exit: _was, ...rest } = p; return proxy ? { ...rest, proxy } : rest; });
  }

  /** `id`'s claude.ai session key, a ciphertext (§3.4), and whether its browser is still to be given it whatever it
   *  has; null: none kept, or no such profile. */
  sessionKeyOf(agent: ProfileAgent, id: string): { readonly sealed: string; readonly due: boolean } | null {
    const p = this.read().agents?.[agent]?.profiles?.find((x) => x.id === id);
    return p?.sessionKey ? { sealed: p.sessionKey, due: p.sessionKeyDue === true } : null;
  }

  /** `id`'s session key from now on (null: forgotten). A new one is due to its browser. */
  setSessionKey(agent: ProfileAgent, id: string, sealed: string | null): void {
    this.ensureDefault(agent, id);
    this.change(agent, id, (p) => { const { sessionKey: _old, sessionKeyDue: _was, ...rest } = p; return sealed ? { ...rest, sessionKey: sealed, sessionKeyDue: true } : rest; });
  }

  /** `id`'s browser has been given its session key. */
  sessionKeyGiven(agent: ProfileAgent, id: string): void {
    this.change(agent, id, (p) => { const { sessionKeyDue: _was, ...rest } = p; return rest; });
  }

  /** The device Claude Code says it is under `id` (§3.5); null: it has not run there yet, or another agent. */
  deviceOf(agent: ProfileAgent, id: string): string | null {
    return agent === "claude-code" ? this.account(agent, id === DEFAULT_PROFILE ? null : join(this.dir, agent, id, "home")).device ?? null : null;
  }

  /** Where `id`'s proxy let traffic out, as just checked (null: it did not). */
  setExit(agent: ProfileAgent, id: string, exit: ProfileExit | null): void {
    this.change(agent, id, (p) => { const { exit: _was, ...rest } = p; return exit ? { ...rest, exit } : rest; });
  }

  private change(agent: ProfileAgent, id: string, edit: (p: NonNullable<Stored["profiles"]>[number]) => NonNullable<Stored["profiles"]>[number]): void {
    const file = this.read();
    const stored = file.agents?.[agent];
    if (!stored?.profiles?.some((p) => p.id === id)) throw new ProfileError("not_found", "no such profile");
    this.write({ ...file, agents: { ...file.agents, [agent]: { ...stored, profiles: stored.profiles.map((p) => (p.id === id ? edit(p) : p)) } } });
  }

  setCurrent(agent: ProfileAgent, id: string): void {
    const file = this.read();
    if (!this.of(agent, file).profiles.some((p) => p.id === id)) throw new ProfileError("not_found", "no such profile");
    this.write({ ...file, agents: { ...file.agents, [agent]: { ...file.agents?.[agent], current: id } } });
  }

  private ensureDefault(agent: ProfileAgent, id: string): void {
    if (id !== DEFAULT_PROFILE) return;
    if (agent !== "claude-code") throw new ProfileError("invalid", "only Claude Code Default supports this setting");
    const file = this.read(), stored = file.agents?.[agent] ?? {};
    if (stored.profiles?.some((p) => p.id === id)) return;
    this.write({ ...file, agents: { ...file.agents, [agent]: { ...stored, profiles: [
      ...(stored.profiles ?? []), { id, name: "Default", kind: "subscription", createdAt: 0 },
    ] } } });
  }

  resetDefaultIdentity(): void {
    const path = join(this.userHome, ".claude.json");
    if (!existsSync(path)) return;
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProfileError("invalid", "Claude config must be an object");
    delete value.userID;
    delete value.machineID;
    delete value.oauthAccount;
    const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(tmp, path);
    } finally { rmSync(tmp, { force: true }); }
  }

  /** A new profile. One that pays by a key is made with the key (a ciphertext the caller has had the gate open once). */
  create(agent: ProfileAgent, name: string, kind: ProfileKind, api?: ProfileApi): Profile {
    if (!PROFILE_KINDS[agent]?.includes(kind)) throw new ProfileError("invalid", PROFILE_KINDS[agent] ? `a ${agent} profile cannot sign in that way yet` : "this agent has `Default` alone so far");
    if ((kind === "api") !== Boolean(api)) throw new ProfileError("invalid", kind === "api" ? "a profile that pays by a key needs the key" : "only a profile that pays by a key has one");
    const checked = api ? checkedApi(agent, api) : null;
    const said = name.trim().replace(/\s+/g, " ");
    if (!said || said.length > 40) throw new ProfileError("invalid", "a profile needs a name of 1 to 40 characters");
    const file = this.read();
    const known = this.of(agent, file).profiles;
    if (known.some((p) => p.name.toLowerCase() === said.toLowerCase())) throw new ProfileError("conflict", `there is a profile named ${said} already`);
    if (known.length >= MAX_PROFILES) throw new ProfileError("conflict", "too many profiles");
    // A colour no other profile of this agent has, while there is one left; then they come round again.
    const taken = new Set((file.agents?.[agent]?.profiles ?? []).map((p) => p.color));
    const color = PROFILE_COLORS.find((c) => !taken.has(c)) ?? PROFILE_COLORS[known.length % PROFILE_COLORS.length]!;
    const profile = { id: randomBytes(5).toString("hex"), name: said, kind, createdAt: this.now(), color };
    // Claude Code's and Codex's sign-in and identifiers are a folder's; Codex paying by a key runs in the Mac's own
    // folder, the key and the address given when it starts (§3.6).
    if (agent === "claude-code") this.claudeHome(join(this.dir, agent, profile.id, "home"));
    if (agent === "codex" && kind === "subscription") this.codexHome(join(this.dir, agent, profile.id, "home"));
    const stored = file.agents?.[agent] ?? {};
    this.write({ ...file, agents: { ...file.agents, [agent]: { ...stored, profiles: [...(stored.profiles ?? []), { ...profile, ...(checked ? { api: checked } : {}) }] } } });
    return { ...profile, ...(checked ? { api: told(checked) } : {}) };
  }

  /** Removes a profile and its folder (the sessions, linked, stay where they are). `Default` cannot go; the current one
   *  going makes `Default` current. The agent's own sign-out (its keychain entry) is the caller's to do first. */
  remove(agent: ProfileAgent, id: string): void {
    const file = this.read();
    const stored = file.agents?.[agent];
    if (id === DEFAULT_PROFILE || !stored?.profiles?.some((p) => p.id === id)) throw new ProfileError("not_found", "no such profile");
    this.write({ ...file, agents: { ...file.agents, [agent]: { current: stored.current === id ? DEFAULT_PROFILE : stored.current, profiles: stored.profiles.filter((p) => p.id !== id) } } });
    rmSync(join(this.dir, agent, id), { recursive: true, force: true });
  }

  /** Every profile folder of `agent` except `keep`'s: what a terminal under one profile is not to read. */
  othersOf(agent: ProfileAgent, keep: string): string[] {
    return (this.read().agents?.[agent]?.profiles ?? []).filter((p) => p.id !== keep).map((p) => join(this.dir, agent, p.id));
  }

  // ---- inside

  private of(agent: ProfileAgent, file: File): AgentProfiles {
    const stored = file.agents?.[agent] ?? {};
    // A proxy's password, a ciphertext, is not for the screens: they are told only that it has one.
    // Nor is a session key: only that there is one. Nor the key a profile pays by: only where it is sent.
    const own: Profile[] = (stored.profiles ?? []).map(({ proxy, sessionKey, sessionKeyDue: _due, api, ...p }) => ({ ...p,
      ...(api ? { api: told(api) } : {}),
      ...(sessionKey ? { sessionKey: true as const } : {}),
      ...(proxy ? { proxy: { server: proxy.server, ...(proxy.username ? { username: proxy.username } : {}), sealed: Boolean(proxy.password) } } : {}),
      ...this.account(agent, p.id === DEFAULT_PROFILE ? null : join(this.dir, agent, p.id, "home")) }));
    const profiles: Profile[] = [own.find((p) => p.id === DEFAULT_PROFILE) ?? { id: DEFAULT_PROFILE, name: "Default", kind: "subscription", createdAt: 0, ...this.account(agent, null) }, ...own.filter((p) => p.id !== DEFAULT_PROFILE)];
    return { current: profiles.some((p) => p.id === stored.current) ? stored.current! : DEFAULT_PROFILE, profiles, creatable: Boolean(PROFILE_KINDS[agent]), kinds: PROFILE_KINDS[agent] ?? [] };
  }

  /** Who the agent's own files in `home` (null: the Mac's own) say is signed in: Claude Code's address as it shows it
   *  itself, Codex's from the ChatGPT sign-in it keeps (the address in its identity token; nothing else is read). */
  private account(agent: ProfileAgent, home: string | null): { account?: string; device?: string } {
    if (agent === "codex") return codexAccount(join(home ?? join(this.userHome, ".codex"), "auth.json"));
    if (agent !== "claude-code") return {};
    try {
      const file = JSON.parse(readFileSync(home ? join(home, ".claude.json") : join(this.userHome, ".claude.json"), "utf8")) as { oauthAccount?: { emailAddress?: unknown }; userID?: unknown };
      const o = file.oauthAccount;
      return { ...(typeof o?.emailAddress === "string" && o.emailAddress ? { account: o.emailAddress.slice(0, 120) } : {}),
        // The device it reports itself as: made by Claude Code on its first run, a folder's own.
        ...(typeof file.userID === "string" && DEVICE.test(file.userID) ? { device: file.userID } : {}) };
    } catch { return {}; }
  }

  /** A Claude Code home for a new profile: the links, and a `.claude.json` with nothing that names an account. */
  private claudeHome(home: string): void {
    const own = join(this.userHome, ".claude");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    for (const name of CLAUDE_SESSIONS) mkdirSync(join(own, name), { recursive: true });
    for (const name of [...CLAUDE_LINKED, ...CLAUDE_SESSIONS]) {
      const target = join(own, name);
      if (!existsSync(target) || present(join(home, name))) continue;
      symlinkSync(target, join(home, name));
    }
    let seed: Record<string, unknown> = {};
    try {
      const mine = JSON.parse(readFileSync(join(this.userHome, ".claude.json"), "utf8")) as Record<string, unknown>;
      for (const key of CLAUDE_CARRIED) if (key in mine) seed[key] = mine[key];
      const projects = mine.projects && typeof mine.projects === "object" ? mine.projects as Record<string, Record<string, unknown>> : {};
      seed.projects = Object.fromEntries(Object.entries(projects).map(([path, p]) => [path, Object.fromEntries(CLAUDE_PROJECT_CARRIED.filter((k) => p && k in p).map((k) => [k, p[k]]))]));
    } catch { seed = {}; }
    writeFileSync(join(home, ".claude.json"), JSON.stringify(seed, null, 2), { mode: 0o600 });
  }

  /** A Codex home for an account profile (made or kept): the links, nothing else — Codex makes the rest on its first
   *  run there. Where the Mac's own has no such file the profile's own stands; a profile's own file is never replaced. */
  private codexHome(home: string): void {
    const own = join(this.userHome, ".codex");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    for (const name of CODEX_SESSIONS) mkdirSync(join(own, name), { recursive: true });
    for (const name of [...CODEX_LINKED, ...CODEX_SESSIONS]) {
      const target = join(own, name);
      if (!existsSync(target) || present(join(home, name))) continue;
      symlinkSync(target, join(home, name));
    }
  }

  private read(): File {
    let file: File;
    try { const parsed = JSON.parse(readFileSync(this.file, "utf8")) as File; file = parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
    // A profile made before profiles had colours is given one now, and keeps it.
    let coloured = false;
    for (const stored of Object.values(file.agents ?? {})) {
      const taken = new Set((stored?.profiles ?? []).map((p) => p.color));
      for (const [i, p] of (stored?.profiles ?? []).entries()) {
        if (p.color && PROFILE_COLORS.includes(p.color)) continue;
        p.color = PROFILE_COLORS.find((c) => !taken.has(c)) ?? PROFILE_COLORS[i % PROFILE_COLORS.length]!;
        taken.add(p.color);
        coloured = true;
      }
    }
    if (coloured) this.write(file);
    return file;
  }

  private write(file: File): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** What the screens are told of how a profile reaches its model: never the key. */
const told = (api: ProfileApi): { baseUrl?: string; model?: string } => ({ ...(api.baseUrl ? { baseUrl: api.baseUrl } : {}), ...(api.model ? { model: api.model } : {}) });

/** A key, address and model as kept; refused when one of them is not what it should be. */
function checkedApi(agent: ProfileAgent, api: ProfileApi): ProfileApi {
  if (!API_HOME[agent]) throw new ProfileError("invalid", "this agent cannot pay by a key here");
  if (!api.key || api.key.length > 4000 || /\s/.test(api.key)) throw new ProfileError("invalid", "a profile that pays by a key needs the key");
  const baseUrl = api.baseUrl?.trim() ? apiAddress(api.baseUrl) : undefined;
  if (baseUrl === null) throw new ProfileError("invalid", "the address is not an http(s) address");
  const model = api.model?.trim() || undefined;
  if (model && !API_MODEL.test(model)) throw new ProfileError("invalid", "the model's name is not one");
  return { key: api.key, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) };
}

const present = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };

/** Who Codex's `auth.json` says is signed in with ChatGPT: the address in its identity token (a JWT, only its middle
 *  part read). Nothing for a key, a file that is not there, or anything else. */
export function codexAccount(file: string): { account?: string } {
  try {
    const token = (JSON.parse(readFileSync(file, "utf8")) as { tokens?: { id_token?: unknown } }).tokens?.id_token;
    if (typeof token !== "string") return {};
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" && claims.email ? { account: claims.email.slice(0, 120) } : {};
  } catch { return {}; }
}
