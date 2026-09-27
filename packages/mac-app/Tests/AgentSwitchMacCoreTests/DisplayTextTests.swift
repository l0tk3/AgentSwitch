@testable import AgentSwitchMacCore
import XCTest

final class ModelNameTests: XCTestCase {
    func testClaudeIds() {
        XCTAssertEqual(ModelName.display("claude-opus-5-5"), "Opus 5.5")
        XCTAssertEqual(ModelName.display("claude-sonnet-4-6"), "Sonnet 4.6")
        XCTAssertEqual(ModelName.display("claude-haiku-4-5-20251001"), "Haiku 4.5")
        XCTAssertEqual(ModelName.display("claude-opus-5"), "Opus 5")
        XCTAssertEqual(ModelName.display("claude-fable-5-1"), "Fable 5.1")
        XCTAssertEqual(ModelName.display("claude-opus-5-5[1m]"), "Opus 5.5 (1M)")
        XCTAssertEqual(ModelName.display("claude-3-5-sonnet-20241022"), "Sonnet 3.5")
    }

    func testOtherProviders() {
        XCTAssertEqual(ModelName.display("gpt-6-luna"), "GPT-6 Luna")
        XCTAssertEqual(ModelName.display("gpt-5.6-sol"), "GPT-5.6 Sol")
        XCTAssertEqual(ModelName.display("gpt-5.5"), "GPT-5.5")
        XCTAssertEqual(ModelName.display("deepseek/deepseek-flash"), "DeepSeek Flash")
        XCTAssertEqual(ModelName.display("deepseek-chat"), "DeepSeek Chat")
        XCTAssertEqual(ModelName.display("gemini-2-5-pro"), "Gemini 2.5 Pro")
        XCTAssertEqual(ModelName.display("o4-mini"), "o4-mini")
    }

    func testUnknownAndEmptyPassThrough() {
        XCTAssertEqual(ModelName.display(""), "")
        XCTAssertEqual(ModelName.display("sonnet"), "Sonnet")
        XCTAssertEqual(ModelName.display("MyModel"), "MyModel")
    }

    func testHarnessNames() {
        XCTAssertEqual(HarnessName.display("claude-code"), "Claude Code")
        XCTAssertEqual(HarnessName.display("codex"), "Codex")
        XCTAssertEqual(HarnessName.display("opencode"), "OpenCode")
        XCTAssertEqual(HarnessName.display("echo"), "echo")
    }
}

final class DisplayPathTests: XCTestCase {
    func testHomeBecomesTilde() {
        XCTAssertEqual(DisplayPath.short("/Users/u/Projects/AgentSwitch", home: "/Users/u"), "~/Projects/AgentSwitch")
        XCTAssertEqual(DisplayPath.short("/Users/u", home: "/Users/u/"), "~")
        XCTAssertEqual(DisplayPath.short("/Users/uu/x", home: "/Users/u"), "/Users/uu/x")
        XCTAssertEqual(DisplayPath.short("/opt/homebrew/bin", home: "/Users/u"), "/opt/homebrew/bin")
    }
}

final class TimeTextTests: XCTestCase {
    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }
    /// 2026-09-25 14:20:00 UTC.
    private let now = Date(timeIntervalSince1970: 1_790_346_000)

    func testMoments() {
        XCTAssertEqual(TimeText.moment(now.addingTimeInterval(-20), now: now, calendar: calendar), "刚刚")
        XCTAssertEqual(TimeText.moment(now.addingTimeInterval(-180), now: now, calendar: calendar), "3 分钟前")
        XCTAssertEqual(TimeText.moment(now.addingTimeInterval(-4 * 3600), now: now, calendar: calendar), "今天 10:20")
        XCTAssertEqual(TimeText.moment(now.addingTimeInterval(-86_400), now: now, calendar: calendar), "昨天 14:20")
        XCTAssertEqual(TimeText.moment(now.addingTimeInterval(-5 * 86_400), now: now, calendar: calendar), "9月20日 14:20")
    }

    func testDaysAndBuilds() {
        XCTAssertEqual(TimeText.day(now, now: now, calendar: calendar), "今天")
        XCTAssertEqual(TimeText.day(now.addingTimeInterval(-400 * 86_400), now: now, calendar: calendar), "2025年8月21日")
        XCTAssertEqual(TimeText.build("2026-09-25T06:20:00Z", now: now, calendar: calendar), "今天 06:20")
        XCTAssertEqual(TimeText.build("dev", now: now, calendar: calendar), "dev")
    }
}

final class ShortStatusTests: XCTestCase {
    private func state(_ phase: SupervisorPhase) -> SupervisorState {
        SupervisorState(phase: phase, wanted: true, failures: 0, restarts: 0, lastExit: nil)
    }

    func testServiceWords() {
        let since = Date(timeIntervalSince1970: 0)
        XCTAssertEqual(StatusText.service(state(.running(pid: 1, since: since)), ready: true), StatusLine("运行中", .ok))
        XCTAssertEqual(StatusText.service(state(.running(pid: 1, since: since)), ready: false), StatusLine("启动中", .busy))
        XCTAssertEqual(StatusText.service(state(.external("x")), ready: false), StatusLine("无响应", .warning))
        XCTAssertEqual(StatusText.service(state(.failed("端口被占用")), ready: false), StatusLine("失败", .error))
        XCTAssertEqual(StatusText.service(.initial, ready: false), StatusLine("已停止", .off))
        XCTAssertEqual(StatusText.headline(.ok), "运行中")
    }

    func testPhoneAndTailscale() {
        let ok = StatusLine("HTTPS", .ok)
        let phone = Device(id: "a", name: "A", platform: "ios", createdAt: nil, lastSeenAt: nil, revokedAt: nil, online: false)
        XCTAssertEqual(StatusText.phone(remote: ok, enabled: false, devices: [phone], online: 1), StatusLine("已关闭", .off))
        XCTAssertEqual(StatusText.phone(remote: StatusLine("404", .warning), enabled: true, devices: [], online: nil).text, "不可用")
        XCTAssertEqual(StatusText.phone(remote: ok, enabled: true, devices: [], online: nil), StatusLine("未配对", .off))
        XCTAssertEqual(StatusText.phone(remote: ok, enabled: true, devices: [phone], online: 1).text, "1 台在线")
        XCTAssertEqual(StatusText.phone(remote: ok, enabled: true, devices: [phone], online: nil).text, "已配对 1 台")
        XCTAssertEqual(StatusText.tailscale(nil, tailnet: ["100.64.0.1"]), StatusLine("100.64.0.1", .ok))
        XCTAssertEqual(StatusText.tailscale(.notInstalled, tailnet: []), StatusLine("未安装", .off))
        XCTAssertEqual(StatusText.harness(.notLoggedIn), StatusLine("未登录", .warning))
    }
}
