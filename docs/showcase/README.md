# 功能展示页

`index.html`：Mac 与 iPhone 两端的全部界面、实时活动、动效录屏，以及可操作的演示（嵌入 `../design/visual-v1/` 的 `terminal.html?bare`、`phone.html?bare&dark`）。所有数据都是演示数据：截图来自 Mac 应用的 `-designPreview` 和 iPhone 应用的 `-uiDemo` 画面，录屏来自 iOS 模拟器。

素材不进 git，由 `build.sh` 生成到 `media/`：

```bash
docs/showcase/build.sh capture   # Mac 出图、实时活动出图、模拟器截图与录屏，写入 .src/（要 Xcode 和 iPhone 17 模拟器）
docs/showcase/build.sh media     # .src/ → media/（网页尺寸的 JPEG、mp4）
docs/showcase/build.sh zip       # 展示页和演示页打成 ~/Desktop/AgentSwitch-showcase.zip，解压后打开 showcase/index.html
```
