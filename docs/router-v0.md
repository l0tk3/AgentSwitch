# 路由器 v0：DeepSeek V4.1 Flash 作为分诊台

替换 `design-v0.md` §3.3。一句话：**DeepSeek Flash 在 OpenCode 里当分诊台，决定谁干、怎么干；代码策略表是地板，模型只能在地板之上做选择。**

2026-09-20 决定：**不做敏感度预检。** 密码、token、PII 由用户自己先做成 secret-gate 密文再发任务，任何模型只见密文；任务文本本身视为可以出门。因此路由没有 sensitivity 维度，也没有"本地可信模型"这一目标。

"可信模型"的概念合并进路由器：分诊台是唯一必须看到每条任务全文的模型，以后若想任务文本不出门，把 `router` agent 的 `model` 换成本地模型即可（OpenCode 加一个本地 provider，其余不动）。执行者仍按 `targets.yaml` 派发，不受影响。

## 0. 三个定位，先说清楚

| 角色 | 是谁 | 不是什么 |
|---|---|---|
| 分诊台（router） | OpenCode 里的 `deepseek/deepseek-flash`，一个只读工具的自定义 agent | 不是执行者，不是安全边界 |
| 地板（policy） | daemon 里的纯函数 + `targets.yaml` | 不调模型 |
| 执行者（executor） | Claude Code 里的 Claude 系、Codex 里的 GPT 系、OpenCode 里的其他模型（含 DeepSeek 自己） | 不互相调用，只被 daemon 派发 |

模型路由的价值在于它能**读任务、看一眼仓库、写一份给执行者的简报**，这是规则表做不到的。什么工具能用、额度和并发怎么算，由代码决定，路由器说了不算。

## 1. 流程

```
手机/CLI 任务（凭据已是 enc:v1: 密文）
   │
   ▼
① 准备（代码）：cwd 解析（附录 B 注册表）、附件落盘、拉一次各目标额度
   │
   ▼
② 分诊（DeepSeek Flash，OpenCode `router` agent，单次调用，≤ 20 s）
   输入：任务文本、cwd 摘要、targets 目录 + 实时额度、最近 20 条同类决策的结果
   输出：Decision JSON（见 §4）
   失败/超时/低置信 ──▶ 走 §4 的默认策略表，任务照常进行
   │
   ▼
③ 校验（纯函数）
   Decision × targets.yaml × 额度 × 并发 ──▶ 通过 / 改写为降级链的下一项 / 拒绝
   │
   ▼
④ 派发（§3.4 执行器）      claude-code ─┬─ fable-5-1 / opus-5-5 / opus-5 / opus-4-8 / 4-7 / 4-6 / sonnet-4-6 / haiku-4-5（含 [1m] 档；sonnet-5 已排除）
                           codex ───────┼─ gpt-6-astra / gpt-5.6-sol / terra / luna / gpt-5.5（× effort 档）
                           opencode ────┴─ deepseek-flash（DeepSeek V4.1 Flash，自己）
   │
   ▼
⑤ 回流：事件流 → 任务表 → 手机；决策 + 结果写 routing_log（§7）
```

粗体原则：**②可以整段失效，系统照样能用**。路由器是优化器，不是依赖。

## 2. 分诊台怎么跑

- **在哪跑**：OpenCode `serve`（常驻，v2 HTTP API），daemon 用 `session.create` + `session.prompt` 调；每次分诊一个新 session，不复用上下文。standalone `run` 每次起服务要 2–3 s，只做后备。
  > 2026-09-22 实现：daemon 启动时拉起 `opencode serve --port 4712`（`OPENCODE_SERVER_PASSWORD` 随机，Basic 认证用户名固定 `opencode`），配置经 `OPENCODE_CONFIG` 注入两个 agent：`dispatcher`（read/glob/grep/list）和 `oracle`（无工具，摘要器与监督者用）。v2 API 不能按调用传 system prompt，所以指令放在消息开头、任务在结尾；完成信号是消息列表里 `type: idle` 的条目；每次问答一个 session，问完删除。实测一次 DeepSeek 调用约 1.2 s（原来 5–10 s）。serve 起不来时退回 `run --standalone`。执行器仍用 `run --standalone`（权限与 `--session` 续接已验证），待迁。
  > 2026-09-24 更新：路由器服务改为 `opencode serve --stdio --port <AGENTSWITCH_OPENCODE_PORT>`，启动前把密码从服务自身环境里删掉，它派生的 shell 和 MCP 拿不到密码；stdin 关闭即退出，随 daemon 启停（`harness/opencodeStdio.ts`）。执行器已迁到另一个**执行器专用**的常驻服务（`executors/opencodeServer.ts`，不与路由器共用：运行时 MCP 按目录生效，共用会让路由器会话看到某次执行的范围）；每次执行按会话设置 shell 环境、权限、指令，按 cwd 添加并在结束时删除 MCP；服务不可用或发 prompt 前任一调用失败时退回 `run --standalone`，`AGENTSWITCH_OPENCODE_EXECUTOR=run` 可强制旧路径。
  > 2026-09-25 更新：OpenCode 2.0.8 在一次权限请求被拒后结束当前步骤（消息 `finish=error`、`aborted: Step interrupted`），会话停下但**不写 `idle` 结束标记**；v2 的回复只有 `once|always|reject`，没法附带理由让它继续。daemon 原来只认 `idle`，于是一直等到看门狗（手机任务 7698f9b5 空等 6 分钟）。现在：会话不在运行、没有子会话在跑、没有待决的审批或提问、本轮消息全部完结，持续 2 秒即视为停下；停下若因 AgentSwitch 拒绝了操作，就在同一会话里补发一条消息，列出被拒的操作，要求不重试、不绕道，用允许的方式继续，做不完就直接回答并说明被拒了什么（最多 3 次），被续上的那一步的 `Step interrupted` 不算失败；没有被拒的操作或次数用完，按失败结束本次执行。真模型探测 `scripts/opencode_deny_probe.ts`：同一场景从 180 秒没结果变为 18 秒给出结论。
- **用什么 agent**：`opencode.json` 里定义 `router` agent，`mode: primary`，model `deepseek/deepseek-flash`，工具只留 `read` / `glob` / `grep` / `list`，`bash` / `edit` / `write` / `webfetch` / `websearch` 全部 deny，无 MCP。它能看仓库，不能改、不能出网、不能拿凭据。
- **看仓库的范围**：只允许读 cwd 之内；`~/.secret-gate`、`.env`、`*.pem`、`*.key` 在 OpenCode permission 里 deny（防误操作，不是隐私边界）。
- **为什么放在 OpenCode 而不是直接调 DeepSeek API**：三点。它需要看仓库，OpenCode 已有受控的只读工具；DeepSeek 作为执行者本来就在 OpenCode 里，provider、限流、账单一处管理；将来换路由模型（比如以后想换成别家或本地模型）只改 agent 的 `model` 字段。
- **输出约束**：系统提示要求只输出一个 JSON 对象；daemon 用 zod 校验，失败重试一次（附上校验错误），再失败走默认策略。不依赖 provider 的 JSON mode。
- **成本**：Flash 一次分诊约 3–8k 输入 token（目录 + 摘要），可忽略；目录部分放提示词开头以命中缓存。

## 2b. 用户环境上下文 `~/.agentswitch/CONTEXT.md`

路由器的"CLAUDE.md"：用户手写的 markdown，每次分诊原样进路由器的 system prompt。内容三类：

- **站点与账号**：URL、账号、密码/2FA/Token 的 **secret-gate 密文**（可以写明文，保存时由 sealer 换成密文，§9 末尾）、备注（表单类型、登录后标题）。
- **环境**：代理地址、内网可达条件、该用哪个二进制。
- **偏好**：某目录优先哪个 harness、某类任务别用贵模型。

路由器的义务写在提示词里：任务提到列出的站点/账号时，把 URL、账号、密文**原样**抄进简报；不得编造凭据；缺凭据时在简报里说明并降低置信度，不能让执行者"去找密码"。

## 9. 明文入口：sealer（2026-09-22）

> 2026-09-28：配了本地模型时，sealer 由本地前台接替并多做脱敏，调度模型只见脱敏文本；没配时本节照旧。见 `docs/local-model-v0.md`。

用户想怎么写任务就怎么写，账号、密码、整张账号表都可以直接放进去，不用先去界面造密文，也不用告诉 daemon「这条有敏感信息」。对用户是透明的：

1. 每一次 `POST /tasks`，在入库之前都先过 sealer。没有关键词预判、没有开关：判断什么是敏感信息是路由器模型的事，不是正则的事。
2. sealer 是路由器模型的文本 agent（`oracle`，和摘要器、监督者同一形状），它看到任务原文、用户的 CONTEXT.md（站点、密文账号、备注）、追问时的上一轮任务文本和线程标题，回一个 JSON：每条 `{value, label, kind, hosts, uses}`。它是唯一允许看到明文的模型（用户决定）。它只标，不造密文。host 从任务里的网址来；任务只点名了站点（「财务系统」「grafana」）就到 CONTEXT.md 或上一轮里找那个站点的 host。
3. daemon 校验（值必须原样出现在文本里、≥4 字符、去重），然后跑 `secret-gate enc --batch`：和 secret-gate-ui 同一条命令、值只走 stdin，用 `~/.secret-gate/current` 指向的密钥对。界面上换密钥对，这里下一个任务就跟着换；代理用全部密钥对解密，旧密文不作废。
4. 文本里每个值的所有出现位置换成密文，再入库、再分诊。事件 `sealed` 只记 label、hosts、uses，不记值。库、事件、路由日志、执行器从头到尾只见密文。
5. 拒绝提交的情况：`http` 用途的值在任务、CONTEXT.md、上一轮里都找不到站点（400，gate 对无 host 的密文一律 403，造了也没用，提示把站点写上或加进 CONTEXT.md）；模型不回 JSON、超时、gate 拒绝（503）。任务不会以明文形式存下来。没有 gate 的 echo 模式没有 sealer，原样提交。

**字段与说明（2026-09-23）**：用户常贴 `邮箱|密码|年份|国家|应用专用密码|session key` 这类整行账号。sealer 必须按分隔符（`|`、tab、`----`、逗号、分号）把记录拆成字段逐个判断，只加密凭据字段，年份、国家这类留明文给执行者用；每个值带 `field`（「登录邮箱」「Google 应用专用密码」这种能对上表单标签的说法），整段另给 `layout`（每个位置是什么）。模型仍把整行当一个值 → 带反馈重问一次 → 还是整行就机械拆开、每个字段都加密（宁可多封）。hosts 的含义改为**这次任务要把值填进/发往的站点**（目的地），不是凭据所属服务：把 Gmail 账号录进平台 X，host 是 X。

加密后的文本末尾追加一段说明（`LEGEND_HEADER` + layout + 每个密文对应的字段和 host）。执行者的 prompt 里除了路由器写的简报，还会收到**用户原话**（只要原话里有密文）：路由器被要求不抄密文，所以之前任务里的密文根本到不了执行者手里，这是「执行者一头雾水」的另一半原因。路由器提示词改为用字段名指代（「用户消息里的应用专用密码」），执行者按说明把密文对到表单字段上。

代价：每个任务多一次路由器调用（常驻 serve 上约 1–4 秒）。不做的：附件不过 sealer（截图、文件原样进 in/，界面已提示）；不把任务里的密文写进 CONTEXT.md（任务里的密文只活在这个任务和它的线程里）。

**CONTEXT.md 的保存也过 sealer（2026-09-24）**：`PUT /context`（网页和手机同一条路）先过 sealer 再过 lint，所以 CONTEXT.md 里也可以直接写账号密码；sealer 追加的执行者说明不写进文件（路由器直接读 CONTEXT.md）；sealer 不可用或看不出站点时拒绝保存、文件不动；内容没变不调用模型；保存前的旧版本留在 `context-history/`。

> 2026-09-21：实测路由器把 226 字符的密文抄成 225 字符，gate 报 `invalid base64url`。对策：提示词改为「指条目名，不抄密文」；daemon 的 `tokens.ts` 用 CONTEXT.md/MEMORY.md/任务原文里的真密文做确定性修复（前缀 ≥10、后缀 ≥6、长度差 ≤4、唯一匹配才替换），作用于简报和 Claude 工具参数（canUseTool 的 updatedInput）；Codex/OpenCode 的工具参数无法改写，只能靠提示词。根治要靠 secret-gate 支持短别名（模型写 `enc:ref:<name>`，gate 查表），待做。
> 2026-09-21：只靠路由器抄不可靠（实测它写了「未提供 URL 和凭据」）。现在整份 lint 后的 CONTEXT.md 也附在执行者提示词末尾（简报 → 交接包 → 环境上下文），文件里只有密文，给执行者是安全的；引擎每次分诊重新读文件，页面上保存即生效（原来引擎只在启动时读一次，这是个 bug）。

规则：
- **只放密文**。daemon 加载时对列表条目做 lint：`密码 / password / token / api key / 2fa / totp / seed` 后面跟的不是 `enc:v1:` 也不是占位符，就删掉该行并在 CLI 打警告。这是防手滑，不是边界；正文段落不检查。
- 上限 64 KB；密文对路由模型无用（只对 gate 有用、只对绑定 host 有用），所以经过 DeepSeek 没有问题。
- v1 只由用户编辑（`npm run route -- context init` 生成模板）。路由器"记住新站点"的能力后做，且必须经手机批准才写入。
- secret-gate 图形界面后续可以直接导出成这个格式的条目。

实测：上下文里放一条内网站点 + 密文 + "浏览器任务优先 Codex"，任务只说"登录 core 控制台看首页标题"，路由器选 codex/gpt-5.6-luna，简报里带上了 URL、账号和密文，无明文，6.5 s。

## 3. 目标目录 `targets.yaml`

一个 harness 一条，下面列出**全部可选模型**；路由粒度是 (harness, model) 二元组。路由器在 harness 的模型列表里自由选，列表之外的一律不通过校验。

```yaml
harnesses:
  claude-code:                      # 执行器：Claude Agent SDK / claude -p --model
    quota: local-count              # design §3.7
    max_concurrent: 1
    browser: true                   # 可经 secret-gate browser 用浏览器
    default_model: claude-sonnet-4-6
    exclude: [claude-sonnet-5, "claude-sonnet-5[1m]"]   # 永不使用：模型发现列出也不加进目录，指定/路由/规划一律拒绝（2026-09-24 用户决定）
    models:                         # `[1m]` 后缀 = Claude Code 的 1M 上下文变体，同一模型另一档
      claude-fable-5-1:       {cost: top,  strengths: [hardest, longest-agentic, architecture]}
      claude-fable-5-1[1m]:   {cost: top,  strengths: [hardest, whole-repo-context]}
      claude-opus-5-5:        {cost: high, strengths: [complex-code, refactor, review]}
      claude-opus-5-5[1m]:    {cost: high, strengths: [complex-code, whole-repo-context]}
      claude-opus-5:          {cost: high, strengths: [complex-code, refactor]}
      claude-opus-5[1m]:      {cost: high, strengths: [complex-code, whole-repo-context]}
      claude-opus-4-8:        {cost: high, strengths: [complex-code]}
      claude-opus-4-8[1m]:    {cost: high, strengths: [complex-code, whole-repo-context]}
      claude-opus-4-7:        {cost: high, strengths: [complex-code]}
      claude-opus-4-7[1m]:    {cost: high, strengths: [complex-code, whole-repo-context]}
      claude-opus-4-6:        {cost: high, strengths: [complex-code]}
      claude-opus-4-6[1m]:    {cost: high, strengths: [complex-code, whole-repo-context]}
      claude-sonnet-4-6:      {cost: mid,  strengths: [code, browser, general]}
      claude-sonnet-4-6[1m]:  {cost: mid,  strengths: [code, whole-repo-context]}
      claude-haiku-4-5-20251001: {cost: low, strengths: [small-edit, quick-answer]}
  codex:                            # 执行器：codex app-server
    quota: rate-limits              # account/rateLimits/read
    max_concurrent: 1
    browser: true
    default_model: gpt-6-astra
    binary: /Applications/ChatGPT.app/Contents/Resources/codex   # 0.155；homebrew 的 0.142 只认 gpt-5.5
    models:                         # 2026-09-20 app-server `model/list` 实拉；启动时刷新
      gpt-6-astra:   {cost: top,  strengths: [complex-code, large-repo, test-heavy], efforts: [low, medium, high, xhigh, max, ultra]}
      gpt-5.6-sol:   {cost: high, strengths: [code, general],                        efforts: [low, medium, high, xhigh, max, ultra]}
      gpt-5.6-terra: {cost: high, strengths: [code, general],                        efforts: [low, medium, high, xhigh, max, ultra]}
      gpt-5.6-luna:  {cost: mid,  strengths: [code, general],                        efforts: [low, medium, high, xhigh, max]}
      gpt-5.5:       {cost: mid,  strengths: [code, shell],                          efforts: [low, medium, high, xhigh]}
  opencode:                         # 执行器：opencode serve
    quota: balance                  # DeepSeek /user/balance；其他 provider 各自
    max_concurrent: 2
    browser: false                  # M4 后可开
    default_model: deepseek/deepseek-flash
    models:                         # 2026-09-20 按 models.dev 目录核实：deepseek-flash = "DeepSeek V4.1 Flash"，1M ctx，$0.15/$0.6 per M
      deepseek/deepseek-flash: {cost: low, strengths: [chat, summarize, long-context, cheap-code], default: true}
      # 目录里还有 deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp，按决定不开
      # openrouter/*: {cost: mid, strengths: [fallback-any]}     # 待拍板；OpenRouter 凭据已存在，开了就能用

router:
  harness: opencode
  model: deepseek/deepseek-flash    # 以后可换本地模型
  default: {harness: opencode, model: deepseek/deepseek-flash}   # 路由失效时的兜底
```

- `models` 里的 key 是执行器实际接受的模型 ID：Claude Code 走 `--model` / SDK 的 `model` 字段，Codex 走 app-server `newConversation.model`，OpenCode 走 `provider/model`。
- Codex 每个模型还有 `efforts`（推理强度，`ultra` 会自动委派子任务）。Decision 里可选 `effort` 字段，缺省 `medium`；校验只检查它在该模型的 `efforts` 里。Claude Code 的对应物是 `--effort`/settings 的 effortLevel，v1 不路由这一维。
- **发现与刷新**（2026-09-22 决定并实现，`src/router/discovery.ts`）：启动时 Codex 走 app-server `model/list`，Claude Code 走 Agent SDK 的 `supportedModels()`（不发消息，2.4 s，返回 `resolvedModel` 规范 id）；结果与 yaml **求并集**：老模型保留（按 id 仍可派发），新 id 加进目录，cost 按名字猜（fable/gpt-6→top、opus→high、haiku/mini/flash→low、其余 mid），strengths 标 `discovered`。不做 `unavailable` 标记。OpenCode 侧不发现（只用 deepseek-flash）。
- `cost` / `strengths` 是给路由器看的自然语言标签，不参与代码校验；`quota`、`max_concurrent`、`browser`、`models` 键集合参与校验。
- 用户在手机上也能**手动指定**模型：任务带 `pin: {harness, model}` 时跳过分诊，只做校验。

## 3b. 受限类别 `categories`（2026-09-21）

有些任务只有少数模型肯做（安全类：CTF、pwn、逆向、exploit、漏洞研究，其余模型直接拒绝）。`targets.yaml` 的 `categories` 段给每类一个 `allow` 名单：

- 路由器提示词里列出类别、描述和名单，Decision 多一个 `category` 字段，要求主选和所有 fallback 只从名单里挑。
- 代码底线：`categoryOf()` 用 `keywords` 做关键词检测（ASCII 整词、中文子串），`validateDecision` 对不在名单里的候选一律拒绝，包括 fallback 和失败后的重派；路由器自报的 `category` 与关键词检测取并集。
- 默认策略：命中类别时按 `allow` 顺序取第一个额度够的目标，不走正则分类。
- `--pin` 是用户的决定，不拦，只在 notes 里警告。

首个类别 `security`：Opus 4.8 / 4.7 / 4.6（含 [1m]）加 deepseek-flash。

## 4. Decision schema 与校验

路由器输出：

```json
{
  "harness": "codex",
  "model": "gpt-6-astra",
  "effort": "high",
  "brief": "在 packages/daemon 下新增 router 模块……验收：vitest 通过。不要动 packages/secret-gate。",
  "needs_browser": false,
  "expected_size": "medium",
  "risk": "writes-files",
  "fallbacks": [{"harness": "claude-code", "model": "claude-opus-5"}, {"harness": "opencode", "model": "deepseek/deepseek-flash"}],
  "reason": "跨 6 个文件的新模块，需要跑测试；Codex 额度充足",
  "confidence": 0.8
}
```

`brief` 是这一步最有用的产物：执行者拿到的是路由器重写过的任务，带验收条件和禁区，而不是手机上的一句话。

校验（纯函数 `validateDecision(decision, targets, quota, running)`），按顺序：

1. `harness` 必须在目录里，`model` 必须在该 harness 的 `models` 键集合里（通配按前缀）且未标 `unavailable`；`model` 缺省用 `default_model`。不通过则换下一个 fallback，全不行用 `router.default`。
2. `needs_browser` 为真时 harness 的 `browser` 必须为 true。
3. 额度：`quota.remaining(harness) < 阈值` 视为不可用，进入 fallback 链。
4. 并发：`running[harness] >= max_concurrent` 时排队而不是换目标（换目标会让同一任务在不同模型间漂移，难以复现）。
5. `confidence < 0.5` 时不信路由器选的 (harness, model)，只保留它的 `brief`，目标按默认策略表取。
6. 任务自带 `pin` 时跳过 1 之前的一切，只跑 1–4。

默认策略表（路由器失效时，按任务里有没有代码/文件/浏览器意图的粗规则）：

| capability | 目标 |
|---|---|
| code | 额度剩余最多的 harness 的 `default_model`（claude-code / codex 二选一） |
| chat / summarize | opencode / deepseek-flash |
| browser | claude-code / claude-sonnet-4-6（2026-09-24 起；原为 sonnet-5，已排除）；Claude 无额度时取其他带浏览器 harness 里**最便宜**的模型（2026-09-21：原实现按额度最多的 harness 取默认模型，一次低置信兜底落到了 gpt-6-astra，已改） |

## 5. 路由提示词的原则（写进 `router` agent 的 prompt）

- 改代码且跨多文件、要跑测试 → Claude Opus/Fable 或 Codex Astra，按额度；整仓库级上下文才选 `[1m]` 档；小改动 → Sonnet / Haiku / gpt-5.5 低 effort；一句话问答、总结、翻译、超长材料 → 自己（deepseek-flash）。每个 harness 的全部模型都可选，按 `cost` 和 `strengths` 权衡。
- **优先模型（2026-09-24 用户决定）**：目录里标 `preferred: true` 的是用户最信得过的（Opus 5.5 / 5 与 GPT-6 astra / sol / luna，含 `[1m]` 档），目录文本里带 “preferred”。正经活——改代码、多步任务、会改东西的浏览器任务、用户要据此决定的调研——交给它们，规划模型也从它们里挑；便宜模型只做简短问答、摘要、翻译、小改动。取代原来的“选够用的最便宜的”。兜底规划模型改为 claude-opus-5-5。浏览器默认目标仍是 claude-sonnet-4-6（Claude 无额度时同档里按目录顺序，GPT-6 luna 排在前面）。
- 浏览器任务 → 标 `needs_browser`，交给 claude-sonnet；凭据一律以 `enc:v1:` 密文形式转交，简报里禁止要求执行者"找密码"。
- 简报必须包含：目标、验收条件、禁止触碰的路径、预计规模。不复述用户没说的需求。
- 不确定时降低 `confidence`，不要编造能力。
- 输出只有 JSON。

这些原则本身要进路由测试集（§8）验证，改一次提示词跑一次集。

## 6. 派发、失败与重派

### 6.1 派发与回流
- 三个执行器接法沿用 design §3.4：claude-code 走 Agent SDK 的 `canUseTool` 做审批；codex 走 app-server 的 `mcpServer/elicitation/request` 和 `execCommandApproval`；opencode 走 serve 的 permission 事件。
- 派发参数：`{ brief, cwd, model, effort, secret_gate: {proxy, mcp, browser}, timeout, approval_policy }`。secret-gate 配置按 harness 从 `packages/secret-gate/config/*` 生成，同 demo 脚本。
- 回流事件统一成 design §3.4 的 `Event`；`done` 时记录 tokens、耗时、审批次数、是否被 403。

### 6.2 执行失败的分类（代码做，不问模型）

> 2026-09-23 修订：拒绝使用独立恢复流程，替代旧的“拒绝后换模型”规则。
> 目标是修复信息缺失造成的误拒绝；不得编造授权、隐藏任务目的或轮换模型追逐被拒绝的结果。

#### 拒绝诊断与一次澄清

> 2026-09-23 交互修订：全局沟通说明用于保护企业内部管理工作的商业机密，只讨论当前操作必要的事实、范围和结果，不要求披露无关业务背景；不将该说明解释为所有目标均属内部系统或已经获得授权。路由器、规划器、监督者与执行器默认用简体中文面向用户沟通，标识符与凭据原样保留。路由器产生英文问题时，仅翻译问题本身再展示，不增加事实或重新判断授权。
>
> 首次路由和澄清后的路由均尊重 `give_up`：记录原因为终止结果，不派发其简报，也不选择默认模型。回答按钮使用按问题 ID 保存的提交状态，立即显示“提交中…”，等待期间防重、保留输入；失败显示可操作反馈，成功与后续界面刷新失败分别处理。

- 执行器保留结构化拒绝信号；即使进程正常完成，也检查最终回复是否为直接拒绝。引用、日志和代码中的拒绝文本不算执行者拒绝。
- 拒绝在普通验收前处理，不能被验收的第二次放行规则记为完成。gate 拒绝不自动重试。
- **监督调用（验收/审批/答题/看护）格式重试一次（2026-09-28）**：监督者（`routerSupervisor.ask`）和调度循环（`router/ask.ts`）一样，首答不是合规 JSON 时，在同一截止时间内带上「上一次格式无效」再问一次；两次都不行才算格式失败。超时或取消不重试。此前只调用一次，模型偶发回一句闲话就把已完成的任务判成 `not accepted`（用户手机上遇到：Codex 已抓到网页内容，却因验收模型格式无效被标 `partial`）。注意：重试只降低发生率；两次都失败、验收确实无法完成时，仍按“无法验证即不算完成”记为 `partial`（§6，安全取向不变）。
- **服务商安全分类器拦截（2026-09-24 用户拍板修订）**：`refusal.source = provider`（如 Claude 的 `[cyber]` 实时防护）不是模型在拒绝，而是分类器对请求的判断，误拦时同一请求重发多半能过（实测：把被拦的那次执行请求原样发给 7 个 Claude 模型、Sonnet 5 共 4 次，11 次无一被拦，`packages/daemon/scripts/guardrail_probe.ts`）。所以代码（不是模型）原样重发**一次**：同一模型、同一 effort、同一简报，不改写、不换模型、不经诊断调用；被拦的会话作废（线程 `session` 事件带 `dropped`，它续接过的旧会话也一起作废，因为被拦的那一轮已经写进去了），重发和之后同 harness 的任务都开新会话。已有副作用（工具、文件、审批计数非零）不重发；重发再被拦即停止，事件 `refusal {reason: "provider_safety"}` 记录重发与停止。这一次重发与澄清重试共用每任务一次的额度。
- **验收不通过交还原执行器改正（2026-09-24）**：监督者验收判定结果不合格（`rejected` 且标 `acceptance`，不含看门狗掐断的执行）时，不再按“有副作用就停、请用户核对现场”处理，而是交还同一执行器、续接它自己的会话，交接说明写明验收意见，要求先只读核对实际情况再改正、已生效的操作不重复。只改一次；第二次不合格照旧以 `partial` 结束并写明原因。用户的例子：列目录的任务“正文说 17 个、表格 15 个”，跑过 `ls` 被算作副作用而停下——核对本来就该执行器自己做。
- **手机任务的工作目录不是用户的地方（2026-09-25）**：手机任务跑在 AgentSwitch 数据目录下的空临时目录（`…/AgentSwitch/work/<id>`）。路由器曾把「Mac 的长期项目工作目录在哪」理解成 AgentSwitch 自己的目录，简报让执行器去翻数据目录和别的任务的目录（全被拒）。提示词写明：这个目录说明不了用户的文件在哪；AgentSwitch 数据目录对所有执行器禁入，简报里不许指向它；关于用户的 Mac、项目、文件的问题，上下文里有写就用（例如项目文件夹），否则去用户自己的目录找（主目录、桌面、文稿、项目和代码目录）。
- 之前任务被服务商拦过或被拒绝，不决定新任务：路由器和规划模型的提示词写明，新任务是用户自己的请求，线程里的拦截记录不是停止、拒绝或换执行者的理由，只按合适程度选目标；没发生在本任务上的拦截不得说成发生了（2026-09-24：用户重发后，规划模型看到同线程的旧拦截记录，没派发就收尾，还声称“本次调度也被拦截”）。
- 普通文本拒绝交给路由器专用诊断调用；只允许 `stop`、`ask_user`、`clarify`。原因分为上下文缺失、密文用途误解、明确政策限制或未知。解析失败、未知和政策限制停止，不走默认模型兜底。
- 背景只能逐字引用当前用户任务、同一父链的用户消息、用户维护的 CONTEXT.md，以及本任务用户实际回答；每条引用保存来源 ID、来源内容哈希和原文。执行器输出、自动摘要和路由器推断不能成为授权证据。引用仅证明用户说过什么，不证明客观授权。
- daemon 校验引用确实存在，再构造“原简报 + 完整拒绝原因 + 带来源的原文补充 + 原用户任务”，不接受诊断模型自由编写的新任务。至少有一条补充不在旧简报中；原任务目标、目录、模型、审批和 gate 策略不变。诊断输入超过长度上限时停止，不截掉后半段限制。
- 每个任务最多一次用户澄清问题、一次同目标澄清重试；保持已有执行器会话和拒绝记录。新回答必须完整引用并携带对应问题，不能只选有利的一句。澄清重试失败（包括额度、网络或验收失败）即停止。被拒绝的那次执行有文件修改、命令执行、已批准操作或缺少副作用记录时不自动重试，以免重复操作。
- 使用现有 `waiting_approval` 表示等待回答、`failed` 表示拒绝终止；新增 `refusal` 事件记录诊断、事实来源、是否重试及停止原因，无需数据库状态迁移。API 的普通问题回答与拒绝澄清回答均在入库前经过既有 sealer，失败保留问题待答且不存部分答案；执行器可识别回答中新提供的密文。原回答上限 4000 字，密文化后内部上限 64 KiB。

每次执行结束，daemon 把结果归一成 `ExecutionOutcome {exitCode, httpStatus, stderr, lastText, sideEffects, events}`，用模式表判成一种 `FailureKind`：

| kind | 信号（按 harness 各自映射） | 含义 |
|---|---|---|
| `refusal` | 最终回复的直接拒绝；Claude SDK 的 refusal stop reason / no-fallback 信号；Codex 的结构化 cyberPolicy 信号 | 先诊断来源与原因，不自动换模型；结构化安全拦截直接停止 |
| `quota` | HTTP 429 / 402；"rate limit / insufficient balance / quota exceeded / usage limit"；Codex `rateLimits` 归零；DeepSeek `/user/balance` 为 0 | 这个 harness 暂时不能用 |
| `transport` | 代理连不上、ECONNREFUSED / ETIMEDOUT、TLS 错、harness 进程崩溃或超时无输出 | 环境问题，与任务无关 |
| `gate_denied` | secret-gate 返回 403 `X-Secret-Gate: denied` | **安全信号，不重派**，推手机 |
| `task_failed` | 执行者正常结束但自己报告失败（测试没过、找不到文件） | 任务本身的问题，交给用户或路由器判断 |
| `unknown` | 其他 | 按 task_failed 处理 |

### 6.3 重派策略（`nextStep`，纯函数）

输入：原 Decision、尝试历史 `[{harness, model, kind, excerpt, sideEffects}]`、当前额度/不可用表。输出四种之一：

| kind | 有副作用？ | 动作 |
|---|---|---|
| `transport` | 无 | 同一目标退避后重试一次；再失败**问路由器**：环境可能对所有 harness 都坏了，由它判断换一条不共享故障点的路，或请求修复工具（§6.6），或放弃并告诉用户查什么。路由器问完额度用尽时才退回沿链换 |
| `transport` | 有 | 直接问路由器（不重试，避免重复副作用） |
| `quota` | 任意 | 该 harness 额度记 0，沿原 Decision 的 fallback 链取下一个能过校验的目标（代码就能决定，不问路由器） |
| `refusal` | 无且遥测完整 | TaskLoop 走 §6.2 专用诊断；纯函数 `nextStep` 返回停止，防止 CLI 等调用者绕回普通换模型 |
| `refusal` | 有或遥测缺失 | 停止，保留已做进度给用户 |
| `task_failed` / `unknown` | 无 | 问路由器一次 |
| `task_failed` / `unknown` | 有 | 停止，推手机；用户可从手机"换个模型继续" |
| `gate_denied` | — | 停止，推手机，记 security 事件 |

上限：每个任务最多 3 次尝试、最多 2 次问路由器；超过即停止并推手机。fallback 链走完也停止。

### 6.4 副作用与交接

- 任务在 git worktree 里跑（design 附录 B.5），所以"做了多少"有据可查：`sideEffects = {filesChanged, commandsRun, approvalsGranted}` 从执行器事件累加。
- 重派时下一位执行者拿到的不是原简报，而是 **交接简报**：原简报 + 上一位做到哪（diff 摘要、最后几条输出）+ 失败原因 + "从这里继续，不要重做已完成的部分"。
- 有 `approvalsGranted` 的尝试（用户批过危险动作）失败后，一律停止推手机，不自动接力。

### 6.5 路由器的再决策

普通失败的再决策仍然是同一个 `router` agent，多一段消息；拒绝使用 §6.2 的专用诊断协议：

```
Previous attempts:
1. claude-code/claude-sonnet-5 -> task_failed: "The login form was not found" (no side effects)
Excluded: claude-code/claude-sonnet-5
Worktree diff: (none)
Decide again from the observed failure. Preserve the original task and known constraints;
do not invent ownership, authorization, or credentials.
```

Decision 多三个可选字段：`action: "redispatch" | "repair" | "give_up"`（默认 redispatch），`repair: {tool, args}`（仅 repair），`handoff_note`（写给下一位的交接说明）。`give_up` 时 daemon 停止并把 `reason` 推给用户。校验规则不变，被排除的目标在校验里视为 unavailable。

普通失败的路由器调用失败（DeepSeek 挂了）→ 和首次分诊一样落到默认表，且默认表也排除已失败的 harness。拒绝诊断调用失败直接停止，不使用此兜底。

### 6.6 修复工具（接口已留，工具未做）

再决策时提示词里列出 daemon 注册的修复工具（名字 + 一句描述）；路由器可回 `action="repair"` 指定工具和参数，daemon 执行后**再问一次路由器**（带上修复结果），修复计入 router asks。未注册的工具名视为普通 redispatch。计划中的工具，都是代码实现、幂等、有超时：

| 工具 | 做什么 |
|---|---|
| `check_gate_proxy` | 探测 127.0.0.1:8080 是否在听、CA 是否可用，返回诊断文本 |
| `restart_gate_proxy` | 重启 secret-gate proxy（launchd 之后是 `launchctl kickstart`） |
| `check_upstream` | 对 api.anthropic.com / chatgpt.com / api.deepseek.com 各发一次 HEAD，返回可达性和延迟 |
| `set_harness_proxy` | 给某个 harness 的启动环境切换代理（例如绕开坏掉的上游代理），仅限白名单值 |
| `refresh_quota` | 重新拉三家额度 |

不给路由器的：改 secret-gate 配置、改 targets.yaml、任何写文件系统的操作。修复工具是"按按钮"，不是 shell。

## 7. 可观测与自我改进

`routing_log`（SQLite）每条：任务哈希、cwd、路由器输入摘要、Decision、校验结果（通过/改写/拒绝及原因）、最终目标、执行结果、用户事后打分（手机上一个 👍/👎）。

用途：
- 手机"额度面板"旁边加"路由面板"：最近 50 条去了哪、为什么。
- 每周把 👎 的条目脱敏后回填到路由测试集（design §5.3 的 `source: replay`）。
- 评估脚本对比"路由器决策"与"默认策略表"在同一批任务上的用户打分，决定路由器是否值得继续开着。

## 8. 测试

| 层 | 内容 | 调云模型？ |
|---|---|---|
| 纯函数 | `validateDecision`、降级链、默认策略表 | 否 |
| 契约 | `echo` 路由器（返回固定 Decision）跑通 ②③④⑤，含超时、非法 JSON、低置信三种失效 | 否 |
| 路由评估集 | design §5.3 的样本改为 `expect.{harness, model}`（不再有 sensitivity 维度；model 只在明显该选高/低档时才断言），起步 100 条：code 40 / chat 30 / browser 30；真 DeepSeek 跑，出准确率和混淆矩阵 | 是，放 `scripts/` |
| 执行器契约 | 沿用 secret-gate 的三份 e2e（claude_code / opencode / codex_appserver）作为派发模板 | 是 |
| 端到端 | 一条 code 任务从 API 进，经真路由器到 echo 执行器出 | 是（仅路由器） |

## 9. v1 实现状态（2026-09-20）

`packages/daemon`（TypeScript，vitest 31 例，覆盖率 90%）：`targets.yaml`、Decision schema、`validateDecision` / `validatePin`、默认策略、`opencode run --agent router` 真路由、routing_log（node:sqlite）、CLI `npm run route`、评估脚本 `npm run eval` + 12 条起步样本。没做：HTTP、执行器、额度采集（quota 目前传空表）、手机打分。

首次真跑（本仓库为 cwd）：DeepSeek 读了 log.ts、vitest 配置和文档后给出 claude-sonnet-5 + 一份含验收条件和禁区的简报，19 s。评估 4 条：3 命中；未命中的是"翻译 README 里的表格"，路由器置信度 0.45 触发默认表，而默认表的正则把 "Testing" 识别成代码任务派给了 claude-code。两个待改：默认表的关键词太粗；路由器对"改文档"类任务信心偏低，提示词里补一条。

失败重派（§6.2–6.5）同日实现：`failure.ts`（分类模式表）、`reroute.ts`（`nextStep` 纯函数）、`route.ts` 的 `reroute()`、CLI `reroute` 子命令；52 例测试，覆盖率 92%。真跑一次：模拟 claude-sonnet-5 拒绝登录任务，DeepSeek 改派 codex/gpt-5.6-luna，交接说明正确解释了 enc:v1: 占位符和"用户自己的账号"，16 s。

## 10. 待拍板

1. OpenRouter 要不要作为目标？
2. 用户打分（👍/👎）要不要做进 M1？不做的话路由测试集只能靠手写。
3. ~~模型 ID 核实~~ 三家都已核实写入。

## 11. 执行中的凭据修复（2026-09-23）

TOTP 种子录入与生成验证码是不同操作。sealer 必须根据用户原始任务识别用途：网页录入种子签发 `kind=secret, uses=[http]`，仅限用户指定的目标；生成验证码继续使用 `kind=totp, uses=[otp]`。既有 `kind=totp` 的 HTTP 解析仍输出验证码，不能简单加 http 权限来录入种子。

为三种执行器提供 `secret_repair(token, host, purpose=totp_seed_import)` MCP 工具，建立执行者到路由器的受控反馈路径。每次执行拥有独立的 loopback 端点和随机访问凭证，结束即关闭；请求必须引用当前任务已有的密文。daemon 先通过 gate 取得无明文的元数据，要求目标仍属于原密文的 hosts 及密文中独立的 `seed_import_hosts` 预授权，再让文本路由器核对用户任务或用户维护的上下文是否明确授权将种子录入该目标；决策必须引用原文，不接受执行者自己声称已授权。缺证据、不同目标、非 TOTP、取消、超时均拒绝修复并保留原拒绝，不改 gate 的全局策略。

通过核对后仅由本地 gate 内部打开旧密文并重签为该目标的普通 secret/http 密文，明文不进入 daemon、模型、日志或持久记录。新密文返回原模型会话，加入本次执行的 knownTokens，并持久记录凭据修复事件供后续派发使用；相同请求去重，有限次数，已完成的业务步骤不重跑。该工具为用途错误的特定修复能力，不开放任意 host/用途修改，也不把 provider safeguard 当作凭据问题。

`seed_import_hosts` 只在输入阶段根据用户原文明示的种子导入目标签入密文，严格限制到已有 hosts 内的精确目标，禁止通配符；gate 重签时独立验证，不能通过直接调用 CLI 绕过。旧密文没有该预授权时不自动升级：用户需在新消息中明确导入目标并重新提供该字段，由 sealer 正确签发。

新输入优先在 sealer 阶段正确区分用途；运行时修复服务处理已持有密文的已授权种子录入场景。所有测试使用假凭据、假路由器与本地模拟执行器，不调用真实模型或重放用户业务任务。


## 输入稳定性与消息接收反馈（2026-09-23）

- 后台状态和额度更新只更新 DOM 差异，保留正在编辑的控件、焦点、选区和输入法组合；同一输入区不能因轮询重建。切换任务/页面按身份隔离草稿；输入法组合期间不触发快捷发送。额度仅在可见首页每两分钟自动更新，保留手动刷新，其他任务状态维持正常刷新。
- POST /tasks 的接收等待包含入口敏感字段识别与加密，完成后才允许入库并进入分诊。默认 JSON API 保持兼容；浏览器可用 Accept: application/x-ndjson 获取接收阶段、耗时及最终任务回执。流中不得包含原始消息、凭据、模型回复或环境内容。
- 流式回执分 progress（stage=sealing/creating、elapsedMs）、accepted（task、elapsedMs）及 error（status、error）。失联且未收到 accepted 时视为结果待确认，禁止自动重发；accepted 后不能因后续网络错误误报发送失败。
- sealer 的模型视图可缩短环境与父任务中已有 enc:v1 密文，但必须保留目标站点、字段和原文授权说明，授权校验仍针对原始材料；自由文本消息仍走识别，不以正则猜测“没有敏感信息”跳过。
