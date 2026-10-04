#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The menu bar's Live Activity for `-designPreview` (docs/design/implemented/mac-live.html): the capsule in each state
/// on a strip of menu bar, and the card in each state, from made-up tasks. Always dark, so drawn once.
@MainActor
enum LivePreview {
    static func render(into directory: URL) throws {
        let now = Date()
        let s = Samples(now: now)
        let bars: [(String, LivePresenter)] = [
            ("busy", presenter([s.summary], now: now)),
            ("busy-3", presenter([s.bug, s.downloads, s.browse], now: now)),
            ("waiting", presenter([s.terminal], now: now)),
            ("waiting-2", presenter([s.terminal, s.question, s.bug], now: now)),
            ("done", ended(s.done, now: now)),
            ("incomplete", ended(s.failed, now: now)),
        ]
        for (name, p) in bars {
            try write(Bar(presenter: p, now: now), to: directory.appendingPathComponent("live-bar-\(name).png"))
        }
        let cards: [(String, LivePresenter)] = [
            ("busy-3", presenter([s.bug, s.downloads, s.browse], now: now)),
            ("terminal", presenter([s.terminal, s.bug], now: now)),
            ("approval", presenter([s.approval], now: now)),
            ("options", presenter([s.options, s.downloads], now: now)),
            ("question", presenter([s.question], now: now)),
            ("more", presenter([s.terminal, s.question, s.bug, s.downloads, s.browse], now: now)),
            ("done", ended(s.done, now: now)),
            ("incomplete", ended(s.failed, now: now)),
        ]
        for (name, p) in cards {
            try write(Wall { LiveCard(presenter: p) }, to: directory.appendingPathComponent("live-card-\(name).png"))
        }
    }

    /// Seen once empty (the app's start), then with these rows: nothing counts as new, the card is drawn as opened.
    private static func presenter(_ rows: [LiveSnapshot.Row], now: Date) -> LivePresenter {
        var p = LivePresenter()
        p.receive(LiveSnapshot(rows: rows, now: now), at: now)
        return p
    }

    /// A task seen running, then ended a second ago: the result on show.
    private static func ended(_ end: LiveSnapshot.End, now: Date) -> LivePresenter {
        var p = LivePresenter()
        p.receive(LiveSnapshot(rows: [LiveSnapshot.Row(id: end.id, kind: end.kind, title: end.title, step: "", startedAt: now)], now: now), at: now)
        p.receive(LiveSnapshot(rows: [], ended: [end], now: now), at: now)
        return p
    }

    private static func write<V: View>(_ view: V, to file: URL) throws {
        let renderer = ImageRenderer(content: view.environment(\.interfaceLook, InterfaceLook.current))
        renderer.scale = 2
        guard let image = renderer.cgImage,
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: file.path])
        }
        try png.write(to: file)
    }

    /// Made-up work (names, folders, commands), never the user's.
    private struct Samples {
        let now: Date
        var summary: LiveSnapshot.Row { .init(id: "t4", kind: .task, title: "总结一下这周的提交", step: "选择模型", startedAt: now - 8, doing: "Route") }
        var bug: LiveSnapshot.Row {
            .init(id: "t1", kind: .task, title: "修 AgentSwitch 的 bug", step: "第 2 步：运行 npx vitest run tests/projects.test.ts", model: "Opus 5.5", startedAt: now - 640, doing: "Run")
        }
        var downloads: LiveSnapshot.Row { .init(id: "t2", kind: .task, title: "整理下载目录", step: "已交给 DeepSeek Flash", model: "DeepSeek Flash", startedAt: now - 40, doing: "Start") }
        var browse: LiveSnapshot.Row { .init(id: "t3", kind: .task, title: "登录 x.com 看通知", step: "浏览器 · 打开 https://x.com", startedAt: now - 15, doing: "Web") }
        var terminal: LiveSnapshot.Row {
            .init(id: "k1", kind: .terminal, title: "fix-login", step: "Bash: npm test -- --watch=false", model: "Claude Code", agent: "claude-code",
                  startedAt: now - 42, needsYou: true, ask: .decide(id: "p1", tool: "Bash", target: "npm test -- --watch=false", place: "~/Projects/web"), doing: "Allow?")
        }
        var approval: LiveSnapshot.Row {
            .init(id: "t5", kind: .task, title: "登录 x.com 发一条动态", step: "浏览器 · 点击", startedAt: now - 130, needsYou: true,
                  ask: .decide(id: "a1", tool: "浏览器 · 点击", target: "发布按钮", place: "~/AgentSwitch/tasks/x-post"), doing: "Allow?")
        }
        var options: LiveSnapshot.Row {
            .init(id: "t7", kind: .task, title: "清理旧构建", step: "build/ 里有 3.2 GB 旧产物，要删掉吗？", startedAt: now - 182, needsYou: true,
                  ask: .question(id: "a2", questionId: "q0", text: "build/ 里有 3.2 GB 旧产物，要删掉吗？", options: ["删掉", "保留"], answerable: true), doing: "Answer")
        }
        var question: LiveSnapshot.Row {
            .init(id: "t6", kind: .task, title: "登录财务平台", step: "短信验证码是多少？", startedAt: now - 95, needsYou: true,
                  ask: .question(id: "a3", questionId: "q0", text: "短信验证码是多少？", options: [], answerable: false), doing: "Answer")
        }
        var done: LiveSnapshot.End { .init(taskId: "t2", title: "整理下载目录", line: "下载目录整理好了，一共四十二个文件，重复的放进了“重复”文件夹。", ok: true, at: now - 1) }
        var failed: LiveSnapshot.End { .init(taskId: "t6", title: "登录财务平台", line: "登录页一直打不开，gate 代理连不上。", ok: false, at: now - 1) }
    }

    /// The right end of a menu bar over a dark wallpaper: the capsule, AgentSwitch's own item, the clock.
    private struct Bar: View {
        let presenter: LivePresenter
        let now: Date

        var body: some View {
            HStack(spacing: 15) {
                Spacer(minLength: 0)
                LiveCapsule(look: presenter.look, trail: presenter.trail, now: now)
                Image(nsImage: MenuBarGlyph.image(.ok)).renderingMode(.template).foregroundStyle(.white)
                Text("周二 9:41").font(.system(size: 13, weight: .medium)).foregroundStyle(.white)
            }
            .padding(.horizontal, 14)
            .frame(width: 460, height: 44)
            .background(LinearGradient(colors: [Color(red: 0.23, green: 0.29, blue: 0.43), Color(red: 0.13, green: 0.16, blue: 0.27)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing))
        }
    }

    private struct Wall<Content: View>: View {
        @ViewBuilder let content: Content

        var body: some View {
            content
                .padding(20)
                .background(LinearGradient(colors: [Color(red: 0.23, green: 0.29, blue: 0.43), Color(red: 0.07, green: 0.09, blue: 0.15)],
                                           startPoint: .topLeading, endPoint: .bottomTrailing))
        }
    }
}
#endif
