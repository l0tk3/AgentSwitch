# 凭据层三个隔离 demo

用虚构数据和真正的浏览器验证 `docs/gate-next-v0.md` §7 的机制。只新增独立脚本，不接入生产 daemon、现有 gate 密钥/配置、真实任务或模型。

## 运行

在仓库根目录：

```sh
node packages/secret-gate/scripts/gate_next_demo/run.mjs
```

默认在 `~/Desktop/WorkSpace/Scratch/agentswitch-gate-next-demo-<时间>/` 创建本次输出。也可以指定一个**尚不存在**的输出目录，脚本不会覆盖旧结果：

```sh
node packages/secret-gate/scripts/gate_next_demo/run.mjs --out /absolute/path/to/new-demo-output
```

需要 Node.js、secret-gate 已有 `.venv`（包含 PyNaCl）和已安装的 Node Playwright。脚本优先使用可直接加载的 Playwright，否则寻找本机 `~/.npm/_npx/` 缓存；不会下载或安装包。macOS 上默认用已安装的 Google Chrome 独立无头实例，其他环境使用 Playwright 自带 Chromium。

可配置：

- `PLAYWRIGHT_MODULE`：现有 `playwright` **包目录**的绝对路径。
- `DEMO_PYTHON`：安装了 secret-gate 依赖的 Python 解释器。
- `DEMO_CHROMIUM`：Chromium/Chrome 可执行文件绝对路径。

完成后打开 `report.html`。退出码为 0 表示本次检查全部通过；断言失败或运行异常返回非 0。

## 验证了什么

| Demo | 实际动作 | 主要断言 |
| --- | --- | --- |
| 短引用 | 在内存中生成新的密钥，使用项目现有 sealed-box 加密和 Resolver，登记随机 `enc:ref:` | 同 label 不串值，任务/host/端口/use 约束，元信息修改不改权限，释放及同密钥期间的续跑恢复 |
| 截图与字段状态 | Playwright 原生截图 mask，在独立页用 Canvas 逐像素比对 PNG | 指定敏感区域不透明，公开区域不变，DOM/value 不变；当前 empty/nonempty/unknown 与历史 attempted/filled 分开 |
| 页面数据搬运 | 两个随机本地端口的页面，经受控 Node 驱动、Python gate 子进程和短引用搬运虚构邮箱/电话，再真实提交表单 | 模拟模型快照没有原值；错误范围、端口和用途拒绝；目标收到原值而不是引用；释放后不可用 |

短引用的 `scope` 在此 demo 由受控驱动提供，生产接入必须由执行器会话绑定，不能让模型任意选择。原密文仍是权限依据；释放引用只删除映射，**不撤销已导出的密文**。恢复入口仅供可信调用方使用，且本原型不能跨临时密钥的生命周期恢复。

动态采集没有往来源页面注入 gate 访问能力，也不替换来源 DOM。受控驱动读取指定字段后通过私有 stdin/stdout 管道交给 gate。`resolve` 返回的值只供驱动填表，不写入模拟模型快照或结果 JSON。示例源码和遮罩前图片中会出现明确标记的虚构数据。

截图演示覆盖普通文字、指定区域的邮箱模式、明文显示密码、已加载的异步节点、开放 Shadow DOM、本地同源 iframe 和整个 canvas。只保证本次选择器和已稳定 fixture 中的覆盖，不代表任意动态页面、跨域 frame 或完整 PII 识别已经解决。截图通道之外的工具仍需独立输出控制。

## 产物

- `report.html`：中文离线报告，可展开检查、切换图片。
- `summary.json`：三项实验的检查结果、测量值及边界说明。
- `refs-summary.json`：Python 短引用独立自测结果。
- `model-snapshot.json`：模拟交给模型的页面快照，只含引用与描述信息。
- `mask-before.png` / `mask-after.png`：同一 fixture 的遮罩前后截图。
- `transfer-source.png` / `transfer-target.png`：虚构来源记录与填入后遮罩的目标表单。
- `report-preview.png`：实际浏览器渲染的报告预览。

报告也经过浏览器检查：图片加载、切换交互、页面异常和窄屏横向溢出。所有浏览器 context、进程、临时密钥和本地监听器在本次运行结束后关闭；输出文件保留供查看。

## 文件分工

- `run.mjs`：依赖发现、JSONL 子进程客户端、运行和报告验证。
- `gate_demo.py`：内存引用注册表、现有加密/权限检查和独立自测。
- `mask_demo.mjs`：截图及字段状态 fixture。
- `transfer_demo.mjs`：两页数据搬运和真实本地表单提交。
- `report.mjs`：无远程依赖的 HTML 渲染。

可以只运行 Python 部分：

```sh
packages/secret-gate/.venv/bin/python packages/secret-gate/scripts/gate_next_demo/gate_demo.py --self-test
```

本目录是可丢弃的实验入口，不对外提供可部署服务，未注册 MCP 工具，也没有更改当前服务的截图或凭据策略。
