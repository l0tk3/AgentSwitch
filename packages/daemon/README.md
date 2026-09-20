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
npm run route -- "把 cli.py 里没用的变量删掉" --cwd ../secret-gate        # real DeepSeek via OpenCode
npm run route -- "总结 README" --router echo                            # canned router
npm run route -- "..." --pin claude-code/claude-fable-5-1[1m]           # skip the router
npm run eval -- --limit 3                  # routing fixture with the real router (costs tokens)
```

Output is the `RouteResult` JSON; every call is appended to `~/.agentswitch/routing.db`.

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
| `scripts/router_eval.ts` + `tests/fixtures/routing/v0.jsonl` | evaluation set (12 samples to start) |

## Facts learned

- `OPENCODE_CONFIG=<file>` + `--agent router` works with OpenCode 2.0.8; the agent's `tools` map
  disables bash/edit/write/webfetch and `permission.read` denies the gate home and key files.
- A real routing call on this repo took 19 s (the agent reads files first); `timeout_ms` is 45 s.
- `node:sqlite` prints an ExperimentalWarning on Node 24; the npm scripts silence it.
