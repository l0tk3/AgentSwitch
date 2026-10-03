# 设计演示页

两端应用的界面样本（`docs/ui-v0.md` §7 视觉语言 v1 的活样本）：直接用浏览器打开（file:// 即可，不连服务，数据是写死的）。**目录页 `index.html`** 把所有页面按组列出、每张卡片是那一页的实时缩略图，点开查看：`open docs/design/index.html`。

- `implemented/`：**已实现**——两端应用里已经是这个样子（或代码已做、待安装）。改规范时同步改这里；写新界面时先对照这里的样子，没有的先补演示页。
- `concepts/`：**概念设计**——还没做、正在做、搁置或待定的；做完后移进 `implemented/`，并改 `index.html` 里的分组。
- `export.py`：把所有页面导出成单文件 HTML（内联 `pixel.js`、写入已画好的画面、窄屏自动缩放），连同目录页，默认到 `~/Desktop/WorkSpace/Scratch/agentswitch-design/`，发到手机或给别人看用。
- 两个文件夹各有一份 `pixel.js`（共用的像素库：标记、agent 图、文字标、glitch；Safari 打开本地网页时读不到上一级文件夹，所以不共用一份）。两份必须一样，`export.py` 会检查；产品里的正式版本是 `packages/daemon/ui/pixel.js`（ES module），图形数据与这里保持一致。

## 已实现（`implemented/`）

- `app.html`：规则、深浅两套颜色、标记与抖动、字、以及 Mac 菜单栏下拉与 iPhone（tasks 深色、terminals 浅色）的样子。
- `mac-window.html`（2026-10-02，dispatch-v0；用户：入口应该保持简洁，和手机一样，一个输入框和对话记录，其他都放在高级设置里）：Mac 主窗口——顶栏紧跟红绿灯的 `Dispatch` / `Terminals` 切换（当前页墨色加信号粉下划线，另一页有事时词后跟状态标记），Dispatch 页是手机首页的桌面版（一栏居中：进行中的话题、对话记录、底部一个输入框，`+` 是系统菜单：附件、密文、Pin Model），任务页在同一栏推入（顶栏 `‹` + 标题），Terminals 页只画个示意（真样子见 `terminal.html`）；下半是设置窗口新的一组 Dispatch：Context、Extensions、Log、History。两页之间切换时顶栏和页面立即换，顶栏以下整块自上而下 13 步刷出、扫描线在前（0.26 秒，同手机与网页终端的刷新；同日由换台改来，换台留给 `mesh.html` 的切换主机；`?freeze=0…12` 定格在第几步，加 `?terminals` 看回到 Dispatch）。`?task` `?menu` `?ask` `?terminals` `?light` `?set=ext|log|history` 直达。
- `terminal.html`：终端窗口——目录树侧栏（同一父目录合并）、新建面板（文字标显形、agent 像素图、模型、单选权限）、权限请求、加密发送、切换终端；顶部可切 English / 正式中文两套短词（已定 English）。2026-09-30 加：侧栏顶上的搜索行（`/` 提示符，⌘F，`#find` 看搜索结果：文件夹名、会话标题、会话内容，命中处标出，内容命中时下面一行摘录），文件夹名后的 git（分支、±改动文件数、↑↓），终端下挂子代理行（名字、正在做的事、类型）。
- `phone.html`：iPhone 的终端——列表（折叠、逐行画出、长按菜单、删除擦除）、新建（文字标显形、选 agent 的 glitch、bypass 确认）、终端页（打开时刷新、拖动发滚轮、权限卡、加密框围住同一个输入框、`/` 补全、像密码时先问）；底部是和桌面对照的特效清单。2026-09-30 加：终端列表顶上的搜索行（`?find`）、git、子代理行，顺序按固定规则；终端页的 `+` 选图后在输入框里留 `[Image #n]` 占位、上面一排缩略图（`?draft`）。
- `island.html`：实时活动的重设计（2026-09-29，用户：灵动岛太丑）——紧凑态、最小态、展开态、锁屏卡片，按 iPhone 17 的尺寸 1 CSS px = 1 pt 画；应用标记兼作状态（进行中青块在上线、等你末端琥珀、完成绿、未完成红），状态方块与转圈第一帧、树形连线、点线、小写等宽短词、`[ open ]`。已照此实现（`AgentSwitchLiveUI`）。
- `mac-live.html`：Mac 上的实时活动（2026-09-30 用户定，已实现：`packages/mac-app` 的 `LiveActivity`）——照 macOS 26 把 iPhone 实时活动放进菜单栏的样子：状态栏里一个黑胶囊（紧凑态：标记 | 计时 / 计数 / 结果方块；胶囊静止，标记是一帧、转圈是第一帧），只在有任务或请求时出现；点开是和手机锁屏同一张卡，在卡上 allow / deny、选选项，要打字的 `[ open ]`；有请求时卡片自己落下、答完收起，结果落下 4 秒。上半是可操作的动态演示（模拟请求、完成、失败），下半是各状态的静态图；深浅壁纸可切。
- `console.html`（2026-09-30，用户：open console 打开的页面太割裂，跟着整体美学风格设计，和手机调度页的元素统一但元素更多）：网页控制台的新样子——顶栏（标记、Mac 名、服务 / 网关 / 手机、`terminals ↗`），侧栏（tasks / log / extensions / context、话题、用量），中间是手机任务页放大（进行中卡片条、记录、审批卡与提问卡、输入框下一排 `// folder` `// model` `// browser` `// approval`），右边是所选任务的步骤时间线；log、extensions、context 三页同一套元素。`#log` `#ext` `#ctx` 直达，`?light` 浅色。
- `depth.html`：像素的层次——硬阴影、台阶补半亮（次像素抗锯齿）、挤出、LCD 次像素，各自用在哪、不用在哪。
- `browser.html`（2026-10-02，browser-v0；用户：就做一个浏览器，然后顺便给 codex 接入上，它调用起来和在 app 里一样）：服务持有的浏览器——手机的 `Browser` 标签页（按持有者分组的标签、本地服务）、看 codex 操作（框出它刚操作的元素）与接手（键帽、`Fill Ciphertext`）、打开 Mac 上的本地网页 / localhost / 被挡的凭据文件 / 外部链接；Mac 主窗口第三页 `Browser`；Codex 那一侧的工具调用。`?took` `?file=localhost|denied|external` 直达。（代码已做，待安装；browser-v0 §3）
- `terminal.html?bare`、`phone.html?bare`（`&dark` 深色）：只留演示本身和模拟操作的按钮，不显示评审用的说明和选项；功能展示页（`docs/showcase/`）这样嵌入。

## 概念设计（`concepts/`）

- `mesh.html`（2026-10-02，用户：抽空做点网状连接的 demo；功能本身搁置，dispatch-v0 §6）：手机同时连多台 Mac、Mac 之间互相使用对方的 Dispatch 与 Terminals——总览（谁能用谁、走局域网 / Tailscale 直连 / 中转，点设备看授权）、主窗口的主机选择（`@ Mac mini`、斜纹提示条、切主机放换台）、两台 Mac 配对（附近的 Mac、配对码、两边核对短指纹、被使用的一方决定给什么）、菜单栏实时活动与手机同时显示多台 Mac。顶上的开关是未定的事：逐对授权 / 信任组、远程终端 Text Only / Full Keyboard、手机按 Mac 分 / 合并。`?host=mini` `?terminals` `?menu` `?step=1…4` `?trust=group` `?keys=full` `?phone=merged` `?light` 直达。
- `menu-icons.html`：Mac 菜单栏面板六个操作的 5×5 像素图标（待用户定），按实际尺寸画在浅色、深色面板里，可和现在只有文字的样子对比；设置的三种画法可切换。
