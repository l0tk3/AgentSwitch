#if DEBUG
import AgentSwitchLive
import Foundation

/// A sample summary for looking at the Live Activity without a Mac (`-liveDemo YES`, debug builds only).
enum LiveDemo {
    static let state = LiveState(rows: [
        .init(id: "demo1", title: "finance-login", step: "短信验证码是多少？", model: "Claude Code",
              startedAt: Date().addingTimeInterval(-95), needsYou: true, doing: "Answer"),
        .init(id: "demo2", title: "api-refactor", step: "运行 npm test", model: "Codex",
              startedAt: Date().addingTimeInterval(-640), needsYou: false, doing: "Run"),
        .init(id: "a1b2c3d4", title: "fix-login", step: "Bash: npm test", model: "Claude Code",
              startedAt: Date().addingTimeInterval(-20), needsYou: true, doing: "Allow?"),
    ], running: 1, waiting: 2)
}
#endif
