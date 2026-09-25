#if DEBUG
import AgentSwitchLive
import Foundation

/// A sample summary for looking at the Live Activity without a Mac (`-liveDemo YES`, debug builds only).
enum LiveDemo {
    static let state = LiveState(rows: [
        .init(id: "demo1", title: "登录财务平台", step: "等你：短信验证码是多少？", model: "claude-sonnet-4-6",
              startedAt: Date().addingTimeInterval(-95), needsYou: true),
        .init(id: "demo2", title: "修 AgentSwitch 的 bug", step: "第 2 步：跑 daemon 测试", model: "claude-opus-5-5",
              startedAt: Date().addingTimeInterval(-640), needsYou: false),
        .init(id: "demo3", title: "整理下载目录", step: "执行中", model: "deepseek-flash",
              startedAt: Date().addingTimeInterval(-20), needsYou: false),
    ], running: 2, waiting: 1)
}
#endif
