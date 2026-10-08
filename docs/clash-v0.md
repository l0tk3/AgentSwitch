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

## 7. 第二版（2026-10-08，用户看过第一版之后；**设计，未动代码**）

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

Clash Verge 没有给外面“更新这个订阅”的入口：它认的链接只有 `clash://install-config`，每次都是新建一个；它的更新命令只有它自己的界面能调。所以这一类靠 **Clash Verge 自己的自动更新**（用户，2026-10-08：要不你就给clash设置一个自动更新吧。。这样是不是就解决了）：AgentSwitch 在回应里带 `profile-update-interval`，Clash Verge 加订阅时照它记下间隔，之后自己按时来取，取到的是当前订阅就重新加载。这个间隔以整小时计，最短 1 小时，所以定为 1；等不及时用户在 Clash Verge 里点一次更新。没取到之前 AgentSwitch 的页面一直挂着提示。要先量一件事再定死：它每次自动更新都会重新加载内核（内容没变也加载），要看这一下会不会断开正在用的连接——装好后请用户点一次更新、同时数连接；会断的话间隔放长（24 小时），靠提示。**没有采用**直接把整份配置推给内核：能立刻生效，但 Clash Verge 不知情，下次它自己生成配置时会盖回去，而且要 AgentSwitch 复刻它生成配置的全过程。

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

## 8. 分步

1. （做了）第一版：§6 末尾。
2. 第二版（§7，等用户说做）：底本归 AgentSwitch 管与自动更新；两个节点集与四个分组；页面上选当前节点、测延迟、`Update Now`。
3. 配置（profile）里填的代理自动进直连表；配置页里出口那一栏可以直接选 Clash 的节点（profiles-v0 §4）。
4. 演示页。
