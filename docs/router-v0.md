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
| browser | claude-code / claude-sonnet-5 |

## 5. 路由提示词的原则（写进 `router` agent 的 prompt）

- 改代码且跨多文件、要跑测试 → Claude Opus/Fable 或 Codex Astra，按额度；整仓库级上下文才选 `[1m]` 档；小改动 → Sonnet / Haiku / gpt-5.5 低 effort；一句话问答、总结、翻译、超长材料 → 自己（deepseek-flash）。每个 harness 的全部模型都可选，按 `cost` 和 `strengths` 权衡，不要总挑最贵的。
- 浏览器任务 → 标 `needs_browser`，交给 claude-sonnet；凭据一律以 `enc:v1:` 密文形式转交，简报里禁止要求执行者"找密码"。
- 简报必须包含：目标、验收条件、禁止触碰的路径、预计规模。不复述用户没说的需求。
- 不确定时降低 `confidence`，不要编造能力。
- 输出只有 JSON。

这些原则本身要进路由测试集（§8）验证，改一次提示词跑一次集。

## 6. 派发与回流

- 三个执行器接法沿用 design §3.4：claude-code 走 Agent SDK 的 `canUseTool` 做审批；codex 走 app-server 的 `mcpServer/elicitation/request` 和 `execCommandApproval`；opencode 走 serve 的 permission 事件。
- 派发参数：`{ brief, cwd, model, secret_gate: {proxy, mcp, browser}, timeout, approval_policy }`。secret-gate 配置按 harness 从 `packages/secret-gate/config/*` 生成，同 demo 脚本。
- 回流事件统一成 design §3.4 的 `Event`；`done` 时记录 tokens、耗时、审批次数、是否被 403。
- **v1 不做二次分诊**：执行失败就是失败，推手机。v2 再考虑"路由器看结果决定换目标重跑"，且必须经用户批准，因为重跑会重复副作用。

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

## 10. 待拍板

1. OpenRouter 要不要作为目标？
2. 用户打分（👍/👎）要不要做进 M1？不做的话路由测试集只能靠手写。
3. ~~模型 ID 核实~~ 三家都已核实写入。
