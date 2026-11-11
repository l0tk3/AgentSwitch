#if DEBUG
import AgentSwitchKit
import SwiftUI
import UIKit

/// `-uiDemo YES -uiDemoScreen terminalsmany`: the terminals tab on a long made-up tree — one home folder holding
/// everything, as a Mac's real list nests (docs/terminal-v0.md §1) — read again every 4 s as the tab reads the Mac (a
/// terminal's sub-agents come and go, a session is written to). With `-terminalsListProbe YES` it is then scrolled to
/// the middle as a finger would and taken through what is done there — another tab and back, a terminal opened and
/// left, the projects folded and unfolded, a failed read's line shown and gone, the list emptied and back (the
/// background is the script's: `simctl launch` another app, then this one); with `-terminalsListProbe errors`, only the
/// failed read's line, at four places down the list — what once left the list drawing nothing (2026-10-17). Each step
/// is written with its time to `tmp/terminals-probe.txt` in the app's data, for `simctl io screenshot`s taken alongside.
@MainActor
enum TerminalsListProbe {
    static let home = "/Users/me"
    static let folders: [String] = {
        var paths = ["", "/Desktop", "/Desktop/WorkSpace/Worktop", "/Desktop/WorkSpace/Worktop/培训", "/Desktop/WorkSpace/Worktop/培训/靶场"]
        for p in ["harbor", "harbor/deploy", "lumen", "lumen/packages/api", "lumen/packages/web", "notes", "relay", "relay/cli",
                  "atlas", "atlas/ios", "atlas/server", "kiln", "quarry", "quarry/tools", "tidewater", "beacon", "beacon/docs", "ember"] {
            paths.append("/Desktop/WorkSpace/Projects/" + p)
        }
        paths += ["/Work/api", "/Work/api/scripts", "/Blog", "/Downloads/scratch"]
        return paths.map { home + $0 }
    }()

    static let words = ["连接池", "错误码统一", "发布流程", "回滚脚本", "缓存命中率", "构建报错", "登录页", "日志轮转", "测试修复", "依赖升级",
                        "接口文档", "重试策略", "权限检查", "迁移脚本", "性能分析"]

    /// The sessions: two to seven a folder, newest first; one written to just now while `tick` goes on.
    static func sessions(tick: Int) -> [SessionSummary] {
        var all: [SessionSummary] = []
        let agents = ["claude-code", "codex", "opencode", "pi", "grok"]
        for (f, cwd) in folders.enumerated() {
            for k in 0..<(2 + (f * 5) % 6) {
                let n = f * 10 + k
                let fresh = n == 31 ? DemoData.ago(5) + Int64(tick) * 4000 : DemoData.ago(Int64(600 + n * 3700))
                all.append(SessionSummary(harness: agents[n % agents.count], id: "m\(n)", cwd: cwd, title: "\(words[n % words.count]) \(n)",
                                          lastText: "…", updatedAt: fresh, startedAt: DemoData.ago(Int64(900 + n * 3700)), active: n == 31))
            }
        }
        return all
    }

    /// Six terminals across the tree; those that work have sub-agents that come and go from one read to the next.
    static func list(tick: Int) -> TerminalList {
        let at: [(Int, TerminalStatus)] = [(5, .working), (5, .idle), (8, .waiting), (13, .working), (20, .working), (24, .idle)]
        let terminals = at.enumerated().map { i, t in
            TerminalInfo(id: "mt\(i)", harness: i % 2 == 0 ? "claude-code" : "codex", cwd: folders[t.0], name: "终端 \(i)", status: t.1,
                         createdAt: DemoData.ago(3600), lastOutputAt: DemoData.ago(2),
                         subagents: t.1 == .working && (tick + i) % 3 != 0
                            ? (0..<(1 + (tick + i) % 3)).map { TerminalSubagent(id: "s\(i)\($0)", type: "Explore", name: "子任务 \($0)", doing: "读取 src/\(tick).ts") } : [])
        }
        return TerminalList(terminals: terminals, agents: ["claude-code", "codex", "opencode", "pi", "grok"])
    }

    /// The tree loaded, then read again every 4 s for as long as the app runs.
    static func start(_ model: AppModel) {
        model.terminals.setDemo(list(tick: 0), sessions: sessions(tick: 0))
        Task { @MainActor in
            var tick = 0
            while true {
                try? await Task.sleep(for: TerminalsTab.pollInterval)
                tick += 1
                model.terminals.setDemo(list(tick: tick), sessions: sessions(tick: tick))
            }
        }
        if UserDefaults.standard.string(forKey: "terminalsListProbe") != nil { Task { await walk(model) } }
    }

    // MARK: the walk

    private static var lines: [String] = []
    private static let out = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("terminals-probe.txt")

    private static func say(_ line: String) {
        let stamp = String(format: "%.1f", Date().timeIntervalSince1970)
        lines.append("\(stamp) \(line)")
        try? lines.joined(separator: "\n").write(to: out, atomically: true, encoding: .utf8)
    }

    private static func pause(_ seconds: Double) async { try? await Task.sleep(for: .milliseconds(Int(seconds * 1000))) }

    private static var window: UIWindow? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow)
    }

    /// The list's scroll view: the tallest one on screen.
    private static func scroller() -> UIScrollView? {
        guard let window else { return nil }
        var found: [UIScrollView] = []
        func walk(_ v: UIView) {
            if let s = v as? UIScrollView, s.window != nil, !s.isHidden, s.contentSize.height > s.bounds.height, s.bounds.width > 300 { found.append(s) }
            v.subviews.forEach(walk)
        }
        walk(window)
        return found.max { $0.contentSize.height < $1.contentSize.height }
    }

    /// Dragged by `dy` in small steps, a frame each, as a finger moves.
    private static func drag(_ dy: CGFloat) async {
        guard let s = scroller() else { say("no scroll view"); return }
        let steps = max(1, Int(abs(dy) / 18))
        for _ in 0..<steps {
            let top = -s.adjustedContentInset.top, bottom = s.contentSize.height - s.bounds.height + s.adjustedContentInset.bottom
            s.contentOffset.y = min(max(top, s.contentOffset.y + dy / CGFloat(steps)), bottom)
            try? await Task.sleep(for: .milliseconds(16))
        }
    }

    private static func place() -> String {
        guard let s = scroller() else { return "no scroll view" }
        return String(format: "offset %.0f of %.0f", s.contentOffset.y, s.contentSize.height)
    }

    private static func walk(_ model: AppModel) async {
        await pause(3)
        // `-terminalsListProbe errors`: only a failed read's line coming and going, at four places down the list.
        if UserDefaults.standard.string(forKey: "terminalsListProbe") == "errors" {
            for to in [700.0, 1600, 2500, 3400] {
                await drag(to - (scroller()?.contentOffset.y ?? 0))
                await pause(1)
                model.terminals.error = "无法连接到 Mac。"
                say("a failed read \(place())")
                await pause(2.5)
                model.terminals.error = nil
                say("a good read \(place())")
                await pause(3.5)
            }
            say("done \(place())")
            return
        }
        say("start \(place())")
        await drag(1400)
        say("scrolled to the middle \(place())")
        await pause(9)
        say("after two reads \(place())")

        model.tab = .files
        say("to Files")
        await pause(5)
        model.tab = .terminals
        say("back to Terminals \(place())")
        await pause(3)

        model.openTerminalRequest = "mt3"
        say("opened a terminal")
        await pause(5)
        if let nav = findNav() { nav.popViewController(animated: true); say("back from the terminal") } else { say("no navigation controller") }
        await pause(3)
        say("after back \(place())")

        await drag(900)
        say("scrolled further \(place())")
        await pause(2)
        UserDefaults.standard.set(folders.filter { $0.hasPrefix(home + "/Desktop/WorkSpace/Projects") && $0.split(separator: "/").count == 6 }.joined(separator: "\n"),
                                  forKey: "terminals.folded")
        say("folded the projects \(place())")
        await pause(3)
        UserDefaults.standard.set("", forKey: "terminals.folded")
        say("unfolded them \(place())")
        await pause(3)

        await drag(-3000)
        await drag(1500)
        say("up and down again \(place())")
        await pause(3)

        // A read that failed (its line over the list), then a good one.
        model.terminals.error = "无法连接到 Mac。"
        say("a failed read \(place())")
        await pause(4)
        model.terminals.error = nil
        say("a good read \(place())")
        await pause(4)

        // Another session: the list empties, then comes back.
        model.terminals.reset()
        say("emptied \(place())")
        await pause(1.5)
        model.terminals.setDemo(list(tick: 99), sessions: sessions(tick: 99))
        say("back \(place())")
        await pause(4)
        say("in the background next (the script) \(place())")
        await pause(14)
        say("done \(place())")
    }

    private static func findNav() -> UINavigationController? {
        guard let window else { return nil }
        func walk(_ vc: UIViewController) -> UINavigationController? {
            if let nav = vc as? UINavigationController, nav.viewControllers.count > 1 { return nav }
            for child in vc.children + [vc.presentedViewController].compactMap({ $0 }) { if let found = walk(child) { return found } }
            return nil
        }
        return window.rootViewController.flatMap(walk)
    }
}
#endif
