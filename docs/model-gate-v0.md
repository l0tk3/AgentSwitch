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

## Regular expressions (2026-11-26, user #596)

A word, global or a room's, can be a regular expression: tick `Regex` beside the word field. Lists show it as `/pattern/` with a `Regex` tag.

- **Placeholders:** each piece of text a pattern matches is treated as a word of its own. It gets the same salted placeholder that text would get as a plain word (the gateway is sent the pattern and the profile's salt: `patterns` in its table, next to `pairs`; `hash_ref` in `model_gate.py` is `hashRef` in `words.ts`, and both test files check the same value). The gateway remembers, per scope and while it runs, which placeholder stood for which text (at most 10,000), so the reply, streamed or not and a placeholder cut across pieces included, comes back with the text.
- **A replacement of the user's own:** every match becomes that one text, one way only (`Replace Only`). There is no telling which match to put back.
- **JSON bodies:** patterns are matched inside the decoded strings, never across the JSON's own quotes and braces. The body is written again only when something was replaced. Other bodies are matched as text.
- **Refused** (`checkPattern` in `words.ts`, with the reason in Chinese):
  - fewer than 3 or more than 200 characters;
  - not valid;
  - matches the empty string;
  - matches a sample of ordinary English and Chinese text (too wide);
  - a repeated group that repeats inside (`(a+)+`, the kind that backtracks without end);
  - what JavaScript and Python's `re` read differently: named groups, lookbehind, inline flags, `\p{…}`.
  The gateway reads patterns with `re.ASCII`, so `\d` and `\w` mean what they mean in JavaScript. A pattern it cannot compile is skipped and said on its stderr.
- **Tests:** daemon `tests/redactRegex.test.ts`; secret-gate `tests/test_model_gate.py` (the `regex` part); Mac `RedactRegexTests`.

## Not yet

- **Gateway account:** the gateway runs under the user's account. Moving it into the gate service's own account is the next step; the design stays the same.
- **Password book:** built (`vault/passwords.ts`, `api/passwords.ts`). On the Mac it is a window of its own, opened from the padlock at the rail's foot or ⇧⌘L (`PasswordsWindowController`).
- **Images:** text inside images and screenshots is not replaced.
- **Remote nodes:** a remote node's words cannot be set from the Mac yet.

## What was found with Antigravity's key profiles (2026-11-27, room #21–#34)

Tried through the real gateway with a stand-in address (probe notes: room-files `agy-key/probe-findings.md` §7–§8). It works for a key profile: the words left as placeholders, came back as words, and `AGY_CA_CERT` is trusted under a key too. Three holes, none of them Antigravity's alone:

- **A stream sent with `content-length` was cut short** when words were put back (a relay's; the vendors' own streams are chunked). Fixed: the length is not passed on, and an HTTP/1 answer is chunked. Seen before and after through the gateway; HTTP/2 has the unit test only.
- **A terminal started without the gateway when the gateway was not there**, and every word left as it is, with nothing said (seen: a secret-gate too old to have `model-proxy`). Now (`ModelGate.open`, `GateDown`): replacing on, words or patterns to replace for that terminal, and no gateway (its program not found, or it did not start) → the terminal is not started, and the error says why and what to do (repair it, or switch replacing off in Settings › Redaction). With nothing to replace, or replacing off, it starts as before. The cost, accepted by the user: while the gateway is broken, no terminal with words to replace opens. A gateway that dies under a running terminal was already closed: the terminal's proxy is gone, so nothing leaves.
- **An https address written as an IP** (`https://1.2.3.4/…`, a relay's) was passed through unread: a client sends no server name for an IP, and the gateway opened a connection by that name alone. Fixed: with no name, the address the connection goes to (its CONNECT) is looked up in the terminal's hosts, where a profile's own address already is; brackets of an IPv6 address are dropped on both sides. Such a connection is then opened like any other, so its server's certificate must be believed (a public CA's, or one that names the IP): one that is not ends the connection with a line in the log (`TLS with … failed, the connection is refused`) and is never passed on unread. Seen through the gateway with a stand-in at an IP: believed → placeholders out, words back; not believed → nothing reached it.
