# AgentSwitch

手机遥控 Mac 上多个 AI agent（Claude Code / Codex / OpenCode）的任务编排层。设计稿在 `docs/design-v0.md`（总体）、`docs/router-v0.md`（路由器）和 `docs/threads-v0.md`（线程、交接、记忆），改架构先改它们。

## 布局
- `docs/` 设计与决策记录
- `packages/secret-gate/` 凭据层（Python）：模型只拿密文，网络层解密。自带 venv、pytest、AGENTS.md
- `packages/secret-gate-ui/` macOS 原生界面（SwiftUI + SwiftPM）：管理命名密钥对、单条/批量生成密文，全部通过 secret-gate CLI，不自己做密码学
- `packages/daemon/` TypeScript 守护进程：任务引擎（SQLite + SSE + 审批）、路由器（`docs/router-v0.md`）、HTTP API、额度、CLI `bin/agentswitch`。执行器：echo（开发）+ claude-code（Agent SDK）/ codex（app-server）/ opencode（run），`AGENTSWITCH_EXECUTORS=real` 启用

## 约定
- 每个 package 自包含：自己的依赖、测试、README；跨 package 只通过进程/网络接口
- 测试不打真模型；打真模型的脚本放 `scripts/` 且不进 pytest
- 密码、token、PII 只能以 secret-gate 密文形式出现在执行器上下文、库和日志里。唯一例外是路由器模型的 sealer 调用（`docs/router-v0.md` §9）：它看任务原文、标出凭据，由 daemon 做成密文后才入库
