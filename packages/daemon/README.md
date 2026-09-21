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

## Phone draft UI

`http://127.0.0.1:4711/ui` (`/` redirects there): one static page, `ui/index.html`, no build step,
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

## Executors

`AGENTSWITCH_EXECUTORS=real` (default `echo`); `AGENTSWITCH_BROWSER=1` adds the gated Playwright
browser as an MCP server; `AGENTSWITCH_BROWSER_ORIGINS=a;b` restricts it. When
`packages/secret-gate/.venv` exists, every executor gets the gate: proxy in the tool env (both
cases), `secret-gate mcp`, gate home unreadable. `scripts/executor_smoke.ts <harness> [model]` runs
one executor on a trivial file task in a temp dir.

| harness | how | approvals | failure signals mapped |
|---|---|---|---|
| claude-code | Agent SDK `query()`; `settingSources: []` so your `~/.claude` is not loaded; model + effort from the verdict | `canUseTool`: Read/Glob/Grep, gate + browser MCP tools and edits inside cwd are allowed; Bash, writes outside cwd, web → engine approval | result subtype, `model_refusal_no_fallback` → refusal, `rate_limit_event` → quota, usage → tokens |
| codex | `codex app-server` JSON-RPC (bundled ChatGPT.app binary); private `CODEX_HOME` with 0600 auth copy + our config.toml, removed after the run; `model_reasoning_effort` from the verdict | `item/*/requestApproval`, `execCommandApproval`, `applyPatchApproval` → engine; MCP elicitations accepted | `turn/completed` error, `error` notifications, process exit |
| opencode | `opencode run --standalone --format json -m <model>`; config via `OPENCODE_CONFIG` | none: `run` cannot surface prompts (design A.3). Edits and shell allowed, webfetch denied, gate home unreadable | `error` events, exit code, stderr |

## API

| method | path | what |
|---|---|---|
| POST | `/tasks` | `{task, cwd?, pin?, needs_browser?, ephemeral?, parent_id?}` → task (queued); no `cwd` = ephemeral work dir; `parent_id` = follow-up (router and executor see the parent chain's text and results; cwd inherited unless the parent was ephemeral) |
| GET | `/tasks`, `/tasks/:id` | list / detail with pending approvals |
| GET | `/tasks/:id/events?after=N` | SSE: queued, routed, dispatched, text, tool_call, approval_request, approval_resolved, attempt_failed, redispatch, done, failed, cancelled |
| POST | `/tasks/:id/approve` | `{approval_id, decision: allow\|deny}` |
| POST | `/tasks/:id/cancel` | abort; pending approvals denied |
| GET | `/approvals` | pending across tasks |
| POST | `/route/preview` | route without executing |
| GET/POST | `/quota`, `/quota/refresh` | readings per harness (`remaining` 0..1, detail, source, error) |
| GET | `/targets` | catalog + current quota map |
| GET | `/routing/log` | recent decisions |
| GET/PUT | `/context` | CONTEXT.md (PUT lints) |
| GET | `/healthz` | |

Later for the phone: bind to the Tailscale address, add bearer auth and pairing. Routes stay.

## Router (router-v0)

`config/targets.yaml` lists every selectable model per harness (Claude Code 15 incl. `[1m]`,
Codex 5 × effort, OpenCode deepseek-flash). The router is an OpenCode `router` agent (DeepSeek V4.1
Flash, read-only tools, injected via `OPENCODE_CONFIG`) that returns a Decision (harness, model,
effort, brief, fallbacks, confidence). `validateDecision` is the floor: catalog, browser, quota,
concurrency (queue, never switch), effort, low confidence → default policy. `CONTEXT.md` (sites,
accounts as secret-gate tokens, environment, preferences) goes into the router prompt; list entries
with plaintext credentials are stripped at load. After a failure, `classifyFailure` + `nextStep`
decide: transport → retry once then ask the router; quota → fallback chain; refusal / task_failed →
ask the router with the history; gate_denied or an approved action → stop. The router may
`give_up` or request a registered repair tool (`action=repair`; none registered yet).

## Layout

| path | what |
|---|---|
| `src/engine/{types,store,bus,engine,cleanup}.ts` | task model, SQLite + JSONL persistence, event fan-out, the engine loop, ephemeral cleanup |
| `ui/index.html` | phone-draft UI served at `/ui` |
| `src/executors/{types,echo,gate,opencode,appserver,codex,claude}.ts` | executor interface, echo, gate wiring, the three real executors |
| `src/router/*` | targets, decision, validate, defaultPolicy, prompt, context, failure, reroute, route, log, routers/{echo,opencode} |
| `src/quota/{codex,deepseek,claude,windows,index}.ts` | providers, 5h/7d windows (Codex app-server windows; Claude `rate_limit_event` from runs or a one-turn probe), cached service |
| `src/api/app.ts`, `src/daemon.ts`, `src/client.ts`, `src/cli.ts`, `bin/agentswitch` | HTTP, composition root, client, CLI |
| `tests/` | 84 tests; API tests run in-process via Hono `request()` |
| `scripts/router_eval.ts`, `tests/fixtures/routing/v0.jsonl` | routing evaluation with the real router (costs tokens) |

## Facts learned

- `OPENCODE_CONFIG=<file>` + `--agent router` works with OpenCode 2.0.8; a real routing call on this repo took 19 s (`timeout_ms` 45 s).
- Codex `account/rateLimits/read` returns `rateLimits.primary.usedPercent` per window plus `planType`; the ChatGPT.app bundled codex (0.155) must be used, homebrew 0.142 only knows gpt-5.5.
- DeepSeek `/user/balance` works with the key OpenCode stores in `~/.local/share/opencode/opencode.db` (`credential` table, JSON `{"type":"key","key":...}`).
- Node's `parseArgs` needs `allowNegative: true` for `--no-watch`; `node:sqlite` prints an ExperimentalWarning on Node 24, silenced in the wrappers.
- Claude's `rate_limit_event` (subscription accounts) carries the 5h / 7d windows in `unifiedWindows`, not in the declared top-level fields; one Haiku turn is enough to receive it. Codex `rateLimits` on this pro plan reports only the 7d window (`secondary` is null).
