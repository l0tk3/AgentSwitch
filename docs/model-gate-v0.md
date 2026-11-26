# Model Traffic Gateway v0 (2026-11-25, user #318–#332)

Terminals started from AgentSwitch (Claude Code, Codex, OpenCode, pi, Grok, Antigravity) reach their model through a built-in gateway.
- **Outgoing:** the user's replacement words become placeholders before they leave this Mac.
- **Incoming:** placeholders become the words again before the agent sees them.

The model's provider never receives the words, and the agent works with them as before. Nothing in the user's own configuration changes.

Feasibility check: room-files `feasibility-model-gateway.md`. Design: `design-redaction-words-and-vault.md`.

## Parts

| Part | Where | What |
|---|---|---|
| Gateway | `packages/secret-gate/secret_gate/model_gate.py`, `secret-gate model-proxy` | mitmproxy. Each terminal has a scope, carried in its proxy credentials `http://s:<terminal>@127.0.0.1:<port>`.<br>Only the models' hosts are opened (TLS); everything else is passed through. All of a scope's connections go on through that terminal's own upstream proxy (its profile's, or the service's).<br>Streams are rewritten as they arrive (Anthropic SSE, OpenAI Responses SSE and WebSocket, Chat Completions, Gemini / Cloud Code SSE — Antigravity's `candidates[].content.parts[].text`). A placeholder split across pieces is joined before it is swapped back.<br>The table arrives on stdin and is never written to disk. |
| Service | `packages/daemon/src/vault/` | `modelGate.ts` runs one gateway for all terminals and sends it the table.<br>Scopes and the port are kept across restarts, so held terminals keep working. |
| Words | `vault/words.ts` | Global list plus per-room lists.<br>Found automatically: the user name and full name (on by default) and the computer name (off by default).<br>The default placeholder is `h_` plus 10 characters of HMAC-SHA256 with a per-profile salt.<br>A user-given placeholder that is too plain is replaced one way only; a clashing one is refused. |
| Storage | `vault/words.enc` | AES-256-GCM.<br>The key is in the macOS Keychain (`VaultKey.swift`) and is handed to the service on its stdin (`AGENTSWITCH_VAULT_STDIN=1`).<br>Elsewhere it is `vault/key` (0600). |
| Launch | `terminals/launch.ts` | `req.gate` sets the proxy variables (both cases) to the gateway, `NODE_EXTRA_CA_CERTS` to its CA, and `SSL_CERT_FILE` to Node's roots plus its CA; Antigravity (Go) is also given `AGY_CA_CERT` to the same CA — the name it reads, beside the system's own roots (measured 2026-11-26).<br>A profile's own proxy becomes the gateway's way on. |
| Logs | `vault/model-gate/logs/<terminal>/<day>.{before,after}.jsonl` | **before:** what the agent sent and received (with the words).<br>**after:** what the provider received and sent.<br>Each entry is at most 1 MiB, each file at most 64 MiB. Off by default (`log`; user #398). `logTerminals`: only those terminals are written down, none = every terminal (user #595; Mac: Logs › Terminals, a menu of the running ones). Files are kept `keepDays` days (default 3).<br>`DELETE /redaction/logs[?days=N]` cleans them. |
| API | `api/redaction.ts` | `GET /redaction`, `PATCH /redaction/settings`, `POST/DELETE /redaction/words`, `GET/POST/DELETE /rooms/:id/redaction/words`, `GET/DELETE /redaction/logs`.<br>Not on the remote allowlist. |
| Mac | Settings › Redaction (`RedactionView.swift`) | Switches, words, room words, logs.<br>A log's button shows the file in the Finder (user #398). |

`vault/` is read-denied to terminals and executors (`executors/protected.ts`).

## Not yet

- **Gateway account:** the gateway runs under the user's account. Moving it into the gate service's own account is the next step; the design stays the same.
- **Password book:** built (`vault/passwords.ts`, `api/passwords.ts`). On the Mac it is a window of its own, opened from the padlock at the rail's foot or ⇧⌘L (`PasswordsWindowController`).
- **Images:** text inside images and screenshots is not replaced.
- **Remote nodes:** a remote node's words cannot be set from the Mac yet.
