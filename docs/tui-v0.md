# tui-v0：`agentswitch config`——Linux 节点的设置界面，从这里开始多语言

2026-10-15 用户（catop）：梳理一下目前 mac 支持但 linux 不支持的配置项，以及前面设置 llm api 那一part，我打算规划一下实现 TUI 的项目配置。从 TUI 开始支持多语言，先 i18n 支持3-5 种 常见语言。

同日，对梳理稿的回答：名字你定即可，方便理解和上手；Ink 框架；（语言）保持你推荐的；（Clash 与 agent CLI 的安装）先不做进去。看过初稿后：命名用 agentswitch config 应该更好吧，settings 还有复数非复数的形式，不好记；报错信息是外文这一点，不用管；开始实施吧。

**本文是草案，§2 的三步都已做（§7）。** 标“已定”的是用户定的，其余是提议。相关：`docs/mesh-v0.md` §4（Linux 节点以命令行为界面）、`docs/profiles-v0.md` §3.6（API key 配置）、`docs/ui-v0.md` §7（文案规范）。

## 0. 要点

- **命令叫 `agentswitch config`**（已定；初稿写的是 `settings`，用户：settings 有单复数两种写法，不好记）。全屏，左边是页面列表、右边是这一页，排法照 Mac 设置窗口的侧栏。
- **用 Ink 写**（已定）：React 式的声明写法，和 Mac 的 SwiftUI 是一个思路；中日韩字符的双宽对齐它自己处理。
- **它只是服务的一个界面**：绝大部分读写走本机 HTTP 接口（`src/client.ts`），和 Mac、网页控制台调的是同一批接口；只有 `node.json`（看护进程的）和网关密钥对（`secret-gate` 命令）在本机直接动。
- **各管各的**（mesh-v0 §2.3）：改设置只在节点自己身上；`--on <节点>` 打开的是另一个节点的只读视图。
- **从这里开始多语言**（已定）：English、简体中文、繁體中文、日本語、Español 五种，英文是源语言。先只覆盖这个界面；命令行其余部分、网页控制台、Mac 以后再说（§5.6）。
- **这一版不做**（已定）：Clash，以及 agent CLI 本身的安装、更新、钉版本。

## 1. Mac 有、Linux 没有的设置（2026-10-15 盘点）

### 1.1 服务已有接口，只是 Linux 没有命令

| Mac 上的位置 | 设置 | 接口 |
|---|---|---|
| Agents › 配置 | 代理与出口检查 | `PUT /profiles/:agent/:id/proxy`、`POST …/check` |
| Agents › 配置 | Session Key（Claude 订阅） | `PUT …/session-key` |
| Agents › 配置 | 遥测开关（§3.7） | `PUT …/telemetry` |
| Models | 调度模型、默认执行器与模型（重启后生效） | `GET/PUT /settings/models` |
| Permissions | 审批模式 `Bypass`（`skip`） | `PUT /approvals/policy`；命令行的 `policy` 现在不认 `skip` |
| General | 默认目录 | `GET/PUT /settings/workdir` |
| Nodes | `Paired Nodes May Type` | `GET/PUT /settings/mesh` |
| Context | CONTEXT.md、MEMORY.md，删除经验记录 | `PUT /context`、`GET/PUT /memory`、`/platform-memory` |
| Extensions | MCP 服务器的增删改与开关；技能的新建、导入、开关、删除 | `/mcp/:name`、`/skills/*` |
| Browser | 浏览器的指纹与身份 | `/browser/identity` |
| Clash | 订阅、自动更新、规则模板、DNS、测速 | `/clash/*`（这一版不做） |

### 1.2 Mac 自己做的，Linux 要另做

| Mac 上的位置 | 设置 | Linux 上 |
|---|---|---|
| General | 四个端口、`Allow iPhone` | 写 `node.json` 后给看护进程发 SIGHUP；现在只有 `node name` |
| Keys | 网关的密钥对：新建、设为当前、删除 | 直接调 `secret-gate`，和 Mac 的 `GateCLI` 一样 |
| Agents 顶部 | agent CLI 的安装、更新、钉版本、清理 | 这一版不做；用户自己装 |
| Environment | 准备清单、信任 CA、登录 shell 的 PATH | 大半已在 `agentswitch doctor` 里，这一页直接显示它 |

### 1.3 只属于 Mac 的

外观、字号、程序坞、菜单栏状态、提示音、工作时不睡眠、退出确认、登录时打开（Linux 上是 `service install`）、macOS 的权限、首次运行向导。不搬。

### 1.4 顺带查出的两处

- 命令行 `policy` 不认 `skip`，服务认。这个界面直接调接口，不受影响；命令行那边顺手补上。
- `PUT /context` 在远程白名单里：已配对的设备能改这台节点的 CONTEXT.md，而其他写操作都只限节点自己。**要你定**：是有意的，还是应当收回。

## 2. 页面

```
 AgentSwitch Config · dellarch                                    English
┌──────────────┬──────────────────────────────────────────────────────────┐
│ ▸ Agents     │ Claude Code                                              │
│   Models     │   Default    this machine's own sign-in                  │
│   Permissions│ ▸ cpub       API Key · prod01.us01.cpub.tech · claude-…  │
│   Node       │   Work       signed in as …            proxy → JP        │
│   Keys       │   [ New Profile ]                                        │
│   Environment│ Codex                                                    │
│ ── Dispatch  │   Default    …                                           │
│   Context    │                                                          │
│   Extensions │                                                          │
├──────────────┴──────────────────────────────────────────────────────────┤
│ ↑↓ Move  ⏎ Open  Tab Switch Pane  / Search  L Language  Q Quit           │
└─────────────────────────────────────────────────────────────────────────┘
```

（字符示意，不是演示页；ui-v0 §7 的“先对照演示页”针对图形界面，终端界面以本节示意为准，做出来后截一张放进 `docs/design/`。）

分三步：

1. **Agents、Models、Permissions、Node**：
   - Agents：配置的列表与新建、API key（§3）、代理与出口检查、Session Key、遥测、颜色、删除；
   - Models：调度模型、默认执行器与模型，保存时说明“重启服务后生效”，并给一个重启按钮（`node restart`）；
   - Permissions：四种模式（含 `Bypass`，选它要再确认一次）与逐类开关；
   - Node：名字、四个端口、远程开关、`Paired Nodes May Type`。
2. **Context、Extensions、默认目录**：长文本交给 `$EDITOR`（没有就 `vi`），存回时整份提交；MCP 和技能的列表、开关、增删改。
3. **Keys、Environment**：网关密钥对；`doctor` 的结果。

每一页都可以只读打开另一个节点（`--on`），能改的控件变灰并说明“在那台节点上改”。

## 3. API key 配置（profiles-v0 §3.6）

现状：Claude Code 与 Codex 能用 API key 建配置，OpenCode 与 pi 只有 Default。字段是名字、key、地址、模型、颜色、代理、遥测。key 由本机网关封成密文、只对地址所在的站点开；地址换到另一个站点要重给 key。模型在保存时对照地址自己列出的模型核对，只拒明显写错的（列表里某一个的另一种写法），别名和中转不列的照存（2026-10-31），`--force` 跳过。

界面在这之上加三样：

- **供应商预设**：新建时先选一家，地址自动填好，可改。预设是一张数据表（`src/profiles/vendors.ts`，按 agent 分），先放：
  - Claude Code：Anthropic（官方）、OpenRouter、DeepSeek、Moonshot、智谱、自定义；
  - Codex：OpenAI（官方）、OpenRouter、DeepSeek、自定义。

  每家的地址在实现时逐个核对官方文档再写进去。
- **模型选择**：现在地址列出的模型只在保存时用来核对，界面拿不到。新增一条只在本机可用的接口：
  `POST /profiles/models {agent, baseUrl?, key?, profile?}` → `{models: string[] | null}`。
  `key` 是刚封好的密文（新建时），或者给 `profile` 用它存着的 key（修改时）；服务向网关取明文、调 `listModels`、只回模型名。地址不列模型时回 `null`，界面退回手填。
- **测试连接**：同一条接口，能列出模型就算通；列不出时说明是 key 不对（401/403）、地址不对，还是这个地址不提供列表。

key 的输入框不回显，粘贴进来立即封成密文，明文不留在界面进程里。

## 4. 实现

- **入口**：`agentswitch config [页面] [--on <节点>] [--lang <语言>]`。不是终端（没有 TTY）时打印一句“需要在终端里运行”并以 2 退出。
- **位置**：`packages/daemon/src/tui/`，界面组件用 `.tsx`。分层上它和 `cli.ts` 同级：只能用 `client.ts`、`keeper/`（node.json、密钥对）、`profiles/store.ts` 的类型与 `i18n/`，不碰服务内部；`tests/layers.test.ts` 加上这一行。
- **依赖**：`ink`、`react`，以及需要时的 `ink-text-input`、`ink-select-input`。运行时会变大，`build-runtime.sh` 照常打包；打包后在 smoke 里加一条：`config` 在假终端里能画出第一屏。
- **测试**：用 `ink-testing-library` 渲染到字符串，配假的 `client`，不连真服务、不调模型。每页至少一条：打开、改一项、看到提交给 client 的请求。

## 5. 多语言

### 5.1 语言（已定）

English（`en`，源语言）、简体中文（`zh-Hans`）、繁體中文（`zh-Hant`）、日本語（`ja`）、Español（`es`）。

### 5.2 选哪种

`--lang` > `AGENTSWITCH_LANG` > `node.json` 的 `language` > `LC_ALL` / `LC_MESSAGES` / `LANG` > `en`。界面里按 `L` 换语言，同时写进 `node.json`，下次照用。看护进程给服务的环境默认是 `LANG=C.UTF-8`（keeper/plan.ts），落到 `en`，所以服务那边要用语言时读 `node.json`，不读环境。

`zh_CN`、`zh_SG` 归简体，`zh_TW`、`zh_HK`、`zh_MO` 归繁体，其余按语言的前两个字母；对不上的用 `en`。

### 5.3 文案表

- 每种语言一个文件：`src/i18n/en.ts`、`zh-Hans.ts`……。`en.ts` 的形状就是类型，其他语言 `satisfies` 它，少一条、多一条、参数对不上，类型检查都过不去。
- 带参数的写成函数：`deleted: (name: string) => \`Deleted ${name}\``。复数用 `Intl.PluralRules`，日期和数字用 `Intl` 按语言格式化。
- 调用处写 `t.profiles.deleted(name)`，不用字符串键，改名时编辑器能跟着改。

### 5.4 和 ui-v0 §7 的关系

现在的规范是“短词英文按苹果的标题式大写、整句正式中文”，这本来就是一种中英混排。提议：

- `zh-Hans` 就照这条规范写，和 Mac 上看到的一致（按钮 `Save`、`Delete…`，说明句是中文）；
- `zh-Hant` 是 `zh-Hans` 的繁体版本，短词同样保留英文；
- `en` 全英文；`ja`、`es` 全部译成本语言，包括短词。

**要你定**：中文两种要不要也把短词译成中文。（第一步先照上面的提议做了。）

### 5.5 服务返回的文字

界面上的很多话不是界面自己的，是服务回的：

- 错误：`{"error": "…"}` 里是一句现成的话，有的英文（`profiles are made on the Mac`），有的中文（模型核对的提示“这个地址没有模型 X，是不是 Y？……”）；
- 审批类别的标题（`approvalPolicy.ts`），也是服务写好的中文。

界面换了语言，这些话仍是原样，日语界面里会冒出一句中文。

**已定：不管**（用户：报错信息是外文这一点，不用管）。服务回的话原样显示；下面的提议不做，留作记录。

提议是：错误回复在原有的 `error` 之外加 `code` 和 `params`，例如

```json
{ "error": "这个地址没有模型 claude-opus-5.5，是不是 claude-opus-5-5？…",
  "code": "profile.unknown_model",
  "params": { "model": "claude-opus-5.5", "near": "claude-opus-5-5", "offered": ["…"] } }
```

- 界面认得 `code` 就用自己语言的文案和 `params` 拼一句；不认得就显示 `error` 原文。
- `error` 照旧保留，Mac、iPhone、网页、旧版命令行不用跟着改，什么时候想换成按 `code` 显示再换。
- 不一次改完：先改这个界面用到的接口（profiles、settings、approvals），别的接口用到时再加。
- 审批类别按 `id` 在界面这边翻译，服务给的标题作退路。

审批类别是界面自己按 `id` 翻的（不是报错），这一条照做了。

### 5.6 以后

- 命令行其余的输出、`doctor`：用同一套文案表，按需迁过去。
- 网页控制台（现在只有简体中文）：可以共用这套表（另出一份 JSON 给浏览器）。
- Mac 与 iPhone：用 Xcode 的 String Catalog（`.xcstrings`），语言列表与本文一致；由负责 Mac 的同事定什么时候做。

### 5.7 守着它的测试

- `tests/i18n.test.ts`：每种语言的每一条都能取到、都不是空串；带参数的用样例参数调一遍不抛错。
- `src/tui/` 下除文案表外不得出现中日文字符（类似 `layers.test.ts` 的扫描），防止有人把文案直接写进组件。

## 6. 要你定的

1. §1.4：`PUT /context` 是否收回到只限节点自己。
2. §5.4：中文两种的短词要不要译成中文。

## 7. 实现（2026-10-15，catop）

§2 的三步和多语言都做了，分支 `config-tui`（接在 `terminal-hold` 之后）。侧栏按 Mac 的顺序：Agents、Models、Permissions、Keys、Node、Environment，下面一个 Dispatch 小标题，Context、Extensions。

- **服务一侧**：
  - `POST /profiles/models {agent, baseUrl?, key?, profile?}`（`api/profiles.ts`，只在本机，远程 403；`remote/routes.ts` 不列）。
    - 回 `ModelProbe`：`{models}`，或说明为什么没有——`{refused: 401|403}`（key 不对）、`{unlisted: true}`（404 或回答里没有列表）、`{status}`、`{unreachable}`。
    - 由 `profiles/apiKeys.ts` 的 `probeModels` 去问，`listModels`（保存时核对用）改成在它上面取模型。
    - 配置自己存的 key 换了站点就不开，和 `set` 一样。
  - `client.ts`：补上代理、出口检查、session key、遥测、模型设置、默认目录、`/settings/mesh` 这几条调用，以及 `profileModels`；`setPolicy` 认 `skip`。旧服务对没有的接口回纯文本 `404 Not Found`，客户端现在说 `HTTP 404: …`，不再报 JSON 解析错。
  - `keeper/profiles.ts` 的 `sealWithGate` 多一个 `label`（`profile/proxy`、`profile/session-key`，和 Mac 的 `GateSealRequest` 一样）。
  - `node.json` 多一个 `language`。
  - `profiles/vendors.ts`：供应商预设。Claude Code：Anthropic、OpenRouter（`https://openrouter.ai/api`）、DeepSeek（`…/anthropic`）、Moonshot（`api.moonshot.cn/anthropic`）、智谱（`open.bigmodel.cn/api/anthropic`）；Codex：OpenAI、OpenRouter（`…/api/v1`）。Codex 的提供方用的是 Responses API（`wire_api = "responses"`），只有 Chat Completions 的地址（如 DeepSeek）不放进 Codex 的预设。**这些地址是按各家文档写的，还没有逐个用真 key 试过。**
- **多语言**（`src/i18n/`）：
  - `en.ts` 是源表，它的形状就是 `Messages`；`zh-Hans`、`zh-Hant` 以英文表为底、只换成句的话（§5.4 的提议），`ja`、`es` 全译。
  - `pickLocale`：`--lang` > `AGENTSWITCH_LANG` > `node.json` 的 `language` > `LC_ALL` / `LC_MESSAGES` / `LANG` 中第一个有值的 > `en`。第一个有值的若是我们没有的语言，就用 `en`，不往下找。
- **界面**（`src/tui/`，Ink 8 + React 19）：
  - `ui.tsx`：选一个、输入、确认三种问题都是 promise，问的时候占住右边那一栏；状态行说正在做什么、做成了什么，调用抛的错原样显示在那里；`Form` 是一列可移动、可按的行，标签列按最宽的标签自动定宽（中日文按两格算）。
  - 页面：Agents（列表、配置页、新建的分步问答）、Models、Permissions、Node（名字、`Allow Pairing`、`Hold Terminals`、语言、四个端口、`Paired Nodes May Type`、默认目录）。
  - `--on <节点>`：所有行变灰，Agents 不出 `New Profile…`，Node 只显示对方 `/node` 说的。
  - 按键：↑↓ 移动，⏎ / 空格 按下，Esc / ← 返回，Tab 在页面列表和页面之间切换，L 换语言，Q 退出；问题里 Ctrl+U 清空、粘贴整段进来。
  - 用的是终端的备用屏幕，退出后原来的内容回来。
- **第二步、第三步**：
  - Context：CONTEXT.md、MEMORY.md 交给用户自己的编辑器（`$VISUAL`、`$EDITOR`，都没有就 `vi`；`tui/editor.ts`，文件放在只有本用户能读的临时文件夹里，用完删掉；编辑时界面经 Ink 的 `suspendTerminal` 让出终端，回来重画）。没改就不发；CONTEXT.md 保存后说服务加密了几处凭据、哪些行没留下（服务的原话）。平台经验逐条列出，删除先确认。
  - Extensions：MCP 服务器与技能的列表。服务器页有开关、Claude Code 的审批（`Ask` / `Allow`）、分给哪几个 agent，其余（kind、command、args、env、url、headers、note）作为 JSON 在编辑器里改——Mac 的表单是逐项填，终端里整段编辑更直接；不是合法 JSON 就不发。技能页有开关、分给哪几个 agent、在编辑器里改 SKILL.md。新建先问名字（不能重名、不能用网关保留的名字）；`Import…` 列出各 agent 文件夹里找到、还没装的技能。
  - Keys：网关的密钥对（`keeper/gateKeys.ts`，调 `secret-gate keys --json …`，和 Mac 的 GateCLI 一样）：列表、公钥、设为当前、删除（确认框写明“用它加密的密文将无法再解密”）、新建（再问要不要设为当前）。`--on` 时不显示：密钥对是各节点自己的。
  - Environment：`agentswitch doctor` 的各行（`doctor` 多了一个 `print` 参数，界面收集它的输出），✓ ✗ ! 分别着色，`Check Again` 再查一遍。`--on` 时不显示。
- **分层**：`tests/layers.test.ts` 加了 `i18n`（叶子）和 `tui`（可用 `profiles`、`keeper`、`i18n`），扫描也包括 `.tsx`。`tui` 不 import `client.ts`，用自己的 `ConfigClient` 接口，由 `cli.ts` 传进来。
- **验证**：
  - `tests/configTui.test.tsx`（19 条，`ink-testing-library` 渲染成字符串，假的服务与网关）：列表与配置页；分步新建按 key 付费的配置（key 封成密文才离开、模型从地址的列表里选）；地址没列的模型先问再带 `force`；整段粘贴的代理（密码按 host:port 封）；换到另一个站点时要新 key；session key 按 claude.ai 封；删除先确认；调用失败显示在状态行；模型保存并重启；Bypass 要再确认；node.json 只写改了的、不认识的字段原样留着；换语言写进 node.json；另一个节点只读；CONTEXT.md 在编辑器里改、没改不发、说出加密与删掉的行；编辑器失败不发；用 JSON 加 MCP 服务器、坏 JSON 不发、开关；导入技能、给某个 agent 关掉；密钥对设为当前、删除要确认；doctor 的各行；日文全译、中文只译整句。
  - `tests/i18n.test.ts`：语言标签的识别与优先顺序；每种语言条目齐全、没有空串、带参数的都能调；日语与西语确实译了，两种中文的每个整句都译了；`src/tui/` 里注释以外不得出现中日文字符。
  - `tests/configText.test.ts`：代理、session key、端口的读法，供应商识别，旧服务的纯文本 404，编辑器（带参数的 `$EDITOR`、失败时报错、不留文件），网关密钥对的调用与它的拒绝原话。
  - `tests/profiles.test.ts`：`probeModels` 的五种回答；`POST /profiles/models` 用刚封的 key 和配置存的 key、换站点被拒、远程 403。
  - 实机：在 dellarch 的 tmux 里对正在运行的服务只读地看了四页的英文、简体中文、日文三种，中日文的标签列对齐正常。当时运行的服务还是旧版，`Test Connection` 得到 `HTTP 404`，部署后才有这条接口。
  - `packages/linux/scripts/smoke.sh` 加了一条：在 `script` 给的伪终端里跑 `agentswitch config`，要能画出第一屏、按 Q 退出。
  - 全部 1820+ 条单元测试通过。
- **还没做**：供应商地址的实测；部署后在 dellarch 上用真 key 试 `Test Connection`。命令行的 `policy` 也认 `skip` 了。
