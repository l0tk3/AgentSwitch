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
| API | `api/redaction.ts` | `GET /redaction`, `PATCH /redaction/settings`, `POST/DELETE /redaction/words`, `GET/POST/DELETE /rooms/:id/redaction/words`, `GET/DELETE /redaction/logs`.<br>From another paired node (2026-11-28): everything but the logs, see "Another node's replacement". A phone: none of it. |
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

## Pictures and files are not touched (2026-11-27, room #52–#70)

A Codex session got `400 input_image image_url must be valid base64` on every turn. Its user name, a found word, stood by chance inside a picture's base64. The placeholder put in broke the picture, because `_` is not a base64 character. The provider refused the request, and the picture went out again, and broke again, with every later turn.

How likely that is with a picture of about 530 KB:

| Word | Pictures it breaks |
|---|---|
| 3 characters | nearly every one |
| 4 characters | about one in thirty |
| 5 characters or more | almost none |

Patterns such as six digits or eight hex characters match inside most pictures. Probe notes: room-files `agy-key/image-base64.md`.

Now binary data goes on as it came, both ways, and the text beside it is replaced as ever (`through`, `opaque`, `is_data` and `is_blob` in `model_gate.py`).

- **Fields that keep data.** A string in them is left alone when it is data: a `data:` URL, or base64 of any length. Anything else there is text and is replaced (user #78): a picture named by an address to fetch (`"image_url": "https://…/<name>/a.png"`), a path. Anthropic's `data` beside `"type": "base64"` and a stream's sound are left alone whatever they hold.
  - `image_url` (OpenAI Responses `input_image`, Chat Completions `{"image_url": {"url": …}}`);
  - `file_data` (`input_file`);
  - `input_audio`;
  - Gemini `inlineData` and `inline_data`;
  - any `data` beside `"type": "base64"` (Anthropic's `source`, for images and documents);
  - the base64 sound of a stream's `…audio.delta` event (its transcript is replaced as text).
- **Strings left alone, wherever they stand:** a `data:…;base64,` URL, and a string of 256 characters or more made of nothing but base64 (a tool's output that is a picture, Ollama's `images`, a generated picture coming back).
- **Words, like patterns, are replaced inside a JSON body's decoded strings and keys only.** Before, they were replaced in the body's raw text. Every form of a word (as it is, JSON-escaped, `\u`-escaped) is still looked for in each string: a tool call's arguments are JSON inside a string. A body that is not JSON is still replaced as a whole text.
- **Tests:** secret-gate `tests/test_model_gate.py`:
  - pictures, files and sound in each protocol, with words and with a pattern, out and back, streamed and whole;
  - a request through the addon.

  Both tests fail on the code before this change.
- **Seen through the real gateway** (`secret-gate model-proxy`, a stand-in endpoint over plain HTTP) with a 400 KB picture holding the word:
  - the picture arrived byte for byte, and the text beside it as a placeholder;
  - a generated picture holding the placeholder's letters came back unchanged, and the text came back as the word;
  - with the code before the change: the picture arrived as invalid base64, and the generated picture came back changed.
- **After the review** (room #83, `review/r81-model-gate-codex-osc.md` in room-files):
  - A word written as a JSON number (a phone number as a tool's argument) is replaced, and goes on as a string. Only a number that is the whole word: a word inside a number, or a pattern, leaves numbers alone (`max_tokens`).
  - A `data:` URL is data only when everything after its comma is base64. A text that begins like one is text.
  - A path is text though its letters are all base64's: a string of at most 4096 letters, with a `/` more often than every sixteen and never two together, is not data (`pathlike`). A JPEG's base64 begins with `/9j/` and is still data; so is a JPEG of text on white, which has a `/` every eleven letters but `//` all over it (second review, #86: counting slashes alone broke such a screenshot again).
  - The forms of the words are worked out once a request, not once a string: a request of 20,000 messages and 60 words took 6.5 s, now 0.1 s.
  - Left as it is: a word that is only part of a number (a phone number with its country code), a number written as a float, and patterns on numbers.
  - Left as it is, and rare: a string of 256 letters or more with no space, dot or slash in it (a long token) is taken for data, and a word inside it is not replaced.
- **Not covered:** text inside a picture, and the words inside a file sent as data (a PDF as base64): they leave as they are. A file's text an agent read and sent as text is replaced like any text, and so are a file's name and path. Multipart bodies are replaced as a whole text.

## Not yet

- **Gateway account:** the gateway runs under the user's account. Moving it into the gate service's own account is the next step; the design stays the same.
- **Password book:** built (`vault/passwords.ts`, `api/passwords.ts`). On the Mac it is a window of its own, opened from the padlock at the rail's foot or ⇧⌘L (`PasswordsWindowController`).
- **Images:** text inside images and screenshots is not replaced.
- **Remote nodes:** set from the Mac since 2026-11-28 (below); both sides need that version. A remote node's logs are still read on that node only.

## What was found with Antigravity's key profiles (2026-11-27, room #21–#34)

Tried through the real gateway with a stand-in address (probe notes: room-files `agy-key/probe-findings.md` §7–§8). It works for a key profile: the words left as placeholders, came back as words, and `AGY_CA_CERT` is trusted under a key too. Three holes, none of them Antigravity's alone:

- **A stream sent with `content-length` was cut short** when words were put back (a relay's; the vendors' own streams are chunked). Fixed: the length is not passed on, and an HTTP/1 answer is chunked. Seen before and after through the gateway; HTTP/2 has the unit test only.
- **A terminal started without the gateway when the gateway was not there**, and every word left as it is, with nothing said (seen: a secret-gate too old to have `model-proxy`). Now (`ModelGate.open`, `GateDown`): replacing on, words or patterns to replace for that terminal, and no gateway (its program not found, or it did not start) → the terminal is not started, and the error says why and what to do (repair it, or switch replacing off in Settings › Redaction). With nothing to replace, or replacing off, it starts as before. The cost, accepted by the user: while the gateway is broken, no terminal with words to replace opens. A gateway that dies under a running terminal was already closed: the terminal's proxy is gone, so nothing leaves.
- **An https address written as an IP** (`https://1.2.3.4/…`, a relay's) was passed through unread: a client sends no server name for an IP, and the gateway opened a connection by that name alone. Fixed: with no name, the address the connection goes to (its CONNECT) is looked up in the terminal's hosts, where a profile's own address already is; brackets of an IPv6 address are dropped on both sides. Such a connection is then opened like any other, so its server's certificate must be believed (a public CA's, or one that names the IP): one that is not ends the connection with a line in the log (`TLS with … failed, the connection is refused`) and is never passed on unread. Seen through the gateway with a stand-in at an IP: believed → placeholders out, words back; not believed → nothing reached it.

## Another node's replacement (2026-11-28, user #89-#91)

Settings › Redaction on the Mac has a Node picker, as Profiles has. With a paired node picked, the page reads and sets that node's switches, words and rooms' words through `/nodes/<id>/…`; nothing falls back to this Mac.

| | |
|---|---|
| Open to a paired node | `GET /redaction`, `PATCH /redaction/settings`, `POST /redaction/words`, `DELETE /redaction/words/:wid`, `GET/POST /rooms/:id/redaction/words`, `DELETE /rooms/:id/redaction/words/:wid` (`remote/routes.ts`). |
| Not open | `GET/DELETE /redaction/logs` (404 from the remote listener), and `log`, `logTerminals`, `keepDays` in a `PATCH` (403). The logs hold the text as it was before the words were replaced; they are read on the node that wrote them. |
| A phone | 403 on all of it. A device counts as a node by the platform it paired with (`macos`, `linux`, `win32`; a phone says `ios`). This keeps the page off the phones; it is not a wall against a paired device that lies about what it is — such a device already reaches the password book. |
| A new word | The Mac first asks the node to seal it (`POST /vault/seal` with `"for": "redaction"` → `asv:1:…`), then sends `{"sealed": "asv:1:…", "replace"?, "regex"?}`. From another node `value` is refused (400). The use is bound into the ciphertext: what the node sealed for anything else (a profile's API key, a proxy's password) does not open as a word — a word is shown again on the page, so without this the route would open any of the vault's ciphertexts for whoever held one. The word still travels to the node once, inside the paired TLS connection, to be sealed; what the sealed step keeps is the word out of the request that changes the list. |
| An older node | Its remote listener answers `404 {"error":"not found"}`; the Mac says the node has to be updated first. |

Not verified: against a real paired node on another machine (two throw-away services on one Mac were paired and driven through `/nodes/<id>/redaction…`).

## A stream that was ended early (2026-11-28, user #129)

Seen in Claude Code behind the gateway: "Streaming response ended before any complete data was received", and Web Search's "The search was cut off before any results arrived".

- **Cause.** The stream function answered `b""` whenever one read from the provider held no whole event. mitmproxy writes each piece of an HTTP/1.1 chunked answer as a chunk, and an empty chunk is `0\r\n\r\n`: the end of the answer. The agent got a 200 that ended properly, without its last events. The gateway printed nothing, and its own logs looked whole.
- **When.** An event bigger than one read: over TLS, anything past about 16 KB (a web search's results, a long tool call), or any event a relay hands on in small pieces. Measured against a made-up provider: a 60 KB `web_search_tool_result` was cut before the results every time; 12 KB events never; 20 KB events when the pieces came 0.5 ms or more apart.
- **Since.** The first version of the gateway. 1b177232 (2026-11-27) made answers sent with `content-length` chunked too, so those were cut the same way from then.
- **Fix.** Nothing to send is no piece at all (`[]`), never an empty one.

Measured in the same round and not a cause: silences of up to 330 s inside a stream pass; requests of 5 MB and 20 MB are held 0.02–0.22 s; other streams stall at most 0.26 s meanwhile.

Still open from that round:
- 600 s with no byte either way closes the connection (mitmproxy's `tcp_timeout`); an answer that is not streamed and takes longer gets no response.
- An answer the provider compresses although `identity` was asked for is not read (seen with gzip: nothing, or bytes that no longer unzip).
- An event stream that is not labelled `text/event-stream` is held whole until it ends.
- A provider that dies in the middle of an event reaches the agent as a proper end.
- Not tested: a real provider, HTTP/2, OpenAI / Gemini / WebSocket streams.

## A terminal's own proxy was passed by (2026-11-28, found while looking into user #129)

A scope's `upstream` — the proxy the terminal would have used without the gateway: its profile's forwarder, Clash — was never used. Every connection of such a terminal went straight out from the Mac, the models' and all the others the gateway passes through, from the gateway's first version (2026-11-25) on.

- **Cause.** The proxy was named in mitmproxy's `server_connect` hook. mitmproxy decides how a connection is made (straight, or a tunnel through a proxy) before that hook, so naming it there did nothing. No test ran the proxy itself.
- **Measured** (mitmproxy 12.2.3, the version in the Mac app; a forwarder that writes down what it is asked, a made-up target on 127.0.0.1): before, the forwarder was asked nothing in all four cases (https opened, https passed through, plain http opened and not) and the target was reached all the same. After, one `CONNECT` each.
- **Fix.** The proxy is named when the terminal's `CONNECT` (or plain request) arrives; nothing is connected until what is in the tunnel is known (`connection_strategy = lazy`, set by the addon); the tunnel is then made through the proxy by the layer mitmproxy's own upstream mode uses (`next_layer`). A proxy that is not there is a 502 or a failed connection, never a connection straight out. A scope without a proxy goes straight out as before.
- **Test.** `tests/test_model_gate_upstream.py` runs mitmdump with the addon.
- **Not verified.** On the installed app with a real profile's forwarder or Clash; an `https://` or SOCKS upstream (only `http://` proxies are taken, as before).
