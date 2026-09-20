# secret-gate-ui

Native macOS (SwiftUI) front end for `packages/secret-gate`: manage named keypairs and mint
`enc:v1:` tokens, one at a time or in batches. It does no cryptography itself; every action
shells out to the `secret-gate` CLI with `SECRET_GATE_HOME` set, and secret values travel only
over stdin. The private key is never read or displayed.

```
┌ 密钥对 ──────────────┐ ┌ 生成密文 ─────────────────────────────────────────────┐
│ ● work   <pubkey> ⧉  │ │ 当前密钥对：work        [粘贴批量导入] [加一行]        │
│ ○ home   <pubkey> ⧉  │ │ label | host,host | 密码/TOTP ▾ | ⊖                     │
│          设为当前     │ │ ●●●●●●●●   ☑http ☐otp ☐exec                            │
│                  [+]  │ │ ...                                    [全部生成 ⌘↩]  │
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

- **Keypairs**: list, generate with a name, switch the current one, copy a public key.
  Creating a keypair never switches silently unless it is the first; tokens minted earlier
  keep working because the gate decrypts with every keypair it holds.
- **Tokens**: label, hosts (comma separated, `*.example.com` and IPs allowed), kind
  (password/token or TOTP), uses (http / otp / exec), value in a secure field. Rows show
  their validation problem inline; only valid rows are sent.
- **Batch**: paste lines `label, host1|host2, [secret|totp,] value`, or add rows by hand.
  Results list per-row success/error with copy buttons, copy-all, and JSON export.
- After a successful run the plaintext of every succeeded row is cleared from the table.

## Layout

| target | what |
|---|---|
| `SecretGateCore` | models, CSV import, `GateCLI` bridge (no UI, unit + integration tested) |
| `SecretGateUI` | SwiftUI views and `AppState` |
| `SecretGateCoreTests` | `swift test`; the integration test skips when the venv CLI is absent |

## CLI contract used

```
secret-gate keys --json [list | new <name> [--use] | use <name>]
secret-gate enc --batch      # stdin: [{label, hosts, kind, uses, value}] → stdout: [{label, token|error}]
```
