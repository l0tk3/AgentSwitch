#if DEBUG
import AgentSwitchMacCore
import AppKit
import SwiftUI

/// `-designPreview <dir> -designPreviewOnly record-turn -probeCPU YES` (debug builds; no service): what a record on
/// screen costs while nothing is asked of it — the app's own time and the window server's, five seconds at a time — with
/// its session still, at work (what it is doing now, its clock, the run of work going), and at work writing an answer
/// that grows as the service says it does (every 150 ms). `cpu.txt` gets a line a scene; `-appearance classic` for the
/// other look, `-probeCPUItems <n>` for a record of another length, `-probeSeconds <s>` for longer scenes. The window is
/// on screen behind the others, where it is drawn as the display asks. At work it also says where each band of light
/// is (`Shimmer`): masked by its words, and moving.
@MainActor
enum RecordCPUProbe {
    static var seconds: Double { UserDefaults.standard.object(forKey: "probeSeconds") as? Double ?? 5 }

    static func run(into directory: URL, log: RecordTurnProbe.Log) async throws {
        try await TerminalsPagePreview.shot(to: directory.appendingPathComponent("cpu.png"), light: true, onScreen: true, stage: { model in
            model.setSimple(true, pane: TerminalPanes.paneShowing(model.layout, "t1")?.id)
        }, then: { model, host in try await play(model: model, host: host, directory: directory, log: log) })
        try log.lines.joined(separator: "\n").appending("\n").write(to: directory.appendingPathComponent("cpu.txt"), atomically: true, encoding: .utf8)
    }

    private static func play(model: TerminalsModel, host: NSView, directory: URL, log: RecordTurnProbe.Log) async throws {
        guard let pane = model.panes.values.first(where: { $0.session?.id == "t1" }), let info = pane.session?.info else { return }
        let all = RecordTurnProbe.realistic(UserDefaults.standard.object(forKey: "probeCPUItems") as? Int ?? 60)
        // Its last item a run of work, as it is while the agent works.
        let items = all + [RecordItem(id: "run", kind: .work, at: Int64(Date().timeIntervalSince1970 * 1000), seconds: 12,
                                      steps: [RecordStep(kind: .run, text: "swift test --filter ListTests")])]
        let activity = TerminalActivity(tool: "Bash", target: "npm test")
        func status(_ word: String) { pane.session?.received(event: "status", data: #"{"status":"\#(word)"}"#) }

        // `-probeCPUScene work`: that one alone (to sample or trace it).
        let only = UserDefaults.standard.string(forKey: "probeCPUScene")
        status("idle")
        pane.record.stage(terminal: info, items: items, plan: [], usage: nil, mode: nil, activity: nil, since: nil)
        try await DesignPreview.settle()
        if only == nil { log.say("\(InterfaceLook.current.rawValue), still: \(try await measure(host) {})") }

        status("working")
        pane.record.stage(terminal: info.with(status: "working"), items: items, plan: [], usage: nil, mode: nil, activity: activity, since: Date().addingTimeInterval(-30))
        try await DesignPreview.settle()
        log.say("\(InterfaceLook.current.rawValue), at work: \(try await measure(host) {})")
        try DesignPreview.write(host, to: directory.appendingPathComponent("cpu-work.png"))
        log.say(await bands(in: host))
        if only == "work" { return }

        let sentence = "排序放在模型里做，界面只读结果，这样列表、搜索和快捷键用的是同一份顺序。"
        var written = ""
        let writing = try await measure(host) {
            written += sentence
            pane.record.stageWriting(AgentWriting(text: written))
        }
        log.say("\(InterfaceLook.current.rawValue), at work, writing: \(writing)")
        pane.record.stageWriting(nil)
        status("idle")
        pane.record.stage(terminal: info, items: items, plan: [], usage: nil, mode: nil, activity: nil, since: nil)
        try await DesignPreview.settle()
        log.say("\(InterfaceLook.current.rawValue), still again: \(try await measure(host) {})")
    }

    /// The bands on screen as their layers are: whether the words' shape masks each, and where it is drawn now and a
    /// little later (a still picture of the window shows none of that).
    private static func bands(in host: NSView) async -> String {
        func all(_ view: NSView) -> [ShimmerBandView] { (view as? ShimmerBandView).map { [$0] } ?? view.subviews.flatMap(all) }
        let found = all(host)
        func xs() -> [CGFloat] { found.map { $0.layer?.sublayers?.first?.presentation()?.position.x ?? .nan } }
        let first = xs()
        try? await Task.sleep(for: .milliseconds(400))
        let later = xs()
        return found.enumerated().map { n, view in
            var masked = false
            var layer = view.layer
            while let l = layer, !masked { masked = l.mask != nil; layer = l.superlayer }
            return String(format: "     band %d: %.0f×%.0f pt, %@, drawn at x %.0f then %.0f", n, view.bounds.width, view.bounds.height,
                          masked ? "masked" : "NOT MASKED", first[n], later[n])
        }.joined(separator: "\n")
    }

    /// The app's time and the window server's over `seconds`, `tick` every 150 ms meanwhile, in percent of one core;
    /// and how many times a second the window's SwiftUI was laid out (2026-11-10: a count, where the percentages move
    /// with whatever else the Mac is doing — and the thing itself: every one of them is the whole window's update).
    static func measure(_ host: NSView, tick: () -> Void) async throws -> String {
        let layouts = LayoutCount(of: host)
        let server = windowServer()
        let app0 = ownTime(), server0 = server.flatMap(time(of:)), start = CFAbsoluteTimeGetCurrent()
        while CFAbsoluteTimeGetCurrent() - start < seconds {
            tick()
            try await Task.sleep(for: .milliseconds(150))
        }
        let wall = CFAbsoluteTimeGetCurrent() - start
        let app = (ownTime() - app0) / wall * 100
        let server1 = server.flatMap(time(of:))
        let ws = server0.flatMap { a in server1.map { ($0 - a) / wall * 100 } }
        return String(format: "app %.1f%%, WindowServer %@, laid out %.1f/s", app, ws.map { String(format: "%.1f%%", $0) } ?? "?", Double(layouts.count) / wall)
    }

    private static func ownTime() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        func s(_ t: timeval) -> Double { Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000 }
        return s(usage.ru_utime) + s(usage.ru_stime)
    }

    private static func windowServer() -> Int32? {
        NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.WindowServer").first?.processIdentifier
            ?? Int32(run("/usr/bin/pgrep", ["-x", "WindowServer"]).trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n").first ?? "")
    }

    /// Another process's CPU time so far (`ps`'s `[[dd-]hh:]mm:ss.cc`).
    private static func time(of pid: Int32) -> Double? {
        let text = run("/bin/ps", ["-o", "time=", "-p", String(pid)]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return text.split(separator: ":").reduce(0.0) { $0 * 60 + (Double($1) ?? 0) }
    }

    private static func run(_ path: String, _ args: [String]) -> String {
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        process.standardOutput = pipe
        guard (try? process.run()) != nil else { return "" }
        process.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }
}
#endif
