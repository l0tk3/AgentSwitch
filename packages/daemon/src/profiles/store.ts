/** Profiles (docs/profiles-v0.md): several sign-ins per agent, each a home folder of its own that the agent is started
 *  with (`CLAUDE_CONFIG_DIR` …), so the Mac's own `~/.claude` is never rewritten and the agents' own apps and other
 *  terminals are untouched. Every agent has `Default` — the Mac's own, with no folder here — and a current profile that
 *  new terminals start under. Claude Code first (step 2); the others have `Default` alone for now.
 *
 *  A profile's folder holds what is the account's and the device's (its `.claude.json` with identifiers Claude Code
 *  makes itself on first run, its credentials); what is the user's — instructions, skills, commands, settings — and the
 *  sessions are the Mac's own, linked in, so any profile continues any session and nothing is set up twice. Of the
 *  Mac's `.claude.json` only what names no account is carried over once (trusted folders, MCP servers, the theme). */

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
  readonly exit?: ProfileExit };
export type AgentProfiles = { readonly current: string; readonly profiles: readonly Profile[]; /** More than `Default` can be made for this agent. */ readonly creatable: boolean };

type Stored = { current?: string; profiles?: { id: string; name: string; kind: ProfileKind; createdAt: number; color?: ProfileColor; proxy?: ProfileProxy; exit?: ProfileExit }[] };
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
const MAX_PROFILES = 24;
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

  /** The folder the agent is started with for `id`; null for `Default` (the Mac's own) and for one that is not there. */
  homeOf(agent: ProfileAgent, id: string): string | null {
    if (id === DEFAULT_PROFILE || !/^[a-z0-9]{6,16}$/.test(id)) return null;
    const home = join(this.dir, agent, id, "home");
    return this.read().agents?.[agent]?.profiles?.some((p) => p.id === id) && existsSync(home) ? home : null;
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

  setColor(agent: ProfileAgent, id: string, color: ProfileColor): void {
    if (!PROFILE_COLORS.includes(color)) throw new ProfileError("invalid", "no such colour");
    this.change(agent, id, (p) => ({ ...p, color }));
  }

  /** The proxy `id` has of its own, whole (for the forwarder); null: none, or no such profile. */
  proxyOf(agent: ProfileAgent, id: string): ProfileProxy | null {
    return this.read().agents?.[agent]?.profiles?.find((p) => p.id === id)?.proxy ?? null;
  }

  /** `id`'s proxy from now on (null: none); what was known of the old one's exit goes with it. */
  setProxy(agent: ProfileAgent, id: string, proxy: ProfileProxy | null): void {
    this.change(agent, id, (p) => { const { proxy: _old, exit: _was, ...rest } = p; return proxy ? { ...rest, proxy } : rest; });
  }

  /** Where `id`'s proxy let traffic out, as just checked (null: it did not). */
  setExit(agent: ProfileAgent, id: string, exit: ProfileExit | null): void {
    this.change(agent, id, (p) => { const { exit: _was, ...rest } = p; return exit ? { ...rest, exit } : rest; });
  }

  private change(agent: ProfileAgent, id: string, edit: (p: NonNullable<Stored["profiles"]>[number]) => NonNullable<Stored["profiles"]>[number]): void {
    const file = this.read();
    const stored = file.agents?.[agent];
    if (id === DEFAULT_PROFILE || !stored?.profiles?.some((p) => p.id === id)) throw new ProfileError("not_found", "no such profile");
    this.write({ ...file, agents: { ...file.agents, [agent]: { ...stored, profiles: stored.profiles.map((p) => (p.id === id ? edit(p) : p)) } } });
  }

  setCurrent(agent: ProfileAgent, id: string): void {
    const file = this.read();
    if (!this.of(agent, file).profiles.some((p) => p.id === id)) throw new ProfileError("not_found", "no such profile");
    this.write({ ...file, agents: { ...file.agents, [agent]: { ...file.agents?.[agent], current: id } } });
  }

  create(agent: ProfileAgent, name: string, kind: ProfileKind): Profile {
    if (agent !== "claude-code") throw new ProfileError("invalid", "profiles are for Claude Code only so far");
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
    this.claudeHome(join(this.dir, agent, profile.id, "home"));
    const stored = file.agents?.[agent] ?? {};
    this.write({ ...file, agents: { ...file.agents, [agent]: { ...stored, profiles: [...(stored.profiles ?? []), profile] } } });
    return profile;
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
    const own: Profile[] = (stored.profiles ?? []).map(({ proxy, ...p }) => ({ ...p,
      ...(proxy ? { proxy: { server: proxy.server, ...(proxy.username ? { username: proxy.username } : {}), sealed: Boolean(proxy.password) } } : {}),
      ...this.account(agent, join(this.dir, agent, p.id, "home", ".claude.json")) }));
    const profiles: Profile[] = [{ id: DEFAULT_PROFILE, name: "Default", kind: "subscription", createdAt: 0, ...this.account(agent, join(this.userHome, ".claude.json")) }, ...own];
    return { current: profiles.some((p) => p.id === stored.current) ? stored.current! : DEFAULT_PROFILE, profiles, creatable: agent === "claude-code" };
  }

  /** Who Claude Code's own file says is signed in: the plan's organisation and the address, as it shows them itself. */
  private account(agent: ProfileAgent, claudeJson: string): { account?: string } {
    if (agent !== "claude-code") return {};
    try {
      const o = (JSON.parse(readFileSync(claudeJson, "utf8")) as { oauthAccount?: { emailAddress?: unknown } }).oauthAccount;
      return typeof o?.emailAddress === "string" && o.emailAddress ? { account: o.emailAddress.slice(0, 120) } : {};
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

const present = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };
