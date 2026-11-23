# secret-gate-ui

Native macOS (SwiftUI) front end for `packages/secret-gate` on a gate without the system service: show the
gate's one keypair, rotate it, and mint
`enc:v1:` tokens, one at a time or in batches. It does no cryptography itself; every action
shells out to the `secret-gate` CLI with `SECRET_GATE_HOME` set, and secret values travel only
over stdin. The private key is never read or displayed.

```
┌ 密钥 ────────────────┐ ┌ 生成密文 ─────────────────────────────────────────────┐
│ ⚿ default            │ │ 密钥：default           [粘贴批量导入] [加一行]        │
│   <pubkey> ⧉         │ │ label | host,host | 密码/TOTP ▾ | ⊖                     │
│ 轮换密钥…            │ │ ●●●●●●●●   ☑http ☐otp ☐exec                            │
│                      │ │ ...                                    [全部生成 ⌘↩]  │
└──────────────────────┘ │ 结果：2 成功 0 失败   [复制全部] [保存为 JSON] [清空]  │
                         └───────────────────────────────────────────────────────┘
```

## Run

```bash
cd packages/secret-gate-ui
swift run SecretGateUI            # debug
swift build -c release && .build/release/SecretGateUI
```

Requires the Python package to be installed (`packages/secret-gate/.venv`). The CLI path and
gate home are editable in Settings (⌘,); defaults are the repo venv and `~/.secret-gate`.

## Features

- **Keypair** (gate-simple-v0 §1): the gate has one. Its public key with a copy button; 生成密钥 on an
  empty gate home (`keygen`); 轮换密钥… replaces it with `keygen --force` after a warning — every
  token minted earlier stops working and has to be sealed again. With the system service installed,
  the key lives in the service and the AgentSwitch app rotates it (`system rotate-key`).
- **Tokens**: label, sites (comma separated; a bare `host[:port]`, `*.example.com`, an IP, or a full URL
  such as `https://core.example:8600/login` — the token binds to `host:port` only, the URL with its
  scheme goes into the CONTEXT.md entry so the model knows http from https), kind
  (password/token or TOTP), uses (http / otp / exec), value in a secure field, plus a note
  (what the platform is for) and an optional account. The note never reaches the CLI; the account
  is minted as a companion token `<label>/user` (same hosts, http use) when "账号也加密" is on
  (the default), so the login name is ciphertext to the model too and is filled with `secret_fill`.
  Rows show their validation problem inline; only valid rows are sent.
- **Batch**: paste lines `label, host1|host2, [secret|totp,] value`, or the JSON that "导出当前行"
  puts on the clipboard (every field, value included: it is plaintext, keep it out of any model
  context), or add rows by hand.
  Results list per-row success/error with copy buttons, copy-all, and JSON export.
- Results pair each token with its row. "复制条目" copies one row as a CONTEXT.md list item
  (`- 备注（label）：hosts` / `账号 …` / `密码 enc:v1:…`, or `2FA …` for TOTP) ready to paste into
  AgentSwitch's router context; "复制全部条目" copies them all; "只复制密文" copies the bare token.
  The JSON export carries label, hosts, kind, note, account and token, never plaintext.
- The table (labels, hosts, kind, uses, note, account, the encrypt-account flag) is saved to
  `~/Library/Application Support/SecretGateUI/rows.json` (0600) on every change and restored at
  launch; secret values are never written to disk.
- Plaintext stays in the table after a run (mint again for another host, fix a typo) until
  "清空明文" is pressed. It lives only in the app's memory.

## Layout

| target | what |
|---|---|
| `SecretGateCore` | models, CSV import, `GateCLI` bridge (no UI, unit + integration tested) |
| `SecretGateUI` | SwiftUI views and `AppState` |
| `SecretGateCoreTests` | `swift test`; the integration test skips when the venv CLI is absent |

## CLI contract used

```
secret-gate keys --json       # one row {name, public, current} or []
secret-gate keygen [--force]
secret-gate enc --batch      # stdin: [{label, hosts, kind, uses, value}] → stdout: [{label, token|error}]
```
