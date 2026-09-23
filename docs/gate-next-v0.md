# 凭据层下一步 v0：值得改的地方（2026-09-23，思路，未实现）

补 `design-v0.md` §3.9、`router-v0.md` §9。对照了同类项目（Infisical Agent Vault、mcp-secrets-vault、Cerberus KeyRouter、browser-use `sensitive_data`、Stagehand 变量、1Password for Claude、Presidio/LLM Guard 可逆脱敏、Skyflow）之后的结论：自描述密文、一个 gate 管四个出口、入口自动加密这三样没有现成替代，保留；下面是它们做得更好、我们该补的。

## 1. 短别名：`enc:ref:<name>`

**问题。** 密文 200 多字符，模型抄写丢字符，靠 `tokens.ts` 的确定性修复兜着；Codex/OpenCode 的工具参数改不了，只能靠提示词。同类项目的占位符都是 `__github_token__` 这种短 ID，不会抄错。

**思路。** 密文照旧造、照旧存，但给每枚密文一个短名字，模型上下文里只出现短名字：
- 名字空间：CONTEXT.md 里的条目名（`finance/pass`）和 sealer 的 label（`acct1/app-pass`）本来就是唯一的短标识，直接用。
- 解析：gate 家目录里一张 `refs.json`（`name → enc:v1:…`），代理、`secret_fill`、`secret_exec`、`secret_otp` 碰到 `enc:ref:name` 先查表再解。表由 secret-gate-ui 和 daemon 的 sealer 写（sealer 造完密文顺手登记），gate 只读。
- 任务里的临时密文（sealer 造的）随任务结束从表里删，避免表无限长；CONTEXT.md 的条目常驻。
- 兼容：`enc:v1:` 原样仍然有效，别名是可选的第二种写法；`secret_describe` 对两种都答。
- 代价：多一张表、多一个同步点（界面换密钥对后表里的密文要一起换），这正是之前不想要查表的原因。折中是表只做「名字 → 密文」映射，策略仍封在密文里，gate 不因为查到了名字就放松校验。

## 2. 密码框的「已填 / 未填」状态

browser-use 把密码框的值打码但给模型看 `filled | empty` 状态，模型不会反复重填。我们的 `secret_fill` 之后模型看快照只看到空白，偶尔会再填一次。做法：browser gate 在快照里对本会话填过的字段加一个 `[filled by secret-gate]` 标记，不露值。

## 3. 部署

- `launchd` 服务：gate 代理现在是手动 `nohup` 起的，重启机器要人再起。做成 `~/Library/LaunchAgents` 里的一条，daemon 启动时检查它在不在，不在就报错（和「没有 gate 就不起执行器」一致）。
- `HTTPS_PROXY` 自举脚本：Agent Vault 的做法是一条命令把 agent 的环境改成走代理并信任 CA。我们三家 harness 各有一份配置片段，合成一个 `secret-gate bootstrap <harness>`，检查 CA 已信任、代理可达、配置片段已写。
- 上游证书名单（`upstream-insecure.txt`）改完要重启代理：加 SIGHUP 重载。

## 4. 浏览器 gate 的安全面要有清单

这一层是单人维护里最容易漏的：截图打码、剪贴板、`browser_evaluate`、文件上传路径、下载文件名、子串搜索、非 http(s) URL……现在散在代码里。要做一张表：每条规则、它防什么、对应的测试名。新加一个 Playwright MCP 工具版本时按表核对，而不是靠记忆。

## 5. 页面内容打码：代理改前端（用户 2026-09-23 提出）

**想法。** 代理在响应里改前端代码，让页面渲染出来时敏感信息已经打码，模型无论看快照还是截图都看不到。

**现状。** 已有两层：代理按**精确值**把响应里的明文换回密文（只覆盖本会话解过的值）；浏览器 gate 拦工具输出里填过的值，页面上有填过的值时拒绝截图。两层都不管页面上**本来就有**的敏感内容（别人的邮箱、手机号、身份证、卡号、地址），也不管截图的像素。

**可行性。** 代理已经是中间人，改 HTML 和 JSON 响应没有技术障碍。但要分清模型「看」页面的两条路：
- Playwright MCP 的 `browser_snapshot` 给的是无障碍树，也就是 DOM 文本。CSS 打码（模糊、`-webkit-text-security`）对它无效，必须改 DOM 文本本身。
- 截图是像素，DOM 文本改了截图自然跟着变。

所以「改前端」实际是**往每个 HTML 响应注入一段脚本**，用 MutationObserver 在渲染后改 DOM：文本节点里匹配敏感模式的片段换成打码或者换成密文；输入框不改 `value`（改了表单就提交错），只加 `-webkit-text-security` 让截图看不到。SPA 通过 XHR 拿数据也一样被 observer 抓到，不用去改 JSON。

**要处理的坑。**
- CSP：站点的 `Content-Security-Policy` 会拦注入的内联脚本。代理可以改这个头（只对 gate 自己的浏览器生效，不影响用户平时的浏览器），要在文档里写明这是有意放宽。
- 页面 JS 读回 DOM 文本时会读到打码后的值，可能把站点搞坏。只打码「展示」性质的节点，`<input>`、`<textarea>`、`contenteditable` 不碰文本。
- 误判：订单号、工单号长得像手机号或卡号。模式按 host 配置，默认只开邮箱、手机号、身份证、银行卡四类；打码格式保留前后各两位，模型还能区分不同条目。
- 这是打码不是加密：模型看不到，但也**用不了**。

**真正有价值的版本：页面数据的动态加密。** 打码之后模型经常还需要把页面上的值搬到别处（把订单里的手机号填进另一个系统）。secret-gate 的密文正好是「模型拿着能用、看不到内容」的载体：注入脚本把页面上识别到的值送回 gate（本地端口），gate 当场用当前公钥造一枚绑定当前 host 的 `enc:v1:` 密文（或 `enc:ref:page/phone-3` 短别名，见 §1），DOM 里显示密文，模型用 `secret_fill` 就能把它填到别处，gate 校验目的 host 后填明文。这就是 Presidio/Skyflow 那种「可逆脱敏」搬进浏览器，而且和现有的密文体系是同一套东西。
- 绑定：动态造的密文只允许用在**当前任务的目的站点**（任务里点名的 host），不是「任何地方」；任务结束密文作废（短别名表删掉即可）。
- 模型端说明：快照里出现 `enc:v1:` 时执行者指南已经写了怎么用；页面内密文只需在注入脚本里加一个 `title` 提示「secret-gate 已打码，用 secret_fill 搬运」。
- 不做的：不试图在像素层做 OCR 打码；不对下载的文件做（下载本来就经 gate 打码文件名、落在 gate 家目录）。

**分期。** 先做工具输出层的模式打码（改 browser gate 的 `_redact_block`，不碰页面，零破坏风险，覆盖快照），再做注入脚本（覆盖截图，按 host 开关），最后做动态加密。每期都要加到 §4 的清单里。

## 6. 现有技术债（沿用审计清单）

OpenCode 执行器迁到常驻 serve；用正则判超时；secret-gate 相对路径查找；JSON-RPC 客户端重复；事件行渲染四份；执行器脚手架重复；zod 解析重复；魔法数字；UI 直接改 DOM；按时间断言的测试。
