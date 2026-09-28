# agentswitch-daemon

TypeScript daemon for AgentSwitch: task engine, router, HTTP API, quota. The phone is just another
client of the API; during development the CLI plays that role. Design: `docs/design-v0.md`,
`docs/router-v0.md`.

```
CLI / Mac app ──HTTP──▶ agentswitchd (127.0.0.1:4711)
iPhone app ──HTTPS (pinned, device token)──▶ agentswitchd (*:4713, AGENTSWITCH_REMOTE=1; see "Remote access")
                        ├─ engine/   queue → route → dispatch → (fail → reroute)* → done; approvals; SQLite + JSONL
                        ├─ router/   targets.yaml, DeepSeek dispatcher (OpenCode agent), policy floor, CONTEXT.md, routing_log
                        ├─ executors/ echo (dev), claude-code (Agent SDK), codex (app-server), opencode (resident serve, run fallback); secret-gate wired in
                        ├─ quota/    codex app-server rateLimits, DeepSeek /user/balance, Claude local token count
                        ├─ api/      Hono: /tasks (+SSE events, approve, cancel), /quota, /targets, /route/preview, /context
                        └─ remote/   HTTPS listener, source filter, route allowlist, pairing, device tokens
```

## Run

```bash
npm install && npm test                       # vitest + coverage, no model calls
bin/agentswitch serve                         # daemon; AGENTSWITCH_ROUTER=echo to skip DeepSeek
bin/agentswitch task "修一下 cli.py 的 bug" --cwd ~/proj      # submit + follow events; approvals prompt y/N in a TTY
bin/agentswitch task "..." --pin claude-code/claude-opus-5[1m] # skip the router
bin/agentswitch tasks | show <id> | watch <id> | cancel <id>
bin/agentswitch approvals | approve <task> <approval> --allow|--deny
bin/agentswitch quota --refresh               # three harnesses
bin/agentswitch preview "..." | log | context | health
bin/agentswitch route "..." [--router echo]   # local routing without the daemon (also `reroute`, `context init`)
npm run build                                 # tsc src/ → dist/ (tsconfig.build.json); then: node dist/cli.js serve
```

Environment: `AGENTSWITCH_HOME` (default `~/.agentswitch`: `agentswitch.db`, `routing.db`, `tasks/<id>.jsonl`,
`CONTEXT.md`), `AGENTSWITCH_PORT` (4711), `AGENTSWITCH_ROUTER` (`opencode`|`echo`), `DEEPSEEK_API_KEY`
(else the key from OpenCode's credential store is used, read-only), `AGENTSWITCH_REMOTE` / `AGENTSWITCH_REMOTE_PORT` /
`AGENTSWITCH_REMOTE_NAME` (see "Remote access").

Production build: `npm run build` compiles `src/` to `dist/` with the same layout, so `dist/` finds `config/` and `ui/`
next to it as `src/` does. What ships: `dist/`, `config/`, `ui/`, `package.json` (it declares `"type": "module"`) and
`npm ci --omit=dev` node_modules; nothing imports a devDependency at runtime (`tests/build.test.ts` checks, then runs
`node dist/cli.js serve` from a copy of that layout). `serve` exits 0 on SIGINT and SIGTERM.

Development executor: put an `@echo {...}` directive in the task text to script the run:
`{"delayMs":50,"approval":"rm -rf /tmp/x","fail":"quota","failTimes":1,"result":"ok","tokens":123}`.

## Plaintext credentials in a task (router-v0 §9)

Write tasks as you like, accounts and passwords included. Every submission passes the sealer before
it is stored: the router's text-only agent decides what is sensitive and which host each value is for
(from the text, CONTEXT.md and the earlier turn), the daemon mints tokens with `secret-gate enc --batch`
(the desktop UI's command and current keypair) and stores the task with tokens in place of the values.
A `sealed` event lists labels and hosts. An http credential whose site nothing names is refused (400);
a sealer failure refuses the submission (503) instead of storing plaintext. Echo mode has no sealer.

## Phone draft UI

`http://127.0.0.1:4711/ui` (`/` redirects there): a desktop console served from `ui/` (plain ES modules, no build step; `/ui/*` serves only files inside that directory),
mobile-first. Home = composer (just type what you want; the router decides) with 高级选项 for
working directory, pinned model and browser, above a feed of pending approvals / running / recent
tasks; task detail with live events (SSE), brief, routing reason, approval buttons and a reply box
(追问: a follow-up task that carries the conversation); 额度 tab with
5h / 7d windows per harness (reset countdowns), DeepSeek balance, Claude local count; 路由日志 tab.
It only uses the API below, so it is the wireframe for the iOS app and the development console until
then. Later: served over Tailscale behind bearer auth.

## Ephemeral tasks

`POST /tasks` without `cwd` (CLI: `task "..." --ephemeral`) runs in `~/.agentswitch/work/<id>` and,
when the task ends, `cleanupEphemeral` deletes the work dir, Claude Code's transcript directory for
it (`~/.claude/projects/<path with non-alphanumerics → "-">`, both `/var` and `/private/var`
spellings) and any `history.jsonl` lines for it, and OpenCode's `session_v2` / messages / project /
worktree rows plus `snapshot/` and `tool-output/` for that directory. Codex runs in a private
`CODEX_HOME` that is removed after every run, so nothing is left there. The work dir is only ever
deleted when it is under the OS temp dir or `~/.agentswitch/work`; a persistent project passed with
`ephemeral: true` keeps its files and only loses the harness records. Only regular, singly linked files of `out/` are
copied to `artifacts/<id>` (no symlink or hard link, not a symlinked `out/`). The task's own event log in
`~/.agentswitch/tasks/<id>.jsonl` is kept (that is AgentSwitch's record, not the harness's).
Executors also remove their own temp files (Claude browser profile, OpenCode config dir, router
config dir).

## Background tasks (background-v0)

Tasks run concurrently. Four gates, in this order: a global cap (`AGENTSWITCH_MAX_TASKS`, default
4, FIFO beyond it), the parent (a follow-up waits for its parent to end), one task per thread and
one per cwd (`KeyedLock`), and one slot per harness `max_concurrent` taken at dispatch (full →
wait, never switch target). A task that has to wait emits a `waiting` event saying for what
(`global`, `parent`, `thread`, `cwd`, `harness:<name>`); cancelling a waiting task takes effect
at once. Sub-agents the harnesses spawn (Claude `task_*` system messages, Codex
`subAgentActivity` / `collabAgentToolCall` items, OpenCode's `subagent` tool, `task` before v2) surface as `agent`
events and are counted in the `done` event; the executors do not return before the harness
reports them finished (Claude holds the one-shot result back, Codex sends `turn/completed`
last, OpenCode runs them synchronously). Verified with `scripts/background_agent_smoke.ts`.

## Task loop (loop-v0)

A task is run step by step (`src/engine/taskLoop.ts`). The router's first decision carries `plan` and
`purpose`; `plan: multi` hands the task to the planner the router names in the decision (`planner`, any listed
model with quota; `router.planner` in targets.yaml is the fallback), run as a text-only Claude, Codex or
opencode call. It replies one action per step: a dispatch (`purpose` research / do /
verify; research and verify are read-only, their approval requests are refused), `ask_user`, `finish`
or `give_up`. After a research/verify step, or in a multi-step task, every successful dispatch goes
back to the loop model; a single-step task ends after the supervisor's acceptance as before. Failures
keep the code rules (transport retry, quota switch, stop after side effects) and otherwise go to the
loop model with the failed target excluded. Budgets: 5 dispatches and 12 loop calls, each extendable
once the user says so. Executor questions go to the supervisor first (loop-v0 §6). Timeline events:
`step` (plan / dispatch / ask_user / finish), `redispatch`, `supervisor {kind: question}`.

## Refusal clarification

All model roles share the privacy and Simplified Chinese communication guidance in
`src/util/communication.ts`. It limits discussion to facts needed for the current operation;
it does not establish ownership or authorization for a target. Router questions are requested
in Chinese. An English question gets one bounded translation attempt before display, with
its original wording retained in the question evidence; a translation failure shows a Chinese
notice with the original question. A router `give_up` stops before any executor is selected.

Question cards show submission progress immediately and retain drafts across live updates.
An accepted answer stays accepted even if refreshing the view fails. An uncertain network result
requires checking the question status before another submission.

An executor's direct refusal is recorded even when its process completed successfully. Provider safety
signals stop automatic recovery. Other refusals can be diagnosed by the router, which may ask one factual
question or select exact quotations from the user's task, parent messages, environment context or answers.
The daemon checks each quotation against its source and records the source ID and SHA-256 hash in a
`refusal` event. It appends those statements to the original brief without changing the target or permissions.
At most one clarification retry is allowed per task, on the same model and existing session. Side effects,
missing execution telemetry, invalid diagnosis, policy restrictions, a repeated refusal or a failed retry
stop recovery; none triggers automatic model switching. Refusals bypass ordinary success acceptance.
Answers submitted through the API pass the configured sealer before being stored, just like new tasks.

## Supervisor (supervisor-v0)

The router model also supervises (`router.supervisor` in targets.yaml). Approvals an executor
raises are shown to the user as before and, in parallel, put to the supervisor with the brief and
the recent events; it answers allow / deny / ask_user and whoever answers first wins
(`approval_resolved.by` = user | router | timeout). Destructive actions (`rm -rf`, force push,
DROP, sudo, payments, sending, account deletion, the daemon's own files) never reach it. A run
with no event for `watchdog_ms` (8 min) gets a check-in: continue (at most 3 times), cancel (the
attempt fails as `rejected` with the note and the router re-dispatches with a handoff), or ask the
user. On done the result is checked against the brief: one rejection sends the task back as a
`rejected` attempt; a second is recorded but overruled. Every verdict is a `supervisor` event.

## Threads (threads-v0)

Every task runs in a thread: one piece of work from first message to done. A follow-up (`parent_id`)
joins its parent's thread, `thread_id` picks one explicitly; otherwise the router decides at routing
time (`thread` + `thread_confidence` in its Decision, from a list of open threads with title, one
line of summary and last target). Above `router.thread_confidence` (0.6) the task joins; below it
the user is asked through the normal approval card (allow = join, deny or timeout = new thread);
"new" or an unknown id opens a thread for the cwd. An ephemeral task that joins a thread moves into
the thread's cwd. The home page lists open threads first (click opens the latest task). AgentSwitch stores only handles, an append-only `thread_events` log (`task`, `session`,
`summary`, `title`, `handoff`, `cost`, `progress`, each with its fold policy; `foldThread` is pure)
and a last-wins summary. Conversation history stays with each harness, in the thread's private home
`$AGENTSWITCH_HOME/threads/<id>/`:

- `claude/` is `CLAUDE_CONFIG_DIR` (with `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` so the normal keychain
  login still applies); the next task in the thread by Claude Code passes `resume: <session_id>`.
- `codex/` is `CODEX_HOME` (auth.json re-copied, config regenerated per run); threads start
  non-ephemeral and the next Codex task calls `thread/resume {threadId}`.
- OpenCode has no private home: its provider credentials sit in the same `opencode.db` as its sessions,
  so a private data dir would lose the DeepSeek key. Sessions stay in the shared db (ephemeral tasks
  still purge theirs); the next OpenCode task in the thread continues that session on the resident
  executor server (or passes `--session <id>` on the standalone path, verified), and a refused resume
  falls back to a fresh session.

Same harness, same thread, same cwd → native resume, no summary involved. Any change of harness
carries a handoff package instead: the thread summary + files touched + `git status`/`diff --stat`
+ the router's note, rendered under "Handoff from a previous attempt". The summary is rewritten by
the router model after every execution (`summary` task event; failure keeps the previous one).
"交给别人" (`POST /tasks/:id/handoff {to?}`) cancels a running task, queues a successor in the same
thread that excludes the current executor (or pins `to`), and records a `handoff` event.

The router also reads three more things (threads-v0 §6–8): `MEMORY.md` (facts the summarizer
noticed, appended with their source task after the CONTEXT.md lint; editable on the 上下文 tab),
the track record (`records` table: per finished task its router-labelled `kind`, target, outcome,
time, tokens, whether the user pinned or later handed it off; summarised per kind for the prompt,
`GET /records`), and the names of registered MCP servers and skills. Two deterministic guards sit
in `validateDecision`: a target with three consecutive refusals/failures on a kind goes behind the
router's fallbacks for 30 days, and a target the user handed that kind off from is noted when the
router gives no reason.

Archive (`POST /threads/:id/archive`) sets `expires_at` = now + 7 days; the hourly sweep deletes
expired threads with their private home; `PATCH` changes title / expiry (status goes through archive / reopen; a
paired phone may change the title only), `DELETE` removes at once. Protected paths (daemon home minus work/artifacts/uploads, `~/.secret-gate`, this
package's `config/`) are denied outright for Claude Code (`decideTool`), denied by static patterns
for OpenCode, and restored from a snapshot after every run for all harnesses (the task fails as a
security event). `EXECUTOR.md` says that no agent-written text is an authorization.

## Executors

`AGENTSWITCH_EXECUTORS=real` (default `echo`). When `packages/secret-gate/.venv` exists, every
executor gets the gate: proxy in the tool env (both cases), `secret-gate mcp`, gate home unreadable,
and, for tasks that need a browser (`needs_browser` on the task or in the router's decision), the
gated Playwright MCP (`AGENTSWITCH_BROWSER=0` disables; `AGENTSWITCH_BROWSER_ORIGINS=a;b` restricts
navigation). The gate proxy must be running on :8080 (`secret-gate proxy`, or `secret-gate service install`
for launchd): `serve` logs an error at start-up when it is not, and every run checks it first; a dead proxy
fails the attempt as `gate_unavailable`, which stops the task (every harness shares the proxy, so there is no
retry or switch, and it is no mark against the model).

Short references (gate-next-v0 §1, `src/executors/gateRefs.ts`, inside the credential-repair bridge): each run
gets a fresh scope (`randomBytes(24)`), the task's known `enc:v1:` tokens are registered under it with
`secret-gate refs register` (scope on stdin only), and task, brief, handoff, context, platform memory, feedback
and answers given during the run reach the executor as `enc:ref:` references. The scope goes to `secret-gate mcp`
and the browser gate as `SECRET_GATE_SCOPE`, and into the shell tools' proxy URL (`http://scope:<scope>@…`);
registry MCP servers keep the plain proxy. Outcome text, event payloads, approval requests, questions and errors
are mapped back to `enc:v1:` (records keep stable ciphertext, approvers see which credential is meant), and the
scope, raw or as its Proxy-Authorization base64, becomes `[scope]`; `secret-gate refs release` runs in `finally`.
If the refs CLI fails, the run goes ahead with full tokens and no scope, and a `text` event says so. Claude's MCP
config (gate env: scope, repair key, grant) goes to the CLI as a 0600 file in the run's private dir
(`--mcp-config <file>`), never inline: the SDK would otherwise put it into argv, which `ps` shows to every user.

Field transfer (§5.2): the router may set `transfer` (`source`/`destination` exact hosts, 1-8 each; `fields` ⊆
email, phone, id_number, bank_card; `purpose` ≤ 200 chars) only when the user's own task asks to move those
fields between two named systems. `src/core/transfer.ts` validates it. Only the first routing decision can grant
(the router sees the user's task and trusted context only), and each host must appear in the user's own statements;
loop and planner decisions, whose models read executor replies and so page content, may only restate a subset
(same purpose or none) and are shown the pin to copy; a step without `transfer` gets none; anything beyond drops
that step's grant. The grant reaches only the browser gate (`SECRET_GATE_TRANSFER`), only with the browser attached
and a scope. Audit trail, `transfer_grant` events: `pinned` / `dropped` (with the reason) from the loop, `offered`
at dispatch, then `applied` or `inactive` (with the reason) from the executor that did or did not wire it.

Every executor also receives the same global guidance, `config/EXECUTOR.md` followed by
`packages/secret-gate/AGENTS.md` (how to treat `enc:v1:` values, `secret_fill`, 403s): Claude via
the SDK system-prompt append, Codex as `$CODEX_HOME/AGENTS.md` in its private home, OpenCode as a
session instruction entry on the resident server and, on the standalone fallback, at the head of the prompt message
(guidance, `=====`, then the same prompt the server path sends), because OpenCode 2.0.8 ignores the config file's
`instructions` key (verified for `run` and `serve`). `scripts/executor_smoke.ts <harness> [model]`
runs one executor on a trivial file task in a temp dir.

| harness | how | approvals | failure signals mapped |
|---|---|---|---|
| claude-code | Agent SDK `query()`; `settingSources: []` so your `~/.claude` is not loaded; model + effort from the verdict | `canUseTool`: Read/Glob/Grep, gate + browser MCP tools and edits inside cwd are allowed; Bash, writes outside cwd, web → engine approval | result subtype, `model_refusal_no_fallback` → refusal, `rate_limit_event` → quota, usage → tokens |
| codex | `codex app-server` JSON-RPC (bundled ChatGPT.app binary); private `CODEX_HOME` with 0600 auth copy + our config.toml, removed after the run; `model_reasoning_effort` from the verdict | `item/*/requestApproval`, `execCommandApproval`, `applyPatchApproval` → engine; MCP elicitations accepted | `turn/completed` error, `error` notifications, process exit |
| opencode | a session on the executors' resident `opencode serve --stdio` (below); fallback `opencode run --standalone --format json -m <model>` with config via `OPENCODE_CONFIG` | static rules as before (edits and shell allowed, webfetch denied, gate home unreadable, protected paths denied); rules that say "ask" (OpenCode's own: access outside cwd) → engine approval, replied `once`/`reject`; the question tool → engine questions. The standalone fallback has static rules only (design A.3) | assistant `error` (+ HTTP status), idle outcome, poll failures (serve); `error` events, exit code, stderr (run) |

OpenCode on its resident server (`src/executors/opencode{Server,ServeRun,ServeMap,Shared}.ts`, `AGENTSWITCH_OPENCODE_EXECUTOR`
= `serve` (default) | `run`). `serve` starts a second OpenCode server next to the router's, only for executors:
`opencode serve --stdio --port 0` under `$AGENTSWITCH_HOME/opencode-exec/` with its own 0600 config (the static
permission rules and a shared skills dir, no MCP servers, nothing per execution), its own password (`--stdio` deletes
it from the server's env, so shells and MCP servers it spawns never see it), a proxy-free env (OpenCode's model
calls go direct), and a lifetime tied to the daemon (it exits when its stdin closes). The router's server is not
reused: its agents deny shell and edit, and its sessions run in task directories too, where they would see an
execution's runtime MCP servers. Per execution, through the API: the session (`location` = cwd, agent `build`, model,
`permissions` = the standalone config's rules), its shell env (`PUT …/environment` replaces it: the daemon's env
without proxy or repair variables, the gate proxy carrying the execution scope, `SECRET_GATE_HOME`, `NO_PROXY`),
the guidance as an instruction entry, and the MCP servers (`PUT /api/experimental/mcp/<name>?location=<cwd>`:
secret-gate with scope and repair bridge, the browser gate with scope and grant, registry servers). A resume
continues the thread's session in place (rules patched in, model switched to the verdict's); a session that is gone,
in another directory or still running gets a new one, as `run` did. Sub-agent sessions inherit the rules but not
the env or the instruction entry, so the executor sets both as soon as a child shows up. Before the prompt, a few
deny probes (`POST …/permission`) check that the rules are in effect: a cold location answered its first checks
wrongly in tests. Runtime MCP servers are per exact directory and outlive the session, so one execution holds a
directory on the server at a time (the engine's cwd lock already allows one task per cwd), every execution first
removes the gate's servers and any name an earlier one could not remove, and removes its own in `finally`
(success, throw, abort, timeout); the session env loses the scope afterwards. The run falls back to
`opencode run --standalone` when the server is down (restarted after a 60 s cooldown), when another execution holds
the directory, or when any API call fails before the prompt is admitted; a `text` event says so. Sessions stay in
OpenCode's shared db either way, so ephemeral cleanup works unchanged. `scripts/opencode_serve_smoke.ts` runs the
real thing on deepseek-flash (2026-09-24: server up in 160-190 ms, ~150-290 ms of API setup per step; a short task
2.0-2.8 s on the server vs 2.7-2.8 s standalone, a resumed turn 0.6 s).

## Terminals (terminal-v0)

The manual entry: agent CLIs (`claude`, `codex`, `opencode`, `pi`) in pseudo-terminals the daemon holds
(`src/terminals/`, `node-pty` + `@xterm/headless`), next to the managed tasks. `POST /terminals {harness, cwd, model?}`
starts one; `GET /terminals/:id/stream` (SSE) sends a snapshot, then output, status and permission requests;
`/input` (sealed reply), `/keys` (named keys), `/write` (raw keystrokes, this Mac only), `/resize`,
`/permissions/:pid {decision}`, `/kill`, `DELETE` (`?transcript=1` also deletes Claude Code's own record);
`POST /terminals/resume {harness, cwd, agentSessionId}` continues a session started elsewhere. Claude Code gets this
terminal's own hooks through `--settings` (status, session id, `PermissionRequest` answered from any screen); the hook
command calls `/terminals/hook` with a per-terminal hook token, never the local token. The protected paths are refused
each agent's own way (terminal-v0 §3): Claude Code's `PreToolUse` hook plus `permissions.deny`; Codex's own permission
profile (`default_permissions`, enforced by its sandbox; the gate only in `shell_environment_policy`); OpenCode with
`--standalone` and an `OPENCODE_CONFIG` of deny rules; pi through `src/terminals/piExtension.ts` (`--extension`), which
also reports its status. The web console has a page for it
(控制台 › 终端, `ui/terminal.html`). `AGENTSWITCH_TERMINALS=0` turns it off; audit in `$AGENTSWITCH_HOME/terminals/audit.jsonl`.
node-pty's spawn helper needs its execute bit (npm skips install scripts): the daemon sets it before the first spawn.

## MCP servers and skills

Managed in the UI's 扩展 tab (or `GET /mcp`, `GET /skills`), stored under `$AGENTSWITCH_HOME`:
`mcp.json` (0600) and `skills/<name>/SKILL.md` + `skills.json`. Nothing touches the user's own
`~/.claude`, `~/.codex` or OpenCode config — each run gets a private copy.

Per entry you choose which harnesses see it. Injection per harness:

| | MCP | skills |
|---|---|---|
| claude-code | `mcpServers` option | local plugin dir (`plugins` + `skills: "all"`) |
| codex | `[mcp_servers.*]` in the private `config.toml` | copied into `$CODEX_HOME/skills` |
| opencode | runtime MCP per execution at the task's location (serve); `mcp` (local/remote) in the run config (run) | the server's shared `skills.paths` dir, refreshed per execution (serve); `skills.paths` to a copied dir (run) |

Names `secret-gate` and `playwright` are reserved for the gate. A stdio server is spawned with
`PATH`/`HOME`, the gate proxy and (when `secret-gate install-ca` has run) the gate CA in
`NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`, so its HTTPS calls survive interception and `enc:v1:`
ciphertext in its env or headers is substituted on the wire. Claude Code asks for approval before
every registry MCP tool call unless the entry is marked `approval: allow`; the gate's own servers
are always allowed. Skills can be imported by copy from `~/.claude/skills`, `~/.codex/skills`,
`~/.agents/skills` and the OpenCode skill folders (`GET /skills/discover`).

## API

| method | path | what |
|---|---|---|
| POST | `/tasks` | `{task, cwd?, pin?, needs_browser?, ephemeral?, parent_id?, thread_id?, attachments?, approval?}` → task (queued); no `cwd` = ephemeral work dir; `parent_id` = follow-up (router and executor see the parent chain's text and results; cwd inherited unless the parent was ephemeral, and refused (400) when that cwd no longer passes the cwd rules); `thread_id` runs in that thread; `approval` = per-task policy override (local only) |
| POST | `/tasks/:id/handoff` | `{to?: {harness, model}}` → successor task in the same thread, excluding the current executor unless `to` pins one; cancels the task if still running |
| GET | `/threads?status=open\|archived`, `/threads/:id` | list with folded state (title, summary, lastTarget, taskCount) / detail with `state`, `tasks`, `events` |
| PATCH | `/threads/:id` | `{title?, expires_at?}` (remote: `title` only) |
| POST | `/threads/:id/archive`, `/threads/:id/reopen` | archive = delete after 7 days (refused while a task runs) / reopen |
| DELETE | `/threads/:id` | permanently delete the thread, all its tasks and associated records, and its private home; 409 while any task is active or finishing |
| GET | `/tasks`, `/tasks/:id` | list / detail with pending approvals |
| DELETE | `/tasks/:id` | permanently delete one task and its stored records/artifacts; remove an empty thread, retain other tasks and the user's working directory; 409 while the thread is active or finishing |
| GET | `/tasks/:id/events?after=N` | SSE: queued, routed, thread, waiting, dispatched, agent, supervisor, text, tool_call, approval_request, approval_resolved, attempt_failed, redispatch, handoff, summary, done, failed, cancelled, cleaned |
| POST | `/tasks/:id/approve` | `{approval_id, decision: allow\|deny}` |
| POST | `/tasks/:id/cancel` | abort; pending approvals denied |
| GET | `/approvals` | pending across tasks |
| POST | `/route/preview` | route without executing |
| GET/POST | `/quota`, `/quota/refresh` | readings per harness (`remaining` 0..1, detail, source, error) |
| GET | `/targets` | catalog + current quota map |
| GET | `/routing/log` | recent decisions (every engine dispatch and re-dispatch, plus previews) |
| POST | `/uploads` | multipart `files`; stages them, returns ids (≤ 20 files, ≤ 50 MB each, swept after 24 h) |
| GET | `/tasks/:id/files`, `/tasks/:id/files/*` | list / download a task's files: `<cwd>/in/` and `<cwd>/out/` only while the cwd exists (paths `in/…`, `out/…`), else `artifacts/<id>` (kept 7 days). Never the rest of the cwd, a symlinked `in/`/`out/`, a symlink leaving them, a hard-linked file, a file in a denied place, or anything of a cwd the rules refuse now; downloads carry `nosniff` and a sandboxing CSP |
| GET/PUT | `/memory` | MEMORY.md, same lint as CONTEXT.md |
| GET | `/records` | track record aggregated per task kind and target (last 30 days) |
| GET/PUT | `/context` | CONTEXT.md (GET returns the linted text the router sees; PUT lints and reports warnings) |
| GET | `/context/example` | the `config/CONTEXT.example.md` template (UI "载入示例模板") |
| GET | `/mcp` | registered MCP servers |
| PUT/DELETE | `/mcp/:name` | upsert (body = the entry without `name`) / remove |
| GET | `/skills`, `/skills/:name` | list / one with its SKILL.md in `content` |
| PUT/DELETE | `/skills/:name` | `{content?, enabled?, harnesses?}` / remove |
| GET | `/skills/discover` | skills found in the user's own folders, with `installed` |
| POST | `/skills/import` | `{path}` copies a skill directory into the registry |
| GET | `/healthz` | |
| GET/PUT | `/settings/models` | model settings (local only, see "Remote access") |
| POST | `/pairing` | local only: a one-time pairing code + QR payload |
| GET | `/devices`, `/remote/info` | local only: paired devices (with `online`) / listener state |
| DELETE | `/devices/:id` | local only: revoke a device (its open streams are cut too) |

**cwd rules** (`src/api/cwdPolicy.ts`, `POST /tasks`, `/route/preview`): an existing absolute directory that is not
`/`, the home directory, a special root entry (`/.vol`, `/.nofollow`, …), inside a place holding credentials or the
daemon's state (`~/.ssh`, `~/.claude`, `~/.codex`, `~/.agentswitch`, `~/.secret-gate`, `~/Library`, `~/.gnupg`, `~/.aws`,
`~/.config`, `$AGENTSWITCH_HOME`, `$SECRET_GATE_HOME`), or containing one (`/Users`, the temp dir above a home). Paths
are compared as the OS opens them: symlinks and `..` after them resolved (`/Volumes/Macintosh HD` is `/`), and by
device + inode, which catches `/System/Volumes/Data/…`, `/.vol/<dev>/<ino>` and case variants.

**The 127.0.0.1 listener** (`src/api/localGuard.ts`, only there; the remote listener forwards in process and never
passes it) refuses what a web page can make a browser send: `Host` other than `127.0.0.1`, `localhost` or `[::1]` on its
own port (DNS rebinding) → 403; an `Origin` other than `http://127.0.0.1:<port>` / `http://localhost:<port>` → 403;
a POST/PUT/PATCH/DELETE with a body that is not `application/json` → 415 (multipart is accepted on `POST /uploads`
only). The web UI (same origin), the CLI, the Mac app and curl (no `Origin`) are unaffected; a script that posts a JSON
body must send `Content-Type: application/json`.

## Remote access (iPhone app)

docs/app-v0.md §2. `AGENTSWITCH_REMOTE=1` adds an HTTPS listener on all interfaces (`::`, dual-stack; `0.0.0.0` when
IPv6 is unavailable), port `AGENTSWITCH_REMOTE_PORT` (4713). The 127.0.0.1 listener is unchanged. A remote port that
is taken fails start-up (exit 1, the port named in the error), so the Mac app sees it.

- **Sources**: only 127/8, ::1, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10 (Tailscale), fc00::/7 and fe80::/10
  (IPv4-mapped IPv6 counts as IPv4). Other sockets are destroyed in the `connection` hook before TLS; every request
  checks the peer again (403).
- **TLS**: `$AGENTSWITCH_HOME/remote/{cert.pem,key.pem}`, made once with `/usr/bin/openssl` (EC P-256, CN=AgentSwitch,
  10 years, serverAuth), directory 0700, key 0600. A pair that does not parse or match is regenerated with a warning
  (phones must pair again). Fingerprint = SHA-256 of the DER, lowercase hex; phones trust nothing else.
- **Routes**: exactly the doc's list (`src/remote/routes.ts`); anything else is 404, with or without a token. `GET
  /healthz` (`{ok:true}`) and `POST /pair` need no token; everything else `Authorization: Bearer <token>`, including
  the SSE stream. Allowed routes other than `/healthz`, `/pair`, `/me`, `/gate/pubkey` are forwarded to the API
  unchanged, marked as a paired device's in the Hono env (`src/core/caller.ts`; no header can set or clear it). The web
  UI, the registries, `PUT /context`, memory, records, routing log, approval policy, device and pairing management and
  model settings are never reachable remotely.
- **What a phone may not decide** (400 with the reason): `approval` on `POST /tasks` (the Mac's policy applies), `cwd`
  (the task gets its own work dir, a follow-up its parent's cwd) and `ephemeral` (it decides whether a work dir is
  deleted); `expires_at` on `PATCH /threads/:id` (an expiry in the past has the sweep delete the thread, and deleting is
  local only; archive and reopen remain).
- **Devices**: `devices` table; the token (32 random bytes, base64url) is returned once, only its SHA-256 is stored and
  every stored hash is compared with `timingSafeEqual`. Revoked → 401 at once, and the device's open requests are cut.
  `last_seen_at` is written at most once a minute; "online" = a request open now or seen in the last 5 minutes.
- **Pairing**: local `POST /pairing` → `{code: "XXXX-XXXX", expiresAt: <epoch ms>, link, payload}`, 8 Crockford
  base32 symbols, 5 minutes, single use, void after 5 wrong attempts; a new code voids the previous one. `link` =
  `agentswitch://pair?p=<base64url(JSON payload), no padding>`, payload `{v, name, port, fp, code, lan, tailnet,
  bonjour, gate}`: `lan` = RFC 1918 IPv4 of this Mac, `tailnet` = `tailscale ip -4` + `status --json` `Self.DNSName`
  (CLI on PATH or in /Applications/Tailscale.app; [] when absent or logged out), `bonjour` = "AgentSwitch on <name>",
  `gate` = the current keypair from `secret-gate keys --json` or `null` when it cannot be read. `name` is
  `AGENTSWITCH_REMOTE_NAME`, else `scutil --get ComputerName`. Remote `POST /pair {code, name, platform}` →
  `{deviceId, token}`; every failure (wrong, expired, used, voided, malformed) is the same 401 `{"error":"pairing
  failed"}`; more than 10 attempts a minute from one address → 429. Codes live in memory: a restart voids them.
- **Remote-only**: `GET /me` → `{deviceId, name, platform}`; `GET /gate/pubkey` → `{publicKey, keypair}` (503 when
  the gate key cannot be read).
- **Local only**: `GET /devices` (with `online`), `DELETE /devices/:id`, `GET /remote/info` → `{enabled, port,
  fingerprint, name, bonjour, lan, tailnet, onlineDevices}` (`enabled:false` and nulls when remote is off; `/pairing`
  is then 409).
- **Model settings** (local): `GET /settings/models` → `{router:{model, options}, default:{harness, model},
  harnesses:{<name>:{models, default_model}}, restartRequired}` as the next start will see it (`options` = the router
  harness's models; wildcards and unavailable models left out). `PUT /settings/models {router?:{model},
  default?:{harness, model}}` checks against the catalog (400 with the reason), merges into
  `$AGENTSWITCH_HOME/models.json` (0600, atomic) and returns `{restartRequired:true}`. At start-up the file is laid
  over targets.yaml after discovery; a part that no longer fits, or a file that does not parse, is ignored with a
  stderr warning.

The Mac app runs `node --no-warnings=ExperimentalWarning <runtime>/daemon/dist/cli.js serve` with
`AGENTSWITCH_HOME`, `AGENTSWITCH_REMOTE=1`, `AGENTSWITCH_EXECUTORS=real`, `SECRET_GATE_BIN` and the login shell's
`PATH` (see docs/app-v0.md §4).

## Start-up (serve)

`serve` discovers models (Codex `model/list`, Claude `supportedModels()`; new ids join the catalog, old
ones stay), brings up a resident `opencode serve --stdio` on `AGENTSWITCH_OPENCODE_PORT` (4712) with a
read-only `dispatcher` agent and a tool-less `oracle` agent, and only then listens. It is started like the executors'
server (`src/harness/opencodeStdio.ts`): its password never reaches the processes it spawns, and it exits with the
daemon. Router, summarizer
and supervisor calls are one short-lived session each on that server (~1 s); if it fails to start
they fall back to `opencode run --standalone`. With real executors it also starts the OpenCode executors' own
resident server (see Executors). Real executors refuse to start without secret-gate.

## Router (router-v0)

`config/targets.yaml` lists every selectable model per harness (Claude Code 15 incl. `[1m]`,
Codex 5 × effort, OpenCode deepseek-flash). The router is an OpenCode `router` agent (DeepSeek V4.1
Flash, read-only tools, injected via `OPENCODE_CONFIG`) that returns a Decision (harness, model,
effort, brief, fallbacks, confidence). `validateDecision` is the floor: catalog, browser, quota, category,
effort, track-record guards, low confidence → default policy. Concurrency is not the floor's business: a full
harness is the scheduler's wait, never a switch. `CONTEXT.md` (sites,
accounts as secret-gate tokens, environment, preferences) is re-read on every dispatch and goes into
the router prompt **and** the executor's prompt (after the brief and any handoff), so a site's URL,
account and tokens reach the model that does the work even when the router's brief leaves them out;
list entries with plaintext credentials are stripped at load. Models retyping a 200-character token drop a
character now and then (seen: 226 → 225 chars, `secret-gate: invalid base64url`), so the router is told to name
the context entry instead of copying tokens, and `src/executors/tokens.ts` puts the genuine token back
wherever a damaged copy appears: the brief, and Claude's tool arguments via `canUseTool` (Codex and OpenCode
tool arguments cannot be rewritten; they only get the prompt-level fix). Edit it in the UI's 上下文 tab (shows the linted
text and the stripped lines), with `agentswitch context init`, or by hand. After a failure, `classifyFailure` + `nextStep`
decide: transport → retry once then ask the router; quota → fallback chain; refusal / task_failed →
ask the router with the history; gate_denied, gate_unavailable or an approved action → stop. The router may
`give_up` or request a registered repair tool (`action=repair`; none registered yet).

## Layout

`src/` is layered; `tests/layers.test.ts` parses every relative import and fails on a wrong direction. A layer may
import only those listed for it (and itself):

| layer | may import |
|---|---|
| `util/` | nothing |
| `core/` | util |
| `harness/`, `files/`, `extensions/`, `secrets/` | util, core |
| `quota/` | util, core, harness |
| `threads/` | util, core |
| `router/` (incl. `routers/`) | util, core, harness |
| `executors/` | util, core, harness, files, extensions, secrets, quota |
| `engine/` | everything above |
| `api/` | everything above and engine |
| `remote/` | same as `api/` (a peer: it reaches the API only through `fetch`) |
| `daemon.ts`, `cli.ts`, `client.ts` | everything |

| path | what |
|---|---|
| `src/core/{outcome,target,modelCall,questions,transfer,contextDoc,evidence,limits,caller}.ts` | the shared vocabulary: how an execution ended (outcome, failure kind, side effects, refusal detection), `TargetRef`, the text-only model call (`Router`), user questions, field-transfer grants, the CONTEXT.md/MEMORY.md lint, bounded evidence excerpts, limits more than one module uses, the remote-device mark on a forwarded request |
| `src/harness/{processes,appserver,opencodeStdio}.ts` | harness processes: own process groups (`spawnOwned`/`terminateProcess`), the Codex app-server JSON-RPC client, the `opencode serve --stdio` process both OpenCode servers run |
| `src/engine/{types,store,bus,engine,cleanup,locks}.ts` | task model, SQLite + JSONL persistence, event fan-out, the concurrent engine, ephemeral cleanup, semaphore/keyed locks |
| `ui/` | desktop console at `/ui`: `index.html` shell, `app.css`, `app.js` (render loop, click routing, polling), `lib/{api,state,actions}.js`, `views/{home,task,log,ext,ctx,quota}.js` |
| `src/executors/{types,echo,gate,instructions,lifecycle,opencode,codex,claude}.ts` | executor interface, echo, gate wiring + proxy health, global guidance, run deadline/abort, the three real executors |
| `src/executors/opencode{Server,ServeRun,ServeMap,Shared}.ts` | OpenCode executors' resident server: process + client, one execution on it, API mapping, what both OpenCode paths share |
| `src/executors/{gateRefs,credentialRepair}.ts`, `src/secrets/refs.ts` | per-run wrappers: enc:ref: scope (refs CLI client), credential-repair bridge |
| `src/executors/protected.ts` | protected paths: deny decision for Claude, deny patterns for OpenCode, snapshot/restore backstop for all |
| `src/threads/memory.ts`, `src/router/record.ts` | MEMORY.md append/lint; track record aggregation + guards (router input) |
| `src/threads/{types,fold,summary,handoff}.ts` | thread model + fold policies, `foldThread`, the summarizer (router model, zod, lint), handoff package (`git status`/`diff --stat`) + rendering |
| `config/EXECUTOR.md` | AgentSwitch's part of the guidance every executor gets |
| `src/router/*` | targets, decision, validate, defaultPolicy, prompt, context, failure (classification), reroute, route, loop, supervisor, record, log, routers/{echo,opencode,opencodeServe,claude,codex} |
| `src/quota/{codex,deepseek,claude,windows,index}.ts` | providers, 5h/7d windows (Codex app-server windows; Claude `rate_limit_event` from runs or a one-turn probe), cached service |
| `src/files/*` | names (limits, MIME), uploads (staging → `<cwd>/in/`), artifacts (tree, safe download path, `out/` → `artifacts/<id>` before an ephemeral cwd is deleted, sweeps), notes (attachment paragraph for router + executor) |
| `src/extensions/*`, `src/executors/extensions.ts` | MCP + skill registries and their per-harness shapes |
| `src/api/app.ts`, `src/daemon.ts`, `src/client.ts`, `src/cli.ts`, `bin/agentswitch` | HTTP, composition root, client, CLI |
| `src/api/{cwdPolicy,localGuard,files}.ts` | where a task may run, the 127.0.0.1 listener's browser guard, task file listing/download |
| `src/remote/{address,tailscale,tls,devices,pairing,gateKey,routes,app,admin,server,runtime}.ts` | remote access: source filter + LAN addresses, Tailscale discovery, certificate, device tokens + presence, pairing codes + payload, gate public key, route allowlist, remote pipeline, local management routes, HTTPS listener, per-daemon state |
| `src/router/modelOverlay.ts`, `src/api/models.ts` | models.json over targets.yaml, `/settings/models` |
| `tests/` | 213 tests; API tests run in-process via Hono `request()` |
| `scripts/router_eval.ts`, `tests/fixtures/routing/v0.jsonl` | routing evaluation with the real router (costs tokens) |
| `scripts/resume_experiment.ts`, `scripts/executor_resume_smoke.ts` | real-model checks that Claude / Codex resume from a thread's private home (costs cents) |

## Facts learned

- `OPENCODE_CONFIG=<file>` + `--agent router` works with OpenCode 2.0.8; a real routing call on this repo took 19 s (`timeout_ms` 45 s).
- OpenCode 2.0.8 server API (checked on a throwaway `serve`): runtime MCP servers (`/api/experimental/mcp`) belong to one exact directory and never reach its parent, children or other directories; a `PUT` with an identical config keeps the running process, a changed one restarts it, `DELETE` stops it. Session env, rules and instruction entries are per session; a session whose env was never set gets the server's whole env, and plain `serve` (not `--stdio`) keeps `OPENCODE_SERVER_PASSWORD` in it, so every shell and MCP child could drive the server. `serve --stdio --port <n>` binds that fixed port (and `0` a free one), reports it as `{"url": …}` on stdout and exits 0 on stdin EOF (2026-09-24; the router server on it: up in ~185 ms, one deepseek-flash answer in ~2.9 s). Session rules are evaluated after agent and config rules, last match wins, so they can loosen as well as tighten. The config file's `instructions` key has no effect in `run` or `serve`; instruction entries do. The sub-agent tool is `subagent`; its child session inherits the rules, not the env.
- Codex `account/rateLimits/read` returns `rateLimits.primary.usedPercent` per window plus `planType`; the ChatGPT.app bundled codex (0.155) must be used, homebrew 0.142 only knows gpt-5.5.
- DeepSeek `/user/balance` works with the key OpenCode stores in `~/.local/share/opencode/opencode.db` (`credential` table, JSON `{"type":"key","key":...}`).
- Node's `parseArgs` needs `allowNegative: true` for `--no-watch`; `node:sqlite` prints an ExperimentalWarning on Node 24, silenced in the wrappers.
- `CLAUDE_CONFIG_DIR` alone makes claude 2.1.278 look for a keychain item `Claude Code-credentials-<sha256(dir)[:8]>` and report "Not logged in"; `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` restores the unsuffixed name. Transcripts land in `<dir>/projects/<realpath cwd key>/<session_id>.jsonl`; `resume` needs the same cwd.
- Codex `thread/resume {threadId}` reloads the rollout from `$CODEX_HOME/sessions/…` + `thread_history_1.sqlite`; the thread must have been started with `ephemeral: false`. Every app-server start also dumps `skills/.system/` and several sqlite files into CODEX_HOME.
- Claude's `rate_limit_event` (subscription accounts) carries the 5h / 7d windows in `unifiedWindows`, not in the declared top-level fields; one Haiku turn is enough to receive it. Codex `rateLimits` on this pro plan reports only the 7d window (`secondary` is null).
