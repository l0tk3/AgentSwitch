# agentswitch-daemon

TypeScript daemon for AgentSwitch: task engine, router, HTTP API, quota. The phone is just another
client of the API; during development the CLI plays that role. Design: `docs/design-v0.md`,
`docs/router-v0.md`.

```
CLI / phone ──HTTP──▶ agentswitchd (127.0.0.1:4711)
                        ├─ engine/   queue → route → dispatch → (fail → reroute)* → done; approvals; SQLite + JSONL
                        ├─ router/   targets.yaml, DeepSeek dispatcher (OpenCode agent), policy floor, CONTEXT.md, routing_log
                        ├─ executors/ echo (dev), claude-code (Agent SDK), codex (app-server), opencode (run); secret-gate wired in
                        ├─ quota/    codex app-server rateLimits, DeepSeek /user/balance, Claude local token count
                        └─ api/      Hono: /tasks (+SSE events, approve, cancel), /quota, /targets, /route/preview, /context
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
```

Environment: `AGENTSWITCH_HOME` (default `~/.agentswitch`: `agentswitch.db`, `routing.db`, `tasks/<id>.jsonl`,
`CONTEXT.md`), `AGENTSWITCH_PORT` (4711), `AGENTSWITCH_ROUTER` (`opencode`|`echo`), `DEEPSEEK_API_KEY`
(else the key from OpenCode's credential store is used, read-only).

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
`ephemeral: true` keeps its files and only loses the harness records. The task's own event log in
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
`subAgentActivity` / `collabAgentToolCall` items, OpenCode's `task` tool) surface as `agent`
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
  still purge theirs); the next OpenCode task in the thread passes `--session <id>` (verified), and a
  refused resume falls back to a fresh session.

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
expired threads with their private home; `PATCH` changes title / expiry / status, `DELETE` removes
at once. Protected paths (daemon home minus work/artifacts/uploads, `~/.secret-gate`, this
package's `config/`) are denied outright for Claude Code (`decideTool`), denied by static patterns
for OpenCode, and restored from a snapshot after every run for all harnesses (the task fails as a
security event). `EXECUTOR.md` says that no agent-written text is an authorization.

## Executors

`AGENTSWITCH_EXECUTORS=real` (default `echo`). When `packages/secret-gate/.venv` exists, every
executor gets the gate: proxy in the tool env (both cases), `secret-gate mcp`, gate home unreadable,
and, for tasks that need a browser (`needs_browser` on the task or in the router's decision), the
gated Playwright MCP (`AGENTSWITCH_BROWSER=0` disables; `AGENTSWITCH_BROWSER_ORIGINS=a;b` restricts
navigation). The gate proxy must be running on :8080 (`secret-gate proxy`).

Every executor also receives the same global guidance, `config/EXECUTOR.md` followed by
`packages/secret-gate/AGENTS.md` (how to treat `enc:v1:` values, `secret_fill`, 403s): Claude via
the SDK system-prompt append, Codex as `$CODEX_HOME/AGENTS.md` in its private home, OpenCode via
the `instructions` config. `scripts/executor_smoke.ts <harness> [model]` runs one executor on a
trivial file task in a temp dir.

| harness | how | approvals | failure signals mapped |
|---|---|---|---|
| claude-code | Agent SDK `query()`; `settingSources: []` so your `~/.claude` is not loaded; model + effort from the verdict | `canUseTool`: Read/Glob/Grep, gate + browser MCP tools and edits inside cwd are allowed; Bash, writes outside cwd, web → engine approval | result subtype, `model_refusal_no_fallback` → refusal, `rate_limit_event` → quota, usage → tokens |
| codex | `codex app-server` JSON-RPC (bundled ChatGPT.app binary); private `CODEX_HOME` with 0600 auth copy + our config.toml, removed after the run; `model_reasoning_effort` from the verdict | `item/*/requestApproval`, `execCommandApproval`, `applyPatchApproval` → engine; MCP elicitations accepted | `turn/completed` error, `error` notifications, process exit |
| opencode | `opencode run --standalone --format json -m <model>`; config via `OPENCODE_CONFIG` | none: `run` cannot surface prompts (design A.3). Edits and shell allowed, webfetch denied, gate home unreadable | `error` events, exit code, stderr |

## MCP servers and skills

Managed in the UI's 扩展 tab (or `GET /mcp`, `GET /skills`), stored under `$AGENTSWITCH_HOME`:
`mcp.json` (0600) and `skills/<name>/SKILL.md` + `skills.json`. Nothing touches the user's own
`~/.claude`, `~/.codex` or OpenCode config — each run gets a private copy.

Per entry you choose which harnesses see it. Injection per harness:

| | MCP | skills |
|---|---|---|
| claude-code | `mcpServers` option | local plugin dir (`plugins` + `skills: "all"`) |
| codex | `[mcp_servers.*]` in the private `config.toml` | copied into `$CODEX_HOME/skills` |
| opencode | `mcp` (local/remote) in the run config | `skills.paths` to a copied dir |

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
| POST | `/tasks` | `{task, cwd?, pin?, needs_browser?, ephemeral?, parent_id?, thread_id?}` → task (queued); no `cwd` = ephemeral work dir; `parent_id` = follow-up (router and executor see the parent chain's text and results; cwd inherited unless the parent was ephemeral); `thread_id` runs in that thread |
| POST | `/tasks/:id/handoff` | `{to?: {harness, model}}` → successor task in the same thread, excluding the current executor unless `to` pins one; cancels the task if still running |
| GET | `/threads?status=open\|archived`, `/threads/:id` | list with folded state (title, summary, lastTarget, taskCount) / detail with `state`, `tasks`, `events` |
| PATCH | `/threads/:id` | `{title?, status?, expires_at?}` |
| POST | `/threads/:id/archive`, `/threads/:id/reopen` | archive = delete after 7 days (refused while a task runs) / reopen |
| DELETE | `/threads/:id` | delete now, private home included |
| GET | `/tasks`, `/tasks/:id` | list / detail with pending approvals |
| GET | `/tasks/:id/events?after=N` | SSE: queued, routed, thread, waiting, dispatched, agent, supervisor, text, tool_call, approval_request, approval_resolved, attempt_failed, redispatch, handoff, summary, done, failed, cancelled, cleaned |
| POST | `/tasks/:id/approve` | `{approval_id, decision: allow\|deny}` |
| POST | `/tasks/:id/cancel` | abort; pending approvals denied |
| GET | `/approvals` | pending across tasks |
| POST | `/route/preview` | route without executing |
| GET/POST | `/quota`, `/quota/refresh` | readings per harness (`remaining` 0..1, detail, source, error) |
| GET | `/targets` | catalog + current quota map |
| GET | `/routing/log` | recent decisions (every engine dispatch and re-dispatch, plus previews) |
| POST | `/uploads` | multipart `files`; stages them, returns ids (≤ 20 files, ≤ 50 MB each, swept after 24 h) |
| GET | `/tasks/:id/files`, `/tasks/:id/files/*` | list / download a task's files: from `<cwd>` while it exists, else from `artifacts/<id>` (kept 7 days) |
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

Later for the phone: bind to the Tailscale address, add bearer auth and pairing. Routes stay.

## Start-up (serve)

`serve` discovers models (Codex `model/list`, Claude `supportedModels()`; new ids join the catalog, old
ones stay), brings up a resident `opencode serve` on `AGENTSWITCH_OPENCODE_PORT` (4712) with a
read-only `dispatcher` agent and a tool-less `oracle` agent, and only then listens. Router, summarizer
and supervisor calls are one short-lived session each on that server (~1 s); if it fails to start
they fall back to `opencode run --standalone`. Real executors refuse to start without secret-gate.

## Router (router-v0)

`config/targets.yaml` lists every selectable model per harness (Claude Code 15 incl. `[1m]`,
Codex 5 × effort, OpenCode deepseek-flash). The router is an OpenCode `router` agent (DeepSeek V4.1
Flash, read-only tools, injected via `OPENCODE_CONFIG`) that returns a Decision (harness, model,
effort, brief, fallbacks, confidence). `validateDecision` is the floor: catalog, browser, quota,
concurrency (queue, never switch), effort, low confidence → default policy. `CONTEXT.md` (sites,
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
ask the router with the history; gate_denied or an approved action → stop. The router may
`give_up` or request a registered repair tool (`action=repair`; none registered yet).

## Layout

| path | what |
|---|---|
| `src/engine/{types,store,bus,engine,cleanup,locks}.ts` | task model, SQLite + JSONL persistence, event fan-out, the concurrent engine, ephemeral cleanup, semaphore/keyed locks |
| `ui/` | desktop console at `/ui`: `index.html` shell, `app.css`, `app.js` (render loop, click routing, polling), `lib/{api,state,actions}.js`, `views/{home,task,log,ext,ctx,quota}.js` |
| `src/executors/{types,echo,gate,instructions,opencode,appserver,codex,claude}.ts` | executor interface, echo, gate wiring, global guidance, the three real executors |
| `src/executors/protected.ts` | protected paths: deny decision for Claude, deny patterns for OpenCode, snapshot/restore backstop for all |
| `src/threads/{record,memory}.ts` | track record aggregation + guards; MEMORY.md append/lint |
| `src/threads/{types,fold,summary,handoff}.ts` | thread model + fold policies, `foldThread`, the summarizer (router model, zod, lint), handoff package (`git status`/`diff --stat`) + rendering |
| `config/EXECUTOR.md` | AgentSwitch's part of the guidance every executor gets |
| `src/router/*` | targets, decision, validate, defaultPolicy, prompt, context, failure, reroute, route, log, routers/{echo,opencode} |
| `src/quota/{codex,deepseek,claude,windows,index}.ts` | providers, 5h/7d windows (Codex app-server windows; Claude `rate_limit_event` from runs or a one-turn probe), cached service |
| `src/files/*` | names (limits, MIME), uploads (staging → `<cwd>/in/`), artifacts (tree, safe download path, `out/` → `artifacts/<id>` before an ephemeral cwd is deleted, sweeps), notes (attachment paragraph for router + executor) |
| `src/extensions/*`, `src/executors/extensions.ts` | MCP + skill registries and their per-harness shapes |
| `src/api/app.ts`, `src/daemon.ts`, `src/client.ts`, `src/cli.ts`, `bin/agentswitch` | HTTP, composition root, client, CLI |
| `tests/` | 213 tests; API tests run in-process via Hono `request()` |
| `scripts/router_eval.ts`, `tests/fixtures/routing/v0.jsonl` | routing evaluation with the real router (costs tokens) |
| `scripts/resume_experiment.ts`, `scripts/executor_resume_smoke.ts` | real-model checks that Claude / Codex resume from a thread's private home (costs cents) |

## Facts learned

- `OPENCODE_CONFIG=<file>` + `--agent router` works with OpenCode 2.0.8; a real routing call on this repo took 19 s (`timeout_ms` 45 s).
- Codex `account/rateLimits/read` returns `rateLimits.primary.usedPercent` per window plus `planType`; the ChatGPT.app bundled codex (0.155) must be used, homebrew 0.142 only knows gpt-5.5.
- DeepSeek `/user/balance` works with the key OpenCode stores in `~/.local/share/opencode/opencode.db` (`credential` table, JSON `{"type":"key","key":...}`).
- Node's `parseArgs` needs `allowNegative: true` for `--no-watch`; `node:sqlite` prints an ExperimentalWarning on Node 24, silenced in the wrappers.
- `CLAUDE_CONFIG_DIR` alone makes claude 2.1.278 look for a keychain item `Claude Code-credentials-<sha256(dir)[:8]>` and report "Not logged in"; `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` restores the unsuffixed name. Transcripts land in `<dir>/projects/<realpath cwd key>/<session_id>.jsonl`; `resume` needs the same cwd.
- Codex `thread/resume {threadId}` reloads the rollout from `$CODEX_HOME/sessions/…` + `thread_history_1.sqlite`; the thread must have been started with `ephemeral: false`. Every app-server start also dumps `skills/.system/` and several sqlite files into CODEX_HOME.
- Claude's `rate_limit_event` (subscription accounts) carries the 5h / 7d windows in `unifiedWindows`, not in the declared top-level fields; one Haiku turn is enough to receive it. Codex `rateLimits` on this pro plan reports only the 7d window (`secondary` is null).
