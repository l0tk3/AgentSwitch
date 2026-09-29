#if os(macOS)
import AgentSwitchLive
import AgentSwitchLiveUI
import AppKit
import SwiftUI
import XCTest

/// Renders the Live Activity's views to PNG for a look before a phone does (`AGENTSWITCH_RENDER_DIR=<dir> swift test
/// --filter LiveRenderTests`; also the showcase's, docs/showcase/build.sh). The island's regions are laid out the way
/// the expanded and compact island place them, black on a clear margin; the lock screen card on a busy background
/// standing in for a wallpaper.
@MainActor
final class LiveRenderTests: XCTestCase {
    private static let now = Date()

    static let states: [(String, LiveState)] = [
        ("routing", LiveState(rows: [.init(id: "a", title: "总结一下 AgentSwitch 最近的改动", step: "选择模型", model: nil,
                                             startedAt: now.addingTimeInterval(-8), needsYou: false)], running: 1, waiting: 0)),
        ("running3", LiveState(rows: [
            .init(id: "a", title: "修 AgentSwitch 的 bug", step: "第 2 步：运行 npx vitest run tests/projects.test.ts", model: "Opus 5.5",
                  startedAt: now.addingTimeInterval(-640), needsYou: false),
            .init(id: "b", title: "整理下载目录", step: "交给 DeepSeek Flash", model: "DeepSeek Flash", startedAt: now.addingTimeInterval(-40), needsYou: false),
            .init(id: "c", title: "登录 x.com 看通知", step: "在用工具 browser_navigate", model: "Sonnet 4.6", startedAt: now.addingTimeInterval(-15), needsYou: false),
        ], running: 3, waiting: 0)),
        ("needsYou", LiveState(rows: [
            .init(id: "a", title: "登录财务平台", step: "短信验证码是多少？", model: "Sonnet 4.6", startedAt: now.addingTimeInterval(-95), needsYou: true),
            .init(id: "b", title: "修 AgentSwitch 的 bug", step: "第 2 步：交给 Opus 5.5", model: "Opus 5.5", startedAt: now.addingTimeInterval(-640), needsYou: false),
        ], running: 1, waiting: 1)),
        ("terminal", LiveState(rows: [
            .init(id: "a", title: "fix-login", step: "Bash: npm test -- --watch=false", model: "Claude Code",
                  startedAt: now.addingTimeInterval(-42), needsYou: true, kind: .terminal),
            .init(id: "b", title: "整理下载目录", step: "交给 DeepSeek Flash", model: "DeepSeek Flash", startedAt: now.addingTimeInterval(-40), needsYou: false),
        ], running: 1, waiting: 1)),
        ("endedOK", .finished(.init(taskId: "a", title: "整理下载目录", line: "下载目录整理好了，一共四十二个文件，重复的放进了“重复”文件夹。", ok: true))),
        ("endedFail", .finished(.init(taskId: "a", title: "登录财务平台", line: "登录页一直打不开，gate 代理连不上。", ok: false))),
    ]

    private func renderDir() throws -> URL {
        guard let dir = ProcessInfo.processInfo.environment["AGENTSWITCH_RENDER_DIR"], !dir.isEmpty else {
            throw XCTSkip("set AGENTSWITCH_RENDER_DIR to render the Live Activity views")
        }
        return URL(fileURLWithPath: dir)
    }

    private func write<V: View>(_ view: V, _ name: String, to dir: URL) throws {
        let renderer = ImageRenderer(content: view.environment(\.colorScheme, .dark))
        renderer.scale = 3
        let image = try XCTUnwrap(renderer.nsImage, name)
        let rep = try XCTUnwrap(image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)))
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: dir.appendingPathComponent("\(name).png"))
    }

    func testRenderEveryStateForALook() throws {
        let dir = try renderDir()
        for (name, state) in Self.states {
            try write(ExpandedIsland(state: state), "island-expanded-\(name)", to: dir)
            try write(CompactIsland(state: state), "island-compact-\(name)", to: dir)
            try write(LockScreen(state: state), "lock-\(name)", to: dir)
            try write(LiveMark(state: state).padding(5).background(.black, in: Circle()).padding(12), "island-minimal-\(name)", to: dir)
        }
    }
}

/// The expanded island as WidgetKit lays it out: leading and trailing beside the camera, the bottom across; black,
/// with rounded ends.
private struct ExpandedIsland: View {
    let state: LiveState
    var body: some View {
        VStack(spacing: 6) {
            HStack(alignment: .center) {
                IslandLeading(state: state)
                Spacer(minLength: 120)   // the camera
                IslandTrailing(state: state)
            }
            .frame(height: 36)
            IslandBottom(state: state, linked: false)
        }
        .padding(.top, 12).padding(.horizontal, 14).padding(.bottom, 14)
        .frame(width: 372)
        .background(.black, in: RoundedRectangle(cornerRadius: 44, style: .continuous))
        .padding(12)
    }
}

private struct CompactIsland: View {
    let state: LiveState
    var body: some View {
        HStack {
            IslandCompactLeading(state: state).padding(.leading, 8)
            Spacer(minLength: 126)   // the camera
            IslandCompactTrailing(state: state).padding(.trailing, 10)
        }
        .frame(width: 250, height: 37)
        .background(.black, in: Capsule())
        .padding(12)
    }
}

private struct LockScreen: View {
    let state: LiveState
    var body: some View {
        LockScreenCard(state: state, mac: "Studio Mac", stale: false)
            .frame(width: 370, alignment: .leading)
            .background(LiveLook.background, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .padding(16)
            .background(LinearGradient(colors: [.pink, .orange, .yellow, .teal], startPoint: .topLeading, endPoint: .bottomTrailing))
    }
}
#endif
