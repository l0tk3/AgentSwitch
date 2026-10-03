# browser-v0：浏览器——Mac 上一个服务持有的浏览器，App 里看与用，agent 经网关用同一个

2026-10-02 用户：现在在手机上没办法查看 Mac 本地的 html / 图片，有办法弄个通用浏览器吗 → 长期方案先设计成“查看器”（手机经独立端口直接加载 Mac 上的文件），用户随即改为：就做一个浏览器，然后顺便给 Codex 接入上，它调用起来和在 App 里一样。本文取代查看器草案。本文是草案；界面以演示页 `docs/design/implemented/browser.html` 为准。

## 0. 要点

- **浏览器在 Mac 上，由服务持有**（同终端，terminal-v0 §0）：关掉 App、手机断线，页面照开；任一端连上都看到当前页面。
- **App 是它的屏幕**：Mac 主窗口和 iPhone 显示实时画面，可以点、滑、输入、开新标签。
- **Agent 用的是同一个**：Codex（先行）、Claude Code、OpenCode——终端里的和调度的任务里的——经网关的浏览器工具操作它。你在 App 里看到的就是它正在操作的那一页；随时可以接手（agent 暂停），交还后它接着做。登录态共用：你在 App 里登录一次，agent 接着用。
- **网关规则不变**：模型拿到的页面内容照旧脱敏、密文只按允许的站点填入（`packages/secret-gate/BOUNDARY.md` 逐条适用）。浏览器只经管道连到宿主，没有远程调试端口，agent 自己的 shell 连不到它。
- **Mac 上的文件与本地服务**：你在 App 里可以打开 `file://` 路径（禁区与凭据文件除外，§2）和 `localhost`。这正是最初要的“在手机上看 Mac 本地的 html / 图片”——手机拿到的只是画面，文件不离开 Mac。

## 1. 界面

**iPhone**（演示页上半）：

- **标签列表**：按持有者分组——`You`（你自己开的）、终端里的 agent（`codex · AgentSwitch`，同终端名）、调度的任务（任务标题）。每行：状态（agent 正在操作是转圈；等你——验证码、登录、确认——是琥珀方块）、页面标题、域名，`file://` 与 `localhost` 写路径或端口。右上 `+`：新标签（地址栏，可输入网址、Mac 上的路径或 `localhost:5173`，下面列最近的与 Mac 上正在监听的本地服务）。
- **页面**：顶栏是地址（锁 + 域名；点开可编辑）与持有者；中间是实时画面；底栏 `‹` `›` `↻`、键盘、`⋯`（`Copy URL`、`Open on Mac`、`Close Tab`）。
  - agent 的标签：画面上标出它刚操作的元素（框 + `codex · click "Merge"`），底栏多一个 `[ Take Over ]`；接手后变成 `[ Hand Back ]`，agent 对这个标签的操作排队等待，交还或 2 分钟无操作后恢复。
  - 操作：点 = 点击，拖 = 滚动，双指 = 只在手机上缩放画面，长按 = 右键菜单。打字用系统键盘，文字按“插入文本”送进页面；上方一条键帽（`esc` `tab` `⏎` `⌫` `←` `→`），同终端页。焦点在输入框时多一个 `Fill Ciphertext`：从密文填入，经网关按站点校验（同 `secret_fill`），明文不出现在手机与模型里。只在你自己的标签上（2026-10-02：agent 的标签即使接手也不提供，交还后 agent 能看到页面；§6）。
  - 尺寸：只看时，画面是标签当前的尺寸、缩放到手机宽；接手时标签换成手机的视口（网站显示手机版），交还时恢复——同终端的“尺寸有主”。
- **位置**：第三个标签页 `Browser`（Dispatch · Terminals · Browser），图标是像素地球（待定，§4）。
- **实时活动**：agent 在浏览器里等你时（它调用“需要用户”或网关遇到验证码与登录时），同终端一样进实时活动，`[ Open ]` 直达那个标签。

> 2026-10-02 iPhone 的 `Browser` 标签已做（第 4 步的标签部分；实时活动与入口未做）：
> - 代码：Kit 的 `API/BrowserModels.swift`、`API/BrowserRoutes.swift`（路由；画面流沿用 SSE 解析，断线按退避重连）、`Browser/BrowserLayout.swift`（画面在手机上的位置、触点到帧像素、agent 操作框、拖动到滚轮、键盘上推）、`Browser/BrowserPolicy.swift`（按连接要画面：局域网质量 70、15 帧；Tailscale 直连 60、10 帧；中转或不明 45、5 帧，且帧不超过手机屏幕的像素；地址栏的端口识别与显示；持有屏幕的说法），测试 `Tests/AgentSwitchKitTests/BrowserTests.swift`；界面在 `App/Sources/Browser/`。
> - 列表：按持有者分组，`// codex · AgentSwitch` 前有 agent 小图；每行是状态（转圈；琥珀方块闪烁，并以琥珀色写出等你的原因；空心）、标题、位置。点开；长按出像素菜单（`Copy URL`、`Close Tab`）；左滑 `Close Tab`；agent 的标签关闭前先确认。列表下方是 `// Local Servers on <Mac>`，点一下在新标签中打开；本地服务在进入 Browser 页、下拉刷新与打开 `+` 时读取，不定时轮询（Mac 每次要运行 `lsof`）。列表从每个标签页轮询（在 Browser 页 2 秒一次，其他页 8 秒；目前没有列表事件流），标签页角标是等你的 agent 标签数。没有标签时写“还没有打开的标签。”；Mac 没有浏览器（版本过旧或已关闭）时写明。
> - `+`：地址（网址、`~/路径`、`localhost:5173`；单独的端口号按本地端口发送），`// Recent`（本机输入过的地址），`// Local Servers on <Mac>`。Mac 拒绝（403）、文件不存在（404）、无法识别（400）时，原因写在地址框下方。
> - 页面：导航栏中间是地址（锁或加载中的转圈；点开可编辑，只有能操作时），右边 `⋯`（`Copy URL`、`Reload`、`Close Tab`）。下面一行是持有者：agent 小图、标签主人、它在做什么（等你时琥珀）；接手后是 `You · Taken Over from Codex`（agent 的名称，`Claude Code`、`OpenCode` 同理，同 Mac）与 `Phone Size`，接手 agent 的标签时底部说明一次（10 秒）：“接手期间你输入的内容，交还后 agent 能在页面上看到；密码请在自己的标签里填写。”；你的标签写 `You` 与位置（`Mac 上的文件`、`vite · ~/Projects/site`）；别的屏幕拿着时写 `On Mac` 等。画面按比例放进画面区、顶端对齐；agent 最后一次操作画成青色框与标签（`Codex · click "Merge pull request"`），框按帧的 `scale` 从页面 CSS 像素换算，接手后不画。底栏 `‹` `›` `↻`、键盘；agent 的标签（以及别的屏幕拿着的标签）多 `[ Take Over ]` / `[ Hand Back ]`，agent 等你时 `[ Take Over ]` 为琥珀底。
> - 手势：点 = 左键单击，长按 = 右键单击，单指拖 = 滚轮（跟随手指，松手后按速度再滚几次），双指捏合 = 只缩放手机上的画面（双指拖动平移，右上角 `2.0×` 点一下复原）。坐标换算到所瞄准那一帧（`seq`）的帧像素。不能操作时（agent 的标签未接手、别的屏幕拿着）不发送，页面底部说明一次。
> - 打字：一个看不见的输入框接住系统键盘；已确定的文字作为 `text` 发出（中文等输入法选定后才发，选定前的拼音显示在键帽条末尾），空框里的退格与回车作为按键发出。键帽条在打字时出现在底栏上方：`esc` `tab` `⏎` `⌫` `←` `→`（终端页的键帽，收窄）与 `Fill Ciphertext`（只在你自己的标签上）：从手机上保存的密文中选一条（选择框标题 `Fill Ciphertext`），`POST /browser/tabs/:id/fill {token}`；Mac 回 404 时先读 `GET /browser/tabs/:id`：标签还在才说明需要更新、之后不再显示，标签已关闭则写“此标签已关闭。”；Mac 的拒绝原样显示（如 400 “只能填入密码或验证码输入框。”）（手机上没有密文时先打开新建密文）。
> - 尺寸有主：你的标签在这台手机上打开、且没有别的屏幕拿着时，手机接手并把视口设为画面区域（点、`mobile: true`、屏幕的像素比）；接手空闲到期后，下一次操作再接手。agent 的标签只看，`[ Take Over ]` 后同样设视口。离开页面、切到其他标签页、进入后台、`[ Hand Back ]` 都会交还（Mac 恢复默认尺寸）；离开时仍在途中的接手，回来后立即交还、不设尺寸（再次进入时的接手等这次交还发出后再发）。两分钟无操作被交还时页面说明“2 分钟无操作，已自动交还。”（同 Mac）。键盘弹出不改视口：画面保持大小并上移，让刚点过的位置露出来（手机浏览器的做法）；之后只在变宽或变高时重发尺寸。手机的屏幕 id 与终端相同（`phone-…`，`PhoneScreen`）。
> - 画面流：页面不可见、应用进入后台即断开；断线时左上角 `Reconnecting`，按退避重连；帧在主线程之外解码（ImageIO，`BrowserFrameDecoder`），解码期间到来的帧只留最新一帧；连接与页面之间的缓冲同样只留一帧最新的画面，其他事件按序、至多 64 个（`BrowserEventBuffer`）；画面流因断线以外的错误结束时写明原因，回到前台即重新连接；`closed` 时在画面上盖一层说明（“此标签已关闭。”、浏览器意外退出、服务已停止）与 `[ Back ]`。
> - 图标：11×11 的像素地球（2 点一格）；导航栏标题旁是 1 点一格的同一张。
> - 调试演示：`-uiDemo YES -uiDemoScreen browser|browserpage|browsertook|browserfile|browserlocal|browserdenied|browsernew|browserclose`，画面是手机上画的假页面。
> - 与演示页的不同：页面内外部链接的确认框（`Open Link`）与本地页面的 `[ Load ]` 横条未做（服务端尚未提供）；`Open on Mac` 未做；`⋯` 在导航栏而不在底栏；`Fill Ciphertext` 不判断焦点是否在输入框（服务端不报告焦点），填不进时由 Mac 说明原因。未在真机和真实的 Mac 浏览器上验证；帧是 CSS 尺寸，在 3 倍屏上偏软（§5 高像素比）。

**Mac**：主窗口第三页 `Browser`，左栏标签列表（同手机的分组），右边画面，键盘鼠标直接转发（完整键盘、拖放上传仍拒绝）；换页同样是扫描线刷新（dispatch-v0 §1）。待定：也可以不画画面，而是让它成为一个真正的 Chrome 窗口（§4）。

- **Mac 页已完成（2026-10-02）**：代码在 `packages/mac-app/Sources/AgentSwitchMac/Browser/`（页面、屏幕视图、页面模型）与 `Sources/AgentSwitchMacCore/Browser/`（接口、画面流、坐标换算、输入与按键、文字，有单元测试）。按演示页画：左栏按持有者分组（`// codex · AgentSwitch`，前面是 agent 的像素图），每行是状态标记（busy 转圈、waiting 琥珀闪烁、idle 空心）、标题、位置（等你时前面是琥珀色的等待原因）；右键 `Close Tab`。右边是地址栏（`‹ › ↻`，https 带锁，点击可编辑，↩ 前往，加载中 `↻` 换成转圈）、画面（JPEG 帧等比缩放、顶部对齐；agent 最后一次操作画成青色框与 `codex · click "…"`）、底栏（持有者、等待原因、`[ Take Over ]`——等你时为实心——或 `[ Hand Back ]`、此 Mac 接手时为信号色的 `You · Taken Over from Codex`，agent 写它的名称）。顶栏标题是当前标签的标记与标题，右侧是 agent 正在操作与等你的标签数和 `+`。空页面写“还没有打开的标签。”与 `[ + New Tab ⌘T ]`。
  - 输入：指针移动（合并发送，至多约每秒 30 次）、三个键的按下与抬起（含点击次数）、拖动、滚轮与触控板，坐标为帧像素并带帧的 `seq`；画面有焦点时，命名键与 ⌘ / ⌃ 加字母按键发送，其余字符经系统文本输入，输入法组字时在最后点击处显示，提交后按文本发送。⌘V 读取 Mac 本机的剪贴板并按文本输入（剪贴板不离开这台 Mac，不涉及服务端不转发粘贴所防的手机读取 Mac 剪贴板）；⌘C、⌘X 不可用，底栏说明画面中的内容无法复制。屏幕 id 为 `mac-main`。agent 的标签未接手时，点击、按键与滚动不发送，底栏写明原因。鼠标侧键（第 4、5 键）为后退、前进，不作为中键点击。切换标签、画面失去键盘焦点时，输入法未提交的组字一并丢弃，不带到别的标签。
  - 接手后把标签尺寸设为画面区域的大小（点即 CSS 像素，`scale` 为屏幕倍率），窗口改变大小后 0.3 秒跟随；交还后由服务端恢复默认尺寸；切换到其他标签或关闭窗口时，交还此 Mac 接手的所有标签（2026-10-02 前只交还画面上的那个）。底栏的说明：2 分钟无操作为“2 分钟无操作，已自动交还。”，被其他屏幕接手为“此标签已由其他屏幕接手。”，自己按 `[ Hand Back ]` 不说明；接手 agent 的标签时说明一次（10 秒）“接手期间你输入的内容，交还后 agent 能在页面上看到；密码请在自己的标签里填写。”。
  - 新标签：`+`（顶栏、⌘T、空页面）打开浮框：地址、最近打开的地址（只保存协议、主机、端口与路径，去掉查询、片段与账号信息，因其可能含令牌）、Mac 上正在监听的本地服务。
  - 快捷键：⌘⇧B 切到 Browser；⌃⇥ / ⌃⇧⇥ 在三页间向后 / 向前循环；Browser 页上 ⌘T 新标签、⌘L 地址栏、⌘R 重新加载、⌘[ ⌘] 后退与前进，⌘1–9 仍切到终端。
  - 与原设想的差异：标签列表在本页显示时每 2 秒轮询；窗口可见但停在其他页时每 6 秒轮询一次，仅用于顶栏 `Browser` 后的标记（服务端尚无列表事件流，`GET /live` 也不含浏览器）；窗口不可见或关闭时都停止。画面流只在本页显示且窗口可见时连接；服务端拒绝画面流（断线与 404 以外）时不随每次轮询重连，而是 2 秒起加倍、至多 1 分钟后再试，原因只说一次（`BrowserStreamRetry`）。帧仍为 CSS 尺寸（§5 的 screencast 限制），在 Retina 屏上略模糊。
  - `Fill Ciphertext`（2026-10-02 接入 §6 的 `POST /browser/tabs/:id/fill`）：当前标签是你自己的、此 Mac 可操作（无人接手或此 Mac 接手）且页面为 http(s) 时（2026-10-02 起 agent 的标签即使接手也不显示，§6），底栏在 `[ Hand Back ]` 前显示 `[ Fill Ciphertext ]`，点击打开表单（主窗口的系统表单，样式同 Dispatch 的 `New Ciphertext`）。粘贴一条完整的 `enc:v1:` 密文后按 `Fill`，发送 `{token, screen: "mac-main"}`；引用（`enc:ref:`）属于某次任务，服务端不接受，表单中写明，发送前即拒绝。`New…` 切换为新建密文：名称、站点（预填当前页面的 host[:port]）、值（安全输入框），由此 Mac 的凭据网关加密（`GateSeal`：`secret-gate enc --batch`，值经 stdin 传入，用途 `http` + `fill`），加密后立即填入；加密期间表单被关闭则不填入。值只存在于安全输入框中，发送、取消或表单关闭时清空，不写日志。成功后表单关闭，底栏显示 `Filled <label> · <host>`（4 秒）。失败时表单保留并写出原因：网关的原因与服务端的中文说明原样显示（如 400 “只能填入密码或验证码输入框。”）；服务端只给出代码的情况（标签已关闭、请求体无效、服务版本过旧而无此路由）由 Mac 写成正式中文。密文保留在输入框中（新建的密文亦保留，无需重新输入值），处理后可再按 `Fill`。填入的始终是打开表单时的标签。与手机相同，不判断焦点是否在输入框（服务端不报告焦点），未点选输入框时由服务端说明原因。代码：Core 的 `Browser/BrowserFill.swift`（响应、密文检查、原因的说法），测试 `BrowserFillTests.swift`；界面 `Browser/BrowserFillSheet.swift`。未在真实的网关与 Chrome 上验证。
  - 验证：`-designPreview` 生成 `main-browser*.png`（`-designPreviewOnly browser` 只画这一页；`main-browser-filled` 为你的本地开发服务页面填入后的底栏，`main-browser-held` 为接手 agent 标签后的底栏与说明，`main-browser-fill`、`main-browser-fill-new` 为 Fill Ciphertext 的表单）；`-browserProbe <dir>` 对一次性服务打开本地测试页，点击、按键、中文提交、回车、接手（尺寸变为画面大小）与交还均已通过。

**入口**：终端里点路径（Mac ⌘-点击、手机点）→ `Open in Browser`；任务的 HTML 文件 → 在 Browser 里打开（同目录的资源一并可用）；Dispatch 记录里的链接 → Browser。

## 2. 结构

- **浏览器宿主**：daemon 看护的一个常驻 Node 进程（`browser-host`）。用 Playwright 以管道方式（`--remote-debugging-pipe`，Playwright 的默认）启动用户已装的 Chrome（同现在的执行器浏览器），不开调试端口。
  - 一个常驻的“你的”配置（`$AGENTSWITCH_HOME/browser-profiles/main`）：你开的标签和终端里的 agent 都在这里，登录态共用。
  - 调度任务的会话槽（threads-v0 §4b，三个配置）照旧隔离，但也在宿主里启动，所以同样能在 App 里看与接手。
  - 密码管理器与自动填充照旧关掉（`browserSlots.ts` 的做法）。
- **给 App（人）**：daemon 经宿主取画面——CDP `Page.startScreencast`（JPEG，按连接调帧率与质量：局域网 15–30 帧，Tailscale 中转降到 5 帧、降质量）——并发输入（`Input.dispatchMouseEvent`、`Input.insertText`、按键）。接口：`GET /browser/tabs`、`POST /browser/tabs`（打开网址、路径或本地端口）、`GET /browser/tabs/:id/stream`（画面流）、`POST /browser/tabs/:id/{input,navigate,take,release,close,fill}`、`GET /browser/servers`（Mac 上监听的本地服务）。加入远程白名单，手机经配对连接（钉证书指纹）用。
- **给 agent**：宿主用 Playwright MCP 的库接口（`createConnection`，传入宿主自己的浏览器上下文）为每个 agent 会话开一个 MCP 连接，只能看见与操作它自己的标签。agent 那边的浏览器工具 = `secret-gate browser -- agentswitch browser-mcp --session <id>`：网关在外层，下游是连到宿主的一座小桥，所以网关的每条规则原样生效。
  - Codex：终端里写进会话配置的 `mcp_servers`（terminal-v0 §3 的做法），调度任务里同现在（app-server 的 MCP 配置）；Claude Code、OpenCode 同理。
  - 会话凭证：宿主给每个 agent 会话发一个只能连它自己标签的令牌，经网关进程的环境传入，不进模型上下文；会话结束即作废。
- **安全**：
  - 浏览器没有调试端口，只有宿主持有管道；宿主的连接要会话令牌。调度的任务照旧有禁区表挡住宿主的令牌与套接字，只能经网关的工具；终端里的 agent 与你是同一个用户、能读 AgentSwitch 的数据（terminal-v0 §3 的决定），对它们这只挡随手直连，不是边界（同 gate-service-v0 对同一 uid 的说明）。
  - 你接手时，agent 对该标签的操作排队（超时返回“用户正在使用此标签”）；你打的字直接进页面、不经过模型。接手期间页面发出的请求与控制台消息，交还后 agent 读不到（§6）；但交还后 agent 的快照能看到页面上显示的内容——密码框照旧遮住，其他输入框里手打的字看得到。`Fill Ciphertext` 只在你自己的标签里、只填密码或验证码输入框（§6）；agent 的标签里需要登录时，请 agent 用 `secret_fill`，或在你自己的标签里登录（登录态共用）。
  - `file://` 只有人能开（agent 的工具照旧只允许 http(s)）。看不了的：执行器的完整禁区表（`defaultProtected`）加上常见凭据（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/Library/Keychains`、`.env*`、`*.pem`、`*.key`、`*.p12`、`*.priv`、`id_*`、`.netrc`、`.npmrc`、`.pypirc`、`credentials*`）与 AgentSwitch、网关文件夹的副本，宿主在导航前按真实路径与文件身份检查（§5 规则），被挡时页面写明原因。
  - 本地开发服务：只列当前用户在 127.0.0.1 / ::1 上监听的端口，去掉 AgentSwitch 自己的（本地接口、远程、网关代理、调度用与各终端的 OpenCode 服务）。
  - 画面流只给配对设备；打开、接手、交还、填入记审计。

## 3. 分期

1. 设计稿与演示页 `browser.html`，给用户看。
2. 宿主 + 画面流 + 输入 + Mac 的 `Browser` 页（本机先通）；测试（标签归属、接手与排队、`file://` 范围与凭据名单、管道而非端口）。服务端已完成（2026-10-02，§5）；Mac 的 `Browser` 页已完成（2026-10-02，§1 Mac）。
3. agent 接入，Codex 先行：MCP 桥、网关包裹、终端会话配置、接手与交还；用 echo / 假 agent 测，不打真模型；真模型的验证脚本放 `scripts/`。服务端已完成（2026-10-02，§6）：终端里的 Codex、Claude Code、OpenCode 都已接入；人的 `Fill Ciphertext` 一并完成。
4. iPhone 的 `Browser` 标签、实时活动、入口（终端路径、任务文件、链接）。标签已做（2026-10-02，§1）；实时活动与入口未做。
5. 调度任务的会话槽迁到宿主。

## 4. 已定（2026-10-02，用户：浏览器设计的不错，可以按照设计实现）

1. 手机上是第三个标签页 `Browser`。
2. Mac 上是主窗口第三页（画面），不弹 Chrome 窗口。
3. 终端里的 agent 与你共用 `main` 配置和登录态。
4. 调度的任务暂时照旧用隔离的三个槽（§3 第 5 步再迁进宿主，届时再定是否共用你的配置）。
5. 页间切换的效果（Dispatch · Terminals · Browser）是扫描线刷新，不是换台（dispatch-v0 §1，同日改）。

## 5. 第 2 步服务端（2026-10-02 已完成）

代码在 `packages/daemon/src/browser/`（宿主、规则、画面流、输入、本地服务、审计）与 `src/api/browser.ts`。Mac 与 iPhone 的界面、agent 接入是后面的步骤。

- **宿主**：daemon 进程内的 `BrowserHost`，不是 §2 写的单独 Node 进程（与终端一样由服务持有，少一层进程间协议；Chrome 本身仍是单独进程）。`playwright-core` 固定为 `1.64.0-alpha-1789764292000`，即网关所用 Playwright MCP 0.0.82 依赖的版本，第 3 步用 MCP 的库接口时两者共用一份。以 `channel: "chrome"` 启动用户已装的 Google Chrome，新无头模式，持久配置 `$AGENTSWITCH_HOME/browser-profiles/main`，经 `--remote-debugging-pipe` 连接，无调试端口（冒烟脚本核对命令行，并用 `lsof` 确认该配置的 Chrome 进程无 TCP 监听）。Chrome 沙箱开启，下载一律拒绝，密码管理器与自动填充关闭（同会话槽的 `disablePasswordManager`）。第一次打开标签时启动；无标签 10 分钟后关闭；Chrome 意外退出时，所有画面流收到 `closed`，下次打开标签时重新启动；每次启动前先停掉仍占用该配置的旧 Chrome。`AGENTSWITCH_BROWSER_HOST=0` 关闭整个浏览器。Playwright 位于 `BrowserDriver` 接口之后，测试使用假实现。
- **标签**：持有者 `{kind: you|terminal|task, id, label}`，人打开的标签为 `you`；页面弹出的窗口归同一持有者。状态 `idle|busy|waiting` 与 agent 的最后操作 `{tool, description, box?, at}`（`box` 为视口像素，与输入坐标同一坐标系）由 agent 桥设置（`setStatus`、`setAction`，第 3 步）。
- **接手**：任何标签都可接手；`heldBy` 为屏幕 id（`mac-…`、`phone-…`），未给出时为配对设备 id 或 `local`。被接手的标签只有接手方可输入和导航；agent 的标签未被接手时，人不可操作（409）。交还或接手方 2 分钟无输入后结束。尺寸只由接手方设置，接手结束时恢复默认 1280×800；另一块屏幕接手时同样先恢复默认（尺寸有主）。agent 调用的排队属第 3 步。
- **画面流**：CDP `Page.startScreencast`（JPEG）。同一标签的多个流共用一个 screencast：质量取最高值；`maxWidth`、`maxHeight` 仅在所有流都给出时生效；每个流按自己的帧率（默认 15，最多 30）接收，只拿最新一帧；回执按最快的流节制。实测 Chrome 154 的帧始终为视口的 CSS 尺寸，与设备像素比无关，因此 `scale` 通常为 1（`maxWidth` 限制时小于 1）。导航之后再改尺寸，Chrome 不再产生新尺寸的帧，因此每次改尺寸后重启 screencast。
- **标题**：Chrome 的目标列表报告标题变化很晚或不报告，改为在页面加载后、重绘后以及每 2 秒读取一次（在 Playwright 的隔离环境中读取，页面无法干预）。
- **规则**（`src/browser/rules.ts`，名单只在此处定义，有测试）：人可打开 http(s)、`about:blank`、`file://` 路径与 `localhost:<端口>`；agent 只可 http(s) 与 `about:blank`。`file:` 路径按原样与 `realpath` 各检查一次（`..` 与符号链接都会被识破），比较不区分大小写：执行器禁区表（`defaultProtected`，含禁读路径；`work`、`artifacts`、`uploads` 照旧可用），凭据目录 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.config/gh`、`~/Library/Keychains`，另加 `~/.kube`、`~/.azure`、`~/.docker`、`~/.password-store`、`~/.config/gcloud`（单层的点目录在任何位置都拒绝），凭据文件名 `.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_*`（不含 `.pub`）、`.netrc`、`.npmrc`、`.pypirc`、`.git-credentials`、`.pgpass`、`credentials*`。拒绝时接口返回 403 与原因。浏览器内每个 `file:` 请求和每个发往本机的请求都先经宿主检查：被拒的导航显示原因页（`[!] Not Viewable`），被拒的子资源不加载。新增一条：AgentSwitch 自己的端口（本地接口、远程、OpenCode、网关代理）任何标签都不可打开，因为 `main` 配置之后与 agent 共用，不应存有控制台的登录。
  - 2026-10-02 安全审查后补：路径除按原样与 `realpath` 比较外，还按文件身份（设备号与 inode）逐层比较其上各级目录，规范写法另去掉数据卷前缀（`realpath` 会保留 `/System/Volumes/Data/Users/…` 这种写法，此前借此可打开 `$AGENTSWITCH_HOME/local-token`、`~/Library/Keychains`、`~/.config/gh/hosts.yml`），大小写、符号链接、数据卷写法都落到同一处（`src/core/paths.ts`，执行器的禁区检查共用）。凭据文件名加 `*.priv`；`.agentswitch`、`.secret-gate` 与 AgentSwitch 家目录、网关家目录的名字（点目录按名字，其他按最后两级，如 `Application Support/AgentSwitch`）在别处出现也拒绝（备份、副本），真正的家目录里仍按禁区表（`work`、`artifacts`、`uploads` 可开）；名为 `AgentSwitch` 的项目目录不受影响。
  - AgentSwitch 自己的端口（纵深防御，同日补）：主机名先规范化（小写、去掉方括号与末尾的点，`localhost.` 同 `localhost`）；发往这些端口的请求不论主机名都经宿主检查，主机名解析到本机地址的也拒绝（`dns.lookup`，2 秒为限，解析失败按非本机）；端口包括本地接口、远程、网关代理、调度用的 OpenCode 与此刻运行的所有 `opencode serve --stdio`（执行器常驻的与各终端的伴随服务）。跳转：Playwright 不让路由看到跳转的下一跳，所以每个页面另经 CDP `Network.setBlockedURLs` 让 Chrome 自己拦下发往这些端口（127.*、`localhost`、`*.localhost`、`[::1]`、`0.0.0.0`）的请求，跳转来的子资源也拦（端口变化 2 秒内跟上）；跳转来的页面导航 Chrome 不拦，宿主看到即停止加载、显示原因页，但请求已到达服务（冒烟脚本实测）。Chrome 自己解析主机名，DNS 重绑定绕得过名字检查；这些服务本身各有凭证。弹出窗口的第一次导航发生时页面尚不存在，无法查到持有者；Chrome 不允许 http(s) 或空白页打开本地文件，所以发往 `file:` 的这类导航只能来自 `file:` 页面，即人的标签，按人的规则检查。
- **本地服务**：`lsof` 列出当前用户在 127.0.0.1、::1 与所有接口（`*`，如 `next dev`）上监听的端口，只保留在用户自己文件夹中运行的程序（与 §2 的差异：聊天、代理等应用的回环端口在 `/`、`~/Library` 容器或应用包内运行，列出无用），并去掉 AgentSwitch 自己的（上述端口、daemon 及其子进程、打包的应用、网关代理、`opencode serve --stdio`）。只返回程序的短名，不返回完整命令行（可能含令牌）：可执行文件的名字；解释器（node、python 等）另取它运行的脚本名（带脚本扩展名的文件或 `bin` 目录下的文件，取文件名）或 Python 的 `-m 模块名`；命令行里的其他词一概不取（2026-10-02 审查：原先会把选项的值当成名字）。
- **审计**：`$AGENTSWITCH_HOME/browser/audit.jsonl`，记录打开、导航（网址去掉查询与片段；路径；端口）、关闭、接手、交还（含 2 分钟到期，`via: daemon`）、拒绝及原因。输入的文字不记录。
- **接口**（本地与远程白名单相同；`screen` 均可省略）：
  - `GET /browser/tabs` → `{running, groups: [{owner, tabs: [Tab]}]}`，组的顺序为终端、任务、你。`Tab` = `{id, owner, title, url, site, kind: web|file|local|blank, status, loading, heldBy, action, viewport: {width, height, scale, mobile, by}, openedAt}`。`GET /browser/tabs/:id` → `{tab}`。
  - `POST /browser/tabs` `{url}`（地址栏原文：网址、裸域名、`localhost:5173`、`/路径`、`~/路径`）| `{path}` | `{port}` → 201 `{tab}`；拒绝 403、文件不存在 404、无法识别 400，均为 `{error}`。`DELETE /browser/tabs/:id` → `{ok}`。
  - `GET /browser/tabs/:id/stream?quality=1..100&fps=1..30&maxWidth=&maxHeight=`（默认 70、15）→ SSE，事件名即 `type`，`data` 为 JSON：先 `tab {tab}`；之后 `frame {seq, data (JPEG base64), format, width, height, scale, viewport: {width, height}, pageScale, scrollX, scrollY}`（SSE `id` 为 `seq`）、`url {url, site, kind}`、`title {title}`、`loading {loading}`、`status {status}`、`held {heldBy, reason: take|hand-back|idle}`、`action {action}`、`viewport {viewport}`；`closed {reason: closed|browser-exited|shutdown}` 后流结束；每 10 秒一行注释 `: ping`。
  - `POST /browser/tabs/:id/input` `{screen?, events: [...]}`（最多 50 个），或单个事件加 `screen`：`{type: "mouse", action: move|down|up|click, x, y, button?: left|right|middle, clickCount?: 1..3, modifiers?, seq?}`、`{type: "wheel", x, y, deltaX?, deltaY?, modifiers?, seq?}`、`{type: "text", text}`（`Input.insertText`）、`{type: "key", key, modifiers?}`（`Escape` `Tab` `Enter` `Backspace` `Delete` 方向键 `Home` `End` `PageUp` `PageDown`，以及 `a`–`z` 用于组合键）。坐标为帧像素（`seq` 指定哪一帧，默认最新），除以 `scale` 得视口像素；`modifiers` ⊆ `Alt` `Control` `Meta` `Shift`。Mac 上的编辑命令随键发送（复制、剪切、粘贴除外）。
  - `POST /browser/tabs/:id/navigate` `{url} | {path} | {port} | {action: back|forward|reload}`（加 `screen?`）→ `{tab}`。
  - `POST /browser/tabs/:id/take`、`/release` `{screen?}` → `{tab}`；交还他人的接手 409。`POST /browser/tabs/:id/viewport` `{width, height: 200..4096, scale?: 0.5..4, mobile?, screen?}` → `{tab}`，未接手 409。
  - `GET /browser/servers` → `{servers: [{port, bind: loopback|all, pid, name, cwd, url}]}`。
  - `POST /browser/tabs/:id/fill` `{token, screen?}` → `{tab, filled: {label, host}}`（第 3 步加入，§6）。
- **测试**：`tests/browser{Rules,Input,Screencast,Host,Servers,Api}.test.ts`（假 Chrome，不调用模型）；`scripts/browser_smoke.ts` 在临时目录中用真 Chrome 运行一遍（`npx tsx scripts/browser_smoke.ts`，不在 `npm test` 中）。
- **未做**：两端界面（第 2、4 步）、本地页面拦截外部资源（演示页的 `[ Load ]`）、页面对话框（alert 等目前由 Playwright 自动关闭）与文件选择、标签列表的事件流（目前轮询 `GET /browser/tabs`）、Chrome 意外退出后恢复原有标签、高像素比的画面（受上述 screencast 行为限制）。

## 6. 第 3 步服务端：agent 接入与人的填入（2026-10-02 已完成）

代码在 `packages/daemon/src/browser/`（`agents.ts` 会话与调用、`agentMcp.ts` Playwright MCP 与上下文替身、`bridgeClient.ts` 桥、`fill.ts` 人的填入）、`src/api/browserAgents.ts`、`src/terminals/launch.ts`，网关一侧是 `secret-gate fill-value`（`packages/secret-gate/secret_gate/fill_cli.py`）。

- **路径**：agent 的浏览器工具 = `secret-gate browser -- <桥>`。桥是 `node bridgeClient.js --url http://127.0.0.1:<端口> --session <id> --token-file <文件>`（用服务自带的 node 运行，同终端的 hook 命令；手动可用 `agentswitch browser-mcp`）。它把 MCP 原样转到本机接口：`GET /browser/agent/mcp` 开一个连接（SSE：先 `endpoint {connection}`，之后每个 `message` 事件是给 agent 的一条 JSON-RPC），agent 的每条消息 `POST /browser/agent/mcp/:connection`。只在本机，不在远程白名单；本机令牌检查对这两条路由放行，由路由核对会话令牌（同 hook 路由）。网关给下游加的 `--output-dir` 桥照收不用。
- **Playwright MCP 在 daemon 进程里**：用它的库接口 `createConnection(config, contextGetter)`（`@playwright/mcp` 0.0.82 导出的正是 playwright-core 的 `tools.createConnection`，与宿主驱动 Chrome 的是同一份），每个桥进程一个连接，经内存传输对接。它的工作区根与输出目录是这个连接自己的 `$AGENTSWITCH_HOME/browser/agents/<会话>-<连接>/`（0700；daemon 声明 roots 能力并自己回答 `roots/list`），每次调用后清空，连接结束即删除。`$AGENTSWITCH_HOME/browser` 整个对调度的执行器禁读（`protected.ts`）。
- **隔离：上下文替身，而不是从 `main` 播种的第二个上下文**。决定 3 要终端里的 agent 与你共用登录态；同一个上下文里 Cookie、本地存储、IndexedDB、Service Worker 双向实时共用，无需来回同步，也不会有两份登录态漂移。Playwright MCP 拿到的 `BrowserContext` 是 `AgentContext`：`pages()` 与 `page` 事件只含这个 agent 自己的标签及其弹出窗口；`newPage()` 经宿主开成它的标签（持有者 `{kind: "terminal", id: <终端 id>, label: "codex · <文件夹>"}`，Claude Code 写作 `claude`）；路由、初始化脚本、Cookie、存储、权限、CDP 等作用于整个配置的调用一律抛错，`browser()` 为空，调试器只回“未暂停”。Playwright MCP 升级后若伸手更多，结果是失败，而不是碰到人的或别的 agent 的标签。当前标签取自 Playwright MCP 自己的 `tools.Tab.forPage(page).context`（每个连接认自己的）。
- **会话令牌**：终端启动时 daemon 为它的 agent 发一个会话（id + 32 字节令牌），令牌写进 `$AGENTSWITCH_HOME/browser/sessions/<id>.token`（0600），桥从文件读。与 §2 的差异：不经网关进程的环境传入——Codex 的会话配置只能用 `-c` 命令行覆盖（`ps` 可见）或把变量放进它的环境（随即进入它跑的每条命令，`env` 一下就进了模型上下文），文件把令牌挡在命令行、环境和模型上下文之外。令牌只对这个会话有效；终端的程序退出即作废、连接断开、标签转为空闲；终端被删除时它的标签一并关闭；daemon 重启时清空。
- **调用**：同一会话的调用逐个按序执行（多个桥进程也排同一队）。调用前定出它作用的标签（Playwright MCP 的当前标签；`browser_tabs` 的 select / close 取对应序号）：有人接手时排队等待，交还后按序继续，2 分钟未交还即失败，给模型的话是 “The user is using this tab in AgentSwitch …”，调用不执行。新连接在第一次调用前 Playwright MCP 还没有当前标签：按它将选中的那个（这个 agent 的第一个标签）判断，判断不了时等这个 agent 的所有标签都无人接手；定位元素的框、交还后的缓冲（见下“接手期间的网络与控制台”）之后、交给 Playwright MCP 之前再查一次，期间被接手就回去等（2026-10-02 审查：原先新连接与这段间隙都会跳过接手）。执行时标签状态为 `busy`，结束后 `idle`；同时设置 `action {tool, description, box?}`：`description` 只取元素描述、按键名、网址的域名（`click "Merge pull request"`、`type into "Password"`、`open github.com`），从不取输入的文字（网关之后那是明文），密文写作 `[ciphertext]`；`box` 是 Playwright MCP 按同一个 ref 或选择器定位到的元素，页面 CSS 像素。网关自己的探测（`browser_evaluate`、`browser_run_code_unsafe`）与读日志类调用不改动作。第一次开出标签时，结果末尾加一句它开在哪个标签、人在 AgentSwitch 里看得到并可接手。agent 的开标签与导航（去掉查询与片段）记审计，`via: "agent"`；工具参数不记日志、不进审计。
- **桥自己的拒绝**（不论调用方是否经过网关）：任何 `filename`、`paths` 参数；`browser_navigate`、`browser_tabs new` 只放行 http(s) 与 `about:blank`，AgentSwitch 自己的端口不放行（宿主对每个请求另有检查）；`browser_resize` 不提供（尺寸归屏幕）；`browser_close` 只关这个 agent 的标签，被接手的等交还后再关，2 分钟未交还即失败、不关。
- **代码只有网关的探测**（2026-10-02，`src/browser/probes.ts`）：`browser_run_code_unsafe` 在 daemon 的 Node `vm` 里执行，拿到真实的 `page`（`page.constructor.constructor` 即 daemon 的 `Function`，`page.context()` 通向所有标签）。桥只放行与网关 `secret_gate/browser_probe.py` 四个模板（字段状态、frame 链、表单去向、遮罩截图）逐字相同的代码，模板中间只能是 JSON 字面量并按模板核对类型（目标 1–500 字；遮罩截图恰好六个键，路径为绝对路径、无 `..`、文件名 `secret-gate-mask-<16 位十六进制>.png`）；`browser_evaluate` 只放行 `() => location.href`。其余一律拒绝。模板在桥里有一份副本：网关的测试固定模板生成的代码，daemon 的测试在网关环境在时用网关自己生成的代码核对桥的检查；改模板须两边一起改。
- **终端会话配置**（terminal-v0 §3）：Codex 是 `-c mcp_servers.browser.{command,args,env,tool_timeout_sec}`（工具超时 300 秒，Codex 默认 60 秒，等接手要更久），Claude Code 是 `--mcp-config` 里 secret-gate 旁边的 `browser`，OpenCode 是 `OPENCODE_CONFIG` 里的 `mcp.browser`。只在网关可用时加（不给 agent 未经网关的浏览器）；pi 没有 MCP，不加；`AGENTSWITCH_BROWSER_HOST=0` 时不加。调度的任务照旧用会话槽（决定 4）。
- **人的 Fill Ciphertext**：`POST /browser/tabs/:id/fill` `{token, screen?}`。只在人自己的标签上（持有者 `you`）：agent 的标签即使接手也 409“Agent 的标签不可填入密文：填入的值会留在页面中，交还后 agent 可能读到。请在你自己打开的标签中填入。”（2026-10-02 审查：值留在页面、存储与页面发出的请求里，网关不知道这个值，不会替 agent 脱敏）。只有能操作这个标签的屏幕可用（接手方；无人接手时任何屏幕）。宿主在 Playwright 的隔离环境里按 `:focus` 找出焦点所在的可编辑输入框（不含 iframe 元素与下拉框），取它所在 frame 及每一层上层 frame 的 URL，任何一层不是 http(s) 即拒绝；只填密码框或标为密码、验证码的输入框（`input[type=password]`，`autocomplete` 含 `current-password`、`new-password`、`one-time-code`），其余 400“只能填入密码或验证码输入框。”（画面流会把其他输入框的文字原样显示到手机上；验证码框照样显示，验证码短时有效）；`secret-gate fill-value`（stdin `{token, urls}`，stdout `{value, label}`）按网关的 `page_host` 与密文策略逐层核对，用途 `fill`（装了网关服务时为 `browser.resolve`，只认 `fill`）；回答后打进检查过的那个元素本身（元素句柄；Playwright 的 `fill`，替换输入框原有内容），焦点已换到别的元素、frame 链变了或元素已不在则不填（原先是 `Input.insertText` 打进当时有焦点的元素，回答期间点到别的输入框就会填错地方）。响应为 `{tab, filled: {label, host}}`；没有焦点输入框、不是密码或验证码输入框、请求体不对 400，非 http(s) 或网关拒绝 403（网关的原因原样给人），agent 的标签、不是接手方或焦点变了 409，没有网关 503。值不出现在响应、日志、审计里；审计记 `fill` 的 label 与 host，拒绝记原因。
- **接手期间的网络与控制台**（2026-10-02，`src/browser/heldTraffic.ts`）：Playwright MCP 按标签保存网络请求（含请求体：人在 agent 的标签里手动登录时，POST 带着密码）并读页面的控制台，交还后 `browser_network_requests`、`browser_network_request`、`browser_console_messages` 会交给 agent；重新连上的桥（新的 MCP 连接）还会从页面自己的记录（`page.requests()`、`page.consoleMessages()`）重建。现在 daemon 从 agent 标签打开起，不论有没有 agent 连着，记录每次接手的起止，以及接手期间与交还后 1.5 秒内页面发出的每个请求（点了提交马上交还时，请求稍后才到 Playwright）；Playwright MCP 为 agent 页面建的每个标签对象（新连接的也一样）在被使用前加一层过滤：请求列表去掉这些请求和开始时间落在接手期间的，控制台去掉接手期间的消息（计数一并），接手期间不再记录新的请求、不往控制台日志文件里写；页面错误不带时间，交还 1.5 秒后从页面清掉（之前的一并清掉）。agent 交还后的下一个调用先等过这 1.5 秒。依赖 Playwright MCP 0.0.82 `Tab` 的内部成员（`requests`、`consoleMessages`、`consoleMessageCount`、`_handleRequest`、`_handleConsoleMessage`），测试用它自己的 `Tab` 类固定；不符合预期时，接手过的标签这三个工具一律拒绝（“The user used this tab in AgentSwitch; its network requests and console messages are not available to agents.”）。仍看得到的：页面本身——交还后快照里非密码输入框中手打的字、页面显示或存下的内容；页面在交还之后自己再发的请求（如延迟提交）；接手期间标签列表里的标题与网址。
- **两端的 Fill Ciphertext（2026-10-02）**：人只在自己的标签（owner `you`）上填入——agent 的标签即使接手也不显示（交还后 agent 的快照能看到页面，服务端随之回 409）；只填入密码与一次性验证码输入框，其他输入框服务端回 400 “只能填入密码或验证码输入框。”，Mac 与 iPhone 原样显示。接手 agent 的标签时两端各说明一次：“接手期间你输入的内容，交还后 agent 能在页面上看到；密码请在自己的标签里填写。”
- **未处理的 rejection**：Playwright MCP 每个连接都会监听整个进程的未处理 rejection（报给 agent，也让真正的错误不再结束进程）。daemon 在它加上时摘掉；有 agent 连接期间，Playwright 自己的（如试图保存被拒的下载）只记日志，其余照 Node 默认处理。
- **已知**：`browser_run_code_unsafe` 已限于网关的探测模板（见上），直连桥的进程仍可让 daemon 把页面截图写成任意目录下一个 `secret-gate-mask-<16 位十六进制>.png` 新文件。共享浏览器不经网关代理（同你自己的 Chrome），页面里的值只经网关的填写进入。
- **测试**：`tests/browserAgents.test.ts`（令牌、私有目录、顺序、接手排队与超时、新连接与定位期间的接手、`browser_close` 等交还、日志工具的拒绝、状态与动作、拒绝、关闭）、`browserAgentContext.test.ts`（上下文替身的隔离、新连接的当前标签、标签对象的过滤与交还后的缓冲）、`browserHeldTraffic.test.ts`（Playwright MCP 自己的 `Tab` 类：接手期间的请求与控制台不进列表、计数与日志文件，重连也一样）、`browserProbes.test.ts`（模板放行、逃逸尝试拒绝、与网关生成的代码核对）、`browserBridge.test.ts`（真 HTTP 上的桥与令牌）、`browserFill.test.ts`（只在人的标签、只填密码与验证码输入框、焦点变了不填）、`browserRules.test.ts`（数据卷写法、大小写、副本与名字，真实文件）、`protected.test.ts`（执行器同样的写法）、`terminalBrowser.test.ts`；网关 `tests/test_fill_value.py`、`tests/test_browser_probe_templates.py`。`scripts/browser_smoke.ts` 在临时目录里用真 Chrome 与仓库里的 secret-gate（临时密钥，不连网关服务）走一遍：经网关导航与快照、标签归属与动作、人的标签不在 agent 列表里、`secret_fill` 填入且结果与快照里没有明文、遮罩截图（daemon 写入、网关核对）、接手时调用等待与失败、交还后继续、人在 agent 的标签里手动登录后 agent 与重连的桥都看不到那次 POST 与控制台、人的填入在 agent 的标签上被拒、填入文本框被拒、填入自己标签的密码框经 `fill-value`、数据卷写法的禁区、跳转到自己端口的子资源与导航、被拒的下载不影响 daemon、Playwright MCP 的文件每次调用后清空。没有用真模型验证（约定不打真模型）。
- **未做**：调度任务迁入宿主（第 5 步）；`waiting` 状态与实时活动（agent 等你时）；标签名跟随终端改名（目前固定为启动时的 `agent · 文件夹`）。
