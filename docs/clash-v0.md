# clash-v0：Clash Integration——为 Claude、OpenAI 单独配置代理，配置的代理直连

2026-10-08 用户：可以和clash进行interactive吗；也就是理论上我可以直接用agentswitch修改配置文件？；需要加一栏 clash-intergration……当前我的clash配置文件中有关于Claude和openai的配置，clash-intergration中要有 “为Claude单独配置代理” 和 “为openai单独配置代理“的功能；可以读取当前订阅文件的所有节点，然后”为Claude配置单独代理” 可以单独按照优先级拖进来几个节点，根据优先级fallback（可以选择自动fallback也可以手动选择节点） openai的同理；设置之后就和我现在的配置文件差不多；然后可以设置claude code profile中添加的代理直接直连（通过agent switch添加的规则必须可逆）然后以后也可以手动删除。

**草案；第二版（§7）已做**，在用户的 Clash Verge 上真切换过去走一遍还没有。界面上的名字是 `Clash Integration`。§2–§6 是走到这一版的经过，以 §7 为准。

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

## 5. 查实的与还差的（2026-10-08 实测）

做法：备份当前订阅的规则扩展文件 → 往 `prepend` 加一条无害的规则（一个不存在的域名，直连）→ 看 Clash → 还原（校验值与之前相同，Clash 与网络照常）。

1. **Clash Verge 不会自己发现文件变了**：加完等了 12 秒，再过一分钟，控制接口的规则表里都没有那一条；它生成的最终配置（`clash-verge.yaml`）的修改时间也没动。
2. **没有找到从外面让它重新生成的办法**：
   - 它对外只有两个命令（本机一个端口，带口令）：显示窗口、切换 PAC；链接协议 `clash://`、`clash-verge://` 只用来导入订阅。
   - “重新生成并加载”是它界面内部的命令（`enhance_profiles`、`restart_core`），外面调不到。
   - 内核实际读的那份配置在一个本用户进不去的系统目录里，改不了也读不到。
   - 所以写完扩展文件之后，**要你在 Clash Verge 里点一次重新加载**（重新激活订阅）才生效。
3. **绕过 Clash Verge 的路有一条，没有试**：用控制接口把“它生成的那份配置加上我们的改动”整份推给内核（`PUT /configs` 带 `payload`）。立刻生效，不用你点；但那是在 Clash Verge 不知情的情况下换掉正在运行的配置，开着 TUN 时推错一处就是全机断网，而且它下次自己重新加载会把推的东西冲掉（所以扩展文件仍然要写）。这条路要你明确说要才做。
4. **还差的**（要你在 Clash Verge 里操作一次才看得到）：重新加载后加的规则是否如期出现在最前；你在它的界面里编辑同一个扩展文件并保存时，是否保留 AgentSwitch 加的条目。

## 6. 改用“AgentSwitch 分发订阅”（2026-10-08，用户提出；取代 §4 的写扩展文件）

用户：要不这样，让用户直接把订阅链接/yaml直接给agentswitch，然后agent switch对本地的端口监听给clash verge分发处理后的订阅文件（只能本机读局域网也不能读取）；然后初始化的时候给clash 新建一个profile 更新链接就是as的服务；然后提示用户去切换并打开tun；然后检测如果用户没切换没打开tun的话就一直挂着提示。

**做法**

1. 你把订阅链接（或一份 yaml）交给 AgentSwitch。链接里通常带着订阅的口令，按密文保存。
2. AgentSwitch 取到原订阅，在它上面加工出一份：原有的节点、分组、规则都留着；最前面加上 AgentSwitch 的分组（Claude、OpenAI 各一组）、引用规则集的几条规则、以及规则集与节点集的声明。
3. 这份加工后的订阅由服务在**本机回环地址**上提供（只听 127.0.0.1，地址里带一段随机口令；局域网读不到）。
4. 初始化：用 Clash Verge 自己的导入链接（`clash://install-config?url=…`，它的程序认这个协议）新建一个订阅，更新地址就是上面那个本机地址。
5. 提示你去 Clash Verge 里切到这个订阅并打开 TUN。服务经控制接口看：当前在跑的配置里有没有 AgentSwitch 的分组、TUN 是否开着——没有就一直挂着提示，有了提示自己消失。

**比写扩展文件好在哪**

- 不改 Clash Verge 的任何文件；它怎么重新生成配置都是从我们这里取，不会把我们的东西冲掉。
- 撤掉就是切回你原来的订阅，或者删掉这一个订阅。
- 分组、规则的结构由 AgentSwitch 一处生成，不必猜 Clash Verge 的合并顺序。

**改动怎么立刻生效**

订阅整份更新要 Clash Verge 去重新取（你点更新，或它的定时更新），不是立刻的。所以日常会变的东西不直接写在订阅正文里，而是放进订阅里声明的规则集与节点集，它们同样由 AgentSwitch 在本机提供：

- 换节点、调优先级：改节点集，再让内核只刷新这一个（控制接口）。
- 配置的代理直连：改规则集，同样只刷新这一个。
- 手动选哪个节点：直接走控制接口。
- 只有结构变了（多了一个分组）才需要重新取订阅，界面提示你去点一次更新。

**要注意的**

- AgentSwitch 经手了你的订阅链接和全部节点的地址与口令：只存密文，只在本机回环上提供。
- AgentSwitch 的服务没开时 Clash Verge 更新这个订阅会失败，它会继续用上一次取到的那份，网络不受影响。
- 原订阅的流量与到期信息（响应头里的那一行）要原样转给 Clash Verge，不然它那里看不到剩余流量。
- 取原订阅时要像 Clash 客户端那样报自己，否则有的订阅服务给的不是 Clash 格式。

**实测（2026-10-08，Clash Verge v2.5.6 / mihomo v1.19.31，TUN 开着）**——测试订阅是用户当前订阅的原样内容，只在最前面多一条引用测试规则集的规则，所以切过去网络不变：

- `open "clash://install-config?url=<编码后的地址>&name=…"`：立刻新建了一个远程订阅，不弹确认，**不自动切换**；它从 `127.0.0.1` 来取，自报 `clash-verge/v2.5.6`；响应头 `Subscription-Userinfo` 被记进了订阅的流量信息；它会在存下的地址后面再接一个 `&name=…`，服务要容得下多余的参数。不带口令的请求回 404。
- 同版本的内核程序（应用包里的那个；后台服务用的那份本用户不能执行）`-t -f <文件> -d <目录>` 能只检查不加载：交出去之前先过这一关。
- 用户切过去之后：内核取规则集的请求来自 `127.0.0.1`（自报 `clash.meta/v1.19.31`），开着 TUN 也没有绕代理；规则集排在规则表第一条。
- 改规则集内容后 `PUT /providers/rules/<名字>`：回 204，47 毫秒，条数 1 → 3；当时的 59 条连接一条没断。再改回去同样即时。
- **没测**：节点集（proxy-provider）的同一种刷新。

**做了的（2026-10-08）**

- 底本不是“把订阅链接交给 AgentSwitch”，而是**在 Clash Verge 已有的订阅里选一个**：AgentSwitch 每次被取时去读 Clash Verge 存着的那份文件，再加工。这样订阅链接、节点的地址和口令都不进 AgentSwitch 的库，订阅的更新仍由 Clash Verge 做。代价：底本更新后，AgentSwitch 这一个要再更新一次才跟上。
- 节点顺序写在订阅正文的分组里（`AgentSwitch Claude` 手选组 + `AgentSwitch Claude Auto` 自动组），没有用节点集：节点集要把节点的地址与口令经手一遍，而且那种刷新没测过。所以**改顺序、增删节点要在 Clash Verge 里更新一次这个订阅**，界面会一直提示到更新为止；直连地址和手选哪个节点立刻生效。
- 这台 Mac 的节点全部来自订阅里的节点集（42 个，`/proxies` 里一个都没有，要读 `/providers/proxies`）。这种节点在分组里不能直接点名，所以每个选中的节点各包一层只筛出它自己的小组（`AS · <节点名>`）。用当前订阅做出来的那份，内核 `-t` 检查通过。
- 服务端：`src/clash/`、`/clash`、`/clash/settings`（只在 Mac 上）、`/clash/sub.yaml`、`/clash/rules/<名字>.yaml`（只认地址里的口令，只在本机回环）。Mac：主窗口左边栏的第四页 `Clash`（⌘⇧K），与 Dispatch、Terminals、Browser 并列（用户：可以不在设置里吗，弄成浏览器 terminal dispatch并列的；起先放在设置里）。`-designPreview <目录> -designPreviewOnly clash` 画出 `main-clash`。`scripts/clash_probe.ts` 只读地看这台 Mac 上的 Clash。
- **还没做**：演示页；配置（profile）里填的代理自动进直连表（现在手填）；真的在 Clash Verge 里切到这个订阅走一遍。

## 7. 第二版（2026-10-08，用户看过第一版之后；已做，见 §7.6）

用户：应该可以接受一个代理链接；然后我为Claude和openai选好节点之后应该在Claude中出现相应的 “Claude 自动选择”和“openAI 自动选择”组，按照我选的优先级自动fallback；然后还有对应的Claude组和openAI组（这俩组是真正决定Claude和openai流量走向的）在Claude组里可以选择Claude自动选择或者其他我为Claude选择的节点，OpenAI同理；如果给的订阅文件/链接中有对应的Claude规则和OpenAI规则的话让我Agentswitch上设置的规则优先级最高；然后不要弄出来一堆没用的 AS. 什么节点；还有就是最好能在AgentSwitch里控制切换哪些节点（比如当前选中的Claude节点直接在AgentSwitch里改一下）；然后要能测节点的延迟（在AS里）；要能帮clash更新订阅（从AS拉新的订阅更新）；如果把订阅链接放到AS里管理了或者yaml里有供应商链接要可以设置自动更新；能做到吗

（“在Claude中出现”读作“在 Clash 中出现”。）

### 7.1 底本归 AgentSwitch 管

- 底本可以是**一条订阅链接**、**一份 yaml 文件**，或者从 Clash Verge 现有的订阅里**导入**（抄一份过来，之后 Clash Verge 里那一个删掉也不影响）。
- yaml 里带 `proxy-providers` 的链接（用户现在这份就是：一个 `tgyun` 节点集，链接回的是整份 Clash 配置，42 个 vless 节点），AgentSwitch 也去取，因为要用里面节点的完整信息。
- 自动更新：关 / 每 1、6、12、24 小时，另有 `Update Now`。取链接时自报 `clash.meta/<版本>`（内核自己取时就是这样报的），否则有的订阅不回 Clash 格式。回来的不是带 `proxies` 或 `proxy-providers` 的 yaml 就报错，不猜别的格式。
- **AgentSwitch 因此存着订阅原文（含节点的地址与口令）和链接**：放在它自己的目录 `clash/` 下，只有本人可读，和 Clash Verge 在它自己目录里的存法一样；不进任务库、不进日志、不进任何 agent 的上下文；对外只在本机回环上、凭地址里的口令提供。第一版为了不经手这些才读 Clash Verge 的文件，现在用户要它管链接，这一条就换了。

### 7.2 交给 Clash Verge 的那一份

底本原样，加上：

- **两个节点集** `as-claude`、`as-openai`，由 AgentSwitch 在本机提供：用户为这一项选的节点，按优先级排好，带完整信息、**用它们原来的名字**。
- **每项两个分组**（名字照用户现有文件；底本里已有同名的——不计空格与大小写——就取代它、沿用它的写法，别处引用它的不用改）：
  - `Claude自动选择`：`fallback`，成员来自 `as-claude`，按顺序用第一个连得上的；探测地址 `https://api.anthropic.com/`，间隔 180 秒（用户现有文件的写法）。
  - `Claude`：`select`，成员是 `Claude自动选择` 加 `as-claude` 里的每个节点。真正决定 Claude 流量去向的是它。
  - OpenAI 同理（`https://api.openai.com/`）。
- **规则**：最前面是 `RULE-SET,as-direct,DIRECT`、`RULE-SET,as-claude,Claude`、`RULE-SET,as-openai,OpenAI`，所以底本里就算有自己的 Claude / OpenAI 规则，也是 AgentSwitch 的先中。
- 没为某一项选节点时：不出它的分组，它的规则集是空的，这类流量照底本原有的走。
- 第一版的 `AS · <节点>` 小组不再有。那是因为节点集里的节点不能在分组里直接点名，当时又不想经手节点信息；现在节点集由 AgentSwitch 自己提供，就不需要了。
- 底本里 `http` 的节点集，链接改成指向 AgentSwitch 存的那一份（原样转交）：只有 AgentSwitch 一处去找机场，它取到新的之后能让内核立刻换上。

### 7.3 哪些立刻生效，哪些要 Clash Verge 重新取

**立刻（AgentSwitch 经控制接口自己做，不经过 Clash Verge）**

| 做什么 | 怎么做 |
| --- | --- |
| 增删节点、调优先级 | 改 `as-claude` / `as-openai` 的内容，只刷新这一个节点集 |
| `Claude` / `OpenAI` 用自动还是某个节点 | 直接在分组里选 |
| 直连地址 | 改规则集，只刷新这一个 |
| 机场的节点更新了 | AgentSwitch 取到新的，刷新底本的节点集和自己的两个 |
| 测延迟 | 一组一次测完，或单测一个节点 |

**要 Clash Verge 重新取一次的**（它是“订阅正文”的事）：某一项从没有节点到有节点（多出分组）或反过来；机场改了它自己的分组或规则。

Clash Verge 没有给外面“更新这个订阅”的入口：它认的链接只有 `clash://install-config`，每次都是新建一个；它的更新命令只有它自己的界面能调。所以这一类靠 **Clash Verge 自己的自动更新**（用户，2026-10-08：要不你就给clash设置一个自动更新吧。。这样是不是就解决了）：AgentSwitch 在回应里带 `profile-update-interval`，Clash Verge 加订阅时照它记下间隔，之后自己按时来取，取到的是当前订阅就重新加载。这个间隔以整小时计，最短 1 小时，所以定为 1；等不及时用户在 Clash Verge 里点一次更新。（用户：为什么最短一小时 分钟级别不行吗。读了 Clash Verge v2.5.6 的源码：回应里的 `profile-update-interval` 它按整数读、乘 60 记成分钟；导入链接只带地址和名字，带不了间隔；它自己的定时器是按分钟走的，间隔在它的订阅编辑框里以分钟填，手填的值优先于回应里的、之后更新也不会被改掉。所以**分钟级可以，但只能在 Clash Verge 里手填一次**，AgentSwitch 从外面给不了；页面的待办里写上这一步作为可选项。自动更新后它以“非强制”方式重新加载内核，手动点更新是“强制”。）没取到之前 AgentSwitch 的页面一直挂着提示。要先量一件事再定死：它每次自动更新都会重新加载内核（内容没变也加载），要看这一下会不会断开正在用的连接——装好后请用户点一次更新、同时数连接；会断的话间隔放长（24 小时），靠提示。**没有采用**直接把整份配置推给内核：能立刻生效，但 Clash Verge 不知情，下次它自己生成配置时会盖回去，而且要 AgentSwitch 复刻它生成配置的全过程。

### 7.4 查实的（2026-10-08）

在临时目录里另起了一份同版本内核（应用包里的 `verge-mihomo`，不开 TUN、不开端口、节点是编的），与用户的 Clash 无关，试完已删：

- 分组成员与顺序就是节点集内容的顺序；`select` 组是“自动组在前，节点在后”。
- 改节点集内容后 `PUT /providers/proxies/as-claude`：回 204，两个分组的成员与顺序当即跟着变。
- `PUT /proxies/Claude {name}` 选中某个节点；之后把它从节点集里拿掉并刷新，`Claude` 自己退回自动组。
- **空的节点集内核不收**（刷新回 503，保留上一份）——所以没选节点时不能出分组，而不是出一个空的。
- 两个节点集里有同名节点没有问题。
- 用户现有文件用的“反引号分隔多个正则、按正则顺序排节点”也试了，成立；但那样节点写在订阅正文里，改一次要 Clash Verge 重新取一次，所以不用。

在用户正在跑的内核上（只测延迟，不改设置）：

- 节点集里的节点不在 `/proxies/<名字>` 下（回 `Resource not found`），所以单个节点的延迟要走 `GET /providers/proxies/<节点集>/<节点>/healthcheck?url=…&timeout=…`（回 `{"delay":904}`）；一组一起测是 `GET /group/<组名>/delay`（回 `{"🇯🇵 日本家宽-01":392,"🇯🇵 日本家宽-02":428}`）。

别的：

- 用户节点集的链接取了一次（照内核的方式自报）：回的是 yaml 的整份 Clash 配置，带 `subscription-userinfo` 和 `profile-update-interval: 24`。内容没有留。
- Clash Verge 的程序里只有 `install-config` 这一种导入链接和 `/commands/visible`、`/commands/pac` 两个本机入口；它认 `profile-update-interval`。
- 服务在本机的端口是设置里固定的那个，重启不变；改了端口，Clash Verge 里那条订阅地址就要重加。

**还没查实的**：Clash Verge 按间隔自动更新当前订阅时会不会让连接断一下（这决定间隔能不能设短）；回应里的间隔它是不是照着记下了（加订阅时看它的 `profiles.yaml`）。

### 7.5 页面

- `Subscription`：来源（链接只显示主机名）、节点数、上次更新、剩余流量与到期；`Paste Link…`、`Choose File…`、`Import from Clash Verge`；`Auto Update`；`Update Now`。
- `Claude` / `OpenAI` 各一块：节点按优先级排，每行有延迟；最上面一行是 `Automatic`（旁边写着它此刻用的是哪个）；点哪一行，`Claude` 组就用哪一行——读的是内核里的实情，在 Clash Verge 里改了这里也跟着变；`Test` 测这一组。
- `Go Direct`、顶上的待办提示同第一版。

### 7.6 做了的（2026-10-08，用户：可以，先实现一下吧）

- 服务端 `packages/daemon/src/clash/`：`source.ts`（底本：链接或文件，连同它点名的节点集，存在 `$AGENTSWITCH_HOME/clash/source/`，目录 0700、文件 0600；出错信息只带主机名）、`build.ts`（交给 Clash Verge 的那一份、节点集、规则集）、`controller.ts`（控制接口：状态、选成员、刷新一个节点集或规则集、单个节点的延迟）、`integration.ts`（把它们串起来；每分钟看一次到没到自动更新的间隔）、`verge.ts`、`store.ts`。
- 接口（当时都只在 Mac 上、手机来的回 403；2026-10-09 起配对的手机也够得着，见 §9）：`GET /clash`、`PUT /clash/settings`、`POST /clash/source`（`{link}`、`{yaml,name}`、`{verge}`）、`DELETE /clash/source`、`POST /clash/update`、`POST /clash/select`、`POST /clash/delays`。给 Clash Verge 和内核取的（只认地址里的口令，只在本机回环）：`/clash/sub.yaml`、`/clash/rules/<名>.yaml`、`/clash/nodes/<名>.yaml`、`/clash/providers/<节点集名的 base64url>.yaml`。
- Mac：主窗口的 `Clash` 页——每项的节点（排序、延迟、点选当前用哪个）在前，`Go Direct`，底本在最下面（链接 / 文件 / 从 Clash Verge 导入、`Auto Update`、`Update Now`、`Remove…`）。
- 给 Clash Verge 的间隔是 1 小时（§7.3）；AgentSwitch 自己去取底本的间隔默认 24 小时。
- 没有的：某个节点集自己带 `filter` / `override` 的，这里没有照做（列出来的是它取回的全部节点、原名）；不是 Clash 格式的订阅（一串 `vless://` 之类）不收。

**真跑了一遍**（`scripts/clash_probe.ts`：在临时目录里把用户 Clash Verge 的当前订阅导入、照内核的方式取了一次它的节点集链接、经真的本机监听提供出去，再另起一份不开 TUN 的内核去取；用户自己的 Clash 只读）：

- 导入：`tgyun_config.yaml`，42 个节点，流量信息有。带口令取到 200，不带 404；回应里的间隔是 1；机场的链接不在交出去的内容里。
- 交出去的分组：`Claude自动选择 | Claude | OpenAI自动选择 | OpenAI | Manual | Auto`——四个是 AgentSwitch 的，站在原来的位置上，没有多出别的组；内核 `-t` 通过。
- 另起的内核：`as-claude(2) as-openai(3) tgyun(42)`；`Claude` = `[Claude自动选择, 日本家宽-02, 日本家宽-01]`，自动组当前用 `日本家宽-02`。
- 经服务自己的代码改顺序并拿掉一个节点：自动组当即变成 `[日本家宽-01]`；直连规则 1 → 2；点选一个节点再点回自动，都生效。
- 延迟：Claude `401 ms`；OpenAI 三个节点 `330 / 403 / 472 ms`；全部 42 个里 33 个有回应。
- 结束后用户自己的内核：7 个分组、没有规则集、TUN 开着，和之前一样。
- **它查出一个单元测试测不到的错**：经真的本机监听提供规则集、节点集时，第二次请求回 500（`v is not iterable`）——回应头用了同一个对象，监听往里面写了东西。改成每次新造，并补了一条走真监听的测试（把错放回去它会红）。

**仍然没做的验证**：在用户的 Clash Verge 里真的加上、切过去；Clash Verge 是否照回应里的间隔记下了 60 分钟；它自动更新时连接断不断；页面上的按钮在装好的应用里点一遍（现在只有编造数据画出来的 `main-clash`、`main-clash-full`）；列表里拖动排序在这种表单里是否可用（所以每行另有上下箭头）。

### 7.7 规则模版与默认组改名（2026-10-08）

用户：把国内与本地直连的规则做成一个模版，我在AS里的配置文件打开一个开关就直接把这个模版规则放上去，可以通过高级设置编辑详细规则；拦截也是；还有可以把机场默认手动选择的节点重命名成Manual吗？

用户原文件的 235 条规则按作用是六类：Claude（4）、OpenAI（6）、国内与本地直连（171，含末尾的 `GEOIP,CN`）、常见国外服务走 `Manual`（26）、拦截广告与统计（27）、兜底（1）。前两类 AgentSwitch 已经有；这里把第三类和第五类做成模版。

**两个模版，各一个开关**

- `Domestic & Local Direct`：国内常用域名、豆包与字节的基础设施、微信 / QQ / 钉钉按进程名、本地与安全服务的几个域名、局域网与保留地址段、`GEOIP,CN`。
- `Block Ads & Trackers`：广告与统计的域名关键词。
- 内置的内容取自用户原文件的对应段落（那本来就是机场通行的默认规则）。**没有收进去的**：原文件“指定 IP”里的两个具体地址——那是这位用户自己的，不该写进程序；要用就填进 `Go Direct`。
- 每个模版的规则可以改（`Edit…`）：一行一条，`类型,内容`，不写去向（直连还是拦截由模版定）；从 yaml 里整行粘过来的（带 `- ` 和去向）会自动去掉多余的部分；空行和 `#` 开头的不算。改过之后用的是你自己的那份，`Reset to Template` 回到内置的。不认识的类型、带括号的逻辑规则不收，说出是第几行。

**放在规则表的什么位置**（照用户原文件的次序）

| 规则集 | 去向 | 位置 | 里面是什么 |
| --- | --- | --- | --- |
| `as-domestic` | `DIRECT` | 最前面，Claude / OpenAI 之后 | 域名、进程名这些不用查 IP 就能判断的（以及写明 `no-resolve` 的地址段） |
| `as-block` | `REJECT` | 订阅自己规则的后面、它最后那几条兜底（`GEOIP…`、`MATCH`）之前 | 拦截模版的全部 |
| `as-domestic-ip` | `DIRECT` | 紧跟在 `as-block` 后面 | 要先查出 IP 才能判断的：局域网段、`GEOIP,CN` |

- 拦截排在后面，是因为它用的是很宽的关键词（原文件注释里就提到 `usage` 会误伤）：前面有规则认领了的流量不受它影响。
- `GEOIP,CN` 排在最后，是因为它要先把域名解析成 IP；放前面的话，已经点名走代理的国外域名也会先被拿去解析、按解析结果判断。
- 三个规则集**始终声明在订阅里**，关着的时候内容是空的。所以开关和改规则都只是规则集内容的变化：立刻生效，不用 Clash Verge 重新取。（从上一版升上来时订阅正文多了这三条引用，要它重新取一次——每小时会自己来。）

**默认组改名为 `Manual`**

- “机场默认手动选择的那一组”认的是：订阅最后那条 `MATCH` 指向的分组，而且它是手选（`select`）的。订阅里已经有叫 `Manual` 的组（用户现在这份）就没有这一项。
- 开关打开后，交给 Clash Verge 的那一份里它叫 `Manual`，别处提到它的地方（规则的去向、其它分组的成员）一并改名。默认关。这是订阅正文的变化，要 Clash Verge 重新取一次。

**“是不是最新”的判断**也跟着改全了：内核里要有 AgentSwitch 的全部规则集、该有的节点集，以及交出去那份里的每一个分组名；差任何一样都提示去更新。

**做了的（2026-10-08）**

- 服务端：`src/clash/templates.ts`（内置的两份：直连 169 条 = 原文件的 171 条去掉那两个地址，拦截 27 条）、`rules.ts`（读一行规则、说出哪一行不是）、`build.ts`（三个规则集、位置、改名）；设置里多了 `templates`（开关与用户自己的规则）和 `renameDefault`；`GET /clash/templates/<名>` 给编辑框取当前在用的规则；`GET /clash` 多了每个模版的状态和 `defaultGroup`。
- Mac：`Rules` 一栏（两个开关，各带条数与 `Edit…`；编辑框一行一条，存不进去的那一行原样留在框里并说出是第几行；`Reset to Template`）；`Subscription` 里的 `Rename “…” to Manual`。画出来的是 `main-clash-full`、`main-clash-rules`。
- 真跑（`scripts/clash_probe.ts`，另起的内核）：两个模版关着时三个规则集各 1 条（占位）；都打开 `as-domestic 160`、`as-domestic-ip 9`、`as-block 27`，页面上仍是“最新”（没有动订阅正文）；换成自己写的四行、拦截关掉 → `2 / 2 / 1`；内核没有对规则或规则集报任何错——进程名、通配进程名、`GEOIP`、地址段在规则集里都收。
- 真跑，机场自己的链接做底本（用户文件里给节点集用的那条）：42 个节点，默认组认出来是机场名字的那一组；打开改名后交出去的分组是 `Claude | Claude自动选择 | OpenAI | OpenAI自动选择 | Manual | 自动选择 | 故障转移`，520 条规则里最后是 `… | RULE-SET,as-block,REJECT | RULE-SET,as-domestic-ip,DIRECT | GEOIP,CN,DIRECT | MATCH,Manual`，没有一条还指着旧名字；内核 `-t` 通过。
- 没做的验证：在装好的应用里点这两个开关和编辑框；模版打开后在用户自己的 Clash 上看规则命中。

### 7.8 DNS 模版（2026-10-08）

用户：DNS规则呢？我配置文件中的DNS规则做成模版了吗

没有：§7.7 只做了规则表里的两类。DNS 是另一种东西——不是规则表里的条目，而是订阅顶层的一整段 `dns:`，所以放不进规则集。

**查到的**

- Clash Verge 的设置里 `enable_dns_settings: false`（它自己的“DNS 覆写”没开），它生成给内核的配置里 `dns:` 与用户 yaml 里的一字不差：**订阅里的 `dns:` 就是内核在用的**。所以 AgentSwitch 在交出去的订阅里放什么 DNS，内核就用什么。用户以后要是打开了 Clash Verge 的 DNS 覆写，就以它的为准，这里的模版不起作用——页面上要说。
- `tun:` 不一样：生成的配置里是 Clash Verge 自己的（`stack: gvisor`、`strict-route: false`，而用户 yaml 写的是 `system` / `true`）。订阅里的 `tun:` 它不照用，所以不做 TUN 模版。
- 现在用用户自己的 yaml 做底本时，`dns:` 原样带了过去，没有丢。改用机场原始链接做底本后，带过去的会是机场那一段，用户自己调的这些（国内域名与 Apple、字节用国内 DNS 解析；Claude 的域名只认境外 DNS 的结果；一长串不用假地址的国内域名）就没有了——这才需要模版。

**做法**

- 一个开关 `DNS`：打开后，交出去的订阅里 `dns:` 这一段**整段换成模版的**；关着就是底本自己的。
- 内置的内容是用户原文件的 `dns:` 段，注释照留；`fake-ip-filter` 里两个只属于这位用户的域名没有收。
- `Edit…`：整段 yaml 直接改（`dns:` 下面的内容，不含 `dns:` 这一行）。存的时候要是合法的 yaml 且是一组键值；不是就说出哪里不对，不存。`Reset to Template` 回到内置的。
- **它改的是订阅正文**，不像规则模版那样立刻生效：要 Clash Verge 重新取一次。

**“是不是最新”再补一层**：DNS 这一段内核的控制接口里看不到，光看分组和规则集判断不出 Clash Verge 取没取到新的。所以另记一个指纹：每次 Clash Verge 来取订阅，记下交出去那份的指纹和时间；现在会交出去的和它不一样，就是还没取到。升级了 AgentSwitch、机场改了分组或规则、改了名、动了 DNS，都由这一条认出来。

**做了的（2026-10-08，用户：继续）**

- 服务端：`templates.ts` 里的 `DNS_TEMPLATE`（用户那段 134 行，注释照留）；设置里的 `dns: { on, text }`；`build.ts` 在开着时把 `dns:` 整段换掉，`dnsSection` 说出一段文字为什么不是一段 DNS；`GET /clash/dns` 给编辑框取当前在用的文字；`GET /clash` 多了 `dns: { on, custom, overridden }`（`overridden`：Clash Verge 自己的 DNS 覆写开着，读它的 `verge.yaml`）。
- 指纹：`settings.json` 里记 `served: { hash, at }`，每次 `/clash/sub.yaml` 被取时写；`upToDate` 除了原来那几条，还要“上次被取走的就是现在会交出去的”。`fetchedAt` 也从这里来，服务重启后还在。
- Mac：`Rules` 里第三行 `DNS`（`Template` / `Edited`，`Edit…` 是整段 yaml）；Clash Verge 的 DNS 覆写开着而这里也开着时，行下面有一句提醒。编辑框改成一个通用的（规则模版与 DNS 共用）。
- 顺带：某一项选的节点在现在这个订阅里一个都没有时，那一块下面的说明改成直说“一个都没有了，照订阅原有的规则走，重新选”——原来还在讲两组分组。（当时选的节点按名字记在设置里、换订阅不清；用户随后改了主意，见 §7.9。）
- 真跑（`scripts/clash_probe.ts`，机场自己的链接做底本）：机场自带的 `dns:` 是 9 个键、假地址模式、没有按域名分流的条目；换成模版后 13 个键、3 条分流、92 个不用假地址的域名；连同改名与两个规则模版一起，内核 `-t` 通过。
- 没做的验证：在用户的 Clash Verge 上真的用这段 DNS 跑（写这一条时它切回了原来的 `tgyun_config.yaml`）；页面上的开关和编辑框在装好的应用里点一遍。原定在 23:45 那次自动更新时数连接的事也没做成：观察脚本随会话结束被停掉，而且订阅已不是当前的。

### 7.9 换订阅就忘掉选过的节点；路由检查（2026-10-08）

用户：还是别记住节点了，不然会一直堆积，而且其他订阅链接里如果有重名的不就弄错了？然后弄一个基准测试，来测试各个代理规则又没有生效；还有agent新建配置的话如果设置了代理，应该再打开新配置的agent前都进行基准测试，来监测agent是否真的走代理，然后代理标注在底栏；agent对应的浏览器也是

（后半句是配置的事，记在 profiles-v0。）

**选过的节点**

- 换一个订阅做底本，或者把底本移除：为 Claude、OpenAI 选的节点清空。另一家订阅里同名的节点不是同一个节点。
- 同一个订阅再取一次（`Update Now`、自动更新）不清；其中不见了的节点留着、标 `Gone`，让人知道少了哪个。
- 直连地址、规则模版、DNS 不属于某一个订阅，换订阅不动。
- 换订阅没成功（链接取不到、不是 Clash 格式）什么都不动。

**路由检查**（页面上叫 `Routing Check`；用户说的“基准测试”）

- 做法：从这台 Mac 经**内核自己的代理端口**（`mixed-port`）各发一条普通连接，再从控制接口的连接列表里找到这一条（按它出发的本机端口认，不会认成用户别的应用开着的同名连接），读出**命中的规则**和**出去的路**（分组 → 节点）。被规则拒掉的连接是立刻被掐断、不进列表。Claude 和 OpenAI 还经这条连接问一次对方（它们自己域名上 Cloudflare 的 `/cdn-cgi/trace`）看到的来源地址与地区。
- 试的是：Claude（`claude.ai`）、OpenAI（`chatgpt.com`）、国内（`www.baidu.com`）、按 IP 归属的国内（`www.163.com`）、广告（`ad.doubleclick.net`）、`Go Direct` 里的每个地址、其它（`www.google.com`）。
- 判对错只在这里有要求时：选了节点的那一项要从它的那个分组出去；国内模版开着、且里面有对应那条规则时要直连；拦截开着时要被拒；`Go Direct` 的地址要直连。没要求的（模版关着、没选节点）也试，只是告诉你它现在怎么走，不打勾也不打叉。
- 不依赖 TUN 开没开，也不依赖内核的日志级别；不改 Clash 的任何设置。内核没开代理端口就做不了，说明白。
- 接口 `POST /clash/check`（只在 Mac 上）。
- **`Go Direct` 的地址按它自己的端口试（2026-10-10）**。用户：这个东西没生效（`Go Direct` 里一个配置的代理 `…:9050`，检查那一行打叉）。查实：规则是生效的——内核日志里这个地址命中 `RuleSet(as-direct)`、走 `DIRECT`；打叉是因为检查一律去连 443，而代理服务器只开自己的端口，连不上的连接内核不列出来，于是被当成了“没直连”。改法：地址是某个配置的代理服务器时，用那个代理的端口去试；别的地址仍试 443。`Go Direct` 的地址试了却什么也没列出来时，不打勾也不打叉（它在那个端口上没有应答，说明不了规则对不对）；列出来却经了节点的，照旧打叉。

**查实的**

- 另起的内核上：对代理端口的 `CONNECT` 一律先回 200；连上的连接在 `/connections` 里带 `rule`、`rulePayload`、`chains`（从节点往上数，页面上倒过来写）；直连到一个不通的地址也会列出来；被拒的 1 毫秒内断开且不列出；节点不通的不列出也不断。
- 在用户正在跑的内核上（当时是他自己的 `tgyun_config.yaml`），1.2 秒跑完：Claude 经 `Claude → Claude自动选择 → 日本家宽-02` 出去，对方看到的是日本的地址，362 毫秒；OpenAI 经 `OpenAI → OpenAI自动选择 → 美国-01`，对方看到美国的地址；`baidu` 按关键词直连；`163` 按 `GeoIP cn` 直连；广告被拒；其它走 `Manual → 新加坡-01`。
- 没做的验证：按钮在装好的应用里点一遍。

## 8. 分步

1. （做了）第一版：§6 末尾。
2. （做了）第二版：§7.6。接着是在用户的 Clash Verge 上走一遍（§7.6 末尾那几条）。
3. 配置（profile）里填的代理自动进直连表；配置页里出口那一栏可以直接选 Clash 的节点（profiles-v0 §4）。
4. 演示页。

## 9. 手机上也管得到（2026-10-09）

用户（2026-10-09）：“手机上没有管理代理的功能吗”——当时没有，三处都把手机挡在外面（Clash 的接口回 403、配置的代理回 403、浏览器的身份回 403）；说明了原来的考虑、提了“看与切放手机，凭据类留 Mac”两档之后：“手机上也得放”。按“代理的管理整个放到手机上”做了，配置的代理见 profiles-v0 §4.2，共用浏览器的代理见 browser-v0 §7.6；这一节是 Clash。

- **放开的接口**（远程白名单 `src/remote/routes.ts`，app-v0 §2）：`GET /clash`、`PUT /clash/settings`、`GET /clash/templates/:name`、`GET /clash/dns`、`POST /clash/check`、`POST /clash/source`、`DELETE /clash/source`、`POST /clash/update`、`POST /clash/select`、`POST /clash/delays`——也就是 Mac 的 Clash 页用的全部十条，语义不变。
- **仍然只在这台 Mac 上的**：给 Clash Verge 和内核取的四类地址（`/clash/sub.yaml`、`/clash/rules/…`、`/clash/nodes/…`、`/clash/providers/…`）不在白名单里，路由自己也不认配对设备（原有的那一条判断没动）。相应地，**给手机的页面里没有 `install`**（Clash Verge 取订阅用的那条地址，带口令、只在本机回环上有用）：服务对手机一律回空串，`PUT /clash/settings`、`POST /clash/select` 这些回同一个页面的接口也一样。所以“把 AgentSwitch 订阅加进 Clash Verge”这一步手机上做不了——它本来就是在 Mac 的 Clash Verge 里点的，手机上的待办写明“在 Mac 上”。
- **订阅链接**：手机可以给一条链接（`POST /clash/source {link}`），经配对的那条钉了证书的连接发给服务，由服务保管；服务照旧只把它的主机名回给任何屏幕，手机上不留。远程请求的日志只记方法、路径和状态，不记正文。也可以从 Mac 的 Clash Verge 里已有的订阅挑一个（`{verge}`），或者从“文件”里选一份 yaml（`{yaml,name}`，8 MB 以内）。
- **为什么放开**：原来留在 Mac 是比照“跳过权限只能在 Mac 上选”。但配对的手机本来就能在这台 Mac 上开终端、派任务并批准它们，换出口并不比这些更重；而人不在电脑前、节点挂了、订阅到期的时候，正是需要在手机上改的时候。设备丢了的办法没变：在 Mac 上移除这台设备。
- **iPhone**：`Settings › Proxies`（新的一段，在 `Dispatch` 之后）第一行 `Clash`，右边是状态一词（`Running`；有待办时琥珀色 `Set Up`；`Not Running`、`Not Found`）。点进去是 Clash 页，和 Mac 的是同一页、同一套词：
  - `Status`：`Clash Verge`、`Core`、`TUN`，下面是待办（琥珀色，一句一行）。
  - `Subscription`：`From`（主机名或文件名）、`Nodes`、`Traffic`、`Updated`、`Auto Update`（`Off`、`1 h`、`6 h`、`12 h`、`24 h`）、`Update Now`、`Replace…`、`Remove`（先确认）；没有订阅时只有 `Add Subscription…`。`Replace…` 是一张表：`Link`（粘贴）、`From Clash Verge`、`Choose File…`。
  - `Separate Proxy for Claude` / `… for OpenAI`：`Automatic`（右边 `→ 它现在用的节点`）和选中的节点各一行，行首是单选标记（`< >` / `<x>`，经典外观是圆环），点一行就改用那一个；右边是延迟（`428 ms`、`Timeout`）或 `Gone`；向左滑拿掉。`Nodes` 进到选节点的一页：上面 `Chosen`（`Edit` 里拖动排序），下面 `All Nodes`（多选标记 `[ ]` / `[x]`，点一下取舍，可搜），右上 `Test All`。`Test` 测选中的几个。
  - `Rules`：两个规则模版和 `DNS` 各一个开关，各带一行 `Edit`（右边 `169 Rules`、`Edited`、`Template`）进到文本页改（`Save`；改过的有 `Use Built-In`；服务说哪一行不对就显示在页上、不退出）；订阅有默认组时多一个 `Rename <组名> to Manual`。
  - `Go Direct`：地址一行一个，向左滑删除，底下一行输入加 `Add`。
  - `Routing Check`：`Run Check` / `Run Again`，每一类一块：名字、试的域名、内核走的路、对方看到的地址与耗时、`OK` / `Wrong` 和不对时的一句话。
- **旧一些的 Mac**（`GET /clash` 回 403 或 404）：手机上没有 `Clash` 这一行。
- 代码：服务 `src/api/clash.ts`（去掉“只在 Mac”的判断，加 `shown()` 给手机去掉 `install`）；Kit `API/ClashModels.swift`（与 Mac 的 `ClashIntegration.swift` 同一套模型，待办的话按“在 Mac 上”改写）、`API/ProxyRoutes.swift`；应用 `Settings/ClashScreen.swift`、`Settings/ProxiesSection.swift`。演示页 `docs/design/implemented/phone-proxies.html`。
- 测试：服务 `tests/clash.test.ts`（手机读得到页面、`install` 为空、页面里没有 `sub.yaml`；检查、模版、DNS 手机都读得到）、`tests/remoteUnits.test.ts`（白名单逐条；四类本机地址仍不在其中）；Kit `ProxyTests`（页面按服务给的样子读出来、设置回写时 `null` 照写、各接口的方法与正文、旧 Mac 回 403 / 404 时当作没有）。
- 看过的：模拟器里的演示（`-uiDemoScreen proxies|clash|clashservice|clashrules|clashcheck|clashnodes|clashtext|clashsource`，像素外观全部、经典外观两张）。**没走过的**：真机连着真服务点一遍（换节点、测速、更新订阅、换订阅）；这要先把这一版装到 Mac 上。
