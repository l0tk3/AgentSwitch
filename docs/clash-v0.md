# clash-v0：Clash Integration——为 Claude、OpenAI 单独配置代理，配置的代理直连

2026-10-08 用户：可以和clash进行interactive吗；也就是理论上我可以直接用agentswitch修改配置文件？；需要加一栏 clash-intergration……当前我的clash配置文件中有关于Claude和openai的配置，clash-intergration中要有 “为Claude单独配置代理” 和 “为openai单独配置代理“的功能；可以读取当前订阅文件的所有节点，然后”为Claude配置单独代理” 可以单独按照优先级拖进来几个节点，根据优先级fallback（可以选择自动fallback也可以手动选择节点） openai的同理；设置之后就和我现在的配置文件差不多；然后可以设置claude code profile中添加的代理直接直连（通过agent switch添加的规则必须可逆）然后以后也可以手动删除。

**草案，还没有代码。** 界面上的名字是 `Clash Integration`。

## 0. 要点

- 设置里新的一页 `Clash Integration`，三样：`Separate Proxy for Claude`、`Separate Proxy for OpenAI`、`Profile Proxies Go Direct`。
- **读**走 Clash 自己的控制接口；**写**只写 Clash Verge 为“扩展”准备的那几个文件里 AgentSwitch 自己的条目，带标记，一键撤掉后和没接入过一样。
- 写之前给你看要加什么、删什么，由你点 `Apply`；加载失败立刻还原。

## 1. 这台 Mac 上查到的（2026-10-08，只读）

- Clash Verge Rev，内核 mihomo v1.19.31，TUN 开着，混合端口 7897。
- 控制接口是一个只有本用户能访问的本机套接字（内核启动参数 `-ext-ctl-unix` 给出它的位置），不需要密码；TCP 的控制端口没开。读到了：分组与成员、每组当前选中的、规则、节点来源。
- 现有的做法（订阅文件里自己写的）：
  - 分组 `Claude`（手动选择）：成员先是 `Claude自动选择`（按顺序 fallback 的一组节点）、`Manual`，然后是各节点。`OpenAI` 同样，配 `OpenAI自动选择`。
  - 规则：`anthropic` 关键字、`claude.ai`、`claude.com`、`claudeusercontent.com` → `Claude`；`openai` 关键字、`chatgpt.com`、`chat.com`、`sora.com`、`oaistatic.com`、`oaiusercontent.com` → `OpenAI`。
  - 订阅的“规则扩展”里已有一条手加的 `IP-CIDR,…/32,DIRECT`——就是“某个代理服务器直连”这件事。
- Clash Verge 的配置由几块拼成，都在用户目录下、文件属于本用户：订阅本身；全局的 `Merge.yaml` / `Script.js`；**当前订阅自己的扩展**——`rules`、`proxies`、`groups` 各一个文件，结构都是 `prepend` / `append` / `delete` 三个列表。

## 2. 为 Claude / OpenAI 单独配置代理

- 页面列出当前订阅的全部节点（从控制接口读）。把节点拖进 `Claude` 那一栏，从上到下就是优先级。
- 两种用法，一个开关：
  - `Automatic`：按优先级 fallback——用排在最前、此刻可用的那个。
  - `Manual`：你点哪个用哪个。
- 落到 Clash 上和现在手写的一样：一个按顺序 fallback 的分组加一个手动选择的分组，外加那几条域名规则指向它。分组名带 `AgentSwitch` 前缀，不与你自己的 `Claude`、`OpenAI` 重名。
- 你已经手写了一套时：页面先认出来并说明（“订阅里已经有 `Claude` 分组和它的规则”），由你选：接着用自己的（AgentSwitch 只显示、只切换选中的节点，不写文件），还是换成 AgentSwitch 管的（它的规则排在前面，优先生效；你原来的不删）。
- 手动选节点、看延迟走控制接口，不改文件。

## 3. 配置的代理直连

- Claude Code 的某个配置填了自己的代理（profiles-v0 §4）时，开着 TUN 会让“去那个代理服务器”的连接先绕一遍 Clash 的节点。
- `Profile Proxies Go Direct` 打开后，AgentSwitch 为每个配置的代理地址加一条直连规则（地址是 IP 用 `IP-CIDR,…/32,DIRECT`，是域名用 `DOMAIN,…,DIRECT`），排在最前。
- 配置的代理改了、删了，对应的规则跟着改、跟着删。

## 4. 怎么写、怎么撤

- 只写**当前订阅的** `groups` 与 `rules` 两个扩展文件的 `prepend` 列表；不碰订阅本身，不碰 `Merge.yaml`、`Script.js`。
- AgentSwitch 加的每一条都认得出来：分组靠名字前缀；规则在 AgentSwitch 自己的清单里逐条记着（`$AGENTSWITCH_HOME/clash/applied.json`：加了哪几条、加在哪个文件、什么时候）。
- **撤**：`Remove All` 把清单里的条目从文件里逐条删掉，清单清空。你也可以在 Clash Verge 里手动删——下次打开页面，AgentSwitch 发现清单里的条目不在文件里了，就从清单里去掉，不再加回来。
- **写的步骤**：先备份要改的文件 → 写 → 让 Clash 重新加载 → 用控制接口确认新分组、新规则在 → 不在或加载出错就把备份放回去并再加载一次。
- 换了订阅：扩展文件是按订阅各一份的。页面说明“这些是加在哪个订阅上的”，换订阅后要重新 `Apply`。

## 5. 没查实的

1. 改了扩展文件后，怎样让 Clash Verge 重新生成并加载最终配置：控制接口能不能触发，还是要它自己的界面点一下。
2. Clash Verge 自己编辑扩展文件时会不会整文件重写（那样会连同 AgentSwitch 的条目一起保留还是丢掉）。
3. 别的 Clash 客户端（ClashX、Stash、Surge）各有各的文件结构：先只做 Clash Verge Rev，认不出来时这一页只显示说明。

## 6. 分步

1. 只读：认出 Clash Verge、连上控制接口、列出节点与分组、认出已有的 `Claude` / `OpenAI` 设置。
2. §5 的两条实测（在你点头之后，加一条再撤掉）。
3. 写：两组分组与规则、直连规则、清单、撤销。
4. 配置页里出口那一栏可以直接选 Clash 的节点（profiles-v0 §4）。
