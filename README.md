# AgentSwitch

Drive AI agents running on your Mac (Claude Code, Codex, OpenCode) from your phone:
task-level async execution, privacy-aware routing, approvals for dangerous actions.

Early stage. Read `docs/design-v0.md` first.

| package | status | what |
|---|---|---|
| `packages/secret-gate` | working, 121 tests + live e2e on Claude Code / OpenCode / Codex | agents handle only `enc:v1:` ciphertext; a local gate decrypts at the network layer |
| `packages/secret-gate-ui` | working, SwiftUI | native macOS app: named keypairs, single and batch token minting |
| `packages/daemon` | not started | TypeScript daemon: API, task engine, router, harness executors |
