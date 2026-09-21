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
④ 派发（§3.4 执行器）      claude-code ─┬─ fable-5-1 / opus-5 / opus-4-8 / 4-7 / 4-6 / sonnet-5 / sonnet-4-6 / haiku-4-5（含 [1m] 档）
                           codex ───────┼─ gpt-6-astra / gpt-5.6-sol / terra / luna / gpt-5.5（× effort 档）
                           opencode ────┴─ deepseek-flash（DeepSeek V4.1 Flash，自己）
   │
   ▼
⑤ 回流：事件流 → 任务表 → 手机；决策 + 结果写 routing_log（§7）
```

粗体原则：**②可以整段失效，系统照样能用**。路由器是优化器，不是依赖。

## 2. 分诊台怎么跑

- **在哪跑**：OpenCode `serve`（常驻，v2 HTTP API），daemon 用 `session.create` + `session.prompt` 调；每次分诊一个新 session，不复用上下文。standalone `run` 每次起服务要 2–3 s，只做后备。
- **用什么 agent**：`opencode.json` 里定义 `router` agent，`mode: primary`，model `deepseek/deepseek-flash`，工具只留 `read` / `glob` / `grep` / `list`，`bash` / `edit` / `write` / `webfetch` / `websearch` 全部 deny，无 MCP。它能看仓库，不能改、不能出网、不能拿凭据。
- **看仓库的范围**：只允许读 cwd 之内；`~/.secret-gate`、`.env`、`*.pem`、`*.key` 在 OpenCode permission 里 deny（防误操作，不是隐私边界）。
- **为什么放在 OpenCode 而不是直接调 DeepSeek API**：三点。它需要看仓库，OpenCode 已有受控的只读工具；DeepSeek 作为执行者本来就在 OpenCode 里，provider、限流、账单一处管理；将来换路由模型（比如以后想换成别家或本地模型）只改 agent 的 `model` 字段。
- **输出约束**：系统提示要求只输出一个 JSON 对象；daemon 用 zod 校验，失败重试一次（附上校验错误），再失败走默认策略。不依赖 provider 的 JSON mode。
- **成本**：Flash 一次分诊约 3–8k 输入 token（目录 + 摘要），可忽略；目录部分放提示词开头以命中缓存。

## 2b. 用户环境上下文 `~/.agentswitch/CONTEXT.md`

路由器的"CLAUDE.md"：用户手写的 markdown，每次分诊原样进路由器的 system prompt。内容三类：

- **站点与账号**：URL、账号、密码/2FA/Token 的 **secret-gate 密文**、备注（表单类型、登录后标题）。
- **环境**：代理地址、内网可达条件、该用哪个二进制。
- **偏好**：某目录优先哪个 harness、某类任务别用贵模型。

路由器的义务写在提示词里：任务提到列出的站点/账号时，把 URL、账号、密文**原样**抄进简报；不得编造凭据；缺凭据时在简报里说明并降低置信度，不能让执行者"去找密码"。

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
    default_model: claude-sonnet-5
    models:                         # `[1m]` 后缀 = Claude Code 的 1M 上下文变体，同一模型另一档
      claude-fable-5-1:       {cost: top,  strengths: [hardest, longest-agentic, architecture]}
      claude-fable-5-1[1m]:   {cost: top,  strengths: [hardest, whole-repo-context]}
      claude-opus-5:          {cost: high, strengths: [complex-code, refactor, review]}
      claude-opus-5[1m]:      {cost: high, strengths: [complex-code, whole-repo-context]}
      claude-opus-4-8:        {cost: high, strengths: [complex-code, refactor]}
      claude-opus-4-8[1m]:    {cost: high, strengths: [complex-code, whole-repo-context]}
      claude-opus-4-7:        {cost: high, strengths: [complex-code]}
      claude-opus-4-7[1m]:    {cost: high, strengths: [complex-code, whole-repo-context]}
      claude-opus-4-6:        {cost: high, strengths: [complex-code]}
      claude-opus-4-6[1m]:    {cost: high, strengths: [complex-code, whole-repo-context]}
      claude-sonnet-5:        {cost: mid,  strengths: [code, browser, general]}
      claude-sonnet-5[1m]:    {cost: mid,  strengths: [code, whole-repo-context]}
      claude-sonnet-4-6:      {cost: mid,  strengths: [code, general]}
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
- **发现与刷新**：daemon 启动时用 Codex app-server 的 `model/list` 拉真实列表，和 yaml 求交集；yaml 里有、后端没有的模型标为 `unavailable` 并在路由面板显示，不会派过去。OpenCode 2.0.8 的 `opencode models` 和 `/api/model` 在本机都返回空，所以 OpenCode 这边用 `opencode auth list`（哪些 provider 有凭据）× models.dev 目录（`https://models.dev/api.json`，OpenCode 自己也用它）求可用集。Claude Code 没有列表接口，以 yaml 为准，派发失败（未知模型）时标 unavailable。
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
| browser | claude-code / claude-sonnet-5；Claude 无额度时取其他带浏览器 harness 里**最便宜**的模型（2026-09-21：原实现按额度最多的 harness 取默认模型，一次低置信兜底落到了 gpt-6-astra，已改） |

## 5. 路由提示词的原则（写进 `router` agent 的 prompt）

- 改代码且跨多文件、要跑测试 → Claude Opus/Fable 或 Codex Astra，按额度；整仓库级上下文才选 `[1m]` 档；小改动 → Sonnet / Haiku / gpt-5.5 低 effort；一句话问答、总结、翻译、超长材料 → 自己（deepseek-flash）。每个 harness 的全部模型都可选，按 `cost` 和 `strengths` 权衡，不要总挑最贵的。
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

每次执行结束，daemon 把结果归一成 `ExecutionOutcome {exitCode, httpStatus, stderr, lastText, sideEffects, events}`，用模式表判成一种 `FailureKind`：

| kind | 信号（按 harness 各自映射） | 含义 |
|---|---|---|
| `refusal` | 模型文本 "I can't help / 无法协助 / against policy / safety"；Claude SDK 的 refusal stop reason；Codex 的 policy 拒绝 | 被围栏拦下，换模型大概率能过 |
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
| `refusal` | 任意 | **问路由器**：只带拒绝原文、已尝试的目标（排除）、工作树 diff 摘要，不额外指导；换模型、改简报还是 `give_up` 由它定 |
| `task_failed` / `unknown` | 无 | 问路由器一次 |
| `task_failed` / `unknown` | 有 | 停止，推手机；用户可从手机"换个模型继续" |
| `gate_denied` | — | 停止，推手机，记 security 事件 |

上限：每个任务最多 3 次尝试、最多 2 次问路由器；超过即停止并推手机。fallback 链走完也停止。

### 6.4 副作用与交接

- 任务在 git worktree 里跑（design 附录 B.5），所以"做了多少"有据可查：`sideEffects = {filesChanged, commandsRun, approvalsGranted}` 从执行器事件累加。
- 重派时下一位执行者拿到的不是原简报，而是 **交接简报**：原简报 + 上一位做到哪（diff 摘要、最后几条输出）+ 失败原因 + "从这里继续，不要重做已完成的部分"。
- 有 `approvalsGranted` 的尝试（用户批过危险动作）失败后，一律停止推手机，不自动接力。

### 6.5 路由器的再决策

再决策仍然是同一个 `router` agent，多一段消息：

```
Previous attempts:
1. claude-code/claude-sonnet-5 -> refusal: "I can't help with automating logins to..." (no side effects)
Excluded: claude-code/claude-sonnet-5
Worktree diff: (none)
Decide again: pick a different harness or model, and rewrite the brief so the executor understands
this is the user's own account and credentials are enc:v1: placeholders.
```

Decision 多三个可选字段：`action: "redispatch" | "repair" | "give_up"`（默认 redispatch），`repair: {tool, args}`（仅 repair），`handoff_note`（写给下一位的交接说明）。`give_up` 时 daemon 停止并把 `reason` 推给用户。校验规则不变，被排除的目标在校验里视为 unavailable。

路由器自己失败（DeepSeek 挂了）→ 和首次分诊一样落到默认表，且默认表也排除已失败的 harness。

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
