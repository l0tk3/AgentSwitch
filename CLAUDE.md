# AgentSwitch

手机遥控 Mac 上多个 AI agent（Claude Code / Codex / OpenCode）的任务编排层。设计稿在 `docs/design-v0.md`（总体）、`docs/router-v0.md`（路由器）、`docs/loop-v0.md`（调度循环）、`docs/threads-v0.md`（线程、交接、记忆）、`docs/gate-next-v0.md`（凭据层下一步）、`docs/app-v0.md`（Mac 应用与 iPhone 应用）、`docs/assistant-v0.md`（助理、线程视图、声音、实时活动、自修复；草案）、`docs/ui-v0.md`（两端界面与文案规范）、`docs/control-v0.md`（权限模式、默认目录、会话监视）、`docs/gate-service-v0.md`（凭据网关以独立服务账户运行）、`docs/local-model-v0.md`（可选的本地模型前台，脱敏后再分发；草案）、`docs/terminal-v0.md`（手动入口：服务持有的终端会话；草案）、`docs/dispatch-v0.md`（调度入口：命名与 Mac 主窗口；草案）、`docs/browser-v0.md`（服务持有的浏览器，App 与 agent 共用；草案）、`docs/mesh-v0.md`（网状连接与 Linux 纯服务端主机；草案，附一次可行性验证）、`docs/agents-v0.md`（四个 agent CLI 的安装、更新与版本；草案）、`docs/simple-view-v0.md`（简略视图：终端的另一种看法与调度页的同一套零件；草案，分步在做）和 `docs/profiles-v0.md`（配置：每个 agent 的多套登录，各带出口与浏览器身份；网关只留在调度里；草案，分步在做：Claude Code 的配置、它自己的代理和它自己的浏览器已做第一版，Mac 与 iPhone 的 Browser 页都能切到它；没登录的配置开终端就从登录开始，配置有颜色、它名下运行的终端带同色的亮点）和 `docs/clash-v0.md`（Clash Integration：为 Claude、OpenAI 单独配置代理，配置的代理直连；订阅由 AgentSwitch 保管并在本机分发给 Clash Verge；草案，§7 已做：`packages/daemon/src/clash/` 与 Mac 主窗口的 Clash 页），改架构先改它们。

## 布局
- `docs/` 设计与决策记录
- `packages/secret-gate/` 凭据层（Python）：模型只拿密文或任务范围内的短引用 `enc:ref:`，网络层与浏览器 gate 解密。自带 venv、pytest、AGENTS.md；`BOUNDARY.md` 是各入口的安全边界清单，改浏览器或凭据入口时同步更新
- `packages/secret-gate-ui/` macOS 原生界面（SwiftUI + SwiftPM）：管理命名密钥对、单条/批量生成密文，全部通过 secret-gate CLI，不自己做密码学
- `packages/mac-app/` macOS 菜单栏应用（SwiftUI + SwiftPM + xcodegen）：内置 Node/Python 运行时，看护 gate 与 daemon，配对二维码、设备、模型、密钥、环境检测；`scripts/build-app.sh` 打出自包含的 `AgentSwitch.app`（`docs/app-v0.md` §4）
- `packages/ios-app/` iPhone 应用（SwiftUI，iOS 17+，xcodegen）：`AgentSwitchKit` 纯逻辑包（配对、钉证书指纹、本地造密文、事件流）+ 界面；`scripts/e2e-live.sh` 用它连打包后的运行时做端到端（`docs/app-v0.md` §5）
- `packages/daemon/` TypeScript 守护进程：任务引擎（SQLite + SSE + 审批）、路由器（`docs/router-v0.md`）、HTTP API、额度、CLI `bin/agentswitch`。执行器：echo（开发）+ claude-code（Agent SDK）/ codex（app-server）/ opencode（执行器专用的常驻 serve，不可用时退回 `run --standalone`；`AGENTSWITCH_OPENCODE_EXECUTOR=run` 强制旧路径），`AGENTSWITCH_EXECUTORS=real` 启用；手动入口的终端会话（`src/terminals/`，`docs/terminal-v0.md`）；服务持有的浏览器（`src/browser/`，`docs/browser-v0.md`）

## 约定
- 每个 package 自包含：自己的依赖、测试、README；跨 package 只通过进程/网络接口
- 测试不打真模型；打真模型的脚本放 `scripts/` 且不进 pytest
- 界面（Mac、iPhone、网页）按 `docs/ui-v0.md` §7 视觉语言写：像素 / 字符 / 信号，克制实用；短词英文按苹果的标题式大写（`Resume`、`[ Allow ]`；键名、数字开头的单位、路径照原样，见 §7.2.7）、整句正式中文；一个图标一个意思。样子以 `docs/design/` 的演示页为准，新界面先对照演示页，没有的先补演示页
- 密码、token、PII 只能以 secret-gate 密文形式出现在执行器上下文、库和日志里。唯一例外是路由器模型的 sealer 调用（`docs/router-v0.md` §9）：它看任务原文、标出凭据，由 daemon 做成密文后才入库。配了本地模型时由本地前台接替这一角色，调度模型不再看明文（`docs/local-model-v0.md`）
