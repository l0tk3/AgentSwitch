# agentswitch-daemon

TypeScript daemon for AgentSwitch. **v1 = the router only** (design: `docs/router-v0.md`): no HTTP,
no executors yet.

```
task ──▶ route()
          ├─ pin?            validatePin ─────────────────────────────┐
          ├─ router (OpenCode `router` agent, DeepSeek V4.1 Flash)     │
          │    parse JSON → validateDecision (catalog, browser,        ├─▶ Verdict {harness, model, effort, queue}
          │    quota, concurrency, effort, confidence) → fallbacks     │
          └─ failure / timeout / low confidence → defaultTarget ───────┘
                                                        └─▶ routing_log (SQLite)
```

## Run

```bash
npm install
npm test                                   # vitest + coverage (no model calls)
npm run route -- route "把 cli.py 里没用的变量删掉" --cwd ../secret-gate  # real DeepSeek via OpenCode
npm run route -- route "总结 README" --router echo                      # canned router
npm run route -- route "..." --pin claude-code/claude-fable-5-1[1m]     # skip the router
npm run eval -- --limit 3                  # routing fixture with the real router (costs tokens)
```

From any other directory (npm scripts only work inside this package), use the wrapper; the
directory you are in is what the router reads:

```bash
~/Desktop/WorkSpace/Projects/AgentSwitch/packages/daemon/bin/route "帮我读取一下工作目录的拓扑"
```

Output is the `RouteResult` JSON; every call is appended to `~/.agentswitch/routing.db`.

## After a failed attempt (router-v0 §6)

`classifyFailure(outcome)` turns an execution result into `refusal | quota | transport | gate_denied |
task_failed | unknown` by pattern table. `nextStep()` then decides without a model where it can:
transport → retry once, then ask the router (the environment may be broken for every harness; it
can switch to a path that avoids the broken piece, request a registered repair tool via
`action="repair"`, or give up with what the user should check); quota → harness marked empty, next
in the chain; gate_denied or an approved action → stop and tell the user. Refusals (and task
failures with no side effects yet) go back to the router with the attempt history and the tried
targets hidden from the catalog; no extra coaching, the history is the input.
Limits: 3 attempts, 2 router asks. Repair tools are passed as `deps.repairs` (none registered yet;
see router-v0 §6.6). Manual check:

```bash
npm run route -- reroute "打开 http://site:8400 登录，密码 enc:v1:..." --failed claude-code/claude-sonnet-5 --kind refusal --excerpt "I can't help with automating logins"
```

## Layout

| file | what |
|---|---|
| `config/targets.yaml` | catalog: every selectable model per harness, quota/browser/concurrency, router settings |
| `src/router/targets.ts` | schema, loader, wildcard lookup, `markUnavailable`, prompt catalog text |
| `src/router/decision.ts` | Decision schema; pulls the first JSON object out of a chatty reply |
| `src/router/validate.ts` | the floor: `validateDecision` / `validatePin`, pure |
| `src/router/defaultPolicy.ts` | coarse code/chat/browser classifier and the no-router target |
| `src/router/prompt.ts` | router system prompt (catalog + rules) and task message |
| `src/router/routers/opencode.ts` | real router: `opencode run --agent router` with a read-only agent injected via `OPENCODE_CONFIG`, in the task's cwd |
| `src/router/routers/echo.ts` | canned router for tests |
| `src/router/route.ts` | pipeline: pin → router (timeout, one retry) → validate → default |
| `src/router/log.ts` | `routing_log` in `node:sqlite` |
| `src/router/failure.ts` | `classifyFailure`: outcome → FailureKind, pattern table |
| `src/router/reroute.ts` | `nextStep`: retry / switch along the chain / ask router / stop, pure |
| `scripts/router_eval.ts` + `tests/fixtures/routing/v0.jsonl` | evaluation set (12 samples to start) |

## Facts learned

- `OPENCODE_CONFIG=<file>` + `--agent router` works with OpenCode 2.0.8; the agent's `tools` map
  disables bash/edit/write/webfetch and `permission.read` denies the gate home and key files.
- A real routing call on this repo took 19 s (the agent reads files first); `timeout_ms` is 45 s.
- `node:sqlite` prints an ExperimentalWarning on Node 24; the npm scripts silence it.
