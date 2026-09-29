#if DEBUG
import AgentSwitchLive
import Foundation

/// A sample summary for looking at the Live Activity without a Mac (`-liveDemo YES`, debug builds only).
enum LiveDemo {
    static let state = LiveState(rows: [
        .init(id: "demo1", title: "登录财务平台", step: "等你回答：短信验证码是多少？", model: "Sonnet 4.6",
              startedAt: Date().addingTimeInterval(-95), needsYou: true),
        .init(id: "demo2", title: "修复 AgentSwitch 的 bug", step: "第 2 步：运行 daemon 测试", model: "Opus 5.5",
              startedAt: Date().addingTimeInterval(-640), needsYou: false),
        .init(id: "a1b2c3d4", title: "fix-login", step: "Bash: npm test", model: "Claude Code",
              startedAt: Date().addingTimeInterval(-20), needsYou: true, kind: .terminal),
    ], running: 1, waiting: 2)
}
#endif
