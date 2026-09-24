/** Time and size limits that more than one module uses, so each has exactly one source. A limit only one module uses
 *  is a named constant at the top of that module instead. */

/** Wall-clock limit for one execution: targets.yaml `timeout_ms` default, and what an executor adapter uses when it is
 *  given none. */
export const DEFAULT_EXECUTOR_TIMEOUT_MS = 30 * 60_000;

/** Outer deadline around one supporting text-only model call (thread summary, supervisor verdict or answer, completion
 *  check, credential-repair authorization), start-up included. The daemon passes targets.yaml `router.timeout_ms` to
 *  the calls themselves; this bounds whatever waits on them. */
export const SUPPORT_CALL_TIMEOUT_MS = 45_000;

/** One `secret-gate` CLI call that mints or registers tokens (`enc --batch`, `refs register|release`). */
export const GATE_CLI_TIMEOUT_MS = 15_000;

/** One request to a disposable `codex app-server` (quota read, model discovery), start-up included. */
export const APP_SERVER_REQUEST_TIMEOUT_MS = 20_000;

/** How long a quota reading is reused before providers are asked again. */
export const QUOTA_TTL_MS = 60_000;

/** Evidence an executor attaches to an approval request (the tool input as JSON), as the approval card shows it. */
export const APPROVAL_EVIDENCE_CHARS = 1000;

/** An attempt's excerpt (Attempt.excerpt): one line of what went wrong, for the router, logs and events. */
export const ATTEMPT_EXCERPT_CHARS = 240;

/** Rows a list (tasks, threads, routing log) returns when the caller names no limit. */
export const DEFAULT_LIST_LIMIT = 50;

/** An SSE comment on a task's event stream this often, so a quiet task (waiting for an answer) does not look like a
 *  dead connection to the phone's idle timeout (app-v0 §5). */
export const SSE_HEARTBEAT_MS = 10_000;
