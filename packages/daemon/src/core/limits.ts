/** Time and size limits that more than one module uses, so each has exactly one source. A limit only one module uses
 *  is a named constant at the top of that module instead. */

/** Wall-clock limit for one execution: targets.yaml `timeout_ms` default, and what an executor adapter uses when it is
 *  given none. */
export const DEFAULT_EXECUTOR_TIMEOUT_MS = 30 * 60_000;

/** One `secret-gate` CLI call (`fill-value`, `keys --json`). */
export const GATE_CLI_TIMEOUT_MS = 15_000;

/** One request to a disposable `codex app-server` (quota read, model discovery), start-up included. */
export const APP_SERVER_REQUEST_TIMEOUT_MS = 20_000;

/** Evidence an executor attaches to an approval request (the tool input as JSON), as the approval card shows it. */
export const APPROVAL_EVIDENCE_CHARS = 1000;

/** An SSE comment on an event stream this often, so a quiet one does not look like a dead connection to the phone's
 *  idle timeout (app-v0 §5). */
export const SSE_HEARTBEAT_MS = 10_000;
