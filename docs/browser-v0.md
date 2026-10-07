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
- **位置**：第三个标签页 `Browser`（Dispatch · Terminals · Browser），图标是像素地球（2026-10-03 重画：用户先说“浏览器图标有点丑”，一度换成像素狐狸，同日又说“浏览器是不是可以再换个通用点的图标，这些图标是不是分辨率可以稍微高一些，太难看了”，于是回到最通用的地球，去掉原来交叉的斜线：一个像素宽的圆、一条经线、赤道，11×11、上下左右对称；Mac 上需要细像素的地方用同样画法的 15×15，1 点一格）。
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
> - 图标：11×11 的像素地球（2 点一格）；导航栏标题旁是 1 点一格的同一张。2026-10-03 重画成更干净的地球（同尺寸、同用法，见上“位置”）。
> - 调试演示：`-uiDemo YES -uiDemoScreen browser|browserpage|browsertook|browserfile|browserlocal|browserdenied|browsernew|browserclose`，画面是手机上画的假页面。
> - 与演示页的不同：页面内外部链接的确认框（`Open Link`）与本地页面的 `[ Load ]` 横条未做（服务端尚未提供）；`Open on Mac` 未做；`⋯` 在导航栏而不在底栏；`Fill Ciphertext` 不判断焦点是否在输入框（服务端不报告焦点），填不进时由 Mac 说明原因。未在真机和真实的 Mac 浏览器上验证；帧是 CSS 尺寸，在 3 倍屏上偏软（§5 高像素比；2026-10-03 起按连接要屏幕的像素，见下）。
>
> 2026-10-03 画面按屏幕的像素（用户：浏览器能不能根据浏览器窗口大小渲染的更sharp一些？；§5 同日）：画面流多带 `scale`。局域网要屏幕的倍数（3），Tailscale 直连最多 2，中转仍是 1 倍（同日稍后改为按网速分档，见下）；质量、帧率照旧按连接，局域网与直连另以屏幕的像素为上限（中转原来就有），所以手机看 1280 宽的桌面页仍只拿屏幕那么多像素，接手后自己尺寸的页面拿到 1170×2532 这样的满像素帧。同一页面换了倍数（Mac 改画法，或 agent 点击前后，§5）只换图，不播自上而下的刷新；页面尺寸变了才播。代码：Kit 的 `BrowserPolicy.swift`（`BrowserStreamPolicy`）、`BrowserRoutes.swift`（`BrowserStreamOptions.scale`）、`BrowserModels.swift`（`BrowserFrame.pageSize`），测试 `BrowserTests.swift`；界面 `App/Sources/Browser/BrowserPage.swift`、`BrowserPageModel.swift`。未在真机上看过。
>
> 2026-10-03 Tailscale 按网速分档（用户：tailscale 直接根据网速来行了，中转有的时候比直连快）：原来按选地址时的应答时间猜直连（0.25 秒内）还是中转，直连最多 2 倍、中转 1 倍；可中转有时比直连快，应答时间也说明不了能传多少。现在 Tailscale 不分直连与中转，进入标签页时测一次网速（`GET /browser/speed`，1 MiB 不可压缩的字节，按第一块之后的字节与时间算，不计往返；最多 2 秒，到时按已收到的算，等的时间也算进去），按档要画面：
>
>   | 网速 | 质量 | 帧率 | 倍数 |
>   |---|---|---|---|
>   | 25 Mbps 及以上 | 70 | 15 | 屏幕的倍数（3），同局域网 |
>   | 8 Mbps 及以上 | 60 | 10 | 最多 2 |
>   | 更慢，或测不出（旧版 Mac 没有这条路由、收到的太少） | 45 | 5 | 1 |
>
>   都以屏幕的像素为上限。阈值依据 §5 的实测：手机自己尺寸 3 倍的帧约 209 KB，每秒 15 帧约 25 Mbps；2 倍约 100 KB，每秒 10 帧约 8 Mbps（画面一直在动时的量，静止时不出帧，所以留有余量）。测出之前先按最慢的档开流，测完档位变了再按新档开一条流、随后关掉旧的，画面不停、标签不交还也不重新接手，同一页面只换图、不重播刷新。同一地址 60 秒内再进标签页（或回到前台）沿用上次的结果，地址变了重测；同时打开的页面共用一次测量。局域网照旧（屏幕的倍数、质量 70、15 帧），不测。代码：Kit 的 `BrowserPolicy.swift`（`BrowserStreamPolicy.options(kind:mbps:…)`、`measures`，`BrowserSpeed.Meter`）、`BrowserRoutes.swift`（`browserSpeed`）；界面 `BrowserPage.swift`（`measure`）、`BrowserPageModel.swift`（`retune`）、`BrowserStore.swift`（按地址记住测得的网速）；测试 `BrowserTests.swift`（分档的边界、测速的算法、到时结束、旧版 Mac）；daemon `src/browser/speed.ts`、`tests/browserApi.test.ts`。未在真机的 Tailscale 上测过。

**Mac**：主窗口第三页 `Browser`，左栏标签列表（同手机的分组），右边画面，键盘鼠标直接转发（完整键盘、拖放上传仍拒绝）；换页同样是扫描线刷新（dispatch-v0 §1）。待定：也可以不画画面，而是让它成为一个真正的 Chrome 窗口（§4）。

- **Mac 页已完成（2026-10-02）**：代码在 `packages/mac-app/Sources/AgentSwitchMac/Browser/`（页面、屏幕视图、页面模型）与 `Sources/AgentSwitchMacCore/Browser/`（接口、画面流、坐标换算、输入与按键、文字，有单元测试）。按演示页画：左栏按持有者分组（`// codex · AgentSwitch`，前面是 agent 的像素图），每行是状态标记（busy 转圈、waiting 琥珀闪烁、idle 空心）、标题、位置（等你时前面是琥珀色的等待原因）；右键 `Close Tab`。右边是地址栏（`‹ › ↻`，https 带锁，点击可编辑，↩ 前往，加载中 `↻` 换成转圈）、画面（JPEG 帧等比缩放、顶部对齐；agent 最后一次操作画成青色框与 `codex · click "…"`）、底栏（持有者、等待原因、`[ Take Over ]`——等你时为实心——或 `[ Hand Back ]`、此 Mac 接手时为信号色的 `You · Taken Over from Codex`，agent 写它的名称）。顶栏标题是当前标签的标记与标题，右侧是 agent 正在操作与等你的标签数和 `+`。空页面写“还没有打开的标签。”与 `[ + New Tab ⌘T ]`。
  - 输入：指针移动（合并发送，至多约每秒 30 次）、三个键的按下与抬起（含点击次数）、拖动、滚轮与触控板，坐标为帧像素并带帧的 `seq`；画面有焦点时，命名键与 ⌘ / ⌃ 加字母按键发送，其余字符经系统文本输入，输入法组字时在最后点击处显示，提交后按文本发送。⌘V 读取 Mac 本机的剪贴板并按文本输入（剪贴板不离开这台 Mac，不涉及服务端不转发粘贴所防的手机读取 Mac 剪贴板）；⌘C、⌘X 不可用，底栏说明画面中的内容无法复制。屏幕 id 为 `mac-main`。agent 的标签未接手时，点击、按键与滚动不发送，底栏写明原因。鼠标侧键（第 4、5 键）为后退、前进，不作为中键点击。切换标签、画面失去键盘焦点时，输入法未提交的组字一并丢弃，不带到别的标签。
  - 接手后把标签尺寸设为画面区域的大小（点即 CSS 像素，`scale` 为屏幕倍率），窗口改变大小后 0.3 秒跟随；交还后由服务端恢复默认尺寸；切换到其他标签或关闭窗口时，交还此 Mac 接手的所有标签（2026-10-02 前只交还画面上的那个）。底栏的说明：2 分钟无操作为“2 分钟无操作，已自动交还。”，被其他屏幕接手为“此标签已由其他屏幕接手。”，自己按 `[ Hand Back ]` 不说明；接手 agent 的标签时说明一次（10 秒）“接手期间你输入的内容，交还后 agent 能在页面上看到；密码请在自己的标签里填写。”。
  - 新标签：`+`（顶栏、⌘T、空页面）打开浮框：地址、最近打开的地址（只保存协议、主机、端口与路径，去掉查询、片段与账号信息，因其可能含令牌）、Mac 上正在监听的本地服务。
  - 快捷键：⌘⇧B 切到 Browser；⌃⇥ / ⌃⇧⇥ 在三页间向后 / 向前循环；Browser 页上 ⌘T 新标签、⌘L 地址栏、⌘R 重新加载、⌘[ ⌘] 后退与前进，⌘1–9 仍切到终端。
  - 与原设想的差异：标签列表在本页显示时每 2 秒轮询；窗口可见但停在其他页时每 6 秒轮询一次，仅用于顶栏 `Browser` 后的标记（服务端尚无列表事件流，`GET /live` 也不含浏览器）；窗口不可见或关闭时都停止。画面流只在本页显示且窗口可见时连接；服务端拒绝画面流（断线与 404 以外）时不随每次轮询重连，而是 2 秒起加倍、至多 1 分钟后再试，原因只说一次（`BrowserStreamRetry`）。帧仍为 CSS 尺寸（§5 的 screencast 限制），在 Retina 屏上略模糊（2026-10-03 起按显示器的像素，见下）。
  - `Fill Ciphertext`（2026-10-02 接入 §6 的 `POST /browser/tabs/:id/fill`）：当前标签是你自己的、此 Mac 可操作（无人接手或此 Mac 接手）且页面为 http(s) 时（2026-10-02 起 agent 的标签即使接手也不显示，§6），底栏在 `[ Hand Back ]` 前显示 `[ Fill Ciphertext ]`，点击打开表单（主窗口的系统表单，样式同 Dispatch 的 `New Ciphertext`）。粘贴一条完整的 `enc:v1:` 密文后按 `Fill`，发送 `{token, screen: "mac-main"}`；引用（`enc:ref:`）属于某次任务，服务端不接受，表单中写明，发送前即拒绝。`New…` 切换为新建密文：名称、站点（预填当前页面的 host[:port]）、值（安全输入框），由此 Mac 的凭据网关加密（`GateSeal`：`secret-gate enc --batch`，值经 stdin 传入，用途 `http` + `fill`），加密后立即填入；加密期间表单被关闭则不填入。值只存在于安全输入框中，发送、取消或表单关闭时清空，不写日志。成功后表单关闭，底栏显示 `Filled <label> · <host>`（4 秒）。失败时表单保留并写出原因：网关的原因与服务端的中文说明原样显示（如 400 “只能填入密码或验证码输入框。”）；服务端只给出代码的情况（标签已关闭、请求体无效、服务版本过旧而无此路由）由 Mac 写成正式中文。密文保留在输入框中（新建的密文亦保留，无需重新输入值），处理后可再按 `Fill`。填入的始终是打开表单时的标签。与手机相同，不判断焦点是否在输入框（服务端不报告焦点），未点选输入框时由服务端说明原因。代码：Core 的 `Browser/BrowserFill.swift`（响应、密文检查、原因的说法），测试 `BrowserFillTests.swift`；界面 `Browser/BrowserFillSheet.swift`。未在真实的网关与 Chrome 上验证。
  - 验证：`-designPreview` 生成 `main-browser*.png`（`-designPreviewOnly browser` 只画这一页；`main-browser-filled` 为你的本地开发服务页面填入后的底栏，`main-browser-held` 为接手 agent 标签后的底栏与说明，`main-browser-fill`、`main-browser-fill-new` 为 Fill Ciphertext 的表单）；`-browserProbe <dir>` 对一次性服务打开本地测试页，点击、按键、中文提交、回车、接手（尺寸变为画面大小）与交还均已通过。

> 2026-10-03（用户：浏览器能不能根据浏览器窗口大小渲染的更sharp一些？然后浏览器侧栏应该也能调整大小/开启关闭才对；演示页 `browser.html` 的 Mac 部分）：
> - **左栏同终端页的侧栏**（terminal-v0 §1，2026-09-29 侧栏）：右边那条点线可以拖，画面随之重新适配；双击复原默认宽度 290；最窄 220，最宽 560 且给页面留出 420。拖过最左边（松手时离左边不到 120）整个收起，不留细栏。顶栏页面切换后面是同一个侧栏按钮（终端页的像素图标，位置相同），点它或按 ⌘B 收起，再点展开回原来的宽度。宽度和开关状态记在本机（`browser.side`，同终端页 `terminal.side` 的写法）。⌘B 在 Browser 页归窗口，网页里的 ⌘B（如编辑器的加粗）不再送进页面。
> - **尺寸有主**（同手机）：你的标签显示在 Mac 窗口里、窗口可见、且没有别的屏幕拿着时，这台 Mac 静默接手，标签换成画面区域的尺寸和显示器的像素比（Retina 为 2），窗口或左栏改变大小后 0.3 秒跟随。显示期间每分钟再设一次同样的尺寸（服务端把同样的尺寸当作续接手，§5），不会因 2 分钟无操作被交还、页面也不会突然变回 1280×800。这不算接手：底栏仍写 `You`，没有 `[ Hand Back ]`，到期也不说明。切到别的标签、关窗口时交还（同之前）；切到别的页或窗口被挡住时不再续，2 分钟后由服务端交还，回来时再接手。手机要用这个标签时按 `[ Take Over ]`，手机离开交还后 Mac 再接手。agent 的标签照旧只在 `[ Take Over ]` 之后改尺寸，2 分钟无操作照旧交还。
> - **清晰**：画面流要窗口所在显示器的倍数，以显示器的像素为上限（§5），1280×800 的标签来的是 2560×1600 的帧；按画面区域大小的标签一个 CSS 像素画成一个点（标签的尺寸是画面区域取整到整数 CSS 像素，比区域窄不到一点时也按一比一画，不再放大一丝），帧的每个像素正好落在屏幕的一个像素上。缩小显示比画面大的页面时按 mipmap 过滤。窗口挪到倍数不同的显示器时重新要画面、重设尺寸。
> - 代码：Core 的 `Browser/BrowserSide.swift`（宽度、拖动、收起、复原、记住）、`Browser/BrowserScreenPolicy.swift`（流的倍数、尺寸有主、底栏的说法）、`BrowserGeometry.fit`（一比一），测试 `BrowserScreenTests.swift`、`MainWindowTests.swift`（⌘B）；界面 `Browser/BrowserSideEdge.swift`（点线与拖动）、`BrowserPage.swift`、`BrowserPageModel.swift`、`MainWindow/MainBar.swift`、`MainWindowController.swift`。
> - 验证：`-browserProbe` 在一次性服务（临时家目录与端口、echo 路由）与真 Chrome 上走了一遍：打开的本地页即被这台 Mac 接手，视口 990×721@2、帧 1980×1442、画在 (0, 0, 990, 721)，一个 CSS 像素一个点；点击、打字、中文提交照常；收起左栏后视口跟到 1280×721（帧 2560×1442），再打开回到 990×721；点线拖到 400 后画面区域 879、视口随之 879×721，拖到 60 收起、宽度留着，按钮再打开，双击回到 290。拖动的鼠标事件是探针直接交给点线视图的，没有用真实的鼠标与光标。`-designPreview` 的 `main-browser*.png` 是顶栏多了侧栏按钮、左栏 290 宽的样子。

> 2026-10-03（用户：排版按照提议B来；dispatch-v0 §1“左侧图标栏与整窗状态栏”）：页面底部那一条移进主窗口横跨整个窗口的状态栏右边，内容与说法不变（持有者、等待原因或说明、`[ Fill Ciphertext ]`、`[ Take Over ]` / `[ Hand Back ]`）；接手与交还另有 ⌘⇧T。侧栏按钮固定在红绿灯后面（不再跟在页名后），`Browser` 后的标记改为左侧图标栏里地球的角标，顶栏不再有 `⠙1 ▪1`，后端只剩 `+`。

> 2026-10-03 **页面缩放**（用户：然后我发现agentswitch的浏览器页没有放大缩小的选项，加上 用来调节大小；演示页 `browser.html`）：浏览器自己的缩放，同 Chrome 与 Safari 的“缩放”——页面按更小或更大的窗口重新排版，画出来就更大或更小。手机上 50% 时页面看到的是 804 宽的窗口（402 点 ÷ 0.5），为桌面做的页面放得下；150% 时字大一半。
> - **档位**：25 33 50 67 75 80 90 100 110 125 150 175 200 250 300 400 500（同 Chrome）。一块屏幕能用的，是其中让标签尺寸（画面区域 ÷ 比例，取整）每边仍在 200–4096 以内（`POST …/viewport` 的范围，§5）、整页不超过 3840×2400 像素的那些（服务端画一个视图的上限；缩小的页面按 CSS 尺寸画，945×726 的画面区域在 25% 是 3780×2904，画一千一百万像素只为显示不到三百万），随画面区域而定：402 点宽的手机 25%–200%（200% 要 400 点以上的宽度，375–393 点宽的手机到 175%），Mac 主窗口默认大小（画面区域 945×726）33%–300%。画面区域变了、记着的比例用不了时，取最近的可用一档，记着的不改。
> - **谁来调**：尺寸有主，缩放是“这块屏幕把标签设成多大”的一部分，所以只有设尺寸的那块屏幕能调：你的标签显示在这块屏幕上时，agent 的标签在接手之后。按站点记在这台设备上（同 Chrome；站点即标签列表第二行的位置——域名、`localhost:5173`、文件路径），同一站点的标签在这台设备上都按它来；100% 不记，最多记 200 个站点（最久没动的先丢）；空白页不记。Mac 和手机各记各的（手机上要 50% 的页面，Mac 上是 100%）。
> - **做法**（客户端算，服务端不知道“缩放”）：设尺寸时宽高 = 画面区域 ÷ 比例（四舍五入到整数 CSS 像素；Mac 在 100% 时原来是向下取整，现在同样四舍五入），`scale`（页面的像素比）= 屏幕倍数 × 比例（限在接口的 0.5–4），`mobile` 照旧。画面流的 `scale` = 这块屏幕每点能显示的帧像素 × 比例，不低于 1、最多 8，放大缩小都乘：放大后的页面仍按屏幕的像素画，不发虚；缩小后的页面来的帧不比屏幕显示得下的更大（Mac 的上限是整个显示器而不是画面区域，不乘的话 50% 的页面来的帧每边是画面区域像素的约 1.4 倍；手机经 Tailscale 的 2 倍档不乘的话 50% 的页面来的是 1206×2070 的帧，该档的 2.25 倍像素，而缩小看桌面页正是手机上最常用的）。乘积不足 1 时（Mac：2 倍屏 50% 以下、1 倍屏 100% 以下；手机：2 倍档 50% 以下、1 倍档 100% 以下）服务端仍按 CSS 尺寸画，帧的上限改为这块屏幕该显示的像素（Mac：画面区域的像素；手机：点数 × 该档的倍数），由 screencast 缩到那么大。手机在帧的上限就是屏幕自己的像素时（局域网、25 Mbps 以上的档；2 倍屏在 2 倍档同）多要 0.02，放大缩小都要（100% 与乘积不足 1 时不要），让上限来定视图：页面的边是整数 CSS 像素，与“区域 ÷ 比例”最多差半个像素，折成倍数不超过 0.02；365 宽的页面要 3.32、实得 3.304，帧正好 1206 宽（按 3.3 是 1205，在屏幕上被拉伸一个像素；390 点宽的手机 90% 按 2.7 是 1169、少一个像素）。2 倍档、1 倍档显示的像素比屏幕少，没有上限可接，不多要。Mac 不拉伸，按一比一画、边上裁掉。换比例 = 立即再设一次尺寸；画面流要的倍数变了就按新的倍数重开一次（手机新流先开、旧流后断；Mac 同换显示器，先断后开，最后一帧留在屏幕上）。输入的坐标照旧是帧像素。标签换到另一个站点时，按那个站点记着的比例再设一次尺寸。画面区域被键盘、说明或缩放条占去一部分时，页面仍按原来的区域算（同键盘不挤页面）：手机记着这个宽度下停留过 0.3 秒以上的最大区域（页面刚打开时一闪而过的几个尺寸不算），交还之后再接手也按它，不因缩放条开着而把页面设矮、关上后再设一次。画面只在页面尺寸变了时自上而下刷新一次（每一档、每次换站点各一次；同一页面换了像素密度不刷新）。
> - **服务端**：原定只改一处；缩放让视图每一步都重画，实现与两轮复查下来改了下面这些（都在 `packages/daemon/src/browser/` 与 `src/api/browser.ts`，细节与实测见 §5“页面缩放之后”）。为缩放本身：画面流的 `scale` 上限由 3 提到 8（3 倍屏 × 200%、2 倍屏 × 400%；视图的像素上限不变，每边 4096、总共 3840×2400）；视图的倍数由按 0.25 取整改为保留到千分位；设尺寸的路由拒绝整页超过 3840×2400 的尺寸；手机版式换尺寸时先按桌面版式设一次（见下一条）。画面流原有的问题（现在装着的版本里就有，缩放使它们更常见）：指针输入按送到 Chrome 那一刻的视图倍数换算，并等正在进行的重画；重画前截到的旧帧不发给屏幕；来了又走的流不把视图留在它要的倍数；一阵变化的最后一帧不再丢；没有流在看时到的帧不再让下一个流停一秒；agent 截图不再把按倍数画的标签排成两倍大；标签变成窗口最前的标签时被 Chrome 改掉的视图会重画回来。旧版服务端把更大的值截到 3、按 0.25 取整：放大的页面照样能用、位置不变，只是不到屏幕的像素。
> - **不跟随设备宽度的页面**（没有 viewport 标签的老式桌面页，或写着 `width=1024` 之类）：手机版式下 Chrome 把它按 980（或它写的宽度）排版、缩到屏幕宽，这一步只在进入手机版式时做一次，之后只改尺寸不会重做。实测（Chrome 154）：402 → 804 宽（50%）时页面只占屏幕左半，402 → 201（200%）时只见一半宽，滚动位置丢失；Mac 设过尺寸后手机再接手，可能停在两倍的缩放上。服务端现在在手机版式换到另一个尺寸时先按桌面版式设一次同样的尺寸、再设手机版式（`playwrightDriver.setViewport`；同一尺寸换倍数重画时不这样做，页面不会被排两次），此后每个尺寸都贴合、滚动位置保留；跟随设备宽度的页面没有差别，也不多收 resize。这类页面在手机上从 50% 到 175% 看起来一样（始终是整页缩到屏幕宽，同手机浏览器看桌面页），33%、25% 才换成更宽的版面；要放大用双指。
> - **Mac**：状态栏最右边 `−` `100%` `+`（在持有者与 `[ Take Over ]` 的右边，位置不随它们变）。`−` `+` 换一档；点百分比回到 100%（不是 100% 时用正文色，否则暗）。Browser 页上 ⌘+（⌘=）放大、⌘− 缩小，小键盘的加减号同；⌘0 仍是回到 Dispatch，复原没有快捷键。这台 Mac 没在设这个标签的尺寸时（agent 的标签未接手、标签在别的屏幕上）三个都暗着，悬停说明“接手后才能缩放。”，此时按 ⌘+ / ⌘− 状态栏说这句话 4 秒；到头的一档暗着；空白页三个都暗着；没有标签时不显示。你的标签还没人拿着时（一显示就会被这台 Mac 接手）也算这台 Mac 的。悬停文字：`Zoom Out ⌘−`、`Actual Size`、`Zoom In ⌘+`。这台 Mac 设过尺寸的标签按“比例”个点画一个 CSS 像素、从左上角画起；显示器倍数 × 比例不小于 1 时（2 倍屏 50% 及以上，1 倍屏 100% 及以上）一个帧像素落在显示器的一个像素上，不重采样；更小的比例服务端按 CSS 尺寸画、screencast 缩到画面区域的像素，文字不如原生缩放清楚；多出的不到一个 CSS 像素在右边与底边裁掉。窗口换到另一块显示器（倍数或像素数不同）时重新要画面，倍数不同时另重设尺寸（原来只看倍数：从 1512×982 的内建屏挪到同为 2 倍的大屏后，画面流仍以小屏的像素为上限，画面是拉大的；复查时发现，早于缩放）。
> - **iPhone**：底栏键盘键后面多一个写着当前比例的键（`100%`；不是 100% 时用信号色），点它在底栏上方出一条，样子同打字时的键帽条：`−` `100%` `+`，点百分比回到 100%；再点一次、或开始打字时收起。这台手机拿着标签时调的是页面（按站点记住）；只看时（agent 的标签未接手、标签在别的屏幕上）调的是手机上的画面，同双指捏合（100 125 150 200 300 400，不记；这一条右边写着“仅放大手机上的画面”），右上角的 `2.0×` 照旧（按钮的 125% 一档写 `1.25×`）。按钮放大画面时以看得见的那部分的中点为准，画面还没占满屏幕区域的高度时顶边贴着区域的顶。你自己的标签暂时没人拿着时（两分钟空闲被交还、接手还在路上）也能调：记下比例并接手，尺寸带着这个比例。缩放条与打字的键帽条不同时出现，地址栏的键盘弹出、标签关闭时也收起；带 `[ Take Over ]` 时底栏五个键各 46 点宽（原 52），375 点宽的手机上仍放得下。
> - **代码**：服务端 `screencast.ts`（`MAX_SCALE`、`renderScale`、`viewAt`、等新视图的第一帧）、`host.ts`（`input`、`applyViewport`、`redraw`）。手机 Kit `Browser/BrowserPageZoom.swift`（档位、可用档位、当前档位、尺寸、画面流倍数、按原区域算、`BrowserZoomMemory`）、`BrowserLayout.swift` 的 `BrowserZoom`（画面的档位与按钮放大）、`BrowserPolicy.swift`（各档连接的倍数乘比例）；App `Browser/BrowserZoomBar.swift`、`BrowserPageModel.swift`、`BrowserPage.swift`、`BrowserStore.swift`（记在 UserDefaults 的 `browser.zoom`）。Mac Core `Browser/BrowserPageZoom.swift`（含 `BrowserZoomMemory`、`BrowserZoomText`）、`BrowserGeometry`（`viewport`、`fit`、输入换算都带比例；`BrowserFrameGeometry.sits`）、`BrowserScreenPolicy`（`stream`、`frameScale`、`sizes`、`zoom`）、`MainShortcut.BrowserShortcut.zoomIn / zoomOut`；App `Browser/BrowserPageModel+Zoom.swift`、`BrowserZoomItems.swift`、`BrowserScreenView.zoom`。两端各自一份逻辑，不共用代码。
> - **验证**：
>   - 服务端：`npm test` 1445 个通过（缩放前 1386；新增的在 `browserScreencast`、`browserHost`、`browserHostView`、`browserLastPicture`、`browserApi`、`browserInput`、`browserAgents` 各测试文件里）。不在 `npm test` 中、用装着的 Chrome 154 与临时配置跑的两份脚本：`scripts/browser_zoom_probe.ts`（经屏幕用的那些路由；`--last` 只跑最后一帧，`--fit` 只跑不跟随设备宽度的页面）52 项全过，`scripts/browser_smoke.ts` 75 项全过，数字见 §5。
>   - Mac：`swift test` 450 个通过（`BrowserZoomTests` 16 个、`MainWindowTests` 的缩放键）；`-designPreview` 多一张 `main-browser-zoom`（125%）。`-browserProbe` 对一次性服务与真 Chrome 走了一遍（窗口的 ⌘= / ⌘−）：100% 视口 945×726@2、帧 1890×1452；125% 视口 756×581@2.5、帧 1890×1453（倍数 2.5），画满画面区域，点输入框落点正确、接着打字；110% 视口 859×660@2.2、帧 1890×1452（倍数 2.2）；90% 视口 1050×807@1.8、帧 1890×1453（倍数 1.8）；回到 100% 后站点不再记着。每一档一个帧像素都落在显示器的一个像素上。
>   - iPhone：Kit `swift test` 299 个通过（`BrowserZoomTests` 21 个）、模拟器构建通过；演示画面 `-uiDemoScreen browserzoom`（页面 50%、缩放条打开）与 `browserzoomwatch`（只看，画面 150%）在模拟器里看过。**没有在真机、也没有对真的 Mac 服务跑过**：拿着标签时换档、换站点、离开再回来、交还后再调、键盘弹出这几条路径，是把 App 的 `BrowserPageModel` 原样编进一个小程序、对着按服务端规则写的假 Mac 跑的（16 个场景 58 项，修正前 21 项不对、修正后 0 项），不是真机。
>   - 未验证：Mac 状态栏三个键的悬停与点击没有用真鼠标试过（键盘路径试过）；旧版服务端下的表现只按其解析规则推断。

**入口**：终端里点路径（Mac ⌘-点击、手机点）→ `Open in Browser`；任务的 HTML 文件 → 在 Browser 里打开（同目录的资源一并可用）；Dispatch 记录里的链接 → Browser。

> 2026-10-03 手机的入口做了两项（用户：手机上现在点击和复制链接还是费劲，修复一下交互；修复好之后想办法让手机可以方便的点击链接，点击之后直接在agent switch浏览器中打开）：
> - **终端画面里的链接和路径**：点一下在共享浏览器里开一个你自己的新标签（`POST /browser/tabs`），手机切到 `Browser` 标签页并打开它（2026-10-05 起不再换标签：页面盖在原处，见下）；长按出菜单 `Open in Browser`、`Copy Link` / `Copy Path`、`Open in Safari`。认哪些、折行怎么接、点不准怎么办，见 terminal-v0 §1 iPhone “链接”。
> - **Dispatch 记录、任务页、会话记录里的链接**：点一下同样在共享浏览器里打开（原来交给 Safari）；长按的菜单里多出每个链接的 `Open in Browser`、`Copy Link`、`Open in Safari`（原来只能把整段文字复制出来）。中文里紧跟着标点或汉字的网址，系统的 Markdown 解析会连同后面的字一起当成链接（`https://example.com/a。然后看https://example.org/b` 整段成了一个打不开的地址），现在在第一个不属于网址的字处截断，后面的网址各自成链；反引号里的网址也是链接。
> - 打不开时同终端：没连上或 Mac 没有浏览器，网址退回 Safari 并说明；Mac 拒绝时写出原因。只有 http / https 会被打开，`agentswitch://` 等其他协议照旧丢弃。
> - 2026-10-05 **点开的页面盖在原处，`Done` 回去**（用户：现在我在手机上点击链接跳转到浏览器，我得返回到浏览器主页面再回来🤔 有没有更方便的符合规范的跳转方法）。原来点链接会把手机切到 `Browser` 标签页并推入那一页，而那一页藏着标签栏，要先退回标签列表才能切回原来的标签——两步，而且是应用替人换了标签。苹果的说法（WWDC22 *Explore navigation design for iOS*）：“Transporting someone to another tab by tapping on an element within a view is jarring and disorienting. Never force someone to change tabs automatically.”；要看一眼再回来的内容用模态（“isolating someone into a focused workflow or self-contained task”），就像各应用里用 Safari 视图打开链接、左上角 `Done`。现在：在 Dispatch、任务页、会话记录、终端画面里点链接，页面从下方盖上来（`fullScreenCover`，`LinkedPage`），就是 Browser 标签页里的那一页（地址、谁持有、画面、底栏都一样），左上角是 `Done`；点 `Done` 回到点链接的地方，原来的页面、滚动位置、输入都没动。这个标签仍然留在 `Browser` 标签页的列表里（`Done` 不关它；要关用 `⋯` › `Close Tab`，关掉也回到原处）。已经在 `Browser` 标签页里时照旧推入。从设置等弹出层里点的链接盖在那个弹出层上。`-uiDemoScreen linkedpage` 看这个状态。
> - 任务的 HTML 文件入口、实时活动未做。

## 2. 结构

- **浏览器宿主**：daemon 看护的一个常驻 Node 进程（`browser-host`）。用 Playwright 以管道方式（`--remote-debugging-pipe`，Playwright 的默认）启动用户已装的 Chrome（同现在的执行器浏览器），不开调试端口。
  - 一个常驻的“你的”配置（`$AGENTSWITCH_HOME/browser-profiles/main`）：你开的标签和终端里的 agent 都在这里，登录态共用。
  - 调度任务的会话槽（threads-v0 §4b，三个配置）照旧隔离，但也在宿主里启动，所以同样能在 App 里看与接手。
  - 密码管理器与自动填充照旧关掉（`browserSlots.ts` 的做法）。
- **给 App（人）**：daemon 经宿主取画面——CDP `Page.startScreencast`（JPEG，按连接调帧率与质量：局域网 15–30 帧，Tailscale 按测得的网速，慢时降到 5 帧、降质量）——并发输入（`Input.dispatchMouseEvent`、`Input.insertText`、按键）。接口：`GET /browser/tabs`、`POST /browser/tabs`（打开网址、路径或本地端口）、`GET /browser/tabs/:id/stream`（画面流）、`POST /browser/tabs/:id/{input,navigate,take,release,close,fill}`、`GET /browser/servers`（Mac 上监听的本地服务）。加入远程白名单，手机经配对连接（钉证书指纹）用。
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
4. iPhone 的 `Browser` 标签、实时活动、入口（终端路径、任务文件、链接）。标签已做（2026-10-02，§1）；入口里终端的链接与路径、Dispatch 的链接已做（2026-10-03，§1 入口），任务文件的入口与实时活动未做。
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
- **画面流**：CDP `Page.startScreencast`（JPEG）。同一标签的多个流共用一个 screencast：质量取最高值；`maxWidth`、`maxHeight` 仅在所有流都给出时生效；每个流按自己的帧率（默认 15，最多 30）接收，只拿最新一帧；回执按最快的流节制。实测 Chrome 154 的帧始终为视口的 CSS 尺寸，与设备像素比无关，因此 `scale` 通常为 1（`maxWidth` 限制时小于 1；2026-10-03 起标签的视图按看它的屏幕的倍数画，见本节末）。导航之后再改尺寸，Chrome 不再产生新尺寸的帧，因此每次改尺寸后重启 screencast。
- **标题**：Chrome 的目标列表报告标题变化很晚或不报告，改为在页面加载后、重绘后以及每 2 秒读取一次（在 Playwright 的隔离环境中读取，页面无法干预）。
- **规则**（`src/browser/rules.ts`，名单只在此处定义，有测试）：人可打开 http(s)、`about:blank`、`file://` 路径与 `localhost:<端口>`；agent 只可 http(s) 与 `about:blank`。`file:` 路径按原样与 `realpath` 各检查一次（`..` 与符号链接都会被识破），比较不区分大小写：执行器禁区表（`defaultProtected`，含禁读路径；`work`、`artifacts`、`uploads` 照旧可用），凭据目录 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.config/gh`、`~/Library/Keychains`，另加 `~/.kube`、`~/.azure`、`~/.docker`、`~/.password-store`、`~/.config/gcloud`（单层的点目录在任何位置都拒绝），凭据文件名 `.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_*`（不含 `.pub`）、`.netrc`、`.npmrc`、`.pypirc`、`.git-credentials`、`.pgpass`、`credentials*`。拒绝时接口返回 403 与原因。浏览器内每个 `file:` 请求和每个发往本机的请求都先经宿主检查：被拒的导航显示原因页（`[!] Not Viewable`），被拒的子资源不加载。新增一条：AgentSwitch 自己的端口（本地接口、远程、OpenCode、网关代理）任何标签都不可打开，因为 `main` 配置之后与 agent 共用，不应存有控制台的登录。
  - 2026-10-02 安全审查后补：路径除按原样与 `realpath` 比较外，还按文件身份（设备号与 inode）逐层比较其上各级目录，规范写法另去掉数据卷前缀（`realpath` 会保留 `/System/Volumes/Data/Users/…` 这种写法，此前借此可打开 `$AGENTSWITCH_HOME/local-token`、`~/Library/Keychains`、`~/.config/gh/hosts.yml`），大小写、符号链接、数据卷写法都落到同一处（`src/core/paths.ts`，执行器的禁区检查共用）。凭据文件名加 `*.priv`；`.agentswitch`、`.secret-gate` 与 AgentSwitch 家目录、网关家目录的名字（点目录按名字，其他按最后两级，如 `Application Support/AgentSwitch`）在别处出现也拒绝（备份、副本），真正的家目录里仍按禁区表（`work`、`artifacts`、`uploads` 可开）；名为 `AgentSwitch` 的项目目录不受影响。
  - AgentSwitch 自己的端口（纵深防御，同日补）：主机名先规范化（小写、去掉方括号与末尾的点，`localhost.` 同 `localhost`）；发往这些端口的请求不论主机名都经宿主检查，主机名解析到本机地址的也拒绝（`dns.lookup`，2 秒为限，解析失败按非本机）；端口包括本地接口、远程、网关代理、调度用的 OpenCode 与此刻运行的所有 `opencode serve --stdio`（执行器常驻的与各终端的伴随服务）。跳转：Playwright 不让路由看到跳转的下一跳，所以每个页面另经 CDP `Network.setBlockedURLs` 让 Chrome 自己拦下发往这些端口（127.*、`localhost`、`*.localhost`、`[::1]`、`0.0.0.0`）的请求，跳转来的子资源也拦（端口变化 2 秒内跟上）；跳转来的页面导航 Chrome 不拦，宿主看到即停止加载、显示原因页，但请求已到达服务（冒烟脚本实测）。Chrome 自己解析主机名，DNS 重绑定绕得过名字检查；这些服务本身各有凭证。弹出窗口的第一次导航发生时页面尚不存在，无法查到持有者；Chrome 不允许 http(s) 或空白页打开本地文件，所以发往 `file:` 的这类导航只能来自 `file:` 页面，即人的标签，按人的规则检查。
- **本地服务**：`lsof` 列出当前用户在 127.0.0.1、::1 与所有接口（`*`，如 `next dev`）上监听的端口，只保留在用户自己文件夹中运行的程序（与 §2 的差异：聊天、代理等应用的回环端口在 `/`、`~/Library` 容器或应用包内运行，列出无用），并去掉 AgentSwitch 自己的（上述端口、daemon 及其子进程、打包的应用、网关代理、`opencode serve --stdio`）。只返回程序的短名，不返回完整命令行（可能含令牌）：可执行文件的名字；解释器（node、python 等）另取它运行的脚本名（带脚本扩展名的文件或 `bin` 目录下的文件，取文件名）或 Python 的 `-m 模块名`；命令行里的其他词一概不取（2026-10-02 审查：原先会把选项的值当成名字）。
- **审计**：`$AGENTSWITCH_HOME/browser/audit.jsonl`，记录打开、导航（网址去掉查询与片段；路径；端口）、关闭、接手、交还（含 2 分钟到期，`via: daemon`）、拒绝及原因。输入的文字不记录。
- **接口**（本地与远程白名单相同；`screen` 均可省略）：
  - `GET /browser/tabs` → `{running, groups: [{owner, tabs: [Tab]}]}`，组的顺序为终端、任务、你。`Tab` = `{id, owner, title, url, site, kind: web|file|local|blank, status, loading, heldBy, action, viewport: {width, height, scale, mobile, by}, openedAt}`。`GET /browser/tabs/:id` → `{tab}`。
  - `POST /browser/tabs` `{url}`（地址栏原文：网址、裸域名、`localhost:5173`、`/路径`、`~/路径`）| `{path}` | `{port}` → 201 `{tab}`；拒绝 403、文件不存在 404、无法识别 400，均为 `{error}`。`DELETE /browser/tabs/:id` → `{ok}`。
  - `GET /browser/tabs/:id/stream?quality=1..100&fps=1..30&maxWidth=&maxHeight=&scale=1..8`（默认 70、15、1；`scale` 为 2026-10-03 加入，见本节末；上限同日随页面缩放由 3 提到 8，§1）→ SSE，事件名即 `type`，`data` 为 JSON：先 `tab {tab}`；之后 `frame {seq, data (JPEG base64), format, width, height, scale, viewport: {width, height}, pageScale, scrollX, scrollY}`（SSE `id` 为 `seq`）、`url {url, site, kind}`、`title {title}`、`loading {loading}`、`status {status}`、`held {heldBy, reason: take|hand-back|idle}`、`action {action}`、`viewport {viewport}`；`closed {reason: closed|browser-exited|shutdown}` 后流结束；每 10 秒一行注释 `: ping`。
  - `POST /browser/tabs/:id/input` `{screen?, events: [...]}`（最多 50 个），或单个事件加 `screen`：`{type: "mouse", action: move|down|up|click, x, y, button?: left|right|middle, clickCount?: 1..3, modifiers?, seq?}`、`{type: "wheel", x, y, deltaX?, deltaY?, modifiers?, seq?}`、`{type: "text", text}`（`Input.insertText`）、`{type: "key", key, modifiers?}`（`Escape` `Tab` `Enter` `Backspace` `Delete` 方向键 `Home` `End` `PageUp` `PageDown`，以及 `a`–`z` 用于组合键）。坐标为帧像素（`seq` 指定哪一帧，默认最新），除以 `scale` 得视口像素；`modifiers` ⊆ `Alt` `Control` `Meta` `Shift`。Mac 上的编辑命令随键发送（复制、剪切、粘贴除外）。
  - `POST /browser/tabs/:id/navigate` `{url} | {path} | {port} | {action: back|forward|reload}`（加 `screen?`）→ `{tab}`。
  - `POST /browser/tabs/:id/take`、`/release` `{screen?}` → `{tab}`；交还他人的接手 409。`POST /browser/tabs/:id/viewport` `{width, height: 200..4096, scale?: 0.5..4, mobile?, screen?}` → `{tab}`，未接手 409；接手方再设一次自己设过的同样尺寸只续接手，不重设、不发 `viewport` 事件（2026-10-03，Mac 在你的标签显示期间每分钟一次，§1 Mac）。
  - `GET /browser/servers` → `{servers: [{port, bind: loopback|all, pid, name, cwd, url}]}`。
  - `GET /browser/speed?bytes=` → `bytes` 个不可压缩的字节（默认 1 MiB，上限 4 MiB，缺省或不合法按默认、超出按上限；`application/octet-stream`、`Cache-Control: no-store`）：手机测这条连接的网速（2026-10-03 加入，§1 iPhone）。一块 64 KiB 的随机数据生成一次、重复使用，去掉换行字节（手机读流时在换行处分块）。
  - `POST /browser/tabs/:id/fill` `{token, screen?}` → `{tab, filled: {label, host}}`（第 3 步加入，§6）。
- **测试**：`tests/browser{Rules,Input,Screencast,Host,Servers,Api}.test.ts`（假 Chrome，不调用模型）；`scripts/browser_smoke.ts` 在临时目录中用真 Chrome 运行一遍（`npx tsx scripts/browser_smoke.ts`，不在 `npm test` 中）。
- **未做**：两端界面（第 2、4 步）、本地页面拦截外部资源（演示页的 `[ Load ]`）、页面对话框（alert 等目前由 Playwright 自动关闭）与文件选择、标签列表的事件流（目前轮询 `GET /browser/tabs`）、Chrome 意外退出后恢复原有标签、高像素比的画面（受上述 screencast 行为限制；2026-10-03 已做，见下）。

> 2026-10-03 画面的像素（用户：浏览器能不能根据浏览器窗口大小渲染的更sharp一些？；§1 Mac、§1 iPhone 同日）：
> - **实测**（`scripts/browser_sharpness_probe.ts`，不在 `npm test` 中：用户装的 Chrome 154、临时配置与临时目录，文字密集的测试页，画面在动，每秒 15 帧）：只在 `Emulation.setDeviceMetricsOverride` 里给 `deviceScaleFactor: 2`，或再给 screencast 设备像素的 `maxWidth`/`maxHeight`，帧仍是 1280×800：screencast 截的是标签的视图，视图是 CSS 尺寸，`maxWidth` 只会缩小。再加仿真的 `scale: 2` 而视图不变，只截到放大后的左上四分之一。`--force-device-scale-factor=2` 能出 2560×1600，但对整个 Chrome 生效：每个标签（包括没人看的 agent 标签）都按 2 倍栅格化，agent 按设备像素的截图变成 2560×1600，手机也拿不到 3 倍。页面静止时用 `Page.captureScreenshot` 补一张 2 倍图：每张约 50 ms、477 KB，截图期间 screencast 的帧变成 2560×1600，页面还收到一次 resize。标签共用一个窗口（Playwright 开的新页是同一窗口的标签），所以也不能按窗口改。
> - **做法**：每个标签自己的视图按看它的屏幕画：`setDeviceMetricsOverride` 加 `scale` 与 `dontSetVisibleSize`，再 `Emulation.setVisibleSize` 为 CSS 尺寸乘倍数。1280×800 的标签在 2 倍下出 2560×1600 的帧；页面看到的仍是 1280×800、原来的 `devicePixelRatio`，没有 resize；同一窗口里的标签各自独立。没有流要倍数时（没人看，或只有旧客户端看）视图就是 CSS 尺寸，同之前。`setVisibleSize` 在协议里已标为弃用，Chrome 不接受时退回 CSS 尺寸，日志说明一次。
> - **倍数**：画面流多一个参数 `scale=1..3`（同日随页面缩放提到 `1..8`，§1）：这块屏幕每个 CSS 像素能显示几个帧像素。标签的倍数取看它的所有流里最大的一个；每个流的倍数先按它自己的 `maxWidth`/`maxHeight` 截住（手机看 1280 宽的桌面页只需 1 倍），再限在每边 4096、总共 3840×2400 像素以内，按 0.25 向下取整（同日随页面缩放改为保留到千分位，见下“页面缩放之后”），不低于 1。帧的 `scale` 是帧像素与 CSS 像素之比、`viewport` 仍是 CSS 尺寸（Chrome 的元数据此时是视图的尺寸，宿主除以倍数），客户端照旧按“帧像素 / scale”换算，旧客户端不受影响。改倍数或尺寸时先停 screencast、改视图、再开，改到一半的帧不会到屏幕上。
> - **输入**：视图按倍数画时，Chrome 把输入的坐标当作视图的像素（实测：2 倍下在 (200, 120) 点击，落在 CSS (100, 60)），滚轮的距离仍是 CSS 像素；宿主按帧算出 CSS 坐标后再乘倍数。Playwright 的点击用 CSS 坐标（实测 2 倍下 `page.click` 超时、按元素框的鼠标点击落空，`fill` 不受影响；截图当时以为也不受影响，其实受影响，见下“页面缩放之后”的“agent 的截图”），所以 agent 每个可能指向页面的调用之前（点击、悬停、拖动、勾选等，以及以后新加的工具；快照、导航、标签列表、等待、读日志与网关的 URL 探测除外；截图与网关自己的代码原来也在除外之列，10-03 起不再除外），它的所有标签先回到 CSS 尺寸，调用结束且 2 秒内没有下一个这样的调用后，再按屏幕的倍数画。这期间屏幕上是 CSS 尺寸的画面。你的标签 agent 动不了，不受影响。
> - **两端**：Mac 要窗口所在显示器的倍数（Retina 为 2），以显示器的像素为上限（§1 Mac）；手机局域网要屏幕的倍数（3），Tailscale 按测得的网速分档（同日稍后改，原为直连最多 2、中转 1 倍；§1 iPhone），质量、帧率与像素上限随档位。同一标签同时有几块屏幕看时共用一个 screencast（质量取最高、倍数取最大），慢档的手机这时也拿到大帧，同之前共用质量的做法。
> - **页面缩放之后**（2026-10-03 同日，§1 页面缩放；缩放的每一步都会重画视图——先设尺寸，再有流按新倍数来——原来偶尔才走到的路径变成了常走的）：
>   - **倍数到千分位**：视图的倍数是屏幕放得下的那个值向下取到千分位（帧不会比流要的、或它的 `maxWidth` / `maxHeight` 放得下的更大），视图是整数像素（尺寸 × 倍数四舍五入，`viewAt`，`Emulation.setVisibleSize` 用同一个数），仍在每边 4096、总共 3840×2400 以内（四舍五入会越界时再少千分之一）。原来按 0.25 取整：2 倍的 Mac 在 110% 要 2.2 却按 2 画，3 倍的手机在 125% 按 3.5 画，各自拉大到屏幕上，发虚。实测（Chrome 154，相邻像素亮度差的均方）：Mac 2.2 对 2 为 544.7 比 340.6（1.6 倍），手机 3.745 对 3.5 为 848.3 比 574.4（1.5 倍），200% 的页面 6 对 3 为 905.2 比 329.7（2.75 倍）。各档实际（按手机现在要的：屏幕倍数 × 比例，上限是屏幕自己的像素时多要 0.02；上限整块屏幕 1206×2622）：3 倍手机 402×690 点，200% 6、175% 5.243（帧 1206×2066）、150% 4.5、125% 3.745（1206×2067）、110% 3.304（1206×2072）、100% 3、90% 2.697（1206×2069）、80% 2.397（1206×2069）、75% 2.25、67% 2.01、50% 1.5，未注明的帧都是 1206×2070；33%、25% 不带倍数、按 1 画，帧缩到 1206×2070。帧都是 1206 宽。2 倍 Mac 990×721 点，110% 2.2、125% 2.5 … 300% 6，帧 1980–1981 宽；90% 1.8、50% 1。千分位在页面宽过 500 像素、由上限定视图时仍可能差一个像素（375 点宽的手机 67%：1124 对 1125）。
>   - **输入按当时的视图**：点的坐标先按它所瞄准的那一帧换成 CSS 像素，再乘**送到 Chrome 那一刻**视图的倍数（原来乘那一帧画时的倍数：瞄准重画之前的帧的点击落在“旧倍数 ÷ 新倍数”处，实测瞄准 CSS (100, 140) 落在 (50, 70)）。指针事件（鼠标、滚轮）先等正在进行的重画做完，再取换算关系，一个事件的几个调用（一次点击是三个）一起发出，中途开始的重画排在它们之后；等完再查一次标签还在、持有者没变（否则 404 / 409）。按键与文字不等。实测：流按 6 来到 3 倍的视图后 0–7 毫秒内发的 40 次点击，原来 14 次落在一半的坐标、8 次没落上，现在 40 次都对。
>   - **旧帧不外发**：screencast 重开后，Chrome 可能先发来重画之前截的帧（一直在重绘的页面上实测 150 次换档里最多 17 帧，都在开始后 0–6 毫秒、新视图的第一帧之前；静止页面没有）。按新倍数标出来，它说的是一个从未有过的页面尺寸。现在宿主把画好的视图（像素尺寸）告诉 screencast，在这个视图的第一帧到来之前、最多 2 秒内，尺寸不符的帧立即回执、不发给屏幕；之后照常（自己改窗口大小的弹出页一直发别的尺寸的帧，2 秒后照收，日志说明一次）。新旧视图像素尺寸相同时（3 倍手机的 90% 与 80% 都是 1206×2069，200% → 150%、67% → 50% 都是 1206×2070）按尺寸分不出，所以另看 Chrome 给帧的时间戳：视图画好之前发出的帧不发给屏幕，不论何时到（时间戳没有、在未来或超过 2 秒时只按尺寸）。两个都是 3840×2400 的视图之间 80 步：改前 30 帧/秒 587 帧里 49 帧标着新页面、画的是旧页面，改后 591 帧里 0 帧。仍分不出的：Chrome 在新视图上、页面还没按新尺寸排版时截的一帧（标新页面、画旧排版，Chrome 回答后 4–38 毫秒发出，下一帧即纠正；30 帧/秒约每步一帧，15 帧/秒的手机 243 帧里 0 帧）。所以上面“改到一半的帧不会到屏幕上”应读作：改前截的帧不到屏幕上，新视图排版之前的那一帧仍可能到。
>   - **来了又走的流**：重画时拿想要的倍数与“记录的视图”比，而记录在重画进行中是旧的；要更高倍数的流在一次重画之内来了又走，视图就停在它要的倍数上（实测 40 次里 16 次）。现在相等时等进行中的重画做完再比一次。
>   - **最后一帧**：Chrome 在一次 screencast 运行里有三帧没回执时，新截到的画面不发、之后也不补发。回执按最快的流的间隔排队（下面“回执”，为的是不让 Chrome 多出帧），代价是一阵变化的最后一帧可能没送出，屏幕停在更早的画面上，直到页面再重绘。改前实测（15 帧/秒、要 2 倍，两轮）：从一直重绘的页面导航到静止页面 24 次，2 秒后仍停在上一页 12、13 次；30 帧的动画 24 次，停在差 2–4 步处 16、23 次；30 个滚轮事件的滚动 24 次，最后一帧比页面落后 120 px 16、23 次（这时点击落在看到的内容之外）。做法（节奏不变）：记本次运行里回执还没发出的帧数；Chrome 发出某帧时（按帧元数据的时间戳，不按到达时刻：大帧在路上的时间比回执间隔长）同一运行里另有回执没发出，这一帧就可能不是最后一次截取；最后一个回执发出后 150 毫秒内没有新帧，就停、开 screencast 一次（Chrome 开始时发一帧当前画面）。每次运行的头两帧不算（三帧在外才会丢）。改后五轮 540 次全对；最后一帧在页面停下后约三个回执间隔加 150 毫秒到（15 帧/秒约 0.3 秒，5 帧/秒约 0.7 秒）。代价：静止页面 0 次重开；一直重绘的页面 Chrome 仍每秒出 15.1–15.3 帧、0 次重开；一阵变化之后重开一次、多发一帧；页面无感（没有 blur、focus、visibilitychange、resize，输入框保持焦点）。
>   - **没有流在看时到的帧**（最后一个流走了、停止还没到 Chrome）立即回执，不占回执队列的位置。原来按每秒 1 帧排着，下一个流的回执排在它后面：一直重绘的页面上换流（Mac 每次换档先断后开；屏幕离开标签又回来）之后画面停住约一秒（60 次里 3–16 次）；改后 0 次，最长等一帧约 0.15–0.2 秒。
>   - **agent 的截图**：视图按倍数画时，Playwright 的截图把页面按视图的像素尺寸排版并留在那里（屏幕以 2 倍看 1280×800 的 agent 标签：第一张图 1280×800 但贴右边和底边的内容不在图里，页面此后自认为 2560×1600，屏幕上是缩成一半的排版，直到下一次重画）。现在 `browser_take_screenshot` 与网关自己的代码（字段状态、表单去向、带遮罩的截图）也算“可能指向页面的调用”，先回到 CSS 尺寸再做。改后视口、整页、元素、再视口四张图依次 1280×800、1280×3000、240×30、1280×800，页面始终 1280×800。
>   - **Chrome 自己改视图**：标签成为窗口最前的标签时（它后面打开的标签关闭、它用 `window.open` 开的标签页关闭、agent 的 `browser_tabs` select），Chrome 把它的视图设回窗口的 1280×713，仿真的页面尺寸不变。以 2 倍看的标签此后的帧是 1280×713、按记录的倍数标成 640×357 的页面，屏幕上只剩页面左上一块；不要倍数时少 87 像素（早于 10-03）。现在 screencast 记着宿主画的视图，尺寸不符的帧不发给屏幕并让宿主重画一次；静止页面上 Chrome 改了视图常常不出帧（12 次关闭里 6–11 次），所以任何标签关闭时，仍有流在看的其它标签各重画一次，agent select 之后重画被选中的标签；agent 的调用进行期间不重画它的标签（Playwright 截元素或整页时会临时改视图），调用都结束后再画。改后关闭 60 次、select 12 次全对（改前全错）。没人看的标签被改了视图后保持 1280×713，直到有流来。
>   - 仍然如此：agent 的调用指向它的某个标签期间，它的所有标签按 CSS 尺寸画，被人接手并放大的那个也是（持有者这几秒看到的是小帧拉大的画面，输入照常落点）；点在最后一个 CSS 像素的那一列或行里时落在该像素的起点；截图与网关的探测现在也是这样的调用，屏幕按倍数看着 agent 的标签时，每次之后约 2 秒屏幕上是 CSS 尺寸的画面，同点击。
>   - 测试：`npm test` 1445 个（缩放前 1386）：`tests/browserScreencast.test.ts`、`browserHost.test.ts`、`browserHostView.test.ts`、`browserLastPicture.test.ts`、`browserApi.test.ts`、`browserInput.test.ts`、`browserAgents.test.ts`；改动过的规则逐条破坏后都有测试失败（38 处）。`scripts/browser_zoom_probe.ts` 52 项、`scripts/browser_smoke.ts` 75 项（Chrome 154）：200% 时帧 1206×2070、倍数 6、页面看到 201×345 与像素比 4，视图重画时页面不收到 resize；帧 (603, 840) 的点击落在 CSS (100.5, 140)，600 帧像素的滚轮滚 100 CSS 像素；110% 帧 1206×2072（倍数 3.304）；25% 时帧 1206×2070、倍数 0.75；Mac 400% 要 12 得 8，帧 2560×1600；重画前后 24 次点击全中；39 次换档里到达流的帧没有一帧说错尺寸。
> - **回执**：Chrome 同时会有几帧未回执，原来每个回执只与上一个已发出的回执隔开，Chrome 实际出到流所要帧率的约三倍（动着时每秒约 44 帧，流只取 15）。现在每个回执按最快的流的间隔排队，Chrome 最多出到那个帧率。
> - **测得**（同上测试页，画面在动，每秒 15 帧；静止的页面不出帧，不花这些）：
>
>   | | 帧 | 每帧（JPEG） | Chrome CPU |
>   |---|---|---|---|
>   | 之前：1 倍、原回执节奏，质量 80 | 1280×800 | 174 KB | 38%（实出每秒约 44 帧） |
>   | 1 倍、新回执节奏 | 1280×800 | 174 KB | 25% |
>   | Mac 2 倍，质量 80 | 2560×1600 | 477 KB | 61%（原回执节奏下 118%） |
>   | 手机自己尺寸 390×844，质量 70：1 / 2 / 3 倍 | 390×844 / 780×1688 / 1170×2532 | 27 / 103 / 209 KB | 13% / 25% / 45% |
>
>   收帧的 node 进程（CDP 消息与 base64 解码，探针自己测得）在 2 倍时约 9%，1 倍时约 5%。M2 Pro 上测。
> - **测试**：`tests/browserScreencast.test.ts`（回执排队、倍数的取法、改视图时停开 screencast、按倍数的帧与几何）、`browserInput.test.ts`（输入乘倍数、滚轮不乘）、`browserHost.test.ts`（倍数随流与尺寸、输入、agent 调用期间与之后、Chrome 不支持时、同样尺寸只续接手）、`browserAgents.test.ts`（点击在 CSS 尺寸上跑，快照与截图不改画法）、`browserApi.test.ts`（`scale` 参数）。`scripts/browser_smoke.ts` 用真 Chrome 加了：要 2 倍的流拿到 2560×1600 的帧、按帧点击落在按钮上；流走后回到 CSS 尺寸、点击照样落对；屏幕以 2 倍看 agent 的标签时，agent 经网关的点击照样落在按钮上，调用后又回到 2 倍。

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
  - **告诉 agent 用哪个**（2026-10-03，用户看到终端里的 Codex 被要求打开网页时用了自己配置里的 `chrome-devtools`，另起一个 Chrome，问到 Playwright 又去本机找 Playwright、试 ChatGPT 自带的电脑操作，一次没用 AgentSwitch 的：“怎么着么费劲呢，codex调用浏览器，我看他默认还是加载chrome”）：终端里的 agent 除了这个 `browser` 往往还有自己配置的浏览器工具（Chrome DevTools MCP、电脑操作、Playwright），没人说就随便挑。加了 `browser` 的终端同时给 agent 一段说明：要用浏览器时用 `browser` 的工具，它就是 AgentSwitch 的共享浏览器，你在 Mac 和 iPhone 上看得到、能接手，登录态共用；除非你点名要别的，不要另起浏览器。Codex 是 `-c developer_instructions=…`（用户自己的 `config.toml` 没有这一项；以后用户写了，就接在用户的后面），Claude Code 是 `--append-system-prompt`，OpenCode 是 `OPENCODE_CONFIG` 的 `instructions` 指向终端目录里的一个文件。不关掉用户自己的那些工具：终端和普通终端一样用（terminal-v0 §3），点名时照样能用。
- **人的 Fill Ciphertext**：`POST /browser/tabs/:id/fill` `{token, screen?}`。只在人自己的标签上（持有者 `you`）：agent 的标签即使接手也 409“Agent 的标签不可填入密文：填入的值会留在页面中，交还后 agent 可能读到。请在你自己打开的标签中填入。”（2026-10-02 审查：值留在页面、存储与页面发出的请求里，网关不知道这个值，不会替 agent 脱敏）。只有能操作这个标签的屏幕可用（接手方；无人接手时任何屏幕）。宿主在 Playwright 的隔离环境里按 `:focus` 找出焦点所在的可编辑输入框（不含 iframe 元素与下拉框），取它所在 frame 及每一层上层 frame 的 URL，任何一层不是 http(s) 即拒绝；只填密码框或标为密码、验证码的输入框（`input[type=password]`，`autocomplete` 含 `current-password`、`new-password`、`one-time-code`），其余 400“只能填入密码或验证码输入框。”（画面流会把其他输入框的文字原样显示到手机上；验证码框照样显示，验证码短时有效）；`secret-gate fill-value`（stdin `{token, urls}`，stdout `{value, label}`）按网关的 `page_host` 与密文策略逐层核对，用途 `fill`（装了网关服务时为 `browser.resolve`，只认 `fill`）；回答后打进检查过的那个元素本身（元素句柄；Playwright 的 `fill`，替换输入框原有内容），焦点已换到别的元素、frame 链变了或元素已不在则不填（原先是 `Input.insertText` 打进当时有焦点的元素，回答期间点到别的输入框就会填错地方）。响应为 `{tab, filled: {label, host}}`；没有焦点输入框、不是密码或验证码输入框、请求体不对 400，非 http(s) 或网关拒绝 403（网关的原因原样给人），agent 的标签、不是接手方或焦点变了 409，没有网关 503。值不出现在响应、日志、审计里；审计记 `fill` 的 label 与 host，拒绝记原因。
- **接手期间的网络与控制台**（2026-10-02，`src/browser/heldTraffic.ts`）：Playwright MCP 按标签保存网络请求（含请求体：人在 agent 的标签里手动登录时，POST 带着密码）并读页面的控制台，交还后 `browser_network_requests`、`browser_network_request`、`browser_console_messages` 会交给 agent；重新连上的桥（新的 MCP 连接）还会从页面自己的记录（`page.requests()`、`page.consoleMessages()`）重建。现在 daemon 从 agent 标签打开起，不论有没有 agent 连着，记录每次接手的起止，以及接手期间与交还后 1.5 秒内页面发出的每个请求（点了提交马上交还时，请求稍后才到 Playwright）；Playwright MCP 为 agent 页面建的每个标签对象（新连接的也一样）在被使用前加一层过滤：请求列表去掉这些请求和开始时间落在接手期间的，控制台去掉接手期间的消息（计数一并），接手期间不再记录新的请求、不往控制台日志文件里写；页面错误不带时间，交还 1.5 秒后从页面清掉（之前的一并清掉）。agent 交还后的下一个调用先等过这 1.5 秒。依赖 Playwright MCP 0.0.82 `Tab` 的内部成员（`requests`、`consoleMessages`、`consoleMessageCount`、`_handleRequest`、`_handleConsoleMessage`），测试用它自己的 `Tab` 类固定；不符合预期时，接手过的标签这三个工具一律拒绝（“The user used this tab in AgentSwitch; its network requests and console messages are not available to agents.”）。仍看得到的：页面本身——交还后快照里非密码输入框中手打的字、页面显示或存下的内容；页面在交还之后自己再发的请求（如延迟提交）；接手期间标签列表里的标题与网址。
- **两端的 Fill Ciphertext（2026-10-02）**：人只在自己的标签（owner `you`）上填入——agent 的标签即使接手也不显示（交还后 agent 的快照能看到页面，服务端随之回 409）；只填入密码与一次性验证码输入框，其他输入框服务端回 400 “只能填入密码或验证码输入框。”，Mac 与 iPhone 原样显示。接手 agent 的标签时两端各说明一次：“接手期间你输入的内容，交还后 agent 能在页面上看到；密码请在自己的标签里填写。”
- **不是 HTML 的页面**（2026-10-03，用户看到终端里的 Codex 用 `browser_navigate` 打开一张带动画的 SVG，页面在共享浏览器里开出来了，调用却报 `TimeoutError: browserBackend.callTool: Timeout 30000ms exceeded`，随后的 `browser_snapshot` 同样：“怎么还能超时的？……但是确实成功打开浏览器了”）：Playwright 读页面结构时固定找 `body,frameset`（`ariaSnapshotJSONForFrame`），找不到就重试到调用的 30 秒用完；作为页面打开的 SVG 文件没有 `body`。agent 的每个标签现在带一段在页面自己的脚本之前运行的初始化脚本：文档加载完还没有 `body` 时，在根元素下补一个空的 XHTML `body`（带 `data-agentswitch-stand-in`，SVG 根下的 XHTML 元素不渲染），快照立即返回（内容为空）。`browser_navigate`、`browser_navigate_back`、`browser_snapshot` 的回答在这种页面上多一句给模型的话：这是 `image/svg+xml` 文档、没有可读的结构、页面已打开，用 `browser_take_screenshot` 看。脚本以文本注入（函数的源码会带上编译器的辅助调用，如 tsx 的 `__name`，页面里没有）。人的标签不加这段脚本（没有人读快照）。`scripts/browser_smoke.ts` 用真 Chrome 覆盖：SVG 约 40 ms 返回并附说明，快照、截图照常，之后的 HTML 页面读法不变。
- **未处理的 rejection**：Playwright MCP 每个连接都会监听整个进程的未处理 rejection（报给 agent，也让真正的错误不再结束进程）。daemon 在它加上时摘掉；有 agent 连接期间，Playwright 自己的（如试图保存被拒的下载）只记日志，其余照 Node 默认处理。
- **已知**：`browser_run_code_unsafe` 已限于网关的探测模板（见上），直连桥的进程仍可让 daemon 把页面截图写成任意目录下一个 `secret-gate-mask-<16 位十六进制>.png` 新文件。共享浏览器不经网关代理（同你自己的 Chrome），页面里的值只经网关的填写进入。
- **测试**：`tests/browserAgents.test.ts`（令牌、私有目录、顺序、接手排队与超时、新连接与定位期间的接手、`browser_close` 等交还、日志工具的拒绝、状态与动作、拒绝、关闭）、`browserAgentContext.test.ts`（上下文替身的隔离、新连接的当前标签、标签对象的过滤与交还后的缓冲）、`browserHeldTraffic.test.ts`（Playwright MCP 自己的 `Tab` 类：接手期间的请求与控制台不进列表、计数与日志文件，重连也一样）、`browserProbes.test.ts`（模板放行、逃逸尝试拒绝、与网关生成的代码核对）、`browserBridge.test.ts`（真 HTTP 上的桥与令牌）、`browserFill.test.ts`（只在人的标签、只填密码与验证码输入框、焦点变了不填）、`browserRules.test.ts`（数据卷写法、大小写、副本与名字，真实文件）、`protected.test.ts`（执行器同样的写法）、`terminalBrowser.test.ts`；网关 `tests/test_fill_value.py`、`tests/test_browser_probe_templates.py`。`scripts/browser_smoke.ts` 在临时目录里用真 Chrome 与仓库里的 secret-gate（临时密钥，不连网关服务）走一遍：经网关导航与快照、标签归属与动作、人的标签不在 agent 列表里、`secret_fill` 填入且结果与快照里没有明文、遮罩截图（daemon 写入、网关核对）、接手时调用等待与失败、交还后继续、人在 agent 的标签里手动登录后 agent 与重连的桥都看不到那次 POST 与控制台、人的填入在 agent 的标签上被拒、填入文本框被拒、填入自己标签的密码框经 `fill-value`、数据卷写法的禁区、跳转到自己端口的子资源与导航、被拒的下载不影响 daemon、Playwright MCP 的文件每次调用后清空。没有用真模型验证（约定不打真模型）。
- **未做**：调度任务迁入宿主（第 5 步）；`waiting` 状态与实时活动（agent 等你时）；标签名跟随终端改名（目前固定为启动时的 `agent · 文件夹`）。

## 7. 真窗口、Camoufox、身份与引擎（2026-10-05 已定）

用户（2026-10-05，先后）：“浏览器在桌面端能不能不用录屏，直接用原生浏览器？手机端用录屏传输”“而且我想让他用camufox，而不是chrome，而且留下更换指纹和代理的接口”“平时就用真窗口不行吗”“需要留一个camufox和playwright更新的接口，不要留下一堆浏览器版本更新的缓存”；Playwright 的更新方式选“也能经接口单独更新”；看过演示页 `docs/design/implemented/browser-window.html` 后：“可以，按照这个做吧”。本节改 §4 的第 2 条（Mac 上不再是画面），其余各条不变。

### 7.1 可行性验证（2026-10-05，只验证、未改代码）

服务内置的 playwright-core 1.64（配 Firefox 156）驱动 Camoufox 156.0.1-beta.34（mac.arm64，下载 1.29 GB，解包 2.4 GB，其中字体 2.0 GB；临时签名）：

- **能用**：启动、开页、弹出页（带 opener）、`setViewportSize`、鼠标、滚轮、按键、`insertText`（中文）、`context.route` 拦请求、无障碍快照；`CAMOU_CONFIG_1` 环境变量给指纹（核心数、语言、平台），Playwright 的 `proxy` 给代理，两者都在启动时给；`navigator.webdriver` 为 false。
- **画面**：`page.screencast`（Juggler）无头每秒 17 帧；带窗口每秒 20 帧，被别的窗口盖住 21，应用隐藏 19（隐藏时页面的 `requestAnimationFrame` 掉到每秒 1 次，`layout.throttled_frame_rate` 无效）。不需要录屏权限。带窗口时 DPR 是屏幕的（2），帧可按屏幕像素要（每秒约 14 帧）。
- **网关密文填入**：`secret-gate browser` 在前、Playwright MCP 在 Camoufox 上，`secret_fill`、字段状态、快照遮盖、截图遮罩、拒绝 `browser_evaluate` 全部通过，表单收到真实值（152 与 156 各一遍）。
- **版本绑定**：Camoufox 152 配这版 Playwright 时 `setViewportSize` 报协议错、录屏只出一帧。构建必须与 Playwright 的 Firefox 同代。
- **缺口**：`context.route` 拦不到 `file:` 页面；拦不到重定向之后的请求（页面经一次 302 能访问本机被禁的端口，Chrome 靠 `Network.setBlockedURLs`）；DPR、触摸是整个浏览器一份、启动时定，没有按页的手机模拟（`isMobile` 被接受但无效）；`page.evaluate` 与 `addInitScript` 在隔离的世界里，页面的全局变量看不到、页面也看不到它们。
- **真窗口**：从外面 `newPage` 的每个页面是一个独立窗口，页面自己 `window.open` 的是同一窗口里的标签（宿主都能看到）；启动时应用到最前；之后从外面开页面不抢键盘焦点，但窗口升到当前窗口的正下方；应用被隐藏时从外面开页面会自己取消隐藏；应用隐藏时输入照常。`addInitScript` 装的监听能数到输入。
- **启动**：156 每次约 8.3 秒（152 约 0.85 秒），与指纹配置无关。

### 7.2 已定

1. **Mac 上浏览器是 Camoufox 自己的窗口**。主窗口的 `Browser` 页不再画画面，是标签列表加 AgentSwitch 加在标签上的东西：所选标签的信息与一张静止预览、`Show Window`、接手与 `Hand Back`、`Fill Ciphertext`、`Copy URL`、`Close Tab`；状态栏右端是身份，点开是指纹、代理与引擎。⌘L、⌘R、⌘[ ⌘] 归 Camoufox，本页保留 ⌘T。
2. **引擎是 Camoufox**，只经 Playwright 的公开接口驱动。没有显示器的主机（Linux 纯服务端）无头运行。Camoufox 尚未下载时用本机的 Chrome 作后备，那时 Mac 上仍是画面（现在的样子），没有指纹与代理设置。
3. **手机仍是画面**，接手时 Mac 上那个窗口缩到手机宽度（窗口最窄 500 点）；页面是窄窗口里的桌面版，不再模拟手机（没有 `mobile`、触摸）；点按照旧换成鼠标事件。
4. **接手改为自动**：在 agent 的窗口里操作即视为你接手——服务发现不是它自己（agent 的调用、手机转发的输入）发出的输入，就把这个标签记为你接手：agent 的操作排队，接手期间的网络与控制台记录不交给它（§6 的规则不变）；2 分钟无操作或 `Hand Back` 交还。自己的标签没有接手一说。
5. **身份**：指纹保存在配置旁、保持不变，`New Fingerprint`（或导入一份）才换，换后重新启动浏览器并按网址恢复标签。代理即时生效、无需重启；代理密码以密文保存，模型与执行器不接触明文。时区随代理出口。
   - 2026-10-05 实现时的两处修正（见 §7.5 第 4 步）：其一，原写“服务不持有明文”做不到——转发层要拿明文去连上游代理，所以明文由凭据网关解开后留在服务的内存里（不落盘、不进日志、不进库、不进模型与执行器上下文）；要让服务也不持有，得由网关自己去连上游，那是网关的一个新入口，未做。其二，时区在浏览器启动时给定，所以代理换了之后时区要到下次启动才跟上，界面说明这一点并给 `Restart Browser`。
6. **引擎更新**：Camoufox 与 Playwright 成对更新。`GET /browser/engine`（现状与可用更新）、`POST /browser/engine/update`（指定版本或取最新的相容版本），设置的环境检测页一行与命令行同此；默认不自动更新。流程：下载 → 核对官方公布的校验值 → 解包 → 自检（启动、开页、改尺寸、连续出帧、拦截、agent 工具）→ 切换 → 删除旧版本。自检不过不切换、保留原版本并说明原因。**磁盘上任何时候只有一份**：压缩包解包后即删，中断的更新在服务启动时清除，不使用 Playwright 自己的浏览器缓存目录，也不碰用户自己的 camoufox 缓存。Playwright 的新版本装在应用包之外（应用包有签名、运行时不能改），自检不过或缺失时用包内的版本。

### 7.3 结构

- **驱动**：`BrowserDriver` 之下两个实现——Chrome（现有，CDP）与 Camoufox（`firefox.launchPersistentContext`，`executablePath` 指向引擎目录，指纹经 `CAMOU_CONFIG_n` 环境变量，`colorScheme` 等四项媒体特性不覆盖）。驱动接口里按 CDP 形状写的输入改成中性的形状，由各驱动翻译。画面在 Camoufox 上用 `page.screencast` 的 `onFrame`：回调返回的承诺就是确认，宿主照旧一帧一确认。
- **转发层**：浏览器的全部流量（含对本机的，`network.proxy.allow_hijacking_localhost`）先到服务自己的本地转发代理。它按解析后的地址拒绝 AgentSwitch 自己的端口（重定向、WebSocket、指向本机的域名都挡得住），再直连或交给上游代理；换上游不用重启浏览器。按页的规则（谁的标签、`file:` 的范围）照旧在 `context.route` 与导航前的检查里。`file:` 页面内的跳转与子资源拦不到：Camoufox 里本地文件只经宿主检查过的导航打开，页面内再去读别的本地文件由 Firefox 自己的同源规则挡（每个文件一个源），显示类的引用（图片、框架）不在禁区检查之内——这一条写进 `BOUNDARY.md`。
- **窗口**：`POST /browser/tabs/:id/show` 把标签的窗口排到本应用最前，Mac 应用再把 Camoufox 激活到最前（由前台的应用把位置让给它：`yieldActivation` 加 `activate(from:)`）。浏览器由服务启动时会到最前：Mac 应用记着之前在前台的是谁，浏览器在刚启动的 30 秒内自己到了前台、而这边 8 秒内没人要过它的窗口（`Show Window`、在 `Browser` 页开标签）、0.6 秒内也没有鼠标按下（那是人点过来的），就把之前的应用换回来，一次启动至多两回（`BrowserFrontPolicy`、`BrowserFrontKeeper`）。浏览器的窗口留在原处，只是不在最前。
- **引擎目录**：`$AGENTSWITCH_HOME/browser/engine/camoufox/current/`（应用本体与 `version.json`）、`…/engine/playwright/current/`（包外的 playwright-core，可无），更新中的在 `…/engine/incoming-*`，启动时清掉。Playwright 一律经一个加载函数取：包外的在且自检过就用它，否则用包内的。
- **身份**（`src/browser/identity.ts`、`exit.ts`、`src/api/browserIdentity.ts`）：`$AGENTSWITCH_HOME/browser/identity.json`（0600：指纹配置、生成时间与来源、代理地址与用户名、代理密码的密文、上次查到的出口）。
  - 指纹：默认的一份是“这台机器上的 Firefox”——系统、屏幕、窗口、字体都用真的（窗口大小若是编的，人就没法调它），只把 Camoufox 的字样换成同版本 Firefox 的，另给核数、音频种子等几项自己的值。引擎换到另一个 Firefox 版本时，浏览器的名字跟着走，其余不变。导入的是一组 Camoufox 属性（JSON 对象，至多 256 KB），原样使用。
  - 代理：`scheme://host:port`（http、https、socks4、socks5），用户名可无；密码只收 `enc:v1:` 密文，须有用户名。设置时即向凭据网关要一次明文（`secret-gate fill-value`，站点是代理自己的 `host:port`，所以密文要对它有 `fill` 用途），要不到就拒绝、什么都不改。服务启动时再要一次；要不到期间上游不可用，出本机的请求一律 502，不改走直连。只改别的、不重输密码时带 `keepPassword`，沿用已存的密文。
  - 出口：有代理时经转发层（也就经代理）向一个公开的查询服务发一次 GET，取出口地址、地点与时区；默认 `https://ipinfo.io/json`，`AGENTSWITCH_BROWSER_EXIT_LOOKUP` 可换成别的或 `off`。设置代理时与服务带着代理启动时各查一次，没有代理时不查。查不到不影响代理，界面写明。
  - 时区：指纹自己没写时区、出口又已知时，浏览器在出口的时区里启动。正在运行的浏览器若是用另一份配置启动的，`restartNeeded` 为真。
  - 接口（只在本机）：`GET /browser/identity`（指纹摘要与全文、代理（密码只说有无）、出口、`restartNeeded`）、`PUT /browser/identity`（`fingerprint: "new" | {config}` 会重启浏览器；`proxy: {server, username?, password?, keepPassword?} | null` 立即生效）、`POST /browser/identity/restart`。
  - WebRTC：Camoufox 自带的默认设置是“在代理之后只走代理”（`media.peerconnection.ice.proxy_only_if_behind_proxy`、`default_address_only`），而浏览器始终在转发层之后，所以不会绕过代理直接发 UDP；页面里的通话只能靠 TCP 的中继。

### 7.4 分期

1. 引擎管理：目录、现状、下载与校验、自检、切换与清理、Playwright 加载函数、两条接口与命令行。不动现有浏览器。
2. Camoufox 驱动与转发层：先无头，对齐现有的宿主测试（标签、画面流、输入、接手与排队、填入、agent 工具）。
3. 真窗口：带窗口启动、`show`、自动接手、静止预览、手机接手时的尺寸。
4. 身份：指纹生成与保存、代理切换、代理密码经网关。
5. Mac：`Browser` 页改成列表加控制、状态栏的身份、指纹 / 代理 / 引擎的浮框、环境检测页一行。演示页移进 `implemented/`。
6. iPhone：文案（不再是 `Phone Size` 的手机版页面）、`Open on Mac`。
7. `packages/secret-gate/BOUNDARY.md`、各 README；网关代理对大响应改为流式（下载 Camoufox 时发现它把整个响应收进内存）。

### 7.5 进度

**第 1、2 步的服务端已完成（2026-10-05，未提交）**，Mac 与手机的界面还没动；Camoufox 现在仍以无头方式运行，装了它之后 Mac 的 `Browser` 页照旧是画面。

- **引擎管理**（`packages/daemon/src/browser/engine/`）：`store.ts`（目录：`camoufox/current`、`playwright/current`、`incoming-*`；切换即删旧、启动时清扫）、`update.ts`（下载 → 校验 → 解包 → 自检 → 切换，一次一个，可取消）、`releases.ts`（读 GitHub 的发布与 npm 的版本；只给有校验值的构建）、`files.ts`（下载、`ditto` / `tar` 解包、找 Camoufox 的程序）、`loader.ts`（Playwright 从哪来）、`selfCheck.ts`（真的启动一次：启动、开页、改尺寸、连续出帧、拦截、agent 工具）、`kit.ts`（对外的服务）。接口 `GET /browser/engine`（`?check=1` 去问可用版本）、`POST /browser/engine/update`、`POST /browser/engine/cancel`，只在本机（不在手机的白名单上）；命令行 `agentswitch engine [check] | engine update [--camoufox <版本>|latest] [--playwright <版本>|bundled] | engine cancel`。
  - 同时更新 Playwright 时必须写明 Camoufox 的版本（新 Playwright 驱动哪个 Firefox 要解包后才知道，是否配套由自检决定）；`--playwright bundled` 改回应用自带的那份。
  - 实测：一次性服务上 `engine update --camoufox latest` 下载 1.29 GB、校验、解包、自检、切换，结束后引擎目录里只有 `camoufox/current`（2.3 GB）。自检对 156 通过（13 秒），对 152 在“改尺寸”一步不通过。
- **Playwright 只用一份**：浏览器由哪一份启动，agent 的工具（Playwright 自己的 MCP）就从哪一份加载（`playwrightInUse`）；Chrome 的驱动同样经加载函数取。
- **Camoufox 驱动**（`camoufoxDriver.ts`、`camoufoxInput.ts`）：宿主发给驱动的输入仍是原来的形状（没有改成中性的，改动面太大），由驱动翻译成 Playwright 的鼠标键盘动作，修饰键按需按下松开；尺寸用 `setViewportSize`，不按页缩放；画面用 `page.screencast`，承诺即确认。配置目录是 Chrome 的旁边一份（`browser-profiles/main-camoufox`）：**两个浏览器的登录态不通**，换成 Camoufox 后要重新登录。
- **转发层**（`forwarder.ts`，库 `proxy-chain`）：只听本机回环，只认本次运行的口令（别的程序用不了它）；AgentSwitch 自己的端口按名字或解析结果拒绝；本机与内网直连，其余交给上游代理（现在还没有设置的入口，第 4 步）。
- **本地文件**：Firefox 不让 `file:` 经过拦截，页面里的链接或内嵌指向受保护的文件时，改为页面到了之后立刻问、不许看的换成拒绝页（内容在页面里出现过一瞬）。宿主自己发起的打开仍是事先拒绝。
- **实机检查**：`scripts/browser_smoke.ts` 加了 `BROWSER_SMOKE_CAMOUFOX=<程序>`，同一套检查在 Camoufox 上 62 项全过（4 项 Chrome 独有的“两倍绘制”跳过），在 Chrome 上 75 项全过。
- **第 3 步的服务端也已完成（同日，未提交）**：
  - 带窗口：`AGENTSWITCH_BROWSER_WINDOW`（Mac 上默认开，`=0` 或其他系统为无头）。`GET /browser/tabs` 多两项：`engine`（`camoufox` / `chrome`）、`windows`（标签是否各有窗口）。
  - 尺寸：带窗口的标签不设尺寸，窗口多大就多大，画面按来的尺寸收；有屏幕接手并设了尺寸时窗口跟着变，交还后回到原来的大小（驱动记着接手前的大小）。人改了窗口大小，画面流按新尺寸重开。
  - `POST /browser/tabs/:id/show`（把窗口排到浏览器各窗口最前；把浏览器叫到别的应用前面由 Mac 应用按应用包的位置来做）、`GET /browser/tabs/:id/preview`（静止的 JPEG，2 秒内复用），都只在本机。
  - 人自己在窗口里开的标签（不是驱动开的，也不是页面弹出的）登记为 `You` 的标签。
  - 在 agent 的窗口里动手即接手：浏览器的初始化脚本在页面看不到的世界里数输入，驱动每半秒读一次，数变了就说一声；宿主排除自己发的（agent 的调用进行中、0.6 秒内有屏幕转发过输入），其余算人的，以 `mac-window` 的名义接手，两分钟无输入或 `POST …/release {screen: "mac-window"}` 交还。审计里记一条。
  - `host.restart(between)`：记下各标签的主人与地址，停浏览器，做中间的事，再逐个开回来。引擎更新的“切换”一步包在它里面（`EngineKit.aroundSwitch`）。
  - 实机检查 `scripts/browser_window_smoke.ts <Camoufox 的程序>`（会开真窗口约半分钟）：21 项全过——窗口保持自己的大小（1280×864，帧 2560 像素宽）、接手设尺寸与交还后原样恢复、手开的标签归 `You`、屏幕的点击不被当成人的、不是宿主发的输入触发接手、叫到最前、预览、重启后三个标签都回来。
- **第 5 步的 Mac 页面，主体已做（同日，未提交）**：服务说 `windows: true` 时，`Browser` 页右侧换成详情栏（`BrowserDetailPane.swift`）——静止预览（`GET …/preview`，这一页看得见时每 3 秒一张，按图自己的长宽比）、标题、地址、主人与它在做什么、按钮与一句说明；不再取画面流，不接手、不设尺寸、不缩放，地址栏不出现，状态栏右端的接手与缩放两组不出现。列表行尾标出谁拿着（`You`、`On iPhone`），双击一行即 `Show Window`。`Show Window` 先请服务把窗口排到最前，再按应用包的位置（`BrowserFront`）把 Camoufox 激活。`Hand Back` 以 `mac-window` 交还。文字与按钮的规则在 Core 的 `BrowserWindowText`（有测试）。设计预览多四张：`main-browser-window`、`-agent`、`-took`、`-phone`（两种外观都画过，与演示页对照无出入）。Chrome 作后备时（`windows: false`）页面照旧。
- **第 4 步，身份（同日，未提交）**：结构见 §7.3“身份”。服务端测试 `tests/browserIdentity.test.ts` 20 项；实机检查 `scripts/browser_identity_smoke.ts <Camoufox 的程序>`（无窗口，上游代理与出口查询都是本机的替身）24 项全过——页面与请求读到的都是指纹里的浏览器（`Firefox/156.0`，没有 Camoufox 字样）、重启后不变、新指纹与导入的指纹重启后生效且标签都回来、带密码的代理即时生效且只管出本机的流量、密码不落盘、出口经代理查到、时区重启后变成出口的、`Direct` 即时生效、密码取不到时不放行。另用一次性的网关目录确认：按 Mac 的做法封的密文（`http` + `fill`，站点 `host:port`）只对那个 `host:port` 给出明文，换端口、换主机都拒绝。默认的出口查询经转发层的 HTTPS 隧道实测可用。
- **第 5 步余下的界面（同日，未提交）**：状态栏右端两项（`BrowserIdentityItems`）——引擎的一句（更新中、未安装，琥珀色）与身份（`macOS · Firefox 156 · socks5 Tokyo`、`… · direct`、`Chrome · No Identity`），点开是浮框 `BrowserIdentityBox`（页面右下角，窗口矮时可滚动）：Camoufox 在用时三段 `Fingerprint`（六行、`New Fingerprint`、`Import…`）/ `Proxy`（地址、用户名、密码、出口、`Apply`、`Direct`，时区待重启时一句说明加 `Restart Browser`）/ `Engine`（版本、`Check for Update`、有新版时 `Update`）；更新中或未安装时只有 `Engine`（进度条、五步、`Cancel`；`Download`）。代理密码在 Mac 上由本机网关封成密文（名字 `browser/proxy`，站点是代理的 `host:port`）再发给服务，明文不出 Mac 应用。模型 `BrowserIdentityModel`，文字与规则在 Core 的 `BrowserIdentity.swift`（有测试）。设计预览多三张：`main-browser-identity`、`main-browser-engine-update`、`main-browser-engine-missing`。演示页的指纹几行、引擎几行已按做出来的样子改过。
- **同日补的两处（未提交）**：Camoufox 启动失败有自己的说法（`camoufoxLaunchFailure`：程序不在、或启动报错的第一行，都指向引擎一栏；此前程序不在会被说成“未找到 Google Chrome”）；设置的环境检测页多一节 `Browser`，一行 `Engine`（`Camoufox 156.0.1-beta.34 · Playwright 1.64.0`、`Camoufox Not Installed · Chrome in Use`、`Updating: download 62%`），只读，下载与更新在 `Browser` 页的浮框里。
- **Mac 页面的整体走查（2026-10-05 夜，未提交）**：调试版应用的探测加了两段（`BrowserProbe+Windows.swift`，`-browserProbe` 连一次性服务，窗口放在最后面），真服务加真的 Camoufox 窗口跑过，全部通过：
  - 有窗口的服务：服务开的标签（没人在这边要过）让浏览器启动并到了前台，前台随即还给原来的应用；列表、详情、静止预览（1280×864）；`Show Window` 后浏览器在最前；身份浮框；代理 `Apply` 即时生效、出口经代理查到、在这边开的标签经代理出网；`Restart Browser` 后两个标签都回来、时区变成出口的、前台仍是原来的应用；`Direct`；`New Fingerprint`（核数变了、标签都回来、前台不变）；关标签。
  - 没装 Camoufox 的服务：状态栏 `Camoufox Not Installed` · `Chrome · No Identity`；浮框查到可下载的版本与大小；`Download` 开始真的下载并显示进度；`Cancel` 后回到未安装，引擎目录里不留东西。
  - 走查中改的：浏览器重启后会留在前台（原先只认 12 秒，带标签启动更久，现在 30 秒，并排除人点过来的）；在 `Browser` 页开的标签现在随即 `Show Window`；浮框里“待重启”的说明与按钮分两行；Playwright 的版本去掉构建戳再显示。
  - 没走到的：代理带密码时 Mac 上封密文那一步（探测里的应用会用到已安装的网关，没有去碰；服务端与网关各自验过）；agent 的标签在页面上的样子（只在设计预览与服务端的实机检查里看过）；`Show Window` 是从后台的探测进程发的，前台的正式应用里没点过。
- **还没做的**：iPhone 的文案与 `Open on Mac`；网关大响应流式；命令行里的身份（现在只有接口）；让网关自己去连上游代理（服务不持有代理密码的明文）。

