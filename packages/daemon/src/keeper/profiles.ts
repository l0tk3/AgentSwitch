/** `agentswitch profiles` (docs/mesh-v0.md §4.3, docs/profiles-v0.md): a node's profiles from its command line — what
 *  the Mac does in Settings › Agents. List them; make one, signing in by an account or paying by an API key (§3.6:
 *  where the key is sent, the model it starts on); change a key-paying one's key, address or model; its colour; remove
 *  one. A key is typed with nothing echoed (or piped in), sealed by this node's own gate for the site it is sent to —
 *  `secret-gate enc --batch`, the value on stdin, as the Mac's GateSeal does — and only the ciphertext reaches the
 *  service. Making, changing and removing are the node's own business (a paired device is refused, mesh-v0 §2.3), so
 *  they are done here and not through `--on`; listing works on another node too. */

import { spawn } from "node:child_process";
import { API_HOME, apiAddress, apiSite, PROFILE_AGENTS, PROFILE_COLORS, type AgentProfiles, type Profile, type ProfileAgent, type ProfileKind } from "../profiles/store.js";

/** The calls on the service this needs (client.ts). */
export type ProfilesClient = {
  profiles(): Promise<{ agents: Record<ProfileAgent, AgentProfiles> }>;
  createProfile(agent: ProfileAgent, name: string, kind: ProfileKind, api?: { key: string; baseUrl?: string; model?: string; force?: boolean }): Promise<{ profile: Profile }>;
  setProfileApi(agent: ProfileAgent, id: string, api: { key: string | null; baseUrl: string | null; model: string | null; force?: boolean }): Promise<unknown>;
  setProfileColor(agent: ProfileAgent, id: string, color: string): Promise<unknown>;
  removeProfile(agent: ProfileAgent, id: string): Promise<unknown>;
};

export type ProfilesOptions = { readonly api: boolean; readonly baseUrl?: string | undefined; readonly model?: string | undefined; readonly key: boolean; readonly json: boolean; readonly remote: boolean;
  /** Keep a model the address does not list (the service checks it against the address's own list). */
  readonly force?: boolean };

export type ProfilesDeps = {
  readonly client: ProfilesClient;
  /** The key, typed or piped; `prompt` says for what. */
  readonly readKey: (prompt: string) => Promise<string>;
  /** `value` sealed by this node's gate for `host` (host[:port]): the ciphertext. */
  readonly seal: (host: string, value: string) => Promise<string>;
  readonly print: (line: string) => void;
};

const USAGE = [
  "profiles [--json]                                        every agent's profiles",
  'profiles new <agent> "<name>" [--api] [--base-url <url>] [--model <model>] [--force]',
  "                                                         a profile that signs in by an account, or (--api, or",
  "                                                         either option) pays by an API key: asked for, never echoed",
  "profiles api <agent> <profile> [--base-url <url>|\"\"] [--model <model>|\"\"] [--key] [--force]",
  "                                                         a key-paying profile's address, model; --key a new key",
  "                                                         (asked for anyway when the address moves to another site)",
  `profiles color <agent> <profile> <${PROFILE_COLORS.join("|")}>`,
  "profiles rm <agent> <profile>",
  "<agent>: claude-code (claude), codex, opencode, pi; <profile>: its id or its name; a model is checked against the",
  "address's own list (--force keeps one it does not list)",
].join("\n");

const ALIASES: Record<string, ProfileAgent> = { claude: "claude-code", cc: "claude-code" };

export function agentOf(said: string | undefined): ProfileAgent {
  const name = said?.trim().toLowerCase() ?? "";
  const agent = ALIASES[name] ?? PROFILE_AGENTS.find((a) => a === name);
  if (!agent) throw new Error(`no such agent: ${said ?? "(none)"} (${PROFILE_AGENTS.join(", ")})`);
  return agent;
}

/** A profile of `agent` by its id, else by its name (letter case aside); one name two profiles share is asked again by id. */
export function profileOf(agents: Record<ProfileAgent, AgentProfiles>, agent: ProfileAgent, said: string | undefined): Profile {
  const all = agents[agent]?.profiles ?? [];
  const ref = said?.trim() ?? "";
  const byId = all.find((p) => p.id === ref);
  if (byId) return byId;
  const byName = all.filter((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new Error(`${byName.length} ${agent} profiles are called ${ref}: name one by its id (${byName.map((p) => p.id).join(", ")})`);
  throw new Error(`no ${agent} profile ${ref || "(none)"}: ${all.map((p) => `${p.id} (${p.name})`).join(", ")}`);
}

/** Where a key for `agent` at `baseUrl` is sealed for, as the gate binds it: host[:port] of the address's site. */
export function sealHost(agent: ProfileAgent, baseUrl: string | undefined): string {
  return new URL(apiSite(agent, baseUrl)).host;
}

/** An address as typed: undefined for none given, null for "" (the vendor's own), else the address as kept. */
function addressOf(said: string | undefined): string | null | undefined {
  if (said === undefined) return undefined;
  if (!said.trim()) return null;
  const kept = apiAddress(said);
  if (!kept) throw new Error(`not an address a key can be sent to: ${said} (http(s), no account, no query)`);
  return kept;
}

/** One line a profile. */
export function profileLine(p: Profile): string {
  const how = p.kind === "api"
    ? `API Key · ${p.api?.baseUrl ? new URL(p.api.baseUrl).host : "the vendor's own address"}${p.api?.model ? ` · ${p.api.model}` : ""}`
    : p.id === "default" ? "this machine's own sign-in" : p.account ? `signed in as ${p.account}` : "not signed in yet";
  const proxy = p.proxy ? `  proxy ${p.proxy.server}${p.exit ? ` → ${p.exit.ip}${p.exit.place ? ` (${p.exit.place})` : ""}` : ""}` : "";
  return `  ${p.id.padEnd(10)} ${p.name.padEnd(16)} ${how}${p.color ? `  [${p.color}]` : ""}${proxy}`;
}

export function listLines(agents: Record<ProfileAgent, AgentProfiles>): string[] {
  const lines: string[] = [];
  for (const agent of PROFILE_AGENTS) {
    const a = agents[agent];
    if (!a) continue;
    lines.push(`${agent}${a.kinds.length ? "" : "  (Default only)"}`);
    for (const p of a.profiles) lines.push(profileLine(p));
  }
  return lines;
}

export async function profilesCommand(args: readonly (string | undefined)[], o: ProfilesOptions, deps: ProfilesDeps): Promise<number> {
  const [sub, ...rest] = args;
  if (sub && sub !== "list" && o.remote) throw new Error("profiles are made, changed and removed on the node itself (mesh-v0 §2.3): only `profiles` lists with --on");
  switch (sub) {
    case undefined:
    case "list": {
      const { agents } = await deps.client.profiles();
      if (o.json) deps.print(JSON.stringify(agents, null, 2));
      else for (const line of listLines(agents)) deps.print(line);
      return 0;
    }
    case "new": {
      const agent = agentOf(rest[0]);
      const name = rest[1]?.trim();
      if (!name) throw new Error(`profiles new ${agent} "<name>"`);
      const { agents } = await deps.client.profiles();
      const kinds = agents[agent]?.kinds ?? [];
      if (!kinds.length) throw new Error(`${agent} has Default alone for now (docs/profiles-v0.md §6)`);
      const byKey = o.api || o.baseUrl !== undefined || o.model !== undefined || !kinds.includes("subscription");
      if (!byKey) {
        const { profile } = await deps.client.createProfile(agent, name, "subscription");
        deps.print(`made ${agent} profile ${profile.id} (${profile.name}): open a terminal under it and it starts by signing in`);
        return 0;
      }
      if (!kinds.includes("api")) throw new Error(`${agent} profiles cannot pay by an API key`);
      const baseUrl = addressOf(o.baseUrl) ?? undefined;
      const model = o.model?.trim() || undefined;
      const host = sealHost(agent, baseUrl);
      const key = await deps.readKey(`API key for ${host}: `);
      if (!key) throw new Error("no key typed; nothing made");
      const { profile } = await deps.client.createProfile(agent, name, "api", { key: await deps.seal(host, key), ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}), ...(o.force ? { force: true } : {}) });
      deps.print(`made ${agent} profile ${profile.id} (${profile.name}): API key for ${host} (kept sealed)${model ? `, model ${model}` : ""}`);
      return 0;
    }
    case "api": {
      const agent = agentOf(rest[0]);
      const { agents } = await deps.client.profiles();
      const p = profileOf(agents, agent, rest[1]);
      if (p.kind !== "api") throw new Error(`${p.name} signs in by an account; it has no API key`);
      const given = addressOf(o.baseUrl);
      const baseUrl = given === undefined ? p.api?.baseUrl : given ?? undefined;
      const model = o.model === undefined ? p.api?.model : o.model.trim() || undefined;
      const host = sealHost(agent, baseUrl);
      // The key kept was sealed for its site: another site takes a new one.
      const moved = sealHost(agent, p.api?.baseUrl) !== host;
      let key: string | null = null;
      if (o.key || moved) {
        const typed = await deps.readKey(`${moved && !o.key ? "the address is on another site now; " : ""}API key for ${host}: `);
        if (!typed) throw new Error("no key typed; nothing changed");
        key = await deps.seal(host, typed);
      }
      await deps.client.setProfileApi(agent, p.id, { key, baseUrl: baseUrl ?? null, model: model ?? null, ...(o.force ? { force: true } : {}) });
      deps.print(`${p.name}: ${baseUrl ?? API_HOME[agent]}${model ? `, model ${model}` : ", the agent's own model"}${key ? ", new key" : ""}. Terminals open under it keep the address and model they started with; close one and resume its conversation to use these`);
      return 0;
    }
    case "color": {
      const agent = agentOf(rest[0]);
      const color = rest[2]?.trim().toLowerCase() ?? "";
      if (!(PROFILE_COLORS as readonly string[]).includes(color)) throw new Error(`a colour is one of ${PROFILE_COLORS.join(", ")}`);
      const p = profileOf((await deps.client.profiles()).agents, agent, rest[1]);
      await deps.client.setProfileColor(agent, p.id, color);
      deps.print(`${p.name}: ${color}`);
      return 0;
    }
    case "rm": {
      const agent = agentOf(rest[0]);
      const p = profileOf((await deps.client.profiles()).agents, agent, rest[1]);
      if (p.id === "default") throw new Error("Default is this machine's own sign-in and stays");
      await deps.client.removeProfile(agent, p.id);
      deps.print(`removed ${agent} profile ${p.id} (${p.name}) and its folder`);
      return 0;
    }
    default:
      deps.print(USAGE);
      return 2;
  }
}

/** A key from the terminal with nothing echoed, or from stdin when it is a pipe (`… | agentswitch profiles new …`). */
export async function readKey(prompt: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  output.write(prompt);
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (err) reject(err); else resolve(value.trim());
    };
    const onData = (text: string) => {
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003" || ch === "\u0004") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}

export type Run = (cmd: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv; input: string }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const run: Run = (cmd, args, opts) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  child.stdin.end(opts.input);
});

/** `value` sealed by the gate at `gate` for `host`, as the Mac seals a profile's key, its proxy's password and its
 *  session key (AgentsView, GateSealRequest): a secret for that one host, for `http` and `fill`, under `label`. The
 *  value goes on stdin, never into argv. */
export async function sealWithGate(gate: { bin: string; home: string }, host: string, value: string, exec: Run = run, label = "profile/api-key"): Promise<string> {
  const entry = [{ label, hosts: [host], uses: ["http", "fill"], kind: "secret", value }];
  const r = await exec(gate.bin, ["enc", "--batch"], { env: { ...process.env, SECRET_GATE_HOME: gate.home }, input: JSON.stringify(entry) });
  // Exit 1 is a refusal of the entry, its reason in the output.
  if (r.code !== 0 && r.code !== 1) throw new Error(`secret-gate: ${r.stderr.trim() || `exit ${r.code}`}`);
  let row: { token?: string; error?: string } | undefined;
  try { row = (JSON.parse(r.stdout) as { token?: string; error?: string }[])[0]; } catch { throw new Error("secret-gate's answer could not be read"); }
  if (row?.token?.startsWith("enc:v1:")) return row.token;
  throw new Error(`the key could not be sealed: ${row?.error ?? r.stderr.trim()}`);
}
