# 功能展示页

`index.html`：Mac 与 iPhone 两端的全部界面、实时活动、动效录屏，以及可操作的演示（嵌入 `docs/design/` 的 `terminal.html?bare`、`phone.html?bare&dark`，构建时复制到 `demo/`：Safari 打开本地网页时只读得到它所在文件夹及子文件夹里的文件）。所有数据都是演示数据：截图来自 Mac 应用的 `-designPreview` 和 iPhone 应用的 `-uiDemo` 画面，录屏来自 iOS 模拟器。

素材不进 git，由 `build.sh` 生成到 `media/`：

```bash
docs/showcase/build.sh capture   # Mac 出图、实时活动出图、模拟器截图与录屏，写入 .src/（要 Xcode 和 iPhone 17 模拟器）
docs/showcase/build.sh media     # .src/ → media/（网页尺寸的 JPEG、mp4）
docs/showcase/build.sh zip       # 展示页和演示页打成 ~/Desktop/AgentSwitch-showcase.zip，解压后打开 showcase/index.html
```

## 根目录 README 里的图（`docs/readme/`）

这九张**进 git**（用户 2026-10-09：应该在readme上弄一些功能展示），是本页“素材不进 git”的例外，所以只留少数几张、压到网页尺寸（共约 1.4 MB）。全是演示数据，重新出图的办法：

- Mac（深色、像素外观，宽 1600、JPEG 82）：`.build/debug/AgentSwitchMac -designPreview <目录>` 的 `main-dispatch-dark`；再加 `-designPreviewOnly terminals` 的 `terminals-record`、`-designPreviewOnly browsers` 的 `main-browser-profiles`、`-designPreviewOnly clash` 的 `main-clash`。
- iPhone（模拟器，`simctl ui … appearance dark`，状态栏 9:41，`-appearance pixel`，宽 600、JPEG 82）：`-uiDemoScreen home`、`terminals`、`simple`、`browserpage`、`clashservice`。换外观后第一次启动会弹“图标已更换”，先空启动一次再截。
- 转换：`sips -s format jpeg -s formatOptions 82 --resampleWidth <宽> <png> --out docs/readme/<名字>.jpg`。
